import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  CommandChunk,
  CommandContext,
  CommandExecutor,
  CommandResult,
  StreamingCommandExecutor,
} from "./command-runner.js";

/**
 * Docker workbench (Workshop WP3b, ADR-002/ADR-005). The container-executing
 * peer of LocalCommandExecutor (WP3a): the same CommandExecutor interface, so
 * the shell-backed verify checks (test/arch/custom) run unchanged — only the
 * execution boundary differs. Each project has a durable named volume and a
 * long-lived maintenance/check container. Provider turns run in disposable
 * profile containers; both writable provider paths receive an attempt-owned
 * scratch copy and a separate, secret-free trusted process applies signed,
 * approved successful edits.
 *
 * The ADR-002 spike validated the substrate (non-root, --network none egress
 * block, resource caps, in-container check exec). This module drives it. Its
 * golden path is verified on a Docker host by scripts/verify-workbench.mjs —
 * the eval harness cannot exercise real containers.
 *
 * NOT wired into the server by default: enabling it is a deliberate, env-gated
 * choice (see apps/server — WORKBENCH_MODE). Egress-requiring steps (clone,
 * dependency install) need the proxy sidecar (a later WP3b piece); with the
 * default `--network none`, exec-only checks work, network steps fail closed.
 */

export interface WorkbenchConfig {
  /** Image tag (docker/workbench.Dockerfile). */
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** Container network when egress is OFF; "none" (default) = no egress. */
  network?: string;
  dockerBin?: string;
  /** WP3b.5 (ADR-005): allowlisted egress hostnames. Empty ⇒ `--network none`
   *  (no egress). Non-empty ⇒ the workbench joins an `--internal` network with
   *  an egress-proxy sidecar and can reach only these hosts (registry, VCS). */
  egressAllow?: string[];
  /** Egress-proxy image (docker/egress-proxy.Dockerfile). */
  egressProxyImage?: string;
  /** The proxy's OWN outbound network — its primary, so it has a default route
   *  and working DNS. Defaults to the standard docker `bridge`. */
  egressOutboundNetwork?: string;
  /** Vault-resolved secrets available for explicit, per-process selection
   *  (ADR-005 — never written to the volume). e.g. a model API key for
   *  bench.delegate. Keys must be valid env names. */
  secrets?: Record<string, string>;
}

export type WorkbenchStatus = "absent" | "running" | "stopped";
export interface WorkbenchCliProbe {
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface WorkbenchImageProbe {
  available: boolean;
  error: string | null;
}

export interface ManagedProcessTerminationOptions {
  /** Only pre-generation (execution_generation=0) rows may have run inside the
   * long-lived project container and therefore require its pidfile fallback. */
  allowLegacyProjectFallback?: boolean;
}

export class WorkbenchTerminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchTerminationError";
  }
}

const DEFAULTS: Required<WorkbenchConfig> = {
  image: process.env.WORKBENCH_IMAGE ?? "puppetmaster-workbench:spike",
  memory: process.env.WORKBENCH_MEMORY ?? "512m",
  cpus: process.env.WORKBENCH_CPUS ?? "1",
  pidsLimit: Number(process.env.WORKBENCH_PIDS_LIMIT ?? "256"),
  network: process.env.WORKBENCH_NETWORK ?? "none",
  dockerBin: process.env.DOCKER_BIN ?? "docker",
  egressAllow: (process.env.WORKBENCH_EGRESS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  egressProxyImage: process.env.WORKBENCH_EGRESS_PROXY_IMAGE ?? "puppetmaster-egress-proxy:spike",
  egressOutboundNetwork: process.env.WORKBENCH_EGRESS_OUTBOUND_NET ?? "bridge",
  secrets: {},
};

const WORKBENCH_CONFIG_LABEL = "puppetmaster.workbench.config";
const EGRESS_CONFIG_LABEL = "puppetmaster.egress.config";
const EXEC_SECRET_VERSION = 6;
const EXECUTION_PROFILE_LABEL = "puppetmaster.execution.profile";
const EXECUTION_PROJECT_LABEL = "puppetmaster.execution.project";
const EXECUTION_ID_LABEL = "puppetmaster.execution.id";
const SCRATCH_PROJECT_LABEL = "puppetmaster.scratch.project";
const SCRATCH_EXECUTION_LABEL = "puppetmaster.scratch.execution";
const SCRATCH_GENERATION_LABEL = "puppetmaster.scratch.generation";
const SCRATCH_IDENTITY_LABEL = "puppetmaster.scratch.identity";
const CLAUDE_SUBPROCESS_SCRUB = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB";
const SYNC_RECOVERY_ENV = "PUPPETMASTER_SYNC_RECOVERY_KEY";
const SYNC_RECOVERY_FILE = "/puppetmaster-state/recovery-key";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REMOVAL_CONVERGENCE_ATTEMPTS = 20;
const REMOVAL_CONVERGENCE_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEnvironmentName(name: string): void {
  if (!ENV_NAME.test(name)) throw new Error(`invalid managed environment name: ${JSON.stringify(name)}`);
}

function withoutEnvironmentNames(
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const blocked = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !blocked.has(name.toUpperCase())),
  );
}

function setEnvironmentValue(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const folded = name.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === folded) delete env[existing];
  }
  env[name] = value;
}

function signedReceipt(stdout: string, prefix: string): string {
  const expression = new RegExp(`^${prefix} ([A-Za-z0-9_-]+\\.[a-f0-9]{64})$`, "gm");
  const matches = [...stdout.matchAll(expression)].map((match) => match[1]!);
  if (matches.length !== 1) throw new Error(`${prefix} output did not contain exactly one signed receipt`);
  return matches[0]!;
}

