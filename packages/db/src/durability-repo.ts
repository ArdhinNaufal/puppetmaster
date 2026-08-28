import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { ScienceManifest } from "@puppetmaster/shared";
import type { Db } from "./client.js";
import {
  missionSteps,
  missions,
  nodeExecutions,
  scienceRuns,
  scienceStudies,
  workflowWaits,
} from "./schema.js";

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
 *  committed side effects are skipped on the retry. A durable workflow wait
 *  is reactivated in the same transaction: its generation advances and any
 *  old claim token is cleared before the mission can run again. */
export async function resetMissionForRetry(db: Db, id: string) {
  const observedWait = await getWorkflowWaitForMission(db, id);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = new Date();
    if (observedWait) {
      await lockWorkflowWaitContext(scoped, id, observedWait.targetRunId);
    } else {
      await scoped.execute(sql`select id from missions where id = ${id} for update`);
    }

    const [mission] = await scoped.select().from(missions).where(eq(missions.id, id)).limit(1);
    if (!mission) throw new Error(`mission ${id} does not exist`);
    if (!isTerminalMissionState(mission.status)) {
      throw new Error(`mission ${id} cannot be retried from status ${mission.status}`);
    }

    const [wait] = await scoped
      .select()
      .from(workflowWaits)
      .where(eq(workflowWaits.missionId, id))
      .limit(1);
    if (!observedWait && wait) {
      throw new Error("workflow wait appeared while retry was acquiring its mission lock; retry again");
    }
    if (
      observedWait &&
      (
        !wait ||
        wait.id !== observedWait.id ||
        wait.nodeId !== observedWait.nodeId ||
        wait.targetRunId !== observedWait.targetRunId
      )
    ) {
      throw new Error("workflow wait changed while retry was acquiring its locks; retry again");
    }

    let updatedWait: WorkflowWaitRow | null = null;
    let missionStatus: "queued" | "waiting" = "queued";
    if (wait) {
      if (mission.kind !== "workflow" || wait.kind !== WORKFLOW_WAIT_KIND) {
        throw new Error("mission retry found an invalid durable workflow wait binding");
      }
      const [run] = await scoped
        .select({ state: scienceRuns.state })
        .from(scienceRuns)
        .where(eq(scienceRuns.id, wait.targetRunId))
        .limit(1);
      if (!run) throw new Error("workflow retry target Science run does not exist");

      const statusAlreadyCommitted = cursorHasWorkflowNode(mission.cursor, wait.nodeId);
      if (statusAlreadyCommitted && !isTerminalScienceRunState(run.state)) {
        throw new Error(
          "workflow retry cursor contains terminal wait output while its Science run is nonterminal",
        );
      }
      const nextState: WorkflowWaitState = statusAlreadyCommitted
        ? "consumed"
        : isTerminalScienceRunState(run.state)
          ? "ready"
          : "pending";
      [updatedWait] = await scoped
        .update(workflowWaits)
        .set({
          state: nextState,
          generation: sql`${workflowWaits.generation} + 1`,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(workflowWaits.id, wait.id))
        .returning() as [WorkflowWaitRow];
      if (!statusAlreadyCommitted) {
        missionStatus = "waiting";
        await setLatestWorkflowStepState(scoped, {
          missionId: id,
          nodeId: wait.nodeId,
          status: "waiting",
          attempt: updatedWait.generation,
          output: null,
          error: null,
          finishedAt: null,
          now,
        });
      }
    }

    const [updatedMission] = await scoped
      .update(missions)
      .set({
        status: missionStatus,
        error: null,
        finishedAt: null,
        cancelRequested: false,
        retryCount: sql`${missions.retryCount} + 1`,
      })
      .where(eq(missions.id, id))
      .returning();
    return { mission: updatedMission!, wait: updatedWait };
  });
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

/**
 * Bounded startup inventory for jobs that may have been left in a previous
 * queue namespace. Science has its own scheduler reconciliation; workflow,
 * agent, and Claude missions share QueueRunner. Approval pauses are
 * deliberately excluded by the exact `queued` state.
 */
