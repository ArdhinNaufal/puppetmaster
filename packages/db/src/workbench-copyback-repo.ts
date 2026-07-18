import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { ClaudeRunResult, ClaudeRunStatus } from "@puppetmaster/shared";
import type { Db } from "./client.js";
import {
  claudeRuns,
  claudeSessions,
  workbenchCopybacks,
} from "./schema.js";
import { finishClaudeRun } from "./claude-repo.js";

export const WORKBENCH_COPYBACK_STATES = [
  "intent",
  "files_committed",
  "db_committed",
  "rolled_back",
  "quarantined",
  "cleaned",
] as const;

export type WorkbenchCopybackState = (typeof WORKBENCH_COPYBACK_STATES)[number];
export type WorkbenchCopybackRow = typeof workbenchCopybacks.$inferSelect;

export interface WorkbenchCopybackPendingCompletion {
  status: "succeeded" | "failed" | "cancelled";
  result: ClaudeRunResult | null;
  error: string | null;
  /** ISO-8601 timestamp so the JSON payload is portable across both drivers. */
  finishedAt: string;
}

export interface WorkbenchCopybackGuard {
  id: string;
  projectId: string;
  claudeRunId: string;
  executionId: string;
  executionIdentitySha256: string;
  executionGeneration: number;
  /** Exact run state observed by the caller; stale workers never mutate. */
  expectedRunStatus: ClaudeRunStatus;
}

export class WorkbenchCopybackConflictError extends Error {
  readonly code = "WORKBENCH_COPYBACK_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WorkbenchCopybackConflictError";
  }
}

const ACTIVE_RECONCILIATION_STATES = [
  "intent",
  "files_committed",
  "db_committed",
  "rolled_back",
] as const;

function conflict(message: string): never {
  throw new WorkbenchCopybackConflictError(message);
}

function assertExecutionId(value: string): void {
  if (value !== value.trim() || value.length < 1 || value.length > 300) {
    throw new Error("Workbench copyback execution id must be canonical and 1-300 characters");
  }
}

function assertExecutionIdentity(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Workbench copyback identity must be a full lowercase SHA-256 digest");
  }
}

function assertExecutionGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Workbench copyback execution generation must be a positive safe integer");
  }
}

function normalizedJson(value: unknown, label: string): unknown {
  if (value === undefined) throw new Error(`${label} must be JSON serializable`);
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined JSON result");
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) target[key] = sortedJson(source[key]);
    return target;
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortedJson(left)) === JSON.stringify(sortedJson(right));
}

function normalizeCompletion(input: {
  status: WorkbenchCopybackPendingCompletion["status"];
  result: ClaudeRunResult | null;
  error: string | null;
  finishedAt: Date | string;
}): WorkbenchCopybackPendingCompletion {
  const finishedAt = input.finishedAt instanceof Date
    ? input.finishedAt
    : new Date(input.finishedAt);
  if (Number.isNaN(finishedAt.getTime())) {
    throw new Error("Workbench copyback completion requires a valid finishedAt timestamp");
  }
  return normalizedJson({
    status: input.status,
    result: input.result,
    error: input.error,
    finishedAt: finishedAt.toISOString(),
  }, "Workbench copyback pending completion") as WorkbenchCopybackPendingCompletion;
}

function assertGuardShape(guard: WorkbenchCopybackGuard): void {
  assertExecutionId(guard.executionId);
  assertExecutionIdentity(guard.executionIdentitySha256);
  assertExecutionGeneration(guard.executionGeneration);
}

async function lockOwnedRun(db: Db, guard: Omit<WorkbenchCopybackGuard, "id" | "expectedRunStatus">) {
  await db.execute(sql`select id from claude_runs where id = ${guard.claudeRunId} for update`);
  const [owned] = await db
    .select({
      id: claudeRuns.id,
      sessionId: claudeRuns.sessionId,
      missionId: claudeRuns.missionId,
      status: claudeRuns.status,
      executionGeneration: claudeRuns.executionGeneration,
      projectId: claudeSessions.projectId,
    })
    .from(claudeRuns)
    .innerJoin(claudeSessions, eq(claudeRuns.sessionId, claudeSessions.id))
    .where(eq(claudeRuns.id, guard.claudeRunId))
    .limit(1);
  if (!owned) conflict(`Claude run ${guard.claudeRunId} does not exist`);
  if (owned.projectId !== guard.projectId) {
    conflict(`Claude run ${guard.claudeRunId} does not belong to project ${guard.projectId}`);
  }
  if (owned.executionGeneration !== guard.executionGeneration) {
    conflict(`Claude run ${guard.claudeRunId} execution generation is stale`);
  }
  return owned;
}

function assertRunStatus(actual: string, expected: ClaudeRunStatus): void {
  if (actual !== expected) {
    conflict(`Claude run status guard failed (expected ${expected}, found ${actual})`);
  }
}