function receiptPayload(receipt: string): Record<string, unknown> {
  const split = receipt.lastIndexOf(".");
  if (split <= 0) throw new Error("signed workbench receipt is malformed");
  try {
    const value = JSON.parse(Buffer.from(receipt.slice(0, split), "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("signed workbench receipt payload is malformed");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Forced environment values for managed provider processes. This is pure so
 * deterministic verification can prove the policy without a Docker daemon. */
export function managedProviderEnvironment(
  profile: CommandContext["containerProfile"],
): Readonly<Record<string, string>> {
  return profile === "claude"
    ? { [CLAUDE_SUBPROCESS_SCRUB]: "1" }
    : {};
}

export interface DockerExecEnvironmentPlan {
  /** Docker receives names only. The CLI resolves each value from its own env. */
  args: string[];
  /** Per-spawn environment; the caller must never copy these values into args. */
  env: NodeJS.ProcessEnv;
}

export interface WorkbenchExecutionSnapshot {
  projectId: string;
  executionId: string;
  executionGeneration: number;
  executionIdentitySha256: string;
  snapshotReceipt: string;
}

export interface WorkbenchCopybackStatus {
  state:
    | "absent"
    | "initializing"
    | "prepared"
    | "swapping"
    | "rolled-back"
    | "discarded"
    | "committed"
    | "db-acked"
    | "cleanup-pending"
    | "acked";
  statusReceipt: string;
  commitReceipt: string | null;
}

/** Full identity shared with workbench-sync v3. Truncating or sanitizing this
 * value would reintroduce journal namespace collisions. */
export function workbenchCopybackIdentity(
  projectId: string,
  executionId: string,
  executionGeneration: number,
): string {
  if (!projectId || !executionId || /[\0\r\n]/.test(`${projectId}${executionId}`)) {
    throw new Error("copy-back identity contains an invalid project or execution id");
  }
  if (!Number.isSafeInteger(executionGeneration) || executionGeneration <= 0) {
    throw new Error("copy-back identity requires a positive execution generation");
  }
  return createHash("sha256")
    .update(`puppetmaster-workbench-sync-v3\0${projectId}\0${executionId}\0${executionGeneration}`)
    .digest("hex");
}

/** Build the only allowed provider-secret transport: `docker exec -e NAME`
 * with the value present solely in that Docker client's environment. */
export function dockerExecEnvironmentPlan(
  baseEnv: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, string>>,
  secretNames?: readonly string[],
  managed: Readonly<Record<string, string>> = {},
): DockerExecEnvironmentPlan {
  const configuredNames = Object.keys(secrets);
  const configuredFolded = new Set<string>();
  for (const name of configuredNames) {
    assertEnvironmentName(name);
    const folded = name.toUpperCase();
    if (configuredFolded.has(folded)) {
      throw new Error(`duplicate managed environment name with different casing: ${name}`);
    }
    configuredFolded.add(folded);
  }
  const env = withoutEnvironmentNames(baseEnv, configuredNames);
  const args: string[] = [];
  const exposed = new Set<string>();
  const expose = (name: string, value: string) => {
    assertEnvironmentName(name);
    const folded = name.toUpperCase();
    if (!exposed.has(folded)) {
      args.push("-e", name);
      exposed.add(folded);
    }
    setEnvironmentValue(env, name, value);
  };
  for (const name of secretNames ?? []) {
    assertEnvironmentName(name);
    // This policy bit is controlled by the executor, never by vault input.
    if (name.toUpperCase() === CLAUDE_SUBPROCESS_SCRUB) continue;
    const value = secrets[name];
    if (value !== undefined) expose(name, value);
  }
  for (const [name, value] of Object.entries(managed)) expose(name, value);
  return { args, env };
}

export interface DockerCliOptions {
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DockerCliStreamingOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onChunk: (chunk: CommandChunk) => void | Promise<void>;
  /** Stops the in-container process group before the host docker client is killed. */
  terminate?: () => void | Promise<void>;
}

export interface DockerCliTransport {
  run(bin: string, args: string[], opts?: DockerCliOptions): Promise<CommandResult>;
  runStreaming(bin: string, args: string[], opts: DockerCliStreamingOptions): Promise<CommandResult>;
}

function dockerCli(
  bin: string,
  args: string[],
  opts?: DockerCliOptions,
): Promise<CommandResult> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: opts?.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // docker binary missing / unreachable → fail closed
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (opts?.input !== undefined) {
      child.stdin.end(opts.input);
    }
  });
}

/** Streaming docker invocation with UTF-8 boundary preservation. The callback
 *  chain is serialized so persisted event ordering matches process delivery. */
function dockerCliStreaming(
  bin: string,
  args: string[],
  opts: DockerCliStreamingOptions,
): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: opts.env, windowsHide: true });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let sink = Promise.resolve();
    let stopPromise: Promise<void> | null = null;
    let stopError: unknown = null;
    const MAX_CAPTURE = 5 * 1024 * 1024;

    const stop = (timeout: boolean) => {
      if (timeout) timedOut = true;
      if (stopPromise) return;
      stopPromise = Promise.resolve(opts.terminate?.())
        .catch((err) => {
          stopError = err;
        })
        .finally(() => child.kill("SIGKILL"));
    };

    const emit = (stream: CommandChunk["stream"], text: string) => {
      if (!text) return;
      if (stream === "stdout") stdout = (stdout + text).slice(-MAX_CAPTURE);
      else stderr = (stderr + text).slice(-MAX_CAPTURE);
      sink = sink.then(() => opts.onChunk({ stream, text }));
      // Event persistence is part of the execution boundary. If it fails, stop
      // the in-container group immediately instead of allowing unlogged edits.
      void sink.catch(() => stop(false));
    };
    const onAbort = () => stop(false);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      stop(true);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => emit("stdout", stdoutDecoder.write(d)));
    child.stderr.on("data", (d: Buffer) => emit("stderr", stderrDecoder.write(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      // A failed local Docker client is not proof that its remote exec or
      // descendants stopped. Preserve the abort fence until its termination
      // callback settles, then surface the most relevant failure.
      stop(false);
      void (async () => {
        if (stopPromise) await stopPromise;
        opts.signal?.removeEventListener("abort", onAbort);
        if (stopError) reject(stopError);
        else reject(err);
      })();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      emit("stdout", stdoutDecoder.end());
      emit("stderr", stderrDecoder.end());
      void (async () => {
        let sinkError: unknown = null;
        try {
          await sink;
        } catch (err) {
          sinkError = err;
          stop(false);
        }
        if (stopPromise) await stopPromise;
        // `onChunk` can notify a caller after the local Docker client has
        // closed. Keep cancellation armed through that buffered work: a
        // detached `setsid` descendant must still be terminated.
        opts.signal?.removeEventListener("abort", onAbort);
        if (stopError) reject(stopError);
        else if (sinkError) reject(sinkError);
        else resolve({ code: code ?? -1, stdout, stderr, timedOut });
      })();
    });
  });
}

export class DockerCommandExecutor implements CommandExecutor, StreamingCommandExecutor {
  private readonly cfg: Required<WorkbenchConfig>;
  private readonly dockerBaseEnv: NodeJS.ProcessEnv;
  private readonly transport: DockerCliTransport;
  /** The signed snapshot receipt is retained in memory until the runtime has
   * durably copied it into workbench_copybacks. Recovery after that point uses
   * the DB receipt plus the scratch volume's authenticated identity labels. */
  private readonly scratchSnapshots = new Map<string, WorkbenchExecutionSnapshot>();

  constructor(cfg?: WorkbenchConfig, transport?: DockerCliTransport) {
    this.cfg = { ...DEFAULTS, ...cfg };
    // Validate once and ensure every Docker subprocess starts without any
    // configured provider secret, including case variants on Windows.
    dockerExecEnvironmentPlan(process.env, this.cfg.secrets);
    this.dockerBaseEnv = withoutEnvironmentNames(process.env, Object.keys(this.cfg.secrets));
    this.transport = transport ?? { run: dockerCli, runStreaming: dockerCliStreaming };
  }

  private docker(args: string[], opts?: DockerCliOptions): Promise<CommandResult> {
    return this.transport.run(this.cfg.dockerBin, args, {
      ...opts,
      env: opts?.env ?? this.dockerBaseEnv,
    });
  }

  private dockerStreaming(args: string[], opts: DockerCliStreamingOptions): Promise<CommandResult> {
    return this.transport.runStreaming(this.cfg.dockerBin, args, {
      ...opts,
      env: opts.env ?? this.dockerBaseEnv,
    });
  }

  containerName(projectId: string): string {
    return `pm-workbench-${projectId}`;
  }

  volumeName(projectId: string): string {
    return `pm-workbench-vol-${projectId}`;
  }

  configVolumeName(projectId: string): string {
    return `pm-workbench-config-${projectId}`;
  }

  lockVolumeName(projectId: string): string {
    return `pm-workbench-lock-${projectId}`;
  }

  /** Egress-proxy sidecar container (WP3b.5). */
  proxyName(projectId: string): string {
    return `pm-egress-${projectId}`;
  }

  /** Internal (no-outbound) network the workbench + proxy share (WP3b.5). */
  networkName(projectId: string): string {
    return `pm-wb-net-${projectId}`;
  }