export async function listQueuedGenericMissionsForRecovery(
  db: Db,
  input: { workspaceId: string; limit?: number },
) {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_001));
  return db
    .select({ id: missions.id, kind: missions.kind, createdAt: missions.createdAt })
    .from(missions)
    .where(and(
      eq(missions.workspaceId, input.workspaceId),
      eq(missions.status, "queued"),
      eq(missions.cancelRequested, false),
      inArray(missions.kind, ["workflow", "agent", "claude"]),
    ))
    .orderBy(asc(missions.createdAt), asc(missions.id))
    .limit(limit);
}

// --- Durable workflow waits ----------------------------------------------------

export type WorkflowWaitRow = typeof workflowWaits.$inferSelect;
export type WorkflowWaitState = "pending" | "ready" | "claimed" | "consumed" | "cancelled";

const WORKFLOW_WAIT_KIND = "science_run_terminal";
const TERMINAL_SCIENCE_RUN_STATES = ["succeeded", "failed", "cancelled"] as const;
const TERMINAL_MISSION_STATES = ["succeeded", "failed", "cancelled"] as const;

function isTerminalScienceRunState(state: string): boolean {
  return (TERMINAL_SCIENCE_RUN_STATES as readonly string[]).includes(state);
}

function isTerminalMissionState(state: string): boolean {
  return (TERMINAL_MISSION_STATES as readonly string[]).includes(state);
}

function cursorHasWorkflowNode(cursor: unknown, nodeId: string): boolean {
  return Boolean(
    cursor &&
    typeof cursor === "object" &&
    !Array.isArray(cursor) &&
    Object.prototype.hasOwnProperty.call(cursor, nodeId),
  );
}

async function setLatestWorkflowStepState(
  db: Db,
  input: {
    missionId: string;
    nodeId: string;
    status: string;
    attempt?: number;
    output?: unknown;
    error?: string | null;
    finishedAt?: Date | null;
    now: Date;
  },
): Promise<void> {
  const [step] = await db
    .select({ id: missionSteps.id })
    .from(missionSteps)
    .where(and(eq(missionSteps.missionId, input.missionId), eq(missionSteps.nodeId, input.nodeId)))
    .orderBy(desc(missionSteps.startedAt))
    .limit(1);
  const patch = {
    status: input.status,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
  };
  if (step) {
    await db.update(missionSteps).set(patch).where(eq(missionSteps.id, step.id));
    return;
  }
  await db.insert(missionSteps).values({
    missionId: input.missionId,
    nodeId: input.nodeId,
    kind: "action",
    status: input.status,
    attempt: input.attempt ?? 0,
    input: null,
    output: input.output === undefined ? null : input.output,
    error: input.error ?? null,
    startedAt: input.now,
    finishedAt: input.finishedAt ?? null,
  });
}

async function lockWorkflowWaitContext(
  db: Db,
  missionId: string,
  targetRunId: string,
): Promise<void> {
  // Every multi-row wait mutation uses this order. Science terminalization
  // already owns the run row and only takes the wait row, so it cannot form a
  // wait -> mission -> run lock cycle with workflow recovery/cancellation.
  await db.execute(sql`select id from science_runs where id = ${targetRunId} for update`);
  await db.execute(sql`select id from missions where id = ${missionId} for update`);
  await db.execute(sql`select id from workflow_waits where mission_id = ${missionId} for update`);
}

