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
 *   - DockerCommandExecutor (WP3b, host-verified): ordinary checks use the
 *     project's maintenance container; provider turns use disposable profile
 *     containers over the same durable workspace boundary (ADR-005).
 */

export interface CommandResult {
  /** Process exit code; -1 if it never started cleanly. The code IS the signal. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface CommandContext {
  projectId: string;
  command: string;
  timeoutMs?: number;
  /** Run in a short-lived container instead of the long-lived project shell.
   *  Provider profiles also control which companion volumes are mounted. */
  containerProfile?: "plain" | "claude" | "openai";
  /** Stable id for cancellation/recovery of an isolated execution. */
  executionId?: string;
  /** Exact durable claim generation bound to the isolated execution. Required
   * for crash-recoverable provider copy-back. */
  executionGeneration?: number;
  /** Project lock mode. Reads/plans may share; mutations are exclusive. */
  accessMode?: "read" | "write";
  /** Mount the project workspace read-only for provider processes. Managed
   * Claude Plan turns set this; Execute scratch and trusted maintenance remain RW. */
  readOnlyProject?: boolean;
  /** Names from the executor's configured secret vault to expose only to this
   *  process. Callers cannot supply values or arbitrary environment entries. */
  secretNames?: string[];
}

export interface CommandExecutor {
  /** Run a shell command in the project's workspace. Resolves on any exit —
   *  a non-zero code is a normal result, not an error. Rejects only when the
   *  workspace itself is unreachable (a real infra failure → fail closed). */
  run(ctx: CommandContext): Promise<CommandResult>;
  /** Docker-only trusted handoff for an attempt-owned provider scratch volume. */
  applyExecutionResult?(
    projectId: string,
    executionId: string,
    executionGeneration: number,
    snapshotReceipt: string,
    signal?: AbortSignal,
  ): Promise<CommandResult & { commitReceipt?: string; committed?: boolean }>;
  /** Remove provider scratch state after Plan, failure, cancellation, or apply. */
  cleanupExecutionArtifacts?(executionId: string): Promise<void>;
}

/** Incremental peer used by long-running agent processes. Implementations
 *  preserve the same isolation boundary as CommandExecutor while exposing
 *  UTF-8 text chunks and cooperative cancellation. */
export interface StreamingCommandExecutor extends CommandExecutor {
  runStreaming(
    ctx: CommandContext & { signal?: AbortSignal },
    onChunk: (chunk: CommandChunk) => void | Promise<void>,
  ): Promise<CommandResult>;
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

  run(ctx: CommandContext): Promise<CommandResult> {
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