  private fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
  }

  private workbenchFingerprint(imageId: string): string {
    return this.fingerprint({
      version: EXEC_SECRET_VERSION,
      image: this.cfg.image,
      imageId,
      memory: this.cfg.memory,
      cpus: this.cfg.cpus,
      pidsLimit: this.cfg.pidsLimit,
      network: this.cfg.network,
      egressAllow: [...this.cfg.egressAllow].sort(),
      egressProxyImage: this.cfg.egressProxyImage,
      egressOutboundNetwork: this.cfg.egressOutboundNetwork,
    });
  }

  private egressFingerprint(imageId: string): string {
    return this.fingerprint({
      version: 1,
      image: this.cfg.egressProxyImage,
      imageId,
      allow: [...this.cfg.egressAllow].sort(),
      outboundNetwork: this.cfg.egressOutboundNetwork,
    });
  }

  private async imageIdentity(image: string): Promise<string> {
    const inspected = await this.docker(["image", "inspect", image]);
    if (inspected.code !== 0) {
      throw new Error(
        `docker image inspect failed for ${image}: ${inspected.stderr.trim() || `docker exited ${inspected.code}`}`,
      );
    }
    try {
      const rows = JSON.parse(inspected.stdout) as Array<{ Id?: string }>;
      const id = rows[0]?.Id;
      if (!id) throw new Error("image id is missing");
      return id;
    } catch (err) {
      throw new Error(
        `docker image inspect returned invalid state for ${image}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async stateAndLabel(
    name: string,
    label: string,
  ): Promise<{ status: WorkbenchStatus; label: string | null }> {
    const res = await this.docker(["inspect", name]);
    if (res.code !== 0) {
      const detail = `${res.stderr}\n${res.stdout}`.trim();
      if (/no such (object|container)/i.test(detail)) {
        return { status: "absent", label: null };
      }
      throw new WorkbenchTerminationError(
        `docker inspect failed for ${name}: ${detail || `docker exited ${res.code}`}`,
      );
    }
    try {
      const inspected = JSON.parse(res.stdout) as Array<{
        State?: { Running?: boolean };
        Config?: { Labels?: Record<string, string> | null };
      }>;
      const row = inspected[0];
      if (!row) throw new Error("empty inspect result");
      return {
        status: row.State?.Running === true ? "running" : "stopped",
        label: row.Config?.Labels?.[label] ?? null,
      };
    } catch (err) {
      throw new WorkbenchTerminationError(
        `docker inspect returned invalid state for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async stateOf(name: string): Promise<WorkbenchStatus> {
    return (await this.stateAndLabel(name, WORKBENCH_CONFIG_LABEL)).status;
  }

  private execEnvironment(
    secretNames: readonly string[] | undefined,
    profile?: CommandContext["containerProfile"],
  ): DockerExecEnvironmentPlan {
    return dockerExecEnvironmentPlan(
      this.dockerBaseEnv,
      this.cfg.secrets,
      secretNames,
      managedProviderEnvironment(profile),
    );
  }

  /** Independently prove the disposable holder contains neither a configured
   * provider secret nor the provider command. Values are never included in an
   * error, so a failed boundary check cannot disclose them through logs. */
  private async assertSecretFreeProviderHolder(name: string): Promise<void> {
    const inspected = await this.docker(["inspect", name]);
    if (inspected.code !== 0) {
      throw new WorkbenchTerminationError(`could not inspect isolated provider holder ${name}`);
    }
    try {
      const rows = JSON.parse(inspected.stdout) as Array<{
        Config?: { Env?: string[] | null; Cmd?: string[] | string | null };
      }>;
      const config = rows[0]?.Config;
      const command = Array.isArray(config?.Cmd)
        ? config.Cmd
        : typeof config?.Cmd === "string"
          ? [config.Cmd]
          : [];
      if (command.length !== 2 || command[0] !== "sleep" || command[1] !== "infinity") {
        throw new Error("holder command is not the fixed idle command");
      }
      const forbiddenNames = new Set(Object.keys(this.cfg.secrets).map((name) => name.toUpperCase()));
      const forbiddenValues = [...new Set(Object.values(this.cfg.secrets).filter(Boolean))];
      for (const entry of config?.Env ?? []) {
        const split = entry.indexOf("=");
        const envName = (split < 0 ? entry : entry.slice(0, split)).toUpperCase();
        const envValue = split < 0 ? "" : entry.slice(split + 1);
        if (forbiddenNames.has(envName)) throw new Error("configured secret name entered holder env");
        if (
          forbiddenValues.some((secret) =>
            secret.length >= 8 ? envValue.includes(secret) : envValue === secret,
          )
        ) {
          throw new Error("configured secret value entered holder env");
        }
      }
      if (
        command.some((part) =>
          forbiddenValues.some((secret) => secret.length >= 8 ? part.includes(secret) : part === secret),
        )
      ) {
        throw new Error("configured secret value entered holder command");
      }
    } catch (err) {
      throw new WorkbenchTerminationError(
        `isolated provider holder ${name} failed the secret-free configuration proof: ` +
          (err instanceof Error ? err.message : "invalid Docker inspect response"),
      );
    }
  }

  private executionContainerName(executionId: string | undefined): string {
    const token = (executionId ?? randomUUID()).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 160);
    return `pm-exec-${token || randomUUID().replaceAll("-", "")}`;
  }

  private executionToken(executionId: string): string {
    const token = executionId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 140);
    if (!token) throw new Error("isolated execution requires a stable executionId");
    return token;
  }

  private scratchVolumeName(executionId: string): string {
    return `pm-exec-vol-${this.executionToken(executionId)}`;
  }

  private stateVolumeName(executionId: string): string {
    return `pm-exec-state-${this.executionToken(executionId)}`;
  }

  private async removeContainer(name: string): Promise<void> {
    let lastDetail = "";
    for (let attempt = 0; attempt < REMOVAL_CONVERGENCE_ATTEMPTS; attempt += 1) {
      const removed = await this.docker(["rm", "-f", name]);
      const detail = `${removed.stderr}\n${removed.stdout}`.trim();
      lastDetail = detail;
      if (
        removed.code !== 0 &&
        !/no such (object|container)|removal of container .+ is already in progress/i.test(detail)
      ) {
        throw new WorkbenchTerminationError(
          `failed to remove container ${name}: ${detail || `docker exited ${removed.code}`}`,
        );
      }
      if ((await this.stateAndLabel(name, WORKBENCH_CONFIG_LABEL)).status === "absent") return;
      if (attempt + 1 < REMOVAL_CONVERGENCE_ATTEMPTS) await delay(REMOVAL_CONVERGENCE_DELAY_MS);
    }
    throw new WorkbenchTerminationError(
      `could not prove container ${name} was removed${lastDetail ? `: ${lastDetail}` : ""}`,
    );
  }

  private async removeVolumeProven(name: string): Promise<void> {
    let lastDetail = "";
    for (let attempt = 0; attempt < REMOVAL_CONVERGENCE_ATTEMPTS; attempt += 1) {
      const removed = await this.docker(["volume", "rm", "-f", name]);
      const detail = `${removed.stderr}\n${removed.stdout}`.trim();
      lastDetail = detail;
      if (removed.code !== 0 && !/no such volume|volume is in use|removal.+in progress/i.test(detail)) {
        throw new WorkbenchTerminationError(
          `failed to remove volume ${name}: ${detail || `docker exited ${removed.code}`}`,
        );
      }
      const proof = await this.docker(["volume", "inspect", name]);
      const proofDetail = `${proof.stderr}\n${proof.stdout}`.trim();
      if (proof.code !== 0 && /no such volume/i.test(proofDetail)) return;
      if (proof.code !== 0) {
        throw new WorkbenchTerminationError(
          `could not inspect volume ${name} after removal: ${proofDetail || `docker exited ${proof.code}`}`,
        );
      }
      lastDetail = proofDetail || lastDetail;
      if (attempt + 1 < REMOVAL_CONVERGENCE_ATTEMPTS) await delay(REMOVAL_CONVERGENCE_DELAY_MS);
    }
    throw new WorkbenchTerminationError(
      `could not prove volume ${name} was removed${lastDetail ? `: ${lastDetail}` : ""}`,
    );
  }

  private async networkState(name: string): Promise<{ exists: boolean; internal: boolean }> {
    const inspected = await this.docker(["network", "inspect", name]);
    if (inspected.code !== 0) {
      const detail = `${inspected.stderr}\n${inspected.stdout}`.trim();
      if (/no such network|network .+ not found/i.test(detail)) return { exists: false, internal: false };
      throw new Error(`docker network inspect failed for ${name}: ${detail || `docker exited ${inspected.code}`}`);
    }
    try {
      const rows = JSON.parse(inspected.stdout) as Array<{ Internal?: boolean }>;
      if (!rows[0]) throw new Error("empty inspect result");
      return { exists: true, internal: rows[0].Internal === true };
    } catch (err) {
      throw new Error(
        `docker network inspect returned invalid state for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async attachedNetworks(name: string): Promise<Set<string>> {
    const inspected = await this.docker(["inspect", name]);
    if (inspected.code !== 0) {
      throw new Error(`docker inspect failed for ${name}: ${inspected.stderr.trim() || `docker exited ${inspected.code}`}`);
    }
    try {
      const rows = JSON.parse(inspected.stdout) as Array<{
        NetworkSettings?: { Networks?: Record<string, unknown> | null };
      }>;
      return new Set(Object.keys(rows[0]?.NetworkSettings?.Networks ?? {}));
    } catch (err) {
      throw new Error(
        `docker inspect returned invalid network state for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async cleanupEgress(projectId: string): Promise<void> {
    const proxy = this.proxyName(projectId);
    const proxyState = await this.stateAndLabel(proxy, EGRESS_CONFIG_LABEL);
    if (proxyState.status !== "absent") await this.removeContainer(proxy);
    const removed = await this.docker(["network", "rm", this.networkName(projectId)]);
    if (removed.code !== 0 && !/no such network|network .+ not found/i.test(`${removed.stderr}\n${removed.stdout}`)) {
      throw new WorkbenchTerminationError(
        `failed to remove stale egress network for ${projectId}: ${removed.stderr.trim() || `docker exited ${removed.code}`}`,
      );
    }
  }

  async status(projectId: string): Promise<WorkbenchStatus> {
    return this.stateOf(this.containerName(projectId));
  }

  async executionStatus(executionId: string): Promise<WorkbenchStatus> {
    return (await this.stateAndLabel(this.executionContainerName(executionId), EXECUTION_PROFILE_LABEL)).status;
  }

  /** Verify that a configured image contains the expected pinned coding CLI.
   * The probe has no project mount, secrets, or network and never pulls. */
  async probeCli(cli: "claude" | "aider", expectedVersion: string): Promise<WorkbenchCliProbe> {
    try {
      const result = await this.docker([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--entrypoint",
        cli,
        this.cfg.image,
        "--version",
      ], { timeoutMs: 30_000 });
      const version = `${result.stdout}\n${result.stderr}`.trim().slice(0, 500) || null;
      if (result.code !== 0) {
        return { available: false, version, error: `${cli} is unavailable in the configured workbench image` };
      }
      if (!version?.includes(expectedVersion)) {
        return {
          available: false,
          version,
          error: `${cli} version does not match the required pinned version ${expectedVersion}`,
        };
      }
      const sync = await this.docker([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--entrypoint",
        "puppetmaster-sync",
        this.cfg.image,
        "self-test",
      ], { timeoutMs: 30_000 });
      if (sync.code !== 0) {
        return {
          available: false,
          version,
          error: "the configured workbench image lacks the required copy-back/recovery helper",
        };
      }
      return { available: true, version, error: null };
    } catch {
      return { available: false, version: null, error: "the Docker workbench image could not be inspected" };
    }
  }

  /** Verify that the configured allowlisting sidecar image exists locally.
   *  Provider readiness must not claim success and then rely on an implicit
   *  registry pull. Project-specific network reconciliation happens in ensure(). */
  async probeEgressProxy(): Promise<WorkbenchImageProbe> {
    if (this.cfg.egressAllow.length === 0) return { available: true, error: null };
    try {
      await this.imageIdentity(this.cfg.egressProxyImage);
      return { available: true, error: null };
    } catch {
      return {
        available: false,
        error: "the configured workbench egress-proxy image is unavailable locally",
      };
    }
  }

  /** Idempotent: create+start the container if absent, start it if stopped.
   *  Returns the container name. Applies the ADR-005 caps + isolation. */
  async ensure(projectId: string): Promise<string> {
    const name = this.containerName(projectId);
    const expected = this.workbenchFingerprint(await this.imageIdentity(this.cfg.image));
    let current = await this.stateAndLabel(name, WORKBENCH_CONFIG_LABEL);
    if (current.status !== "absent" && current.label !== expected) {
      // Container environment/network settings are immutable. Replace only
      // the container; both named persistent volumes remain intact.
      await this.removeContainer(name);
      current = { status: "absent", label: null };
    }
    const egress = this.cfg.egressAllow.length > 0;
    if (egress) {
      await this.ensureEgress(projectId);
      // Egress reconciliation may remove a base container that was attached to
      // an unsafe pre-existing network. Never return a stale state snapshot.
      current = await this.stateAndLabel(name, WORKBENCH_CONFIG_LABEL);
      if (current.status !== "absent") {
        const networks = await this.attachedNetworks(name);
        if (networks.size !== 1 || !networks.has(this.networkName(projectId))) {
          await this.removeContainer(name);
          current = { status: "absent", label: null };
        }
      }
    }
    if (current.status === "running") {
      return name;
    }
    if (current.status === "stopped") {
      const started = await this.docker(["start", name]);
      if (started.code !== 0) {
        throw new Error(`workbench start failed for ${projectId}: ${started.stderr.trim()}`);
      }
      return name;
    }
    // Egress OFF (default): `--network none`, no proxy — the host-verified path.
    // Egress ON: join the internal network with an allowlisting proxy sidecar,
    // routed via HTTP(S)_PROXY. Provider secrets are selected per execution
    // and never persisted in the container configuration.
    let networkArg = `--network=${this.cfg.network}`;
    const proxyEnv: string[] = [];
    if (egress) {
      networkArg = `--network=${this.networkName(projectId)}`;
      const proxyUrl = `http://${this.proxyName(projectId)}:8080`;
      proxyEnv.push(
        "-e", `HTTP_PROXY=${proxyUrl}`,
        "-e", `HTTPS_PROXY=${proxyUrl}`,
        "-e", `http_proxy=${proxyUrl}`,
        "-e", `https_proxy=${proxyUrl}`,
        "-e", "NO_PROXY=localhost,127.0.0.1",
        "-e", "no_proxy=localhost,127.0.0.1",
      );
    } else {
      await this.cleanupEgress(projectId);
    }

    const run = await this.docker([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `${WORKBENCH_CONFIG_LABEL}=${expected}`,
      networkArg,
      `--memory=${this.cfg.memory}`,
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
      ...proxyEnv,
      "-v",
      `${this.volumeName(projectId)}:/workbench`,
      "-v",
      `${this.lockVolumeName(projectId)}:/puppetmaster-lock`,
      this.cfg.image,
      "sleep",
      "infinity",
    ]);
    if (run.code !== 0) {
      throw new Error(`workbench create failed for ${projectId}: ${run.stderr.trim()}`);
    }
    return name;
  }

  /** Bring up the egress path (WP3b.5, ADR-005): an `--internal` network (no
   *  direct outbound) shared by the workbench and an allowlisting proxy; the
   *  proxy is additionally attached to the default bridge for its own outbound,
   *  so the workbench's ONLY route out is the declared allowlist. Idempotent. */
  private async ensureEgress(projectId: string): Promise<void> {
    const net = this.networkName(projectId);
    // Never trust a pre-existing same-named network: inspect and reconcile it
    // before attaching either the workbench or the proxy.
    const boundary = await this.networkState(net);
    if (boundary.exists && !boundary.internal) {
      const base = await this.stateAndLabel(this.containerName(projectId), WORKBENCH_CONFIG_LABEL);
      if (base.status !== "absent") await this.removeContainer(this.containerName(projectId));
      const proxyState = await this.stateAndLabel(this.proxyName(projectId), EGRESS_CONFIG_LABEL);
      if (proxyState.status !== "absent") await this.removeContainer(this.proxyName(projectId));
      const removed = await this.docker(["network", "rm", net]);
      if (removed.code !== 0) throw new Error(`unsafe egress network ${net} could not be removed`);
    }
    if (!(await this.networkState(net)).exists) {
      const network = await this.docker(["network", "create", "--internal", net]);
      if (network.code !== 0) {
        throw new Error(
          `egress network create failed for ${projectId}: ${network.stderr.trim() || `docker exited ${network.code}`}`,
        );
      }
    }
    const provenBoundary = await this.networkState(net);
    if (!provenBoundary.exists || !provenBoundary.internal) {
      throw new Error(`egress network ${net} is not an internal Docker network`);
    }

    const proxy = this.proxyName(projectId);
    const expected = this.egressFingerprint(await this.imageIdentity(this.cfg.egressProxyImage));
    let current = await this.stateAndLabel(proxy, EGRESS_CONFIG_LABEL);
    if (current.status !== "absent" && current.label !== expected) {
      await this.removeContainer(proxy);
      current = { status: "absent", label: null };
    }
    if (current.status === "stopped") {
      const started = await this.docker(["start", proxy]);
      if (started.code !== 0) {
        throw new Error(`egress proxy start failed for ${projectId}: ${started.stderr.trim()}`);
      }
      current = { status: "running", label: current.label };
    }
    if (current.status === "running") {
      const networks = await this.attachedNetworks(proxy);
      if (!networks.has(this.cfg.egressOutboundNetwork)) {
        await this.removeContainer(proxy);
        current = { status: "absent", label: null };
      } else if (!networks.has(net)) {
        const connected = await this.docker(["network", "connect", net, proxy]);
        if (connected.code === 0 && (await this.attachedNetworks(proxy)).has(net)) return;
        await this.removeContainer(proxy);
        current = { status: "absent", label: null };
      } else {
        return;
      }
    }
    // Primary network = the outbound one (default route + working external DNS);
    // the internal net is attached second, only so the workbench can reach the
    // proxy by name. Order matters: an --internal primary would leave the proxy
    // with no route/DNS to resolve and reach the allowlisted upstream.
    const run = await this.docker([
      "run",
      "-d",
      "--name",
      proxy,
      "--label",
      `${EGRESS_CONFIG_LABEL}=${expected}`,
      `--network=${this.cfg.egressOutboundNetwork}`,
      "-e",
      `EGRESS_ALLOW=${this.cfg.egressAllow.join(",")}`,
      this.cfg.egressProxyImage,
    ]);
    if (run.code !== 0) {
      throw new Error(`egress proxy create failed for ${projectId}: ${run.stderr.trim()}`);
    }
    // Attach the internal net so the workbench resolves + reaches the proxy.
    const connect = await this.docker(["network", "connect", net, proxy]);
    if (connect.code !== 0) {
      await this.removeContainer(proxy);
      throw new Error(`egress proxy internal attach failed for ${projectId}: ${connect.stderr.trim()}`);
    }
    const networks = await this.attachedNetworks(proxy);
    if (!networks.has(net) || !networks.has(this.cfg.egressOutboundNetwork)) {
      await this.removeContainer(proxy);
      throw new Error(`egress proxy ${proxy} is not attached to both required networks`);
    }
  }

  /** Run a shell command in the project's workbench via `docker exec`. Resolves
   *  on any exit code; rejects only if docker itself can't run (fail closed). */
  async run(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.containerProfile) {
      return this.runIsolatedStreaming(ctx, () => {});
    }
    const name = this.containerName(ctx.projectId);
    const exec = this.execEnvironment(ctx.secretNames);
    const lockMode = ctx.accessMode === "read" ? "-s" : "-x";
    return this.docker(
      [
        "exec", ...exec.args, "-w", "/workbench", name,
        "flock", lockMode, "/puppetmaster-lock/project.lock", "sh", "-c", ctx.command,
      ],
      { timeoutMs: ctx.timeoutMs, env: exec.env },
    );
  }

  private async listExecutionContainerIds(filters: readonly string[]): Promise<string[]> {
    const listed = await this.docker(["ps", "-aq", ...filters]);
    if (listed.code !== 0) {
      throw new WorkbenchTerminationError("could not enumerate isolated execution containers");
    }
    return listed.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  }

  /** Converge only holders carrying the exact durable execution label. This is
   * safe to use before scratch cleanup: it cannot scan or kill arbitrary volume
   * consumers. */
  private async terminateExecutionHolders(
    executionId: string,
    projectId?: string,
  ): Promise<boolean> {
    const filters = ["--filter", `label=${EXECUTION_ID_LABEL}=${executionId}`];
    if (projectId) filters.push("--filter", `label=${EXECUTION_PROJECT_LABEL}=${projectId}`);
    let found = false;
    for (let attempt = 0; attempt < REMOVAL_CONVERGENCE_ATTEMPTS; attempt += 1) {
      const holders = await this.listExecutionContainerIds(filters);
      if (holders.length === 0) return found;
      found = true;
      for (const holder of holders) await this.terminateExecutionContainer(holder);
      if (attempt + 1 < REMOVAL_CONVERGENCE_ATTEMPTS) await delay(REMOVAL_CONVERGENCE_DELAY_MS);
    }
    throw new WorkbenchTerminationError(`could not prove all execution holders for ${executionId} were removed`);
  }

  private async terminateProjectExecutionHolders(projectId: string): Promise<void> {
    const filters = ["--filter", `label=${EXECUTION_PROJECT_LABEL}=${projectId}`];
    for (let attempt = 0; attempt < REMOVAL_CONVERGENCE_ATTEMPTS; attempt += 1) {
      const holders = await this.listExecutionContainerIds(filters);
      if (holders.length === 0) return;
      for (const holder of holders) await this.terminateExecutionContainer(holder);
      if (attempt + 1 < REMOVAL_CONVERGENCE_ATTEMPTS) await delay(REMOVAL_CONVERGENCE_DELAY_MS);
    }
    throw new WorkbenchTerminationError(`could not prove all execution holders for ${projectId} were removed`);
  }

  private async terminateExecutionContainer(name: string): Promise<void> {
    const current = await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL);
    if (current.status === "absent") return;
    if (current.status === "running") await this.forceStop(name);
    const remaining = await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL);
    if (remaining.status !== "absent") await this.removeContainer(name);
    if ((await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL)).status !== "absent") {
      throw new WorkbenchTerminationError(`could not prove isolated execution container ${name} stopped`);
    }
  }

  private async startCreatedContainer(
    name: string,
    opts: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onChunk: (chunk: CommandChunk) => void | Promise<void>;
    },
  ): Promise<CommandResult> {
    try {
      const result = await this.dockerStreaming(["start", "-a", name], {
        ...opts,
        terminate: () => this.terminateExecutionContainer(name),
      });
      // Attach exiting is not proof that the daemon-side container exited.
      await this.terminateExecutionContainer(name);
      return result;
    } catch (err) {
      try {
        await this.terminateExecutionContainer(name);
      } catch (cleanupError) {
        throw cleanupError;
      }
      throw err;
    }
  }

  private async createScratchVolume(
    projectId: string,
    executionId: string,
    executionGeneration: number,
  ): Promise<{ volume: string; stateVolume: string }> {
    const volume = this.scratchVolumeName(executionId);
    const stateVolume = this.stateVolumeName(executionId);
    const identity = workbenchCopybackIdentity(projectId, executionId, executionGeneration);
    const recoveryKey = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await this.terminateExecutionHolders(executionId, projectId);
    await this.removeVolumeProven(volume);
    await this.removeVolumeProven(stateVolume);
    try {
      for (const name of [volume, stateVolume]) {
        const created = await this.docker([
          "volume",
          "create",
          "--label",
          `${SCRATCH_PROJECT_LABEL}=${projectId}`,
          "--label",
          `${SCRATCH_EXECUTION_LABEL}=${executionId}`,
          "--label",
          `${SCRATCH_GENERATION_LABEL}=${executionGeneration}`,
          "--label",
          `${SCRATCH_IDENTITY_LABEL}=${identity}`,
          name,
        ]);
        if (created.code !== 0) throw new Error(`could not create isolated execution volume for ${projectId}`);
      }
      await this.initializeRecoveryState(projectId, executionId, stateVolume, recoveryKey);
      return { volume, stateVolume };
    } catch (error) {
      await this.removeVolumeProven(volume).catch(() => {});
      await this.removeVolumeProven(stateVolume).catch(() => {});
      throw error;
    }
  }

  private async initializeRecoveryState(
    projectId: string,
    executionId: string,
    stateVolume: string,
    recoveryKey: string,
  ): Promise<void> {
    const name = this.executionContainerName(`${executionId}-recovery-key`);
    const existing = await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL);
    if (existing.status !== "absent") await this.terminateExecutionContainer(name);
    const created = await this.docker([
      "create", "--rm", "--name", name,
      "--label", `${EXECUTION_PROFILE_LABEL}=plain`,
      "--label", `${EXECUTION_PROJECT_LABEL}=${projectId}`,
      "--label", `${EXECUTION_ID_LABEL}=${executionId}`,
      "--network=none",
      `--memory=${this.cfg.memory}`,
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
      "-v", `${stateVolume}:/puppetmaster-state`,
      this.cfg.image, "sleep", "infinity",
    ]);
    if (created.code !== 0) throw new Error(`could not create recovery-state initializer for ${projectId}`);
    try {
      await this.assertSecretFreeProviderHolder(name);
      const started = await this.docker(["start", name]);
      if (started.code !== 0) throw new Error(`could not start recovery-state initializer for ${projectId}`);
      const plan = dockerExecEnvironmentPlan(
        this.dockerBaseEnv,
        { [SYNC_RECOVERY_ENV]: recoveryKey },
        [SYNC_RECOVERY_ENV],
      );
      const initialized = await this.docker([
        "exec", ...plan.args, name, "sh", "-c",
        `umask 077; set -C; printf %s \"$${SYNC_RECOVERY_ENV}\" > ${SYNC_RECOVERY_FILE}; ` +
          `chmod 600 ${SYNC_RECOVERY_FILE}; sync ${SYNC_RECOVERY_FILE}`,
      ], { timeoutMs: 30_000, env: plan.env });
      if (initialized.code !== 0) throw new Error(`could not initialize recovery state for ${projectId}`);
    } finally {
      await this.terminateExecutionContainer(name);
    }
  }

  async cleanupExecutionArtifacts(executionId: string): Promise<void> {
    // Scratch mounts are only deleted after every exact execution holder has
    // disappeared. Docker Desktop may release a --rm mount shortly after the
    // holder's process exits, so removeVolumeProven supplies the bounded proof
    // loop for that final daemon-side detach.
    await this.terminateExecutionHolders(executionId);
    try {
      await this.removeVolumeProven(this.scratchVolumeName(executionId));
    } finally {
      try {
        await this.removeVolumeProven(this.stateVolumeName(executionId));
      } finally {
        this.scratchSnapshots.delete(executionId);
      }
    }
  }

  private async scratchVolumeMetadata(
    projectId: string,
    executionId: string,
    executionGeneration: number,
    required: boolean,
  ): Promise<{ volume: string; stateVolume: string; executionIdentitySha256: string } | null> {
    const volume = this.scratchVolumeName(executionId);
    const stateVolume = this.stateVolumeName(executionId);
    const inspected = await this.docker(["volume", "inspect", volume, stateVolume]);
    if (inspected.code !== 0) {
      const detail = `${inspected.stderr}\n${inspected.stdout}`.trim();
      if (/no such volume/i.test(detail)) {
        if (!required) return null;
        throw new Error(`isolated scratch volume ${volume} is missing`);
      }
      throw new WorkbenchTerminationError(
        `could not inspect isolated scratch volume ${volume}: ${detail || `docker exited ${inspected.code}`}`,
      );
    }
    try {
      const rows = JSON.parse(inspected.stdout) as Array<{ Name?: string; Labels?: Record<string, string> | null }>;
      if (rows.length !== 2) throw new Error("execution state volume pair is incomplete");
      const expectedIdentity = workbenchCopybackIdentity(projectId, executionId, executionGeneration);
      for (const row of rows) {
        const labels = row.Labels ?? {};
        if (
          labels[SCRATCH_PROJECT_LABEL] !== projectId ||
          labels[SCRATCH_EXECUTION_LABEL] !== executionId ||
          labels[SCRATCH_GENERATION_LABEL] !== String(executionGeneration) ||
          labels[SCRATCH_IDENTITY_LABEL] !== expectedIdentity
        ) {
          throw new Error(`execution volume ${row.Name ?? "unknown"} ownership labels do not match`);
        }
      }
      return { volume, stateVolume, executionIdentitySha256: expectedIdentity };
    } catch (err) {
      throw new Error(
        `isolated scratch volume ${volume} is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async assertScratchVolume(
    projectId: string,
    executionId: string,
    executionGeneration: number,
  ): Promise<{ volume: string; stateVolume: string; executionIdentitySha256: string }> {
    const metadata = await this.scratchVolumeMetadata(projectId, executionId, executionGeneration, true);
    if (!metadata) throw new Error(`isolated scratch volume for ${executionId} is missing`);
    return metadata;
  }

  /** Runs a trusted sync operation through a secret-free idle holder. The
   * recovery key lives in a companion volume never mounted into providers; it
   * never enters Docker Config.Env, Config.Cmd, labels, or host argv. */
  private async runTrustedSync(input: {
    projectId: string;
    executionId: string;
    operation: string;
    stateVolume: string;
    mounts: readonly string[];
    command: string;
    lockMode: "read" | "write";
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    const name = this.executionContainerName(`${input.executionId}-${input.operation}`);
    const existing = await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL);
    if (existing.status !== "absent") await this.terminateExecutionContainer(name);
    const created = await this.docker([
      "create",
      "--rm",
      "--name",
      name,
      "--label",
      `${EXECUTION_PROFILE_LABEL}=plain`,
      "--label",
      `${EXECUTION_PROJECT_LABEL}=${input.projectId}`,
      "--label",
      `${EXECUTION_ID_LABEL}=${input.executionId}`,
      "--network=none",
      `--memory=${this.cfg.memory}`,
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
      "-v",
      `${this.lockVolumeName(input.projectId)}:/puppetmaster-lock`,
      "-v",
      `${input.stateVolume}:/puppetmaster-state:ro`,
      ...input.mounts.flatMap((mount) => ["-v", mount]),
      this.cfg.image,
      "sleep",
      "infinity",
    ]);
    if (created.code !== 0) {
      await this.terminateExecutionContainer(name);
      throw new Error(`could not create trusted ${input.operation} helper for ${input.projectId}`);
    }
    try {
      await this.assertSecretFreeProviderHolder(name);
      const started = await this.docker(["start", name]);
      if (started.code !== 0) throw new Error(`could not start trusted ${input.operation} helper`);
      return await this.dockerStreaming([
        "exec",
        name,
        "flock",
        input.lockMode === "read" ? "-s" : "-x",
        "/puppetmaster-lock/project.lock",
        "setsid",
        "sh",
        "-c",
        input.command,
      ], {
        timeoutMs: input.timeoutMs ?? 300_000,
        signal: input.signal,
        env: this.dockerBaseEnv,
        onChunk: () => {},
        terminate: () => this.terminateExecutionContainer(name),
      });
    } finally {
      await this.terminateExecutionContainer(name);
    }
  }

  private async prepareOpenAiScratch(
    projectId: string,
    executionId: string,
    executionGeneration: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const scratch = await this.createScratchVolume(projectId, executionId, executionGeneration);
    try {
      const command =
        "set -eu; " +
        "export HOME=/tmp/puppetmaster-snapshot-home " +
        "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 " +
        "GIT_TEMPLATE_DIR=/tmp/puppetmaster-empty-git-template; " +
        "mkdir -p -- \"$HOME\" \"$GIT_TEMPLATE_DIR\"; " +
        `/usr/local/bin/puppetmaster-sync snapshot-v3 /source /workbench ${shellQuote(projectId)} ` +
        `${shellQuote(executionId)} ${executionGeneration} file:${SYNC_RECOVERY_FILE}; ` +
        "git -C /workbench init -q; " +
        "git -C /workbench -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A; " +
        "git -C /workbench -c core.hooksPath=/dev/null -c core.fsmonitor=false " +
        "-c user.name=puppetmaster -c user.email=puppetmaster@invalid.local " +
        "commit -qm 'Puppetmaster provider snapshot' --allow-empty --no-verify";
      const copied = await this.runTrustedSync({
        projectId,
        executionId,
        operation: "snapshot-v3",
        stateVolume: scratch.stateVolume,
        mounts: [
          `${this.volumeName(projectId)}:/source:ro`,
          `${scratch.volume}:/workbench`,
        ],
        command,
        lockMode: "read",
        timeoutMs: 300_000,
        signal,
      });
      if (copied.code !== 0) {
        throw new Error(
          `isolated OpenAI repository snapshot exited ${copied.code}: ` +
            (copied.stderr.trim().slice(0, 1_000) || "snapshot helper failed"),
        );
      }
      const snapshotReceipt = signedReceipt(copied.stdout, "PUPPETMASTER_SNAPSHOT_V3");
      const executionIdentitySha256 = workbenchCopybackIdentity(
        projectId,
        executionId,
        executionGeneration,
      );
      this.scratchSnapshots.set(executionId, {
        projectId,
        executionId,
        executionGeneration,
        executionIdentitySha256,
        snapshotReceipt,
      });
      return scratch.volume;
    } catch (err) {
      await this.cleanupExecutionArtifacts(executionId);
      throw err;
    }
  }

  async getExecutionSnapshot(
    projectId: string,
    executionId: string,
    executionGeneration: number,
  ): Promise<WorkbenchExecutionSnapshot> {
    const snapshot = this.scratchSnapshots.get(executionId);
    if (
      !snapshot ||
      snapshot.projectId !== projectId ||
      snapshot.executionGeneration !== executionGeneration
    ) {
      throw new Error(`signed execution snapshot for ${executionId} is unavailable`);
    }
    const scratch = await this.assertScratchVolume(projectId, executionId, executionGeneration);
    if (scratch.executionIdentitySha256 !== snapshot.executionIdentitySha256) {
      throw new Error(`signed execution snapshot identity for ${executionId} does not match its scratch volume`);
    }
    return { ...snapshot };
  }

  private parseCopybackStatus(
    result: CommandResult,
    projectId: string,
    executionId: string,
    executionGeneration: number,
  ): WorkbenchCopybackStatus {
    if (result.code !== 0) {
      throw new WorkbenchTerminationError(
        `copy-back reconciliation exited ${result.code}: ${result.stderr.trim().slice(0, 1_000) || "unknown error"}`,
      );
    }
    const statusReceipt = signedReceipt(result.stdout, "PUPPETMASTER_STATUS_V3");
    const payload = receiptPayload(statusReceipt);
    const expectedIdentity = workbenchCopybackIdentity(projectId, executionId, executionGeneration);
    const states = new Set<WorkbenchCopybackStatus["state"]>([
      "absent", "initializing", "prepared", "swapping", "rolled-back", "discarded",
      "committed", "db-acked", "cleanup-pending", "acked",
    ]);
    if (
      payload.version !== 3 ||
      payload.kind !== "status" ||
      payload.projectId !== projectId ||
      payload.executionId !== executionId ||
      payload.executionGeneration !== executionGeneration ||
      payload.token !== expectedIdentity ||
      typeof payload.state !== "string" ||
      !states.has(payload.state as WorkbenchCopybackStatus["state"])
    ) {
      throw new WorkbenchTerminationError("copy-back helper returned a mismatched signed status receipt");
    }
    const commitReceipt = typeof payload.commitReceipt === "string" ? payload.commitReceipt : null;
    if (["committed", "db-acked"].includes(payload.state) && !commitReceipt) {
      throw new WorkbenchTerminationError("committed copy-back status omitted its commit receipt");
    }
    return {
      state: payload.state as WorkbenchCopybackStatus["state"],
      statusReceipt,
      commitReceipt,
    };
  }

  async statusExecutionCopyback(
    projectId: string,
    executionId: string,
    executionGeneration: number,
  ): Promise<WorkbenchCopybackStatus> {
    const scratch = await this.assertScratchVolume(projectId, executionId, executionGeneration);
    const result = await this.runTrustedSync({
      projectId,
      executionId,
      operation: "status-v3",
      stateVolume: scratch.stateVolume,
      mounts: [`${this.volumeName(projectId)}:/workbench`],
      command:
        `/usr/local/bin/puppetmaster-sync status-v3 /workbench ${shellQuote(projectId)} ` +
        `${shellQuote(executionId)} ${executionGeneration} file:${SYNC_RECOVERY_FILE}`,
      lockMode: "write",
    });
    return this.parseCopybackStatus(result, projectId, executionId, executionGeneration);
  }

  async recoverExecutionCopyback(
    projectId: string,
    executionId: string,
    executionGeneration: number,
  ): Promise<WorkbenchCopybackStatus> {
    const scratch = await this.assertScratchVolume(projectId, executionId, executionGeneration);
    const result = await this.runTrustedSync({
      projectId,
      executionId,
      operation: "recover-v3",
      stateVolume: scratch.stateVolume,
      mounts: [`${this.volumeName(projectId)}:/workbench`],
      command:
        `/usr/local/bin/puppetmaster-sync recover-v3 /workbench ${shellQuote(projectId)} ` +
        `${shellQuote(executionId)} ${executionGeneration} file:${SYNC_RECOVERY_FILE}`,
      lockMode: "write",
    });
    return this.parseCopybackStatus(result, projectId, executionId, executionGeneration);
  }

  async acknowledgeExecutionCopyback(
    projectId: string,
    executionId: string,
    executionGeneration: number,
    commitReceipt: string,
  ): Promise<WorkbenchCopybackStatus> {
    const scratch = await this.assertScratchVolume(projectId, executionId, executionGeneration);
    const result = await this.runTrustedSync({
      projectId,
      executionId,
      operation: "ack-v3",
      stateVolume: scratch.stateVolume,
      mounts: [`${this.volumeName(projectId)}:/workbench`],
      command:
        `/usr/local/bin/puppetmaster-sync ack-v3 /workbench ${shellQuote(projectId)} ` +
        `${shellQuote(executionId)} ${executionGeneration} ${shellQuote(commitReceipt)} file:${SYNC_RECOVERY_FILE}`,
      lockMode: "write",
    });
    return this.parseCopybackStatus(result, projectId, executionId, executionGeneration);
  }

  async applyExecutionResult(
    projectId: string,
    executionId: string,
    executionGeneration: number,
    snapshotReceipt: string,
    signal?: AbortSignal,
  ): Promise<CommandResult & { commitReceipt?: string; committed?: boolean }> {
    const scratch = await this.assertScratchVolume(projectId, executionId, executionGeneration);
    if (signal?.aborted) return { code: 143, stdout: "", stderr: "", timedOut: false, committed: false };
    const result = await this.runTrustedSync({
      projectId,
      executionId,
      operation: "apply-v3",
      stateVolume: scratch.stateVolume,
      mounts: [
        `${this.volumeName(projectId)}:/workbench`,
        `${scratch.volume}:/turn:ro`,
      ],
      command:
        `/usr/local/bin/puppetmaster-sync apply-v3 /turn /workbench ${shellQuote(projectId)} ` +
        `${shellQuote(executionId)} ${executionGeneration} ${shellQuote(snapshotReceipt)} file:${SYNC_RECOVERY_FILE}`,
      lockMode: "write",
      timeoutMs: 300_000,
      signal,
    });
    if (result.code === 0) {
      const commitReceipt = signedReceipt(result.stdout, "PUPPETMASTER_COMMIT_V3");
      return { ...result, committed: true, commitReceipt };
    }
    try {
      const recovered = await this.recoverExecutionCopyback(projectId, executionId, executionGeneration);
      if ((recovered.state === "committed" || recovered.state === "db-acked") && recovered.commitReceipt) {
        return {
          code: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          committed: true,
          commitReceipt: recovered.commitReceipt,
        };
      }
      return signal?.aborted
        ? { ...result, code: 143, committed: false }
        : { ...result, committed: false };
    } catch (err) {
      throw new WorkbenchTerminationError(
        `could not prove copy-back commit or rollback for ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async runIsolatedStreaming(
    ctx: CommandContext & { signal?: AbortSignal },
    onChunk: (chunk: CommandChunk) => void | Promise<void>,
  ): Promise<CommandResult> {
    const profile = ctx.containerProfile ?? "plain";
    const usesProviderScratch =
      profile === "openai" || (profile === "claude" && ctx.readOnlyProject !== true);
    const executionId = ctx.executionId ?? (usesProviderScratch ? "" : randomUUID());
    const executionGeneration = ctx.executionGeneration;
    if (usesProviderScratch && !executionId) {
      throw new Error("writable provider execution requires a stable executionId");
    }
    if (
      usesProviderScratch &&
      (!Number.isSafeInteger(executionGeneration) || executionGeneration! <= 0)
    ) {
      throw new Error("writable provider execution requires a positive executionGeneration");
    }
    const name = this.executionContainerName(ctx.executionId);
    let holderTermination: Promise<void> | null = null;
    const terminateHolder = () => {
      if (!holderTermination) holderTermination = this.terminateExecutionContainer(name);
      return holderTermination;
    };
    const onOwnerAbort = () => {
      // The Docker client can close before a buffered chunk notifies the caller
      // (notably with setsid). The holder, not that client, owns cancellation.
      // Keep the rejection for the final await while preventing an unhandled
      // rejection from an event-listener turn.
      void terminateHolder().catch(() => {});
    };
    let ownerAbortAttached = false;
    const existing = await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL);
    if (existing.status === "running") {
      throw new WorkbenchTerminationError(`isolated execution ${name} is already running`);
    }
    if (existing.status === "stopped") await this.removeContainer(name);
    const scratch = usesProviderScratch
      ? await this.prepareOpenAiScratch(ctx.projectId, executionId, executionGeneration!, ctx.signal)
      : null;

    const egress = this.cfg.egressAllow.length > 0;
    const proxyEnv: string[] = [];
    let networkArg = `--network=${this.cfg.network}`;
    if (egress) {
      await this.ensureEgress(ctx.projectId);
      networkArg = `--network=${this.networkName(ctx.projectId)}`;
      const proxyUrl = `http://${this.proxyName(ctx.projectId)}:8080`;
      proxyEnv.push(
        "-e", `HTTP_PROXY=${proxyUrl}`,
        "-e", `HTTPS_PROXY=${proxyUrl}`,
        "-e", `http_proxy=${proxyUrl}`,
        "-e", `https_proxy=${proxyUrl}`,
        "-e", "NO_PROXY=localhost,127.0.0.1",
        "-e", "no_proxy=localhost,127.0.0.1",
      );
    }
    const configMount = profile === "claude"
      ? ["-v", `${this.configVolumeName(ctx.projectId)}:/home/bench/.puppetmaster`]
      : [];
    const projectMount = usesProviderScratch
      ? [`${scratch}:/workbench`]
      : [`${this.volumeName(ctx.projectId)}:/workbench${ctx.readOnlyProject ? ":ro" : ""}`];
    // Create only a secret-free idle holder. The provider command and selected
    // credentials enter later through one `docker exec`; neither is persisted
    // in the container's immutable Config.Cmd/Config.Env metadata.
    const args = [
      "create",
      "--rm",
      "--name",
      name,
      "--label",
      `${EXECUTION_PROFILE_LABEL}=${profile}`,
      "--label",
      `${EXECUTION_PROJECT_LABEL}=${ctx.projectId}`,
      "--label",
      `${EXECUTION_ID_LABEL}=${executionId}`,
      networkArg,
      `--memory=${this.cfg.memory}`,
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
      ...proxyEnv,
      "-v",
      projectMount[0]!,
      "-v",
      `${this.lockVolumeName(ctx.projectId)}:/puppetmaster-lock`,
      ...configMount,
      "-w",
      "/workbench",
      this.cfg.image,
      "sleep",
      "infinity",
    ];
    const created = await this.docker(args);
    if (created.code !== 0) {
      await terminateHolder();
      throw new Error(
        `isolated execution create failed for ${ctx.projectId}: ${created.stderr.trim() || `docker exited ${created.code}`}`,
      );
    }
    try {
      await this.assertSecretFreeProviderHolder(name);
      if (ctx.signal?.aborted) {
        return { code: 143, stdout: "", stderr: "", timedOut: false };
      }
      const started = await this.docker(["start", name]);
      if (started.code !== 0) {
        throw new Error(
          `isolated execution start failed for ${ctx.projectId}: ` +
            (started.stderr.trim() || `docker exited ${started.code}`),
        );
      }
      const running = await this.stateAndLabel(name, EXECUTION_PROFILE_LABEL);
      if (running.status !== "running" || running.label !== profile) {
        throw new WorkbenchTerminationError(`could not prove isolated provider holder ${name} started`);
      }
      ctx.signal?.addEventListener("abort", onOwnerAbort, { once: true });
      ownerAbortAttached = true;
      if (ctx.signal?.aborted) {
        return { code: 143, stdout: "", stderr: "", timedOut: false };
      }
      // Claude Code starts Bash, hooks, MCP servers, and other descendants. Its
      // managed scrub flag is forced in this same process-scoped exec plan so a
      // caller cannot override it and it never enters holder configuration.
      const exec = this.execEnvironment(ctx.secretNames, profile);
      const lockMode = usesProviderScratch || ctx.readOnlyProject || ctx.accessMode === "read"
        ? "-s"
        : "-x";
      return await this.dockerStreaming(
        [
          "exec",
          ...exec.args,
          "-w",
          "/workbench",
          name,
          "flock",
          lockMode,
          "/puppetmaster-lock/project.lock",
          "setsid",
          "sh",
          "-c",
          `umask 077; ${ctx.command}`,
        ],
        {
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
          env: exec.env,
          onChunk,
          terminate: terminateHolder,
        },
      );
    } finally {
      // A docker exec client exiting is not proof that daemonized descendants
      // stopped. Removing the holder is the termination boundary on every path.
      try {
        await terminateHolder();
      } finally {
        if (ownerAbortAttached) ctx.signal?.removeEventListener("abort", onOwnerAbort);
      }
    }
  }

  private async forceStop(name: string): Promise<void> {
    if ((await this.stateOf(name)) !== "running") return;
    const stopped = await this.docker(["stop", "-t", "2", name], { timeoutMs: 10_000 });
    if ((await this.stateOf(name)) !== "running") return;
    const killed = await this.docker(["kill", name], { timeoutMs: 10_000 });
    if ((await this.stateOf(name)) !== "running") return;
    if (killed.code !== 0) {
      throw new WorkbenchTerminationError(
        `failed to stop workbench ${name}: ${killed.stderr.trim() || stopped.stderr.trim() || `docker exited ${killed.code}`}`,
      );
    }
    throw new WorkbenchTerminationError(`could not prove container ${name} stopped after kill`);
  }

  private async terminatePidFile(name: string, pidFile: string): Promise<boolean> {
    const script =
      `if [ ! -s ${pidFile} ]; then exit 3; fi; pid=$(cat ${pidFile}); ` +
      `children=$(cat /proc/$pid/task/$pid/children 2>/dev/null || true); ` +
      `kill -TERM "$pid" 2>/dev/null || true; ` +
      `for child in $children; do kill -TERM "$child" 2>/dev/null || true; done; ` +
      `kill -TERM -- -"$pid" 2>/dev/null || true; sleep 1; ` +
      `children=$(cat /proc/$pid/task/$pid/children 2>/dev/null || true); ` +
      `kill -KILL "$pid" 2>/dev/null || true; ` +
      `for child in $children; do kill -KILL "$child" 2>/dev/null || true; done; ` +
      `kill -KILL -- -"$pid" 2>/dev/null || true; sleep 0.1; ` +
      `if [ -d /proc/$pid ]; then exit 4; fi; rm -f ${pidFile}`;
    const result = await this.docker(
      ["exec", name, "sh", "-c", script],
      { timeoutMs: 5_000 },
    );
    if (result.code === 0) {
      // PID/group checks cannot prove a daemonized descendant did not create a
      // new session. Stop the legacy project container before releasing lock.
      await this.forceStop(name);
      return true;
    }
    if (result.code === 3) return false;
    // If group-level termination cannot be proven, stop the whole isolated
    // project container. The named code/config volumes remain intact.
    await this.forceStop(name);
    return true;
  }

  /** Stream a long-running command from the same non-root project container. */
  async runStreaming(
    ctx: CommandContext & { signal?: AbortSignal },
    onChunk: (chunk: CommandChunk) => void | Promise<void>,
  ): Promise<CommandResult> {
    if (ctx.containerProfile) return this.runIsolatedStreaming(ctx, onChunk);
    const name = this.containerName(ctx.projectId);
    const token = (ctx.executionId ?? randomUUID()).replace(/[^A-Za-z0-9]/g, "");
    const pidFile = `/tmp/puppetmaster-${token}.pid`;
    const wrapped =
      `umask 077; echo $$ > ${pidFile}; ` +
      `trap 'rm -f ${pidFile}' EXIT; ${ctx.command}`;
    const exec = this.execEnvironment(ctx.secretNames);
    const terminate = async () => {
      try {
        const ready =
          `i=0; while [ ! -s ${pidFile} ] && [ "$i" -lt 20 ]; do sleep 0.05; i=$((i+1)); done; ` +
          `test -s ${pidFile}`;
        const waited = await this.docker(["exec", name, "sh", "-c", ready], { timeoutMs: 3_000 });
        if (waited.code !== 0 || !(await this.terminatePidFile(name, pidFile))) {
          await this.forceStop(name);
        }
      } catch (err) {
        if (err instanceof WorkbenchTerminationError) throw err;
        throw new WorkbenchTerminationError(
          `could not prove managed process termination in ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    return this.dockerStreaming(
      [
        "exec", ...exec.args, "-w", "/workbench", name,
        "flock", ctx.accessMode === "read" ? "-s" : "-x", "/puppetmaster-lock/project.lock",
        "setsid", "sh", "-c", wrapped,
      ],
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal, env: exec.env, onChunk, terminate },
    );
  }

  /** Terminate a managed process after a server restart, when the original
   *  AbortController and host-side docker client no longer exist. */
  async terminateManagedProcess(
    projectId: string,
    executionId: string,
    options?: ManagedProcessTerminationOptions,
  ): Promise<boolean> {
    if (await this.terminateExecutionHolders(executionId)) return true;
    const isolatedName = this.executionContainerName(executionId);
    const isolated = await this.stateAndLabel(isolatedName, EXECUTION_PROFILE_LABEL);
    if (isolated.status !== "absent" && isolated.label !== null) {
      await this.terminateExecutionContainer(isolatedName);
      return true;
    }
    if (!options?.allowLegacyProjectFallback) {
      // The exact generation label/name is absent, which proves its disposable
      // The exact generation holder is gone. Filesystem journal reconciliation
      // belongs to the durable runtime ledger; never delete its evidence here.
      return true;
    }
    const name = this.containerName(projectId);
    const token = executionId.replace(/[^A-Za-z0-9]/g, "");
    if (!token) return false;
    const pidFile = `/tmp/puppetmaster-${token}.pid`;
    const terminated = await this.terminatePidFile(name, pidFile);
    // Legacy versions ran inside the long-lived project container. A missing
    // pidfile is not proof: stop that container before releasing the lock.
    if (!terminated) await this.forceStop(name);
    return true;
  }

  /** Destroy the workbench, every provider execution, both durable volumes,
   *  all scratch volumes, and the egress boundary. Missing resources are
   *  idempotent; every other removal must be proven before this resolves. */
  async destroy(projectId: string): Promise<void> {
    await this.terminateProjectExecutionHolders(projectId);
    for (const name of [this.containerName(projectId), this.proxyName(projectId)]) {
      const state = await this.stateAndLabel(name, WORKBENCH_CONFIG_LABEL);
      if (state.status !== "absent") await this.removeContainer(name);
      if ((await this.stateAndLabel(name, WORKBENCH_CONFIG_LABEL)).status !== "absent") {
        throw new WorkbenchTerminationError(`could not prove container ${name} was removed`);
      }
    }
    const removedNetwork = await this.docker(["network", "rm", this.networkName(projectId)]);
    if (
      removedNetwork.code !== 0 &&
      !/no such network|network .+ not found/i.test(`${removedNetwork.stderr}\n${removedNetwork.stdout}`)
    ) {
      throw new Error(`could not remove egress network for ${projectId}`);
    }
    if ((await this.networkState(this.networkName(projectId))).exists) {
      throw new Error(`could not prove egress network for ${projectId} was removed`);
    }
    // Re-enumerate after the durable holders and network have converged. This
    // closes the Docker --rm/volume-detach window before scratch removal.
    await this.terminateProjectExecutionHolders(projectId);
    const scratches = await this.docker([
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=${SCRATCH_PROJECT_LABEL}=${projectId}`,
    ]);
    if (scratches.code !== 0) throw new Error(`could not enumerate scratch volumes for ${projectId}`);
    for (const volume of scratches.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean)) {
      await this.removeVolumeProven(volume);
    }
    await this.removeVolumeProven(this.volumeName(projectId));
    await this.removeVolumeProven(this.configVolumeName(projectId));
    await this.removeVolumeProven(this.lockVolumeName(projectId));
  }
}