export async function getWorkflowWaitForMission(
  db: Db,
  missionId: string,
): Promise<WorkflowWaitRow | null> {
  const [row] = await db
    .select()
    .from(workflowWaits)
    .where(eq(workflowWaits.missionId, missionId))
    .orderBy(desc(workflowWaits.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically suspends a workflow on one exact Science run. Locking the run
 * before inserting closes the terminal-before-registration race: a run that
 * already terminalized produces a `ready` row, never an unwakeable pending
 * row.
 */
export async function registerScienceRunTerminalWait(
  db: Db,
  input: { missionId: string; nodeId: string; targetRunId: string; now?: Date },
): Promise<{ wait: WorkflowWaitRow; runState: string; cancelled: boolean }> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = input.now ?? new Date();
    await scoped.execute(sql`select id from science_runs where id = ${input.targetRunId} for update`);
    await scoped.execute(sql`select id from missions where id = ${input.missionId} for update`);
    const [context] = await scoped
      .select({
        runState: scienceRuns.state,
        runWorkspaceId: scienceStudies.workspaceId,
        missionWorkspaceId: missions.workspaceId,
        missionKind: missions.kind,
        missionStatus: missions.status,
        cancelRequested: missions.cancelRequested,
      })
      .from(scienceRuns)
      .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
      .innerJoin(missions, eq(missions.id, input.missionId))
      .where(eq(scienceRuns.id, input.targetRunId))
      .limit(1);
    if (!context) throw new Error("workflow wait mission or Science run does not exist");
    if (context.missionKind !== "workflow") {
      throw new Error("durable Science waits are only valid for workflow missions");
    }
    if (context.runWorkspaceId !== context.missionWorkspaceId) {
      throw new Error("workflow wait target must belong to the mission workspace");
    }

    await scoped.execute(
      sql`select id from workflow_waits where mission_id = ${input.missionId} for update`,
    );
    const [existing] = await scoped
      .select()
      .from(workflowWaits)
      .where(eq(workflowWaits.missionId, input.missionId))
      .limit(1);
    if (existing && (existing.nodeId !== input.nodeId || existing.targetRunId !== input.targetRunId)) {
      throw new Error("workflow mission is already bound to a different durable wait");
    }
    if (existing && existing.kind !== WORKFLOW_WAIT_KIND) {
      throw new Error("workflow wait kind is not supported");
    }
    if (existing && ["consumed", "cancelled"].includes(existing.state)) {
      return {
        wait: existing,
        runState: context.runState,
        cancelled: existing.state === "cancelled",
      };
    }

    const cancelled = context.cancelRequested || context.missionStatus === "cancelled";
    const ready = !cancelled && isTerminalScienceRunState(context.runState);
    let wait: WorkflowWaitRow;
    if (existing) {
      [wait] = await scoped
        .update(workflowWaits)
        .set({
          state: cancelled ? "cancelled" : ready ? "ready" : "pending",
          generation: ready && existing.state === "pending"
            ? sql`${workflowWaits.generation} + 1`
            : existing.generation,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(workflowWaits.id, existing.id))
        .returning() as [WorkflowWaitRow];
    } else {
      [wait] = await scoped
        .insert(workflowWaits)
        .values({
          missionId: input.missionId,
          nodeId: input.nodeId,
          kind: WORKFLOW_WAIT_KIND,
          targetRunId: input.targetRunId,
          state: cancelled ? "cancelled" : ready ? "ready" : "pending",
          generation: ready ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning() as [WorkflowWaitRow];
    }
    await scoped
      .update(missions)
      .set({
        status: cancelled ? "cancelled" : "waiting",
        cancelRequested: cancelled,
        error: cancelled ? "cancelled by operator" : null,
        finishedAt: cancelled ? now : null,
      })
      .where(eq(missions.id, input.missionId));
    await setLatestWorkflowStepState(scoped, {
      missionId: input.missionId,
      nodeId: input.nodeId,
      status: cancelled ? "skipped" : "waiting",
      error: cancelled ? "cancelled by operator" : null,
      finishedAt: cancelled ? now : null,
      now,
    });
    return { wait: wait!, runState: context.runState, cancelled };
  });
}

/** Called from the Science terminal-state transaction. */
export async function markWorkflowWaitsReadyForScienceRun(
  db: Db,
  input: { runId: string; now?: Date },
): Promise<WorkflowWaitRow[]> {
  const now = input.now ?? new Date();
  await db.execute(
    sql`select id from workflow_waits where target_run_id = ${input.runId} and state = 'pending' for update`,
  );
  return db
    .update(workflowWaits)
    .set({
      state: "ready",
      generation: sql`${workflowWaits.generation} + 1`,
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(workflowWaits.targetRunId, input.runId), eq(workflowWaits.state, "pending")))
    .returning();
}

export type WorkflowWaitClaimResult =
  | { status: "claimed"; wait: WorkflowWaitRow; runState: string }
  | { status: "pending" | "busy" | "consumed" | "cancelled" | "terminal"; wait: WorkflowWaitRow; runState: string };

export async function claimScienceRunTerminalWorkflowWait(
  db: Db,
  input: {
    missionId: string;
    claimToken: string;
    claimExpiresAt: Date;
    now?: Date;
  },
): Promise<WorkflowWaitClaimResult | null> {
  const observed = await getWorkflowWaitForMission(db, input.missionId);
  if (!observed) return null;
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = input.now ?? new Date();
    if (input.claimExpiresAt.getTime() <= now.getTime()) {
      throw new Error("workflow wait claim expiry must be in the future");
    }
    await lockWorkflowWaitContext(scoped, input.missionId, observed.targetRunId);
    const [[initialWait], [mission], [run]] = await Promise.all([
      scoped.select().from(workflowWaits).where(eq(workflowWaits.id, observed.id)).limit(1),
      scoped.select().from(missions).where(eq(missions.id, input.missionId)).limit(1),
      scoped.select({ state: scienceRuns.state }).from(scienceRuns).where(eq(scienceRuns.id, observed.targetRunId)).limit(1),
    ]);
    if (!initialWait || !mission || !run) throw new Error("workflow wait context disappeared while claiming");
    let wait = initialWait;
    if (isTerminalMissionState(mission.status)) {
      return { status: "terminal", wait, runState: run.state } as const;
    }
    if (mission.cancelRequested || wait.state === "cancelled") {
      const [cancelled] = await scoped
        .update(workflowWaits)
        .set({ state: "cancelled", claimToken: null, claimExpiresAt: null, updatedAt: now })
        .where(eq(workflowWaits.id, wait.id))
        .returning();
      await scoped.update(missions).set({
        status: "cancelled",
        cancelRequested: true,
        error: "cancelled by operator",
        finishedAt: now,
      }).where(eq(missions.id, mission.id));
      if (!cursorHasWorkflowNode(mission.cursor, wait.nodeId)) {
        await setLatestWorkflowStepState(scoped, {
          missionId: mission.id,
          nodeId: wait.nodeId,
          status: "skipped",
          error: "cancelled by operator",
          finishedAt: now,
          now,
        });
      }
      return { status: "cancelled", wait: cancelled!, runState: run.state } as const;
    }
    if (wait.state === "pending" && isTerminalScienceRunState(run.state)) {
      [wait] = await scoped
        .update(workflowWaits)
        .set({ state: "ready", generation: sql`${workflowWaits.generation} + 1`, updatedAt: now })
        .where(eq(workflowWaits.id, wait.id))
        .returning() as [WorkflowWaitRow];
    }
    if (wait.state === "consumed") {
      return { status: "consumed", wait, runState: run.state } as const;
    }
    if (wait.state === "pending") {
      return { status: "pending", wait, runState: run.state } as const;
    }
    if (
      wait.state === "claimed" &&
      wait.claimExpiresAt &&
      wait.claimExpiresAt.getTime() > now.getTime()
    ) {
      return { status: "busy", wait, runState: run.state } as const;
    }
    if (wait.state !== "ready" && wait.state !== "claimed") {
      throw new Error(`workflow wait cannot be claimed from state ${wait.state}`);
    }
    const [claimed] = await scoped
      .update(workflowWaits)
      .set({
        state: "claimed",
        claimToken: input.claimToken,
        claimExpiresAt: input.claimExpiresAt,
        updatedAt: now,
      })
      .where(eq(workflowWaits.id, wait.id))
      .returning();
    await scoped.update(missions).set({ status: "running", error: null }).where(eq(missions.id, mission.id));
    if (!cursorHasWorkflowNode(mission.cursor, wait.nodeId)) {
      await setLatestWorkflowStepState(scoped, {
        missionId: mission.id,
        nodeId: wait.nodeId,
        status: "running",
        attempt: claimed!.generation,
        error: null,
        finishedAt: null,
        now,
      });
    }
    return { status: "claimed", wait: claimed!, runState: run.state } as const;
  });
}

export async function renewWorkflowWaitClaim(
  db: Db,
  input: { waitId: string; claimToken: string; claimExpiresAt: Date; now?: Date },
): Promise<boolean> {
  const observedAt = input.now ?? new Date();
  if (input.claimExpiresAt.getTime() <= observedAt.getTime()) {
    throw new Error("workflow wait claim renewal expiry must be in the future");
  }
  const [row] = await db
    .update(workflowWaits)
    .set({
      claimExpiresAt: sql`greatest(${workflowWaits.claimExpiresAt}, ${input.claimExpiresAt})`,
      updatedAt: observedAt,
    })
    .where(and(
      eq(workflowWaits.id, input.waitId),
      eq(workflowWaits.state, "claimed"),
      eq(workflowWaits.claimToken, input.claimToken),
      gt(workflowWaits.claimExpiresAt, observedAt),
    ))
    .returning({ id: workflowWaits.id });
  return Boolean(row);
}

/**
 * Persists the terminal status-node output/cursor without consuming the wait.
 * The live claim remains the durable continuation owner until the whole parent
 * mission terminalizes; an expired claim therefore recovers a crash between
 * this commit and any downstream node.
 */
export async function commitClaimedWorkflowWaitStatus(
  db: Db,
  input: {
    missionId: string;
    nodeId: string;
    claimToken: string;
    cursor: Record<string, unknown>;
    output: unknown;
    attempt: number;
    claimExpiresAt: Date;
    now?: Date;
  },
): Promise<void> {
  const observed = await getWorkflowWaitForMission(db, input.missionId);
  if (!observed) throw new Error("workflow wait does not exist");
  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = input.now ?? new Date();
    await lockWorkflowWaitContext(scoped, input.missionId, observed.targetRunId);
    const [[wait], [run], [mission]] = await Promise.all([
      scoped.select().from(workflowWaits).where(eq(workflowWaits.id, observed.id)).limit(1),
      scoped.select({ state: scienceRuns.state, manifest: scienceRuns.manifest }).from(scienceRuns).where(eq(scienceRuns.id, observed.targetRunId)).limit(1),
      scoped.select().from(missions).where(eq(missions.id, input.missionId)).limit(1),
    ]);
    if (!wait || !run || !mission) throw new Error("workflow wait context disappeared while committing status");
    if (mission.cancelRequested || mission.status === "cancelled") {
      throw new Error("workflow wait was cancelled before status commit");
    }
    if (wait.state !== "claimed" || wait.claimToken !== input.claimToken) {
      throw new Error("workflow wait claim was lost before status commit");
    }
    if (run.state !== "succeeded") {
      throw new Error(`successful deferred status commit requires a succeeded Science run, got ${run.state}`);
    }
    const manifest = ScienceManifest.safeParse(run.manifest);
    if (!manifest.success || !manifest.data.complete) {
      throw new Error("successful deferred status commit requires a complete Science manifest");
    }
    await scoped.update(missions).set({ cursor: input.cursor, status: "running" }).where(eq(missions.id, input.missionId));
    await scoped.update(workflowWaits).set({
      claimExpiresAt: input.claimExpiresAt,
      updatedAt: now,
    }).where(eq(workflowWaits.id, wait.id));
    await setLatestWorkflowStepState(scoped, {
      missionId: input.missionId,
      nodeId: input.nodeId,
      status: "succeeded",
      attempt: input.attempt,
      output: input.output,
      error: null,
      finishedAt: now,
      now,
    });
  });
}

