import type {
  CodingBackend,
  CodingProvider,
  ClaudeEffort,
  ClaudeRunResult,
  ClaudeRunStatus,
  ClaudeUsage,
} from "@puppetmaster/shared";
import {
  appendClaudeEvent,
  claimClaudeRun,
  commitWorkbenchCopybackAndFinishClaudeRun,
  createWorkbenchCopybackIntent,
  ensureClaudeApproval,
  finishClaudeRun,
  getClaudeRun,
  getClaudeRunByMission,
  getClaudeSession,
  getBlockingWorkbenchCopybackForProject,
  getMission,
  getProject,
  getWorkbenchCopybackByRunGeneration,
  listRunningClaudeRuns,
  listWorkbenchCopybacksForReconciliation,
  markWorkbenchCopybackCleaned,
  markWorkbenchCopybackFilesCommitted,
  markWorkbenchCopybackQuarantined,
  markWorkbenchCopybackRolledBack,
  prepareWorkbenchCopyback,
  resetClaudeRunForRetry,
  updateClaudeSession,
  type WorkbenchCopybackGuard,
  type WorkbenchCopybackRow,
  type Db,
} from "@puppetmaster/db";
import type { AuditSink } from "./audit-sink.js";
import type { EventBus } from "./bridge.js";
import {
  aiderAdapter,
  buildClaudeCommand,
  isolateAiderRepositoryCommand,
  type ClaudePermissionMode,
} from "./coding-cli.js";
import {
  ClaudeJsonLineDecoder,
  normalizeClaudeResult,
  type DecodedClaudeLine,
} from "./claude-stream.js";
import { DockerCommandExecutor, WorkbenchTerminationError, type WorkbenchStatus } from "./workbench.js";

const APPROVAL_NODE = "claude.session.start";
const CONFIG_DIR = "/home/bench/.puppetmaster/claude-config";
const MAX_AIDER_CAPTURE = 1_000_000;
const MAX_AIDER_EVENTS = 2_000;
const MAX_AIDER_EVENT_BYTES = 5 * 1024 * 1024;
const RUN_STATUSES = ["queued", "awaiting_approval", "running", "succeeded", "failed", "cancelled"] as const;
export type AnthropicTransport = "direct" | "bedrock" | "foundry" | "vertex" | "invalid";

/** Stable, generation-scoped Docker/scratch identity for one claimed attempt. */
export function claudeAttemptExecutionId(missionId: string, executionGeneration: number): string {
  if (!Number.isSafeInteger(executionGeneration) || executionGeneration <= 0) {
    throw new Error("Claimed Claude attempt generation must be a positive safe integer");
  }
  return `${missionId}-attempt-${executionGeneration}`;
}

/** Resolve a durable row to its execution identity. Generation zero can only
 *  be a pre-upgrade running row, whose container/pidfile used the mission id. */
export function persistedClaudeExecutionId(missionId: string, executionGeneration: number): string {
  return executionGeneration === 0
    ? missionId
    : claudeAttemptExecutionId(missionId, executionGeneration);
}

/** Select only the credentials and routing controls for the transport that
 * readiness resolved. Unrelated direct/cloud credentials must not coexist in
 * Claude's process environment because Claude Code's own precedence rules can
 * otherwise disagree with the UI readiness decision. */
export function anthropicSecretNamesForTransport(transport: AnthropicTransport): string[] {
  switch (transport) {
    case "direct":
      return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
    case "bedrock":
      return [
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
      ];
    case "foundry":
      return [
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "ANTHROPIC_FOUNDRY_BASE_URL",
      ];
    case "vertex":
      return [
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CLOUD_ML_REGION",
      ];
    case "invalid":
      return [];
  }
}
const OPENAI_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
] as const;

interface RunConfig {
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
}

function finiteInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function permissionMode(value: string): ClaudePermissionMode {
  return value === "plan" || value === "dontAsk" || value === "acceptEdits"
    ? value
    : "plan";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function safePayload(payload: unknown): unknown {
  try {
    const encoded = JSON.stringify(payload);
    return encoded.length <= 64_000
      ? payload
      : { truncated: true, bytes: Buffer.byteLength(encoded, "utf8") };
  } catch {
    return { unserializable: true };
  }
}

function providerOf(value: unknown): CodingProvider | null {
  return value === "openai" || value === "anthropic" ? value : null;
}

function backendOf(value: unknown): CodingBackend | null {
  return value === "aider" || value === "claude" ? value : null;
}

function appendBounded(current: string, chunk: string, max = MAX_AIDER_CAPTURE): string {
  const next = current + chunk;
  return next.length <= max ? next : next.slice(next.length - max);
}

function cleanTerminalText(value: string): string {
  // Aider's human stream can contain ANSI terminal controls. Persist raw chunks
  // for diagnostics, but keep the durable transcript readable and bounded.
  return value
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .trim()
    .slice(-100_000);
}

function normalizeAiderUsage(value: unknown): ClaudeUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const inputTokens = Number(row.inputTokens);
  const outputTokens = Number(row.outputTokens);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return {
    inputTokens: Number.isFinite(inputTokens) ? Math.max(0, Math.trunc(inputTokens)) : 0,
    outputTokens: Number.isFinite(outputTokens) ? Math.max(0, Math.trunc(outputTokens)) : 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function terminalStatus(
  result: ClaudeRunResult | null,
  exec: { code: number; timedOut: boolean },
  aborted: boolean,
): { status: Exclude<ClaudeRunStatus, "queued" | "awaiting_approval" | "running">; error: string | null } {
  if (aborted) return { status: "cancelled", error: "cancelled by operator" };
  if (exec.timedOut) return { status: "failed", error: "Claude Code exceeded its wall-clock budget" };
  if (!result) return { status: "failed", error: `Claude Code exited ${exec.code} without a result event` };
  if (result.isError) {
    return { status: "failed", error: result.subtype ?? result.result ?? "Claude Code reported an error" };
  }
  if (exec.code !== 0) {
    return {
      status: "failed",
      error: `Claude Code exited ${exec.code} despite reporting a non-error result`,
    };
  }
  return { status: "succeeded", error: null };
}

/** Durable Claude Code mission runner. It intentionally uses only the Docker
 *  executor: project code never runs as a host subprocess. */
export class ClaudeCodeRuntime {
  private readonly activeByMission = new Map<string, AbortController>();
  private readonly activeBySession = new Set<string>();
  private readonly activePromises = new Map<string, Promise<ClaudeRunStatus>>();
  private shuttingDown = false;
  private shutdownFailure: Error | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      bus: EventBus;
      executor?: DockerCommandExecutor;
      audit?: AuditSink;
      /** Transport selected by server readiness. Defaults to direct only for
       * backwards-compatible embedded/test construction. */
      anthropicTransport?: AnthropicTransport;
    },
  ) {}

  enabled(): boolean {
    return Boolean(this.deps.executor);
  }

  async workbenchStatus(projectId: string): Promise<WorkbenchStatus> {
    if (!this.deps.executor) return "absent";
    return this.deps.executor.status(projectId);
  }

  async inspectWorkbench(projectId: string): Promise<{
    status: WorkbenchStatus;
    gitStatus: string;
    diffStat: string;
    diff: string;
    error: string | null;
  }> {
    if (!this.deps.executor) {
      return { status: "absent", gitStatus: "", diffStat: "", diff: "", error: "WORKBENCH_MODE=docker is not enabled" };
    }
    const status = await this.deps.executor.status(projectId);
    if (status !== "running") return { status, gitStatus: "", diffStat: "", diff: "", error: null };
    const trackedStat =
      "git diff --no-ext-diff --stat HEAD -- 2>/dev/null || " +
      "{ git diff --no-ext-diff --stat --; git diff --no-ext-diff --cached --stat --; }; " +
      "git ls-files --others --exclude-standard | while IFS= read -r f; do " +
      "git diff --no-index --stat -- /dev/null \"$f\" || true; done";
    const completeDiff =
      "git diff --no-ext-diff --binary HEAD -- 2>/dev/null || " +
      "{ git diff --no-ext-diff --binary --; git diff --no-ext-diff --cached --binary --; }; " +
      "git ls-files --others --exclude-standard | while IFS= read -r f; do " +
      "git diff --no-index --binary -- /dev/null \"$f\" || true; done";
    const [git, stat, diff] = await Promise.all([
      this.deps.executor.run({ projectId, command: "git status --porcelain=v1 --branch", timeoutMs: 15_000, accessMode: "read" }),
      this.deps.executor.run({ projectId, command: trackedStat, timeoutMs: 15_000, accessMode: "read" }),
      this.deps.executor.run({ projectId, command: completeDiff, timeoutMs: 30_000, accessMode: "read" }),
    ]);
    const failed = [git, stat, diff].find((row) => row.code !== 0);
    return {
      status,
      gitStatus: git.stdout.slice(0, 100_000),
      diffStat: stat.stdout.slice(0, 100_000),
      diff: diff.stdout.slice(0, 500_000),
      error: failed ? (failed.stderr.trim() || `git inspection exited ${failed.code}`) : null,
    };
  }

  /** Reconcile every durable copy-back and every orphaned running claim before
   * queue workers accept missions. A signed filesystem commit wins over
   * cancellation/process loss. A running attempt with no ledger cannot have
   * crossed the apply boundary, so exact process termination plus scratch
   * cleanup proves it safe to terminalize rather than wedge on redelivery. */
  async reconcilePendingCopybacks(): Promise<{ reconciled: number; orphaned: number }> {
    const copybackInventory = await listWorkbenchCopybacksForReconciliation(this.deps.db, { limit: 1_001 });
    const rows = copybackInventory.slice(0, 1_000);
    let reconciled = 0;
    let orphaned = 0;
    const failures: Error[] = [];
    if (copybackInventory.length > rows.length) {
      failures.push(new WorkbenchTerminationError("more than 1000 workbench copy-backs require reconciliation"));
    }
    for (const row of rows) {
      try {
        await this.reconcileCopybackRow(row, "failed", "server restarted before copy-back completed");
        reconciled += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Re-query after ledger reconciliation: committed rows are now terminal,
    // while pre-intent Plan/provider crashes are still visibly running.
    const runningInventory = await listRunningClaudeRuns(this.deps.db, 1_001);
    const running = runningInventory.slice(0, 1_000);
    if (runningInventory.length > running.length) {
      failures.push(new WorkbenchTerminationError("more than 1000 running Claude claims require reconciliation"));
    }
    for (const run of running) {
      const copyback = run.executionGeneration > 0
        ? await getWorkbenchCopybackByRunGeneration(this.deps.db, run.id, run.executionGeneration)
        : null;
      if (copyback) {
        failures.push(
          new WorkbenchTerminationError(
            `running Claude run ${run.id} remains blocked by copy-back ${copyback.id} (${copyback.state})`,
          ),
        );
        continue;
      }
      try {
        await this.reconcileOrphanedRunningRun(run);
        orphaned += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (failures.length > 0) {
      throw new WorkbenchTerminationError(
        `startup Claude recovery incomplete: ${failures.map((failure) => failure.message).join("; ")}`,
      );
    }
    return { reconciled, orphaned };
  }

  private async reconcileOrphanedRunningRun(
    run: NonNullable<Awaited<ReturnType<typeof getClaudeRun>>>,
  ): Promise<void> {
    const executor = this.deps.executor;
    if (!executor) {
      throw new WorkbenchTerminationError(
        `running Claude run ${run.id} requires WORKBENCH_MODE=docker for termination proof`,
      );
    }
    const session = await getClaudeSession(this.deps.db, run.sessionId);
    if (!session) throw new WorkbenchTerminationError(`running Claude run ${run.id} has no session`);
    const mission = await getMission(this.deps.db, run.missionId);
    if (!mission) throw new WorkbenchTerminationError(`running Claude run ${run.id} has no mission`);
    const executionId = persistedClaudeExecutionId(run.missionId, run.executionGeneration);
    const terminated = await executor.terminateManagedProcess(
      session.projectId,
      executionId,
      { allowLegacyProjectFallback: run.executionGeneration === 0 },
    );
    if (!terminated) {
      throw new WorkbenchTerminationError(`could not prove orphaned execution ${executionId} terminated`);
    }
    await executor.cleanupExecutionArtifacts(executionId);
    const status = mission.cancelRequested ? "cancelled" : "failed";
    const transitioned = await this.finish(
      run,
      session,
      status,
      null,
      mission.cancelRequested
        ? "cancelled during server restart recovery"
        : "server restarted before the active provider attempt reached a durable terminal state",
      ["running"],
      run.executionGeneration,
    );
    if (!transitioned) {
      const latest = await getClaudeRun(this.deps.db, run.id);
      if (!latest || !["succeeded", "failed", "cancelled"].includes(latest.status)) {
        throw new WorkbenchTerminationError(
          `orphaned execution ${executionId} terminated but its durable run did not terminalize`,
        );
      }
    }
  }

  private async reconcileCopybackRow(
    row: WorkbenchCopybackRow,
    rollbackStatus: "failed" | "cancelled",
    rollbackReason: string,
  ): Promise<"committed" | "rolled-back" | "cleaned"> {
    const executor = this.deps.executor;
    if (!executor) throw new Error("copy-back reconciliation requires the Docker executor");
    const run = await getClaudeRun(this.deps.db, row.claudeRunId);
    if (!run) throw new Error(`copy-back ${row.id} references a missing Claude run`);
    const session = await getClaudeSession(this.deps.db, run.sessionId);
    if (!session) throw new Error(`copy-back ${row.id} references a missing Claude session`);
    const guard = (expectedRunStatus: ClaudeRunStatus): WorkbenchCopybackGuard => ({
      id: row.id,
      projectId: row.projectId,
      claudeRunId: row.claudeRunId,
      executionId: row.executionId,
      executionIdentitySha256: row.executionIdentitySha256,
      executionGeneration: row.executionGeneration,
      expectedRunStatus,
    });
    const receipt = typeof row.receipt === "string" ? row.receipt : null;

    if (row.state === "db_committed") {
      if (!receipt || !["succeeded", "failed", "cancelled"].includes(run.status)) {
        throw new WorkbenchTerminationError(`copy-back ${row.id} has inconsistent db_committed state`);
      }
      const acked = await executor.acknowledgeExecutionCopyback(
        row.projectId,
        row.executionId,
        row.executionGeneration,
        receipt,
      );
      if (acked.state !== "acked") {
        throw new WorkbenchTerminationError(`copy-back ${row.id} acknowledgment returned ${acked.state}`);
      }
      await markWorkbenchCopybackCleaned(this.deps.db, guard(run.status as ClaudeRunStatus));
      await executor.cleanupExecutionArtifacts(row.executionId);
      return "cleaned";
    }

    if (row.state === "rolled_back") {
      let terminalStatus = run.status as ClaudeRunStatus;
      if (run.status === "running") {
        await this.finish(
          run,
          session,
          rollbackStatus,
          null,
          row.error || rollbackReason,
          ["running"],
          row.executionGeneration,
        );
        terminalStatus = rollbackStatus;
      }
      if (!["succeeded", "failed", "cancelled"].includes(terminalStatus)) {
        throw new WorkbenchTerminationError(`copy-back ${row.id} rollback has a non-terminal run`);
      }
      await markWorkbenchCopybackCleaned(this.deps.db, guard(terminalStatus));
      await executor.cleanupExecutionArtifacts(row.executionId);
      return "cleaned";
    }

    if (row.state !== "intent" && row.state !== "files_committed") {
      throw new WorkbenchTerminationError(`copy-back ${row.id} cannot reconcile state ${row.state}`);
    }
    if (run.status !== "running" || run.executionGeneration !== row.executionGeneration) {
      throw new WorkbenchTerminationError(`copy-back ${row.id} no longer owns its running Claude claim`);
    }
    try {
      const filesystem = await executor.recoverExecutionCopyback(
        row.projectId,
        row.executionId,
        row.executionGeneration,
      );
      if ((filesystem.state === "committed" || filesystem.state === "db-acked") && filesystem.commitReceipt) {
        if (row.state === "intent") {
          await markWorkbenchCopybackFilesCommitted(this.deps.db, guard("running"), filesystem.commitReceipt);
        } else if (!receipt || receipt !== filesystem.commitReceipt) {
          throw new WorkbenchTerminationError(`copy-back ${row.id} commit receipt does not match its ledger`);
        }
        await commitWorkbenchCopybackAndFinishClaudeRun(
          this.deps.db,
          guard("running") as WorkbenchCopybackGuard & { expectedRunStatus: "running" },
          filesystem.commitReceipt,
        );
        const pending = row.pendingCompletion as {
          status?: "succeeded" | "failed" | "cancelled";
          result?: ClaudeRunResult | null;
          finishedAt?: string;
        } | null;
        const terminal = pending?.status ?? "succeeded";
        const finishedAt = pending?.finishedAt ? new Date(pending.finishedAt) : new Date();
        await this.publishFinished(run, session, terminal, pending?.result ?? null, finishedAt);
        const acked = await executor.acknowledgeExecutionCopyback(
          row.projectId,
          row.executionId,
          row.executionGeneration,
          filesystem.commitReceipt,
        );
        if (acked.state !== "acked") {
          throw new WorkbenchTerminationError(`copy-back ${row.id} acknowledgment returned ${acked.state}`);
        }
        await markWorkbenchCopybackCleaned(this.deps.db, guard(terminal));
        await executor.cleanupExecutionArtifacts(row.executionId);
        return "committed";
      }
      if (row.state === "files_committed") {
        throw new WorkbenchTerminationError(
          `copy-back ${row.id} ledger says files committed but filesystem reports ${filesystem.state}`,
        );
      }
      if (!["absent", "discarded", "rolled-back"].includes(filesystem.state)) {
        throw new WorkbenchTerminationError(`copy-back ${row.id} recovery stopped in ${filesystem.state}`);
      }
      await markWorkbenchCopybackRolledBack(this.deps.db, guard("running"), rollbackReason);
      await this.finish(
        run,
        session,
        rollbackStatus,
        null,
        rollbackReason,
        ["running"],
        row.executionGeneration,
      );
      await markWorkbenchCopybackCleaned(this.deps.db, guard(rollbackStatus));
      await executor.cleanupExecutionArtifacts(row.executionId);
      return "rolled-back";
    } catch (error) {
      if (row.state === "intent") {
        await markWorkbenchCopybackQuarantined(
          this.deps.db,
          guard("running"),
          error instanceof Error ? error.message : String(error),
        ).catch(() => {});
      }
      throw error instanceof WorkbenchTerminationError
        ? error
        : new WorkbenchTerminationError(
            `copy-back ${row.id} could not be reconciled: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
  }

  private async prepareWorkbench(
    project: { id: string; name: string; repoRef: string },
    executionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const executor = this.deps.executor;
    if (!executor) throw new Error("Claude Code requires WORKBENCH_MODE=docker");
    await executor.ensure(project.id);
    const managed = async (command: string, timeoutMs: number) => {
      if (signal.aborted) throw new Error("cancelled before workbench preparation");
      const result = await executor.runStreaming(
        {
          projectId: project.id,
          command,
          timeoutMs,
          signal,
          executionId,
          containerProfile: "plain",
        },
        () => {},
      );
      if (signal.aborted) throw new Error("cancelled during workbench preparation");
      return result;
    };
    const repository = await managed("git rev-parse --is-inside-work-tree", 15_000);
    if (repository.code === 0 && repository.stdout.trim() === "true") return;

    const empty = await managed("test -z \"$(find . -mindepth 1 -maxdepth 1 -print -quit)\"", 15_000);
    if (empty.code !== 0) {
      throw new Error(
        `workbench for project "${project.name}" is non-empty but is not a Git repository; ` +
          "inspect or recreate it before starting Claude Code",
      );
    }
    if (!project.repoRef.trim()) {
      throw new Error(
        `project "${project.name}" has an empty workbench and no repoRef; configure a repository before starting Claude Code`,
      );
    }
    const cloned = await managed(`git clone -- ${shellQuote(project.repoRef.trim())} .`, 300_000);
    if (cloned.code !== 0) {
      throw new Error(
        `failed to clone project "${project.name}" into its isolated workbench: ` +
          (cloned.stderr.trim().slice(0, 1_000) || `git exited ${cloned.code}`),
      );
    }
  }

  async cancel(missionId: string): Promise<boolean> {
    const controller = this.activeByMission.get(missionId);
    if (controller) {
      controller.abort();
      return true;
    }
    if (!this.deps.executor) return false;
    const run = await getClaudeRunByMission(this.deps.db, missionId);
    if (!run || run.status !== "running") return false;
    const session = await getClaudeSession(this.deps.db, run.sessionId);
    if (!session) return false;
    const executionId = persistedClaudeExecutionId(missionId, run.executionGeneration);
    const terminated = await this.deps.executor.terminateManagedProcess(
      session.projectId,
      executionId,
      { allowLegacyProjectFallback: run.executionGeneration === 0 },
    );
    if (terminated) {
      if (run.executionGeneration > 0) {
        const copyback = await getWorkbenchCopybackByRunGeneration(
          this.deps.db,
          run.id,
          run.executionGeneration,
        );
        if (copyback) {
          await this.reconcileCopybackRow(copyback, "cancelled", "cancelled by operator during copy-back");
          return true;
        }
        // No ledger means apply-v3 was never authorized, so no durable files
        // can have crossed the trust boundary. Scratch cleanup is safe.
        await this.deps.executor.cleanupExecutionArtifacts(executionId);
      }
      await this.finish(
        run,
        session,
        "cancelled",
        null,
        "cancelled by operator after runtime recovery",
        ["running"],
        run.executionGeneration,
      );
    }
    return terminated;
  }

  async markCancelled(missionId: string): Promise<boolean> {
    const run = await getClaudeRunByMission(this.deps.db, missionId);
    if (!run || (run.status !== "queued" && run.status !== "awaiting_approval")) return false;
    const session = await getClaudeSession(this.deps.db, run.sessionId);
    if (!session) return false;
    return this.finish(
      run,
      session,
      "cancelled",
      null,
      "cancelled by operator",
      [run.status],
    );
  }

  async resetForRetry(missionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return resetClaudeRunForRetry(this.deps.db, missionId);
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const controller of this.activeByMission.values()) controller.abort();
  }

  async drain(): Promise<void> {
    while (this.activePromises.size > 0) {
      await Promise.allSettled([...this.activePromises.values()]);
    }
    if (this.shutdownFailure) throw this.shutdownFailure;
  }

  async runMission(missionId: string): Promise<ClaudeRunStatus> {
    if (this.shuttingDown) throw new Error("Claude runtime is shutting down");
    if (this.activePromises.has(missionId)) return "running";
    const task = this.executeMission(missionId);
    this.activePromises.set(missionId, task);
    try {
      return await task;
    } finally {
      if (this.activePromises.get(missionId) === task) this.activePromises.delete(missionId);
    }
  }

  private async executeMission(missionId: string): Promise<ClaudeRunStatus> {
    const { db, bus } = this.deps;
    const mission = await getMission(db, missionId);
    const run = await getClaudeRunByMission(db, missionId);
    if (!mission || !run) throw new Error(`Claude mission ${missionId} has no durable run`);
    const session = await getClaudeSession(db, run.sessionId);
    if (!session) throw new Error(`Claude session ${run.sessionId} not found`);
    const observedStatus = run.status as ClaudeRunStatus;
    if (["succeeded", "failed", "cancelled"].includes(run.status)) {
      await this.finish(
        run,
        session,
        run.status as "succeeded" | "failed" | "cancelled",
        (run.result as ClaudeRunResult | null) ?? null,
        run.error,
        // Reconcile only if this exact terminal snapshot is still current. A
        // duplicate delivery may have read it immediately before an operator
        // reset the run for retry; it must not finish the new attempt.
        [run.status as "succeeded" | "failed" | "cancelled"],
      );
      const latest = await getClaudeRun(db, run.id);
      return latest && RUN_STATUSES.includes(latest.status as (typeof RUN_STATUSES)[number])
        ? latest.status as ClaudeRunStatus
        : observedStatus;
    }
    // A duplicate queue delivery never owns an already-running generation.
    if (run.status === "running") return "running";
    const provider = providerOf(run.provider);
    const backend = backendOf(run.backend);
    const sessionProvider = providerOf(session.provider);
    const sessionBackend = backendOf(session.backend);
    const executionMode = run.mode === "plan" || run.mode === "execute" ? run.mode : null;
    const validSnapshot =
      provider !== null &&
      backend !== null &&
      sessionProvider === provider &&
      sessionBackend === backend &&
      ((provider === "anthropic" && backend === "claude") ||
        (provider === "openai" && backend === "aider")) &&
      executionMode !== null &&
      run.model.trim().length > 0 &&
      (provider !== "openai" || /^openai\/.+/.test(run.model));
    if (!validSnapshot || provider === null || backend === null) {
      await this.finish(
        run,
        session,
        "failed",
        null,
        `invalid coding provider/backend snapshot: ${String(run.provider)}/${String(run.backend)} model=${run.model}`,
        [observedStatus],
      );
      return "failed";
    }
    const runtimeLabel = provider === "openai" ? "OpenAI/Aider" : "Claude Code";
    const actorLabel = provider === "openai" ? "openai-aider" : "claude-code";
    if (mission.cancelRequested) {
      await this.finish(run, session, "cancelled", null, "cancelled by operator", [observedStatus]);
      return "cancelled";
    }

    const project = await getProject(db, session.projectId);
    if (!project || project.workspaceId !== session.workspaceId || mission.workspaceId !== session.workspaceId) {
      await this.finish(
        run,
        session,
        "failed",
        null,
        "project is outside the Claude session workspace",
        [observedStatus],
      );
      return "failed";
    }
    if (run.mode === "execute") {
      const blocked = await getBlockingWorkbenchCopybackForProject(db, project.id);
      if (blocked) {
        await this.finish(
          run,
          session,
          "failed",
          null,
          `project mutation is blocked by unresolved copy-back ${blocked.id} (${blocked.state})`,
          [observedStatus],
        );
        return "failed";
      }
    }

    let preclaimStatus = observedStatus;

    // Planning is read-only. Execute mode receives a single explicit outer
    // approval until a future Agent-SDK permission callback can gate each tool.
    if (run.mode === "execute") {
      const gate = await ensureClaudeApproval(db, {
        runId: run.id,
        missionId,
        nodeId: APPROVAL_NODE,
        prompt:
      `Authorize ${runtimeLabel} execution in project "${project.name}" with model ${run.model}. ` +
          "This allows edits inside the isolated workbench; review the resulting diff before any push or deploy.",
        tier: "write_approved",
      });
      if (!gate.eligible) {
        if (gate.cancelRequested) {
          await this.finish(
            run,
            session,
            "cancelled",
            null,
            "cancelled by operator before authorization",
            [gate.runStatus as ClaudeRunStatus],
          );
        }
        const latest = await getClaudeRun(db, run.id);
        return latest && ["queued", "awaiting_approval", "running", "succeeded", "failed", "cancelled"].includes(latest.status)
          ? latest.status as ClaudeRunStatus
          : "running";
      }
      preclaimStatus = gate.runStatus as ClaudeRunStatus;
      if (gate.approval.status === "pending") {
        if (gate.created) {
        await bus.publish({
          type: "approval.requested",
          missionId,
          nodeId: APPROVAL_NODE,
            approvalId: gate.approval.id,
            prompt: gate.approval.prompt,
          at: new Date().toISOString(),
        });
        }
        return "awaiting_approval";
      }
      if (gate.approval.status === "rejected") {
        await this.finish(
          run,
          session,
          "cancelled",
          null,
          "execution authorization denied",
          [preclaimStatus],
        );
        return "cancelled";
      }
    }

    if (!this.deps.executor) {
      await this.finish(
        run,
        session,
        "failed",
        null,
        `${runtimeLabel} requires WORKBENCH_MODE=docker`,
        [preclaimStatus],
      );
      return "failed";
    }
    if (this.activeByMission.has(missionId) || this.activeBySession.has(session.id)) return "running";

    const controller = new AbortController();
    const startedAt = new Date();
    this.activeByMission.set(missionId, controller);
    this.activeBySession.add(session.id);
    let terminal: ClaudeRunResult | null = null;
    let claimedGeneration: number | null = null;
    let executionId: string | null = null;
    try {
      claimedGeneration = await claimClaudeRun(db, { runId: run.id, missionId, startedAt });
      if (claimedGeneration === null) {
        const latest = await getClaudeRun(db, run.id);
        return latest && ["succeeded", "failed", "cancelled"].includes(latest.status)
          ? (latest.status as ClaudeRunStatus)
          : "running";
      }
      executionId = claudeAttemptExecutionId(missionId, claimedGeneration);
      const claimedMission = await getMission(db, missionId);
      if (controller.signal.aborted || claimedMission?.cancelRequested) {
        await this.finish(
          run,
          session,
          "cancelled",
          null,
          "cancelled by operator before process start",
          ["running"],
          claimedGeneration,
        );
        return "cancelled";
      }
      await bus.publish({ type: "mission.started", missionId, at: startedAt.toISOString() });
      await this.prepareWorkbench(project, executionId, controller.signal);
      await bus.publish({
      type: "claude.run.started",
      sessionId: session.id,
      runId: run.id,
      missionId,
      provider,
      backend,
      model: run.model,
      mode: run.mode as "plan" | "execute",
      at: startedAt.toISOString(),
    });
      await this.deps.audit?.({
      workspaceId: session.workspaceId,
      actorKind: "system",
      actorLabel,
      missionId,
      action: provider === "openai" ? "openai.run.started" : "claude.run.started",
      target: session.id,
      detail: { runId: run.id, projectId: project.id, provider, backend, model: run.model, mode: run.mode },
    });

      const cfg = (run.config ?? {}) as RunConfig;
      const maxTurns = finiteInt(cfg.maxTurns, run.mode === "plan" ? 12 : 24, 1, 100);
      const timeoutMs = finiteInt(cfg.timeoutMs, 900_000, 10_000, 3_600_000);
      if (backend === "aider") {
        const outcome = await this.runAiderTurn({
          run,
          session,
          projectId: project.id,
          missionId,
          controller,
          startedAt,
          timeoutMs,
          provider,
          backend,
          executionId,
          executionGeneration: claimedGeneration,
        });
        if (!outcome.terminalCommitted) {
          await this.finish(
            run,
            session,
            outcome.status,
            outcome.result,
            outcome.error,
            ["running"],
            claimedGeneration,
          );
        }
        return outcome.status;
      }
      const externalSessionId = session.claudeSessionId ?? session.id;
      const command = buildClaudeCommand(run.prompt, {
      maxTurns,
      model: run.model,
      permissionMode: run.mode === "plan" ? "plan" : permissionMode(run.permissionMode),
      ...(run.effort ? { effort: run.effort as ClaudeEffort } : {}),
      ...(typeof cfg.maxBudgetUsd === "number" ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
      sessionId: externalSessionId,
      resume: run.turnNumber > 1 || Boolean(session.claudeSessionId),
      sessionName: session.title,
      configDir: CONFIG_DIR,
      includePartialMessages: true,
      includeHookEvents: true,
      allowedTools: Array.isArray(cfg.allowedTools) ? cfg.allowedTools : [],
      disallowedTools: Array.isArray(cfg.disallowedTools) ? cfg.disallowedTools : [],
      additionalDirectories: Array.isArray(cfg.additionalDirectories) ? cfg.additionalDirectories : [],
      });

      const decoder = new ClaudeJsonLineDecoder();
      const persist = async (line: DecodedClaudeLine) => {
      const normalized = normalizeClaudeResult(line.event);
      terminal = normalized
        ? {
            ...normalized,
            structuredOutput: safePayload(normalized.structuredOutput),
            raw: safePayload(normalized.raw),
          }
        : terminal;
      const eventSessionId =
        line.event && typeof line.event.session_id === "string" ? line.event.session_id : null;
      if (eventSessionId && eventSessionId !== session.claudeSessionId) {
        await updateClaudeSession(db, session.id, { claudeSessionId: eventSessionId });
        session.claudeSessionId = eventSessionId;
      }
      const stored = await appendClaudeEvent(db, {
        sessionId: session.id,
        runId: run.id,
        stream: "stdout",
        eventType: line.eventType,
        raw: line.raw.slice(0, 200_000),
        payload: line.event ? safePayload(line.event) : null,
      });
      await bus.publish({
        type: "claude.event",
        sessionId: session.id,
        runId: run.id,
        missionId,
        provider,
        backend,
        seq: stored.sequence,
        stream: "stdout",
        eventType: line.eventType,
        ...(line.text === undefined ? {} : { text: line.text.slice(0, 32_000) }),
        ...(line.event ? { payload: safePayload(line.event) } : {}),
        at: stored.createdAt.toISOString(),
      });
      };

      const exec = await this.deps.executor.runStreaming(
        {
          projectId: project.id,
          command,
          timeoutMs,
          signal: controller.signal,
          executionId,
          executionGeneration: claimedGeneration,
          containerProfile: "claude",
          readOnlyProject: run.mode === "plan",
          secretNames: anthropicSecretNamesForTransport(this.deps.anthropicTransport ?? "direct"),
        },
        async (chunk) => {
          if (chunk.stream === "stdout") {
            for (const line of decoder.push(chunk.text)) await persist(line);
            return;
          }
          const raw = chunk.text.slice(0, 200_000);
          const stored = await appendClaudeEvent(db, {
            sessionId: session.id,
            runId: run.id,
            stream: "stderr",
            eventType: "stderr",
            raw,
            payload: null,
          });
          await bus.publish({
            type: "claude.event",
            sessionId: session.id,
            runId: run.id,
            missionId,
            provider,
            backend,
            seq: stored.sequence,
            stream: "stderr",
            eventType: "stderr",
            text: raw.slice(0, 32_000),
            at: stored.createdAt.toISOString(),
          });
        },
      );
      for (const line of decoder.finish()) await persist(line);
      const outcome = terminalStatus(terminal, exec, controller.signal.aborted);
      if (run.mode === "execute" && outcome.status === "succeeded" && terminal) {
        const committed = await this.commitSuccessfulProviderCopyback({
          run,
          session,
          projectId: project.id,
          executionId,
          executionGeneration: claimedGeneration,
          controller,
          result: terminal,
        });
        if (!committed.terminalCommitted) {
          await this.finish(
            run,
            session,
            committed.status,
            committed.result,
            committed.error,
            ["running"],
            claimedGeneration,
          );
        }
        return committed.status;
      }
      if (run.mode === "execute") {
        await this.deps.executor.cleanupExecutionArtifacts(executionId);
      }
      await this.finish(
        run,
        session,
        outcome.status,
        terminal,
        outcome.error,
        ["running"],
        claimedGeneration,
      );
      return outcome.status;
    } catch (err) {
      if (err instanceof WorkbenchTerminationError) {
        if (this.shuttingDown) this.shutdownFailure = err;
        await this.deps.audit?.({
          workspaceId: session.workspaceId,
          actorKind: "system",
          actorLabel,
          missionId,
          action: provider === "openai" ? "openai.termination.failed" : "claude.termination.failed",
          target: session.id,
          detail: { runId: run.id, provider, backend, error: err.message },
        });
        // Fail closed: keep the durable run active so no later turn can enter
        // the same project while termination is unproven.
        return "running";
      }
      if (backend === "claude" && run.mode === "execute" && executionId) {
        await this.deps.executor.cleanupExecutionArtifacts(executionId).catch(() => {});
      }
      const aborted = controller.signal.aborted;
      const status = aborted ? "cancelled" : "failed";
      const message = aborted
        ? "cancelled by operator"
        : err instanceof Error
          ? err.message
          : String(err);
      await this.finish(
        run,
        session,
        status,
        terminal,
        message,
        claimedGeneration === null ? [preclaimStatus] : ["running"],
        claimedGeneration === null ? undefined : claimedGeneration,
      );
      return status;
    } finally {
      this.activeByMission.delete(missionId);
      this.activeBySession.delete(session.id);
    }
  }

  private async runAiderTurn(input: {
    run: NonNullable<Awaited<ReturnType<typeof getClaudeRunByMission>>>;
    session: NonNullable<Awaited<ReturnType<typeof getClaudeSession>>>;
    projectId: string;
    missionId: string;
    controller: AbortController;
    startedAt: Date;
    timeoutMs: number;
    provider: CodingProvider;
    backend: CodingBackend;
    executionId: string;
    executionGeneration: number;
  }): Promise<{
    status: "succeeded" | "failed" | "cancelled";
    result: ClaudeRunResult;
    error: string | null;
    terminalCommitted: boolean;
  }> {
    const {
      run, session, projectId, missionId, controller, startedAt, provider, backend,
      executionId, executionGeneration,
    } = input;
    const executor = this.deps.executor!;
    const aiderCommand = aiderAdapter.buildCommand(run.prompt, {
      maxTurns: 1,
      model: run.model,
      permissionMode: run.mode === "plan" ? "plan" : permissionMode(run.permissionMode),
      ...(run.effort ? { effort: run.effort as ClaudeEffort } : {}),
    });
    // Aider maintains repo-map caches even in ask mode. Run plans against a
    // disposable copy as a second, filesystem-level guard so neither model
    // output nor Aider's own metadata can modify the durable workbench.
    const command = isolateAiderRepositoryCommand(
      aiderCommand,
      executionId,
      run.mode === "execute" ? "execute" : "plan",
    );
    let stdout = "";
    let stderr = "";
    let persistedEvents = 0;
    let persistedBytes = 0;
    let truncationPublished = false;
    const persistChunk = async (stream: "stdout" | "stderr", text: string) => {
      if (!text) return;
      if (stream === "stdout") stdout = appendBounded(stdout, text);
      else stderr = appendBounded(stderr, text);
      const raw = text.slice(0, 200_000);
      const rawBytes = Buffer.byteLength(raw, "utf8");
      if (persistedEvents >= MAX_AIDER_EVENTS || persistedBytes + rawBytes > MAX_AIDER_EVENT_BYTES) {
        if (!truncationPublished) {
          truncationPublished = true;
          const stored = await appendClaudeEvent(this.deps.db, {
            sessionId: session.id,
            runId: run.id,
            stream: "system",
            eventType: "aider.output.truncated",
            raw: "",
            payload: {
              provider,
              backend,
              maxEvents: MAX_AIDER_EVENTS,
              maxBytes: MAX_AIDER_EVENT_BYTES,
            },
          });
          await this.deps.bus.publish({
            type: "claude.event",
            sessionId: session.id,
            runId: run.id,
            missionId,
            provider,
            backend,
            seq: stored.sequence,
            stream: "system",
            eventType: "aider.output.truncated",
            payload: stored.payload,
            at: stored.createdAt.toISOString(),
          });
        }
        return;
      }
      persistedEvents += 1;
      persistedBytes += rawBytes;
      const eventType = stream === "stdout" ? "aider.output" : "stderr";
      const payload = stream === "stdout" ? { provider, backend, text: raw } : null;
      const stored = await appendClaudeEvent(this.deps.db, {
        sessionId: session.id,
        runId: run.id,
        stream,
        eventType,
        raw,
        payload,
      });
      await this.deps.bus.publish({
        type: "claude.event",
        sessionId: session.id,
        runId: run.id,
        missionId,
        provider,
        backend,
        seq: stored.sequence,
        stream,
        eventType,
        text: raw.slice(0, 32_000),
        ...(payload ? { payload } : {}),
        at: stored.createdAt.toISOString(),
      });
    };

    try {
      const exec = await executor.runStreaming(
        {
          projectId,
          command,
          timeoutMs: input.timeoutMs,
          signal: controller.signal,
          executionId,
          executionGeneration,
          containerProfile: "openai",
          secretNames: [...OPENAI_SECRET_NAMES],
        },
        (chunk) => persistChunk(chunk.stream, chunk.text),
      );
      const parsed = aiderAdapter.parse(stdout, { code: exec.code, stderr });
      let aborted = controller.signal.aborted;
      let status: "succeeded" | "failed" | "cancelled" =
        aborted ? "cancelled" : exec.timedOut || !parsed.ok ? "failed" : "succeeded";
      let error: string | null = aborted
        ? "cancelled by operator"
        : exec.timedOut
          ? "OpenAI/Aider exceeded its wall-clock budget"
          : parsed.ok
            ? null
            : parsed.reason ?? `OpenAI/Aider exited ${exec.code}`;
      const transcript = cleanTerminalText(stdout);
      const result: ClaudeRunResult = {
        subtype: status === "succeeded" ? "success" : status,
        result: transcript || parsed.result || null,
        isError: status !== "succeeded",
        stopReason: aborted
          ? "cancelled"
          : exec.timedOut
            ? "timeout"
            : status === "succeeded"
              ? "end_turn"
              : "error",
        totalCostUsd: parsed.costUsd ?? null,
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        durationApiMs: null,
        numTurns: null,
        usage: normalizeAiderUsage(parsed.usage),
        structuredOutput: parsed.filesChanged ? { filesChanged: parsed.filesChanged } : null,
        raw: safePayload({
          cli: parsed.cli,
          provider,
          backend,
          exitCode: exec.code,
          timedOut: exec.timedOut,
          filesChanged: parsed.filesChanged ?? [],
        }),
      };
      if (status === "succeeded" && run.mode === "execute") {
        return this.commitSuccessfulProviderCopyback({
          run,
          session,
          projectId,
          executionId,
          executionGeneration,
          controller,
          result,
        });
      }
      await executor.cleanupExecutionArtifacts(executionId);
      return { status, result, error, terminalCommitted: false };
    } catch (error) {
      // Unproven termination/copy-back keeps its signed scratch evidence for
      // startup or operator reconciliation. Provider failures before any
      // durable intent may safely discard the isolated scratch.
      if (error instanceof WorkbenchTerminationError) throw error;
      await executor.cleanupExecutionArtifacts(executionId);
      throw error;
    }
  }

  private async commitSuccessfulProviderCopyback(input: {
    run: NonNullable<Awaited<ReturnType<typeof getClaudeRunByMission>>>;
    session: NonNullable<Awaited<ReturnType<typeof getClaudeSession>>>;
    projectId: string;
    executionId: string;
    executionGeneration: number;
    controller: AbortController;
    result: ClaudeRunResult;
  }): Promise<{
    status: "succeeded" | "failed" | "cancelled";
    result: ClaudeRunResult;
    error: string | null;
    terminalCommitted: boolean;
  }> {
    const { run, session, projectId, executionId, executionGeneration, controller } = input;
    const executor = this.deps.executor!;
    if (controller.signal.aborted) {
      await executor.cleanupExecutionArtifacts(executionId);
      return {
        status: "cancelled",
        result: { ...input.result, subtype: "cancelled", isError: true, stopReason: "cancelled" },
        error: "cancelled by operator",
        terminalCommitted: false,
      };
    }
    let guard: (WorkbenchCopybackGuard & { expectedRunStatus: "running" }) | null = null;
    try {
      const snapshot = await executor.getExecutionSnapshot(projectId, executionId, executionGeneration);
      const intent = await createWorkbenchCopybackIntent(this.deps.db, {
        projectId,
        claudeRunId: run.id,
        executionId,
        executionIdentitySha256: snapshot.executionIdentitySha256,
        executionGeneration,
        expectedRunStatus: "running",
        baseline: { snapshotReceipt: snapshot.snapshotReceipt },
      });
      guard = {
        id: intent.row.id,
        projectId,
        claudeRunId: run.id,
        executionId,
        executionIdentitySha256: snapshot.executionIdentitySha256,
        executionGeneration,
        expectedRunStatus: "running",
      };
      const finishedAt = new Date();
      await prepareWorkbenchCopyback(this.deps.db, guard, {
        candidate: { executionIdentitySha256: snapshot.executionIdentitySha256 },
        pendingCompletion: {
          status: "succeeded",
          result: input.result,
          error: null,
          finishedAt,
        },
      });
      const applied = await executor.applyExecutionResult(
        projectId,
        executionId,
        executionGeneration,
        snapshot.snapshotReceipt,
        controller.signal,
      );
      if (applied.committed && applied.commitReceipt) {
        await markWorkbenchCopybackFilesCommitted(this.deps.db, guard, applied.commitReceipt);
        await commitWorkbenchCopybackAndFinishClaudeRun(this.deps.db, guard, applied.commitReceipt);
        await this.publishFinished(run, session, "succeeded", input.result, finishedAt);
        try {
          const acked = await executor.acknowledgeExecutionCopyback(
            projectId,
            executionId,
            executionGeneration,
            applied.commitReceipt,
          );
          if (acked.state !== "acked") {
            throw new Error(`copy-back acknowledgment returned ${acked.state}`);
          }
          await markWorkbenchCopybackCleaned(this.deps.db, {
            ...guard,
            expectedRunStatus: "succeeded",
          });
          await executor.cleanupExecutionArtifacts(executionId);
        } catch (cleanupError) {
          await this.deps.audit?.({
            workspaceId: session.workspaceId,
            actorKind: "system",
            actorLabel: run.provider === "openai" ? "openai-aider" : "claude-code",
            missionId: run.missionId,
            action: `${run.provider}.copyback.cleanup.pending`,
            target: session.id,
            detail: {
              runId: run.id,
              executionId,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
          });
        }
        return { status: "succeeded", result: input.result, error: null, terminalCommitted: true };
      }
      const cancelled = controller.signal.aborted || applied.code === 143;
      const error = cancelled
        ? "cancelled by operator"
        : applied.stderr.trim().slice(0, 1_000) || `trusted copy-back exited ${applied.code}`;
      await markWorkbenchCopybackRolledBack(this.deps.db, guard, error);
      await executor.cleanupExecutionArtifacts(executionId);
      const status = cancelled ? "cancelled" : "failed";
      return {
        status,
        result: {
          ...input.result,
          subtype: status,
          isError: true,
          stopReason: cancelled ? "cancelled" : "error",
        },
        error,
        terminalCommitted: false,
      };
    } catch (error) {
      // Once an intent exists, deleting the scratch would destroy the HMAC key
      // needed to distinguish rollback from an irreversible commit. Convert
      // every ambiguous failure into the fail-closed runtime error.
      if (guard) {
        throw error instanceof WorkbenchTerminationError
          ? error
          : new WorkbenchTerminationError(
              `${run.provider} copy-back requires reconciliation: ${error instanceof Error ? error.message : String(error)}`,
            );
      }
      await executor.cleanupExecutionArtifacts(executionId);
      throw error;
    }
  }

  private async publishFinished(
    run: Awaited<ReturnType<typeof getClaudeRunByMission>> & {},
    session: Awaited<ReturnType<typeof getClaudeSession>> & {},
    status: "succeeded" | "failed" | "cancelled",
    result: ClaudeRunResult | null,
    finishedAt: Date,
  ): Promise<void> {
    if (!run || !session) return;
    const provider = providerOf(run.provider) ?? providerOf(session.provider) ?? "anthropic";
    const backend =
      backendOf(run.backend) ??
      backendOf(session.backend) ??
      (provider === "openai" ? "aider" : "claude");
    const actorLabel = provider === "openai" ? "openai-aider" : "claude-code";
    const usage = result?.usage ?? null;
    try {
      await this.deps.bus.publish({
        type: "claude.run.finished",
        sessionId: session.id,
        runId: run.id,
        missionId: run.missionId,
        provider,
        backend,
        status,
        ...(result?.totalCostUsd == null ? {} : { costUsd: result.totalCostUsd }),
        at: finishedAt.toISOString(),
      });
      await this.deps.bus.publish({
        type: "mission.finished",
        missionId: run.missionId,
        status,
        at: finishedAt.toISOString(),
      });
      if (usage) {
        await this.deps.bus.publish({
          type: "audit.appended",
          workspaceId: session.workspaceId,
          at: finishedAt.toISOString(),
          action: "llm.call",
          actorKind: "system",
          actorLabel,
          target: run.model,
          missionId: run.missionId,
          model: run.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      }
    } catch {
      // Durable terminal state, audit, and usage are already committed. Live
      // projections recover through REST polling and must not rewrite outcome.
    }
  }

  private async finish(
    run: Awaited<ReturnType<typeof getClaudeRunByMission>> & {},
    session: Awaited<ReturnType<typeof getClaudeSession>> & {},
    status: "succeeded" | "failed" | "cancelled",
    result: ClaudeRunResult | null,
    error: string | null,
    expectedStatuses: readonly [ClaudeRunStatus],
    expectedGeneration?: number,
  ): Promise<boolean> {
    if (!run || !session) return false;
    const finishedAt = new Date();
    const completion = await finishClaudeRun(this.deps.db, {
      runId: run.id,
      sessionId: session.id,
      missionId: run.missionId,
      status,
      result,
      error,
      finishedAt,
      expectedStatuses,
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
    });
    if (!completion.transitioned) return false;
    await this.publishFinished(run, session, status, result, finishedAt);
    return true;
  }
}
