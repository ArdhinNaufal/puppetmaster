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
  /** Container network; "none" (default) = no egress until the proxy lands. */
  network?: string;
  dockerBin?: string;
}

export type WorkbenchStatus = "absent" | "running" | "stopped";

const DEFAULTS: Required<WorkbenchConfig> = {
  image: process.env.WORKBENCH_IMAGE ?? "puppetmaster-workbench:spike",
  memory: process.env.WORKBENCH_MEMORY ?? "512m",
  cpus: process.env.WORKBENCH_CPUS ?? "1",
  pidsLimit: Number(process.env.WORKBENCH_PIDS_LIMIT ?? "256"),
  network: process.env.WORKBENCH_NETWORK ?? "none",
  dockerBin: process.env.DOCKER_BIN ?? "docker",
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

  async status(projectId: string): Promise<WorkbenchStatus> {
    const res = await dockerCli(this.cfg.dockerBin, [
      "inspect",
      "-f",
      "{{.State.Running}}",
      this.containerName(projectId),
    ]);
    if (res.code !== 0) return "absent";
    return res.stdout.trim() === "true" ? "running" : "stopped";
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
    const run = await dockerCli(this.cfg.dockerBin, [
      "run",
      "-d",
      "--name",
      name,
      `--network=${this.cfg.network}`,
      `--memory=${this.cfg.memory}`,
      `--cpus=${this.cfg.cpus}`,
      `--pids-limit=${this.cfg.pidsLimit}`,
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

  /** Destroy the workbench: remove the container and its named volume. */
  async destroy(projectId: string): Promise<void> {
    await dockerCli(this.cfg.dockerBin, ["rm", "-f", this.containerName(projectId)]);
    await dockerCli(this.cfg.dockerBin, ["volume", "rm", "-f", this.volumeName(projectId)]);
  }
}
