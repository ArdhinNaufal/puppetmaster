import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { missions, nodeExecutions } from "./schema.js";

// --- Idempotency ledger (Stage 2, G4) -------------------------------------------

/** Record that a side-effectful execution is about to run. Re-running the same
 *  key (a retry of an uncommitted attempt) reuses the existing row. */
export async function beginNodeExecution(
  db: Db,
  input: { missionId: string; nodeId: string; attempt?: number; key?: string },
) {
  const attempt = input.attempt ?? 0;
  const key = input.key ?? `${input.missionId}:${input.nodeId}:${attempt}`;
  const [row] = await db
    .insert(nodeExecutions)
    .values({ missionId: input.missionId, nodeId: input.nodeId, attempt, key })
    .onConflictDoUpdate({ target: nodeExecutions.key, set: { attempt } })
    .returning();
  return row!;
}

export async function commitNodeExecution(db: Db, id: string, output: unknown) {
  await db
    .update(nodeExecutions)
    .set({ output: output === undefined ? null : output, committed: true })
    .where(eq(nodeExecutions.id, id));
}

/** Latest committed execution of a node in a mission (any attempt) — its
 *  output substitutes for re-running the side effect on retry. */
export async function findCommittedExecution(db: Db, missionId: string, nodeId: string) {
  const [row] = await db
    .select()
    .from(nodeExecutions)
    .where(
      and(
        eq(nodeExecutions.missionId, missionId),
        eq(nodeExecutions.nodeId, nodeId),
        eq(nodeExecutions.committed, true),
      ),
    )
    .orderBy(desc(nodeExecutions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function findCommittedExecutionByKey(db: Db, key: string) {
  const [row] = await db
    .select()
    .from(nodeExecutions)
    .where(and(eq(nodeExecutions.key, key), eq(nodeExecutions.committed, true)))
    .limit(1);
  return row ?? null;
}

// --- Cancellation & retry (Stage 2) ----------------------------------------------

export async function requestMissionCancel(db: Db, id: string) {
  await db.update(missions).set({ cancelRequested: true }).where(eq(missions.id, id));
}

/** Reset a failed/cancelled mission so it re-enqueues, resuming from its
 *  cursor. The step log and idempotency ledger are preserved deliberately —
 *  committed side effects are skipped on the retry. */
export async function resetMissionForRetry(db: Db, id: string) {
  await db
    .update(missions)
    .set({
      status: "queued",
      error: null,
      finishedAt: null,
      cancelRequested: false,
      retryCount: sql`${missions.retryCount} + 1`,
    })
    .where(eq(missions.id, id));
}

/** Dead-letter list: missions that were retried at least `minRetries` times
 *  and are still failed — repeat offenders needing human attention. */
export async function listDeadLetterMissions(db: Db, workspaceId: string, minRetries = 1) {
  return db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.workspaceId, workspaceId),
        eq(missions.status, "failed"),
        gte(missions.retryCount, minRetries),
      ),
    )
    .orderBy(desc(missions.retryCount), desc(missions.finishedAt))
    .limit(50);
}