async function lockCopyback(db: Db, guard: WorkbenchCopybackGuard): Promise<WorkbenchCopybackRow> {
  await db.execute(sql`select id from workbench_copybacks where id = ${guard.id} for update`);
  const [row] = await db
    .select()
    .from(workbenchCopybacks)
    .where(eq(workbenchCopybacks.id, guard.id))
    .limit(1);
  if (!row) conflict(`Workbench copyback ${guard.id} does not exist`);
  if (
    row.projectId !== guard.projectId ||
    row.claudeRunId !== guard.claudeRunId ||
    row.executionId !== guard.executionId ||
    row.executionIdentitySha256 !== guard.executionIdentitySha256 ||
    row.executionGeneration !== guard.executionGeneration
  ) {
    conflict(`Workbench copyback ${guard.id} ownership guard failed`);
  }
  return row;
}

function sameIntent(
  row: WorkbenchCopybackRow,
  input: {
    projectId: string;
    claudeRunId: string;
    executionId: string;
    executionIdentitySha256: string;
    executionGeneration: number;
    baseline: unknown;
  },
): boolean {
  return row.projectId === input.projectId &&
    row.claudeRunId === input.claudeRunId &&
    row.executionId === input.executionId &&
    row.executionIdentitySha256 === input.executionIdentitySha256 &&
    row.executionGeneration === input.executionGeneration &&
    sameJson(row.baseline, input.baseline);
}

export async function createWorkbenchCopybackIntent(
  db: Db,
  input: {
    projectId: string;
    claudeRunId: string;
    executionId: string;
    executionIdentitySha256: string;
    executionGeneration: number;
    expectedRunStatus: "running";
    baseline: unknown;
  },
): Promise<{ row: WorkbenchCopybackRow; created: boolean }> {
  assertExecutionId(input.executionId);
  assertExecutionIdentity(input.executionIdentitySha256);
  assertExecutionGeneration(input.executionGeneration);
  const baseline = normalizedJson(input.baseline, "Workbench copyback baseline");

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, input);
    const [existing] = await tx
      .select()
      .from(workbenchCopybacks)
      .where(
        or(
          eq(workbenchCopybacks.executionId, input.executionId),
          eq(workbenchCopybacks.executionIdentitySha256, input.executionIdentitySha256),
          and(
            eq(workbenchCopybacks.claudeRunId, input.claudeRunId),
            eq(workbenchCopybacks.executionGeneration, input.executionGeneration),
          ),
        ),
      )
      .limit(1);
    if (existing) {
      if (!sameIntent(existing, { ...input, baseline })) {
        conflict("Workbench copyback execution binding is already owned by different intent data");
      }
      return { row: existing, created: false };
    }
    assertRunStatus(owned.status, input.expectedRunStatus);
    const [row] = await tx
      .insert(workbenchCopybacks)
      .values({
        projectId: input.projectId,
        claudeRunId: input.claudeRunId,
        executionId: input.executionId,
        executionIdentitySha256: input.executionIdentitySha256,
        executionGeneration: input.executionGeneration,
        state: "intent",
        baseline,
      })
      .returning();
    return { row: row!, created: true };
  });
}

export async function getWorkbenchCopyback(db: Db, id: string): Promise<WorkbenchCopybackRow | null> {
  const [row] = await db.select().from(workbenchCopybacks).where(eq(workbenchCopybacks.id, id)).limit(1);
  return row ?? null;
}

export async function getWorkbenchCopybackByRunGeneration(
  db: Db,
  claudeRunId: string,
  executionGeneration: number,
): Promise<WorkbenchCopybackRow | null> {
  const [row] = await db
    .select()
    .from(workbenchCopybacks)
    .where(
      sql`${workbenchCopybacks.claudeRunId} = ${claudeRunId} AND ${workbenchCopybacks.executionGeneration} = ${executionGeneration}`,
    )
    .limit(1);
  return row ?? null;
}

export async function listWorkbenchCopybacksForReconciliation(
  db: Db,
  opts: { projectId?: string; limit?: number } = {},
): Promise<WorkbenchCopybackRow[]> {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(opts.limit ?? 100)));
  return db
    .select()
    .from(workbenchCopybacks)
    .where(
      opts.projectId
        ? sql`${workbenchCopybacks.projectId} = ${opts.projectId} AND ${workbenchCopybacks.state} IN ('intent', 'files_committed', 'db_committed', 'rolled_back')`
        : inArray(workbenchCopybacks.state, [...ACTIVE_RECONCILIATION_STATES]),
    )
    .orderBy(asc(workbenchCopybacks.createdAt))
    .limit(limit);
}

/** A quarantined or not-yet-reconciled journal is a project mutation barrier.
 * Reads remain available for diagnosis, but no new writer may run until this
 * row is reconciled or an operator migrates/restores the whole project state. */