export async function releaseWorkflowWaitClaim(
  db: Db,
  input: { missionId: string; claimToken: string; now?: Date },
): Promise<WorkflowWaitRow> {
  const observed = await getWorkflowWaitForMission(db, input.missionId);
  if (!observed) throw new Error("workflow wait does not exist");
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = input.now ?? new Date();
    await lockWorkflowWaitContext(scoped, input.missionId, observed.targetRunId);
    const [wait] = await scoped.select().from(workflowWaits).where(eq(workflowWaits.id, observed.id)).limit(1);
    if (!wait || wait.state !== "claimed" || wait.claimToken !== input.claimToken) {
      throw new Error("workflow wait claim was lost before release");
    }
    const [ready] = await scoped.update(workflowWaits).set({
      state: "ready",
      generation: sql`${workflowWaits.generation} + 1`,
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: now,
    }).where(eq(workflowWaits.id, wait.id)).returning();
    await scoped.update(missions).set({ status: "waiting" }).where(eq(missions.id, input.missionId));
    await setLatestWorkflowStepState(scoped, {
      missionId: input.missionId,
      nodeId: wait.nodeId,
      status: "waiting",
      error: null,
      finishedAt: null,
      now,
    });
    return ready!;
  });
}

export async function finishClaimedWorkflowWaitMission(
  db: Db,
  input: {
    missionId: string;
    claimToken: string;
    status: "succeeded" | "failed" | "cancelled";
    output: unknown;
    error: string | null;
    now?: Date;
  },
): Promise<void> {
  const observed = await getWorkflowWaitForMission(db, input.missionId);
  if (!observed) throw new Error("workflow wait does not exist");
  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = input.now ?? new Date();
    await lockWorkflowWaitContext(scoped, input.missionId, observed.targetRunId);
    const [[wait], [mission], [run]] = await Promise.all([
      scoped.select().from(workflowWaits).where(eq(workflowWaits.id, observed.id)).limit(1),
      scoped.select().from(missions).where(eq(missions.id, input.missionId)).limit(1),
      scoped.select({ state: scienceRuns.state }).from(scienceRuns).where(eq(scienceRuns.id, observed.targetRunId)).limit(1),
    ]);
    if (!wait || !mission || !run) throw new Error("workflow wait context disappeared while finishing mission");
    if (
      isTerminalMissionState(mission.status) &&
      (wait.state === "consumed" || wait.state === "cancelled")
    ) return;
    if (wait.state !== "claimed" || wait.claimToken !== input.claimToken) {
      throw new Error("workflow wait claim was lost before mission completion");
    }
    if (!isTerminalScienceRunState(run.state)) {
      throw new Error("workflow wait target is not terminal at mission completion");
    }
    await scoped.update(workflowWaits).set({
      state: input.status === "cancelled" ? "cancelled" : "consumed",
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: now,
    }).where(eq(workflowWaits.id, wait.id));
    await scoped.update(missions).set({
      status: input.status,
      output: input.output === undefined ? null : input.output,
      error: input.error,
      cancelRequested: input.status === "cancelled" ? true : mission.cancelRequested,
      finishedAt: now,
    }).where(eq(missions.id, input.missionId));
  });
}

