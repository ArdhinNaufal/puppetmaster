import { spawn } from "node:child_process";
import type { CommandExecutor, CommandResult } from "./command-runner.js";

/**
 * Docker workbench (Workshop WP3b, ADR-002/ADR-005). The container-executing
 * peer of LocalCommandExecutor (WP3a): the same CommandExecutor interface, so
 * the shell-backed verify checks (test/arch/custom) run unchanged — only the
 * execution boundary differs. One long-lived container + named volume per
 * project; commands run via `docker exec` in /workbench.
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
  /** Vault-resolved secrets injected into the workbench env at spawn only
   *  (ADR-005 — never written to the volume). e.g. a model API key for
   *  bench.delegate. Keys must be valid env names. */
  secrets?: Record<string, string>;
}

export type WorkbenchStatus = "absent" | "running" | "stopped";

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

function dockerCli(
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
): Promise<CommandResult> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
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

export class DockerCommandExecutor implements CommandExecutor {
  private readonly cfg: Required<WorkbenchConfig>;

  constructor(cfg?: WorkbenchConfig) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  containerName(projectId: string): string {
    return `pm-workbench-${projectId}`;
  }

  volumeName(projectId: string): string {
    return `pm-workbench-vol-${projectId}`;
  }

  /** Egress-proxy sidecar container (WP3b.5). */
  proxyName(projectId: string): string {
    return `pm-egress-${projectId}`;
  }

  /** Internal (no-outbound) network the workbench + proxy share (WP3b.5). */
  networkName(projectId: string): string {
    return `pm-wb-net-${projectId}`;
  }

  private async stateOf(name: string): Promise<WorkbenchStatus> {
    const res = await dockerCli(this.cfg.dockerBin, ["inspect", "-f", "{{.State.Running}}", name]);
    if (res.code !== 0) return "absent";
    return res.stdout.trim() === "true" ? "running" : "stopped";
  }

  async status(projectId: string): Promise<WorkbenchStatus> {
    return this.stateOf(this.containerName(projectId));
  }

  /** Idempotent: create+start the container if absent, start it if stopped.
   *  Returns the container name. Applies the ADR-005 caps + isolation. */
  async ensure(projectId: string): Promise<string> {
    const name = this.containerName(projectId);
    const state = await this.status(projectId);
    if (state === "running") return name;
    if (state === "stopped") {
      const started = await dockerCli(this.cfg.dockerBin, ["start", name]);
      if (started.code !== 0) {
        throw new Error(`workbench start failed for ${projectId}: ${started.stderr.trim()}`);
      }
      return name;
    }
    // Egress OFF (default): `--network none`, no proxy — the host-verified path.
    // Egress ON: join the internal network with an allowlisting proxy sidecar,
    // routed via HTTP(S)_PROXY. Either way, vault secrets are injected as env.
    const egress = this.cfg.egressAllow.length > 0;
    let networkArg = `--network=${this.cfg.network}`;
    const proxyEnv: string[] = [];
    if (egress) {
      await this.ensureEgress(projectId);
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
    }
    const secretEnv = Object.entries(this.cfg.secrets).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    const run = await dockerCli(this.cfg.dockerBin, [
      "run",
      "-d",
      "--name",
      name,
      networkArg,
      `--memory=${this.cfg.memory}`,
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
      ...proxyEnv,
      ...secretEnv,
      "-v",
      `${this.volumeName(projectId)}:/workbench`,
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
    // `network create` fails (non-zero) if it already exists — idempotent, ignore.
    await dockerCli(this.cfg.dockerBin, ["network", "create", "--internal", net]);

    const proxy = this.proxyName(projectId);
    const state = await this.stateOf(proxy);
    if (state === "running") return;
    if (state === "stopped") {
      const started = await dockerCli(this.cfg.dockerBin, ["start", proxy]);
      if (started.code !== 0) {
        throw new Error(`egress proxy start failed for ${projectId}: ${started.stderr.trim()}`);
      }
      return;
    }
    // Primary network = the outbound one (default route + working external DNS);
    // the internal net is attached second, only so the workbench can reach the
    // proxy by name. Order matters: an --internal primary would leave the proxy
    // with no route/DNS to resolve and reach the allowlisted upstream.
    const run = await dockerCli(this.cfg.dockerBin, [
      "run",
      "-d",
      "--name",
      proxy,
      `--network=${this.cfg.egressOutboundNetwork}`,
      "-e",
      `EGRESS_ALLOW=${this.cfg.egressAllow.join(",")}`,
      this.cfg.egressProxyImage,
    ]);
    if (run.code !== 0) {
      throw new Error(`egress proxy create failed for ${projectId}: ${run.stderr.trim()}`);
    }
    // Attach the internal net so the workbench resolves + reaches the proxy.
    const connect = await dockerCli(this.cfg.dockerBin, ["network", "connect", net, proxy]);
    if (connect.code !== 0) {
      throw new Error(`egress proxy internal attach failed for ${projectId}: ${connect.stderr.trim()}`);
    }
  }

  /** Run a shell command in the project's workbench via `docker exec`. Resolves
   *  on any exit code; rejects only if docker itself can't run (fail closed). */
  async run(ctx: { projectId: string; command: string; timeoutMs?: number }): Promise<CommandResult> {
    const name = this.containerName(ctx.projectId);
    return dockerCli(
      this.cfg.dockerBin,
      ["exec", "-w", "/workbench", name, "sh", "-c", ctx.command],
      { timeoutMs: ctx.timeoutMs },
    );
  }

  /** Destroy the workbench: remove the container, the egress proxy + its
   *  network (if any), and the named volume. Each step is best-effort — a
   *  missing resource returns non-zero, which is fine (nothing to remove). */
  async destroy(projectId: string): Promise<void> {
    await dockerCli(this.cfg.dockerBin, ["rm", "-f", this.containerName(projectId)]);
    await dockerCli(this.cfg.dockerBin, ["rm", "-f", this.proxyName(projectId)]);
    await dockerCli(this.cfg.dockerBin, ["network", "rm", this.networkName(projectId)]);
    await dockerCli(this.cfg.dockerBin, ["volume", "rm", "-f", this.volumeName(projectId)]);
  }
}