export async function getBlockingWorkbenchCopybackForProject(
  db: Db,
  projectId: string,
): Promise<WorkbenchCopybackRow | null> {
  const [row] = await db
    .select()
    .from(workbenchCopybacks)
    .where(
      and(
        eq(workbenchCopybacks.projectId, projectId),
        inArray(workbenchCopybacks.state, [
          "intent",
          "files_committed",
          "db_committed",
          "quarantined",
        ]),
      ),
    )
    .orderBy(asc(workbenchCopybacks.createdAt))
    .limit(1);
  return row ?? null;
}

export async function prepareWorkbenchCopyback(
  db: Db,
  guard: WorkbenchCopybackGuard,
  input: {
    candidate: unknown;
    pendingCompletion: {
      status: WorkbenchCopybackPendingCompletion["status"];
      result: ClaudeRunResult | null;
      error: string | null;
      finishedAt: Date | string;
    };
  },
): Promise<{ row: WorkbenchCopybackRow; transitioned: boolean }> {
  assertGuardShape(guard);
  const candidate = normalizedJson(input.candidate, "Workbench copyback candidate");
  const pendingCompletion = normalizeCompletion(input.pendingCompletion);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, guard);
    const row = await lockCopyback(tx, guard);
    if (row.state !== "intent") {
      conflict(`Workbench copyback ${row.id} cannot be prepared from ${row.state}`);
    }
    if (row.candidate !== null || row.pendingCompletion !== null) {
      if (sameJson(row.candidate, candidate) && sameJson(row.pendingCompletion, pendingCompletion)) {
        return { row, transitioned: false };
      }
      conflict(`Workbench copyback ${row.id} was already prepared with different data`);
    }
    assertRunStatus(owned.status, guard.expectedRunStatus);
    const now = new Date();
    const [updated] = await tx
      .update(workbenchCopybacks)
      .set({ candidate, pendingCompletion, error: null, updatedAt: now })
      .where(eq(workbenchCopybacks.id, row.id))
      .returning();
    return { row: updated!, transitioned: true };
  });
}

export async function markWorkbenchCopybackFilesCommitted(
  db: Db,
  guard: WorkbenchCopybackGuard,
  receiptInput: unknown,
): Promise<{ row: WorkbenchCopybackRow; transitioned: boolean }> {
  assertGuardShape(guard);
  const receipt = normalizedJson(receiptInput, "Workbench copyback receipt");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, guard);
    const row = await lockCopyback(tx, guard);
    if (row.state === "files_committed") {
      if (!sameJson(row.receipt, receipt)) {
        conflict(`Workbench copyback ${row.id} already has a different filesystem receipt`);
      }
      return { row, transitioned: false };
    }
    if (row.state !== "intent") {
      conflict(`Workbench copyback ${row.id} cannot commit files from ${row.state}`);
    }
    if (row.candidate === null || row.pendingCompletion === null) {
      conflict(`Workbench copyback ${row.id} must be prepared before files are committed`);
    }
    assertRunStatus(owned.status, guard.expectedRunStatus);
    const now = new Date();
    const [updated] = await tx
      .update(workbenchCopybacks)
      .set({ state: "files_committed", receipt, filesCommittedAt: now, error: null, updatedAt: now })
      .where(eq(workbenchCopybacks.id, row.id))
      .returning();
    return { row: updated!, transitioned: true };
  });
}

export async function markWorkbenchCopybackRolledBack(
  db: Db,
  guard: WorkbenchCopybackGuard,
  error: string,
): Promise<{ row: WorkbenchCopybackRow; transitioned: boolean }> {
  assertGuardShape(guard);
  const message = error.trim();
  if (!message) throw new Error("Workbench copyback rollback requires an error/reason");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, guard);
    const row = await lockCopyback(tx, guard);
    if (row.state === "rolled_back") {
      if (row.error !== message) conflict(`Workbench copyback ${row.id} has a different rollback reason`);
      return { row, transitioned: false };
    }
    // An authenticated filesystem commit is irreversible. Once the journal
    // reports files_committed, recovery must finish the DB transition rather
    // than reinterpret a late cancel/error as permission to roll files back.
    if (row.state !== "intent") {
      conflict(`Workbench copyback ${row.id} cannot roll back from ${row.state}`);
    }
    assertRunStatus(owned.status, guard.expectedRunStatus);
    const now = new Date();
    const [updated] = await tx
      .update(workbenchCopybacks)
      .set({ state: "rolled_back", error: message, rolledBackAt: now, updatedAt: now })
      .where(eq(workbenchCopybacks.id, row.id))
      .returning();
    return { row: updated!, transitioned: true };
  });
}

/** Atomically terminalizes the exact Claude claim and records that its
 * authenticated filesystem commit is represented in the DB. The journal is
 * acknowledged only after this transaction commits. */