export async function cancelWorkflowMissionWait(
  db: Db,
  input: { missionId: string; error?: string; now?: Date },
): Promise<WorkflowWaitRow | null> {
  const observed = await getWorkflowWaitForMission(db, input.missionId);
  if (!observed) return null;
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const now = input.now ?? new Date();
    const error = input.error ?? "cancelled by operator";
    await lockWorkflowWaitContext(scoped, input.missionId, observed.targetRunId);
    const [[wait], [mission]] = await Promise.all([
      scoped.select().from(workflowWaits).where(eq(workflowWaits.id, observed.id)).limit(1),
      scoped.select().from(missions).where(eq(missions.id, input.missionId)).limit(1),
    ]);
    if (!wait || !mission) throw new Error("workflow wait context disappeared while cancelling");
    if (isTerminalMissionState(mission.status)) return wait;
    const [cancelled] = await scoped.update(workflowWaits).set({
      state: "cancelled",
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: now,
    }).where(eq(workflowWaits.id, wait.id)).returning();
    await scoped.update(missions).set({
      status: "cancelled",
      cancelRequested: true,
      error,
      finishedAt: now,
    }).where(eq(missions.id, input.missionId));
    if (!cursorHasWorkflowNode(mission.cursor, wait.nodeId)) {
      await setLatestWorkflowStepState(scoped, {
        missionId: input.missionId,
        nodeId: wait.nodeId,
        status: "skipped",
        error,
        finishedAt: now,
        now,
      });
    }
    return cancelled!;
  });
}

