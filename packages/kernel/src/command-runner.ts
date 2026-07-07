import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Command execution boundary for shell-backed verify checks (Workshop WP3).
 *
 * A CheckRunner decides *what* a check runs and how to read its result; a
 * CommandExecutor decides *where* it runs. This seam is exactly where the
 * container boundary lives:
 *   - LocalCommandExecutor (WP3a, here): runs on the host, verifiable in any
 *     environment with the toolchain — proves the shell-check logic and serves
 *     a trusted-local deployment.
 *   - DockerCommandExecutor (WP3b, host-verified): `docker exec` into the
 *     project's workbench container (ADR-005) — same interface, isolated
 *     execution. The ADR-002 spike validated the container substrate.
 */

export interface CommandResult {
  /** Process exit code; -1 if it never started cleanly. The code IS the signal. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandExecutor {
  /** Run a shell command in the project's workspace. Resolves on any exit —
   *  a non-zero code is a normal result, not an error. Rejects only when the
   *  workspace itself is unreachable (a real infra failure → fail closed). */
  run(ctx: { projectId: string; command: string; timeoutMs?: number }): Promise<CommandResult>;
}

const DEFAULT_ROOT = process.env.WORKBENCH_LOCAL_ROOT ?? join(tmpdir(), "pm-workbench");

/** The host directory backing a project's local workbench. */
export function localWorkbenchDir(projectId: string, root: string = DEFAULT_ROOT): string {
  return join(root, projectId);
}

export class LocalCommandExecutor implements CommandExecutor {
  constructor(private readonly root: string = DEFAULT_ROOT) {}

  workspaceDir(projectId: string): string {
    return localWorkbenchDir(projectId, this.root);
  }

  /** Create the workspace dir if missing (a real workbench would clone here). */
  ensureWorkspace(projectId: string): string {
    const dir = this.workspaceDir(projectId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  run(ctx: { projectId: string; command: string; timeoutMs?: number }): Promise<CommandResult> {
    const cwd = this.workspaceDir(ctx.projectId);
    const timeoutMs = ctx.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", ctx.command], { cwd });
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
        reject(err); // e.g. ENOENT: workspace never provisioned → fail closed
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }
}