export async function commitWorkbenchCopybackAndFinishClaudeRun(
  db: Db,
  guard: WorkbenchCopybackGuard & { expectedRunStatus: "running" },
  receiptInput: unknown,
): Promise<{ row: WorkbenchCopybackRow; transitioned: boolean; status: ClaudeRunStatus }> {
  assertGuardShape(guard);
  const receipt = normalizedJson(receiptInput, "Workbench copyback receipt");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, guard);
    assertRunStatus(owned.status, guard.expectedRunStatus);
    const row = await lockCopyback(tx, guard);
    if (row.state === "db_committed") {
      if (!sameJson(row.receipt, receipt)) {
        conflict(`Workbench copyback ${row.id} already has a different filesystem receipt`);
      }
      return { row, transitioned: false, status: owned.status as ClaudeRunStatus };
    }
    if (row.state !== "files_committed") {
      conflict(`Workbench copyback ${row.id} cannot commit DB state from ${row.state}`);
    }
    if (!sameJson(row.receipt, receipt)) {
      conflict(`Workbench copyback ${row.id} filesystem receipt guard failed`);
    }
    const pending = row.pendingCompletion as WorkbenchCopybackPendingCompletion | null;
    if (!pending || !["succeeded", "failed", "cancelled"].includes(pending.status)) {
      conflict(`Workbench copyback ${row.id} has no valid pending completion`);
    }
    const finishedAt = new Date(pending.finishedAt);
    if (Number.isNaN(finishedAt.getTime())) {
      conflict(`Workbench copyback ${row.id} has an invalid completion timestamp`);
    }
    const completion = await finishClaudeRun(tx, {
      runId: guard.claudeRunId,
      sessionId: owned.sessionId,
      missionId: owned.missionId,
      status: pending.status,
      result: pending.result,
      error: pending.error,
      finishedAt,
      expectedStatuses: ["running"],
      expectedGeneration: guard.executionGeneration,
    });
    if (!completion.transitioned) {
      conflict(`Workbench copyback ${row.id} lost its Claude run ownership before DB commit`);
    }
    const now = new Date();
    const [updated] = await tx
      .update(workbenchCopybacks)
      .set({ state: "db_committed", dbCommittedAt: now, error: null, updatedAt: now })
      .where(
        and(
          eq(workbenchCopybacks.id, row.id),
          eq(workbenchCopybacks.state, "files_committed"),
        ),
      )
      .returning();
    if (!updated) conflict(`Workbench copyback ${row.id} DB commit guard failed`);
    return { row: updated!, transitioned: true, status: completion.status };
  });
}

export async function markWorkbenchCopybackQuarantined(
  db: Db,
  guard: WorkbenchCopybackGuard,
  error: string,
): Promise<{ row: WorkbenchCopybackRow; transitioned: boolean }> {
  assertGuardShape(guard);
  const message = error.trim();
  if (!message) throw new Error("Workbench copyback quarantine requires an error/reason");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, guard);
    const row = await lockCopyback(tx, guard);
    if (row.state === "quarantined") {
      if (row.error !== message) conflict(`Workbench copyback ${row.id} has a different quarantine reason`);
      return { row, transitioned: false };
    }
    if (row.state === "cleaned") {
      conflict(`Workbench copyback ${row.id} cannot be quarantined after cleanup`);
    }
    assertRunStatus(owned.status, guard.expectedRunStatus);
    const now = new Date();
    const [updated] = await tx
      .update(workbenchCopybacks)
      .set({ state: "quarantined", error: message, quarantinedAt: now, updatedAt: now })
      .where(eq(workbenchCopybacks.id, row.id))
      .returning();
    return { row: updated!, transitioned: true };
  });
}

/** Records filesystem-journal cleanup after either a durable DB commit or a
 *  proved rollback. Quarantines are intentionally not auto-cleanable. */
export async function markWorkbenchCopybackCleaned(
  db: Db,
  guard: WorkbenchCopybackGuard,
): Promise<{ row: WorkbenchCopybackRow; transitioned: boolean }> {
  assertGuardShape(guard);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const owned = await lockOwnedRun(tx, guard);
    const row = await lockCopyback(tx, guard);
    if (row.state === "cleaned") return { row, transitioned: false };
    if (row.state !== "db_committed" && row.state !== "rolled_back") {
      conflict(`Workbench copyback ${row.id} cannot be cleaned from ${row.state}`);
    }
    assertRunStatus(owned.status, guard.expectedRunStatus);
    const now = new Date();
    const [updated] = await tx
      .update(workbenchCopybacks)
      .set({ state: "cleaned", cleanedAt: now, updatedAt: now })
      .where(eq(workbenchCopybacks.id, row.id))
      .returning();
    return { row: updated!, transitioned: true };
  });
}