export async function listReadyWorkflowWaits(
  db: Db,
  input: { workspaceId: string; runId?: string; limit?: number },
): Promise<Array<WorkflowWaitRow & { missionStatus: string }>> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const filters = [
    eq(workflowWaits.state, "ready"),
    eq(missions.workspaceId, input.workspaceId),
    eq(missions.status, "waiting"),
    eq(missions.cancelRequested, false),
  ];
  if (input.runId) filters.push(eq(workflowWaits.targetRunId, input.runId));
  return db
    .select({
      id: workflowWaits.id,
      missionId: workflowWaits.missionId,
      nodeId: workflowWaits.nodeId,
      kind: workflowWaits.kind,
      targetRunId: workflowWaits.targetRunId,
      state: workflowWaits.state,
      generation: workflowWaits.generation,
      claimToken: workflowWaits.claimToken,
      claimExpiresAt: workflowWaits.claimExpiresAt,
      createdAt: workflowWaits.createdAt,
      updatedAt: workflowWaits.updatedAt,
      missionStatus: missions.status,
    })
    .from(workflowWaits)
    .innerJoin(missions, eq(workflowWaits.missionId, missions.id))
    .where(and(...filters))
    .orderBy(asc(workflowWaits.updatedAt), asc(workflowWaits.id))
    .limit(limit) as Promise<Array<WorkflowWaitRow & { missionStatus: string }>>;
}

export async function recoverExpiredWorkflowWaitClaims(
  db: Db,
  input: { workspaceId: string; now?: Date; limit?: number },
): Promise<WorkflowWaitRow[]> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const candidates = await db
    .select({ id: workflowWaits.id, missionId: workflowWaits.missionId, targetRunId: workflowWaits.targetRunId })
    .from(workflowWaits)
    .innerJoin(missions, eq(workflowWaits.missionId, missions.id))
    .where(and(
      eq(missions.workspaceId, input.workspaceId),
      eq(workflowWaits.state, "claimed"),
      lte(workflowWaits.claimExpiresAt, now),
    ))
    .orderBy(asc(workflowWaits.claimExpiresAt), asc(workflowWaits.id))
    .limit(limit);
  const recovered: WorkflowWaitRow[] = [];
  for (const candidate of candidates) {
    const row = await db.transaction(async (tx) => {
      const scoped = tx as unknown as Db;
      await lockWorkflowWaitContext(scoped, candidate.missionId, candidate.targetRunId);
      const [[wait], [mission]] = await Promise.all([
        scoped.select().from(workflowWaits).where(eq(workflowWaits.id, candidate.id)).limit(1),
        scoped.select().from(missions).where(eq(missions.id, candidate.missionId)).limit(1),
      ]);
      if (
        !wait || !mission || mission.workspaceId !== input.workspaceId ||
        wait.state !== "claimed" || !wait.claimExpiresAt ||
        wait.claimExpiresAt.getTime() > now.getTime()
      ) return null;
      if (isTerminalMissionState(mission.status)) {
        const [closed] = await scoped.update(workflowWaits).set({
          state: mission.status === "cancelled" ? "cancelled" : "consumed",
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        }).where(eq(workflowWaits.id, wait.id)).returning();
        return closed ?? null;
      }
      if (mission.cancelRequested) {
        const [cancelled] = await scoped.update(workflowWaits).set({
          state: "cancelled",
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        }).where(eq(workflowWaits.id, wait.id)).returning();
        await scoped.update(missions).set({ status: "cancelled", error: "cancelled by operator", finishedAt: now }).where(eq(missions.id, mission.id));
        return cancelled ?? null;
      }
      const [ready] = await scoped.update(workflowWaits).set({
        state: "ready",
        generation: sql`${workflowWaits.generation} + 1`,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: now,
      }).where(eq(workflowWaits.id, wait.id)).returning();
      await scoped.update(missions).set({ status: "waiting" }).where(eq(missions.id, mission.id));
      if (!cursorHasWorkflowNode(mission.cursor, wait.nodeId)) {
        await setLatestWorkflowStepState(scoped, {
          missionId: mission.id,
          nodeId: wait.nodeId,
          status: "waiting",
          error: null,
          finishedAt: null,
          now,
        });
      }
      return ready ?? null;
    });
    if (row) recovered.push(row);
  }
  return recovered;
}
