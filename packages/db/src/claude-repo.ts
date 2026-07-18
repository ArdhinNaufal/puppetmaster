import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import type {
  ClaudeEffort,
  ClaudeEventStream,
  ClaudePermissionMode,
  ClaudeRunResult,
  ClaudeRunMode,
  ClaudeRunStatus,
  CodingBackend,
  CodingProvider,
} from "@puppetmaster/shared";
import type { Db } from "./client.js";
import {
  approvals,
  auditLog,
  claudeEvents,
  claudeRuns,
  claudeSessions,
  missions,
  usageLedger,
} from "./schema.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;

function codingProvider(value: unknown): CodingProvider {
  if (value === "anthropic" || value === "openai") return value;
  throw new Error(`Unsupported coding provider: ${String(value)}`);
}

function codingBackend(value: unknown): CodingBackend {
  if (value === "claude" || value === "aider") return value;
  throw new Error(`Unsupported coding backend: ${String(value)}`);
}

function assertProviderBackend(provider: CodingProvider, backend: CodingBackend): void {
  const expected = provider === "openai" ? "aider" : "claude";
  if (backend !== expected) {
    throw new Error(`Invalid coding provider/backend pair: ${provider}/${backend}`);
  }
}

function normalizedCodingModel(provider: CodingProvider, value: unknown): string {
  if (typeof value !== "string") throw new Error("Coding model must be a string");
  const model = value.trim();
  if (!model) throw new Error("Coding model must not be empty");
  if (model.length > 200) throw new Error("Coding model must not exceed 200 characters");
  if (provider === "openai") {
    if (model.toLowerCase().startsWith("openai/")) {
      const suffix = model.slice("openai/".length).trim();
      if (!suffix) throw new Error("OpenAI model must include a name after openai/");
      return `openai/${suffix}`;
    }
    if (model.includes("/")) {
      throw new Error("OpenAI coding sessions only accept OpenAI models (use openai/<model>)");
    }
    return `openai/${model}`;
  }
  if (model.toLowerCase().startsWith("openai/")) {
    throw new Error("Anthropic/Claude sessions do not accept OpenAI model identifiers");
  }
  return model;
}

export class ClaudeSessionBusyError extends Error {
  readonly code = "CLAUDE_SESSION_BUSY";

  constructor(sessionId: string) {
    super(`Claude session ${sessionId} already has an active turn`);
    this.name = "ClaudeSessionBusyError";
  }
}

export async function createClaudeSession(
  db: Db,
  input: {
    workspaceId: string;
    projectId: string;
    provider?: CodingProvider;
    backend?: CodingBackend;
    title: string;
    model: string;
    effort?: ClaudeEffort | null;
    permissionMode: ClaudePermissionMode;
    config?: Record<string, unknown>;
  },
) {
  const provider = codingProvider(input.provider ?? "anthropic");
  const backend = codingBackend(input.backend ?? (provider === "openai" ? "aider" : "claude"));
  assertProviderBackend(provider, backend);
  const model = normalizedCodingModel(provider, input.model);
  const [row] = await db
    .insert(claudeSessions)
    .values({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      provider,
      backend,
      title: input.title,
      model,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode,
      config: input.config ?? {},
    })
    .returning();
  return row!;
}

export async function listClaudeSessions(db: Db, workspaceId: string, limit = 50) {
  return db
    .select()
    .from(claudeSessions)
    .where(eq(claudeSessions.workspaceId, workspaceId))
    .orderBy(desc(claudeSessions.updatedAt))
    .limit(Math.max(1, Math.min(200, limit)));
}

export async function getClaudeSession(db: Db, id: string) {
  const [row] = await db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).limit(1);
  return row ?? null;
}

export async function getClaudeSessionInWorkspace(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(claudeSessions)
    .where(and(eq(claudeSessions.id, id), eq(claudeSessions.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function updateClaudeSession(
  db: Db,
  id: string,
  patch: Partial<Omit<typeof claudeSessions.$inferInsert, "provider" | "backend">>,
) {
  // Provider/backend select the durable runtime and cannot change mid-session.
  const mutablePatch = { ...patch } as Partial<typeof claudeSessions.$inferInsert>;
  delete mutablePatch.provider;
  delete mutablePatch.backend;
  if (mutablePatch.model !== undefined) {
    const current = await getClaudeSession(db, id);
    if (!current) return null;
    const provider = codingProvider(current.provider);
    const backend = codingBackend(current.backend);
    assertProviderBackend(provider, backend);
    mutablePatch.model = normalizedCodingModel(provider, mutablePatch.model);
  }
  const [row] = await db
    .update(claudeSessions)
    .set({ ...mutablePatch, updatedAt: new Date() })
    .where(eq(claudeSessions.id, id))
    .returning();
  return row ?? null;
}

/** Remove a just-created session only when no turn was ever attached. This is
 *  used to clean up an atomic project-busy rejection without deleting durable
 *  failed/history-bearing sessions. */
export async function deleteEmptyClaudeSession(db: Db, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from claude_sessions where id = ${id} for update`);
    const [run] = await tx
      .select({ id: claudeRuns.id })
      .from(claudeRuns)
      .where(eq(claudeRuns.sessionId, id))
      .limit(1);
    if (run) return false;
    const deleted = await tx
      .delete(claudeSessions)
      .where(eq(claudeSessions.id, id))
      .returning({ id: claudeSessions.id });
    return deleted.length > 0;
  });
}

/** Create the Puppetmaster mission and its Claude turn together at the repo
 *  boundary. A rare concurrent turn collision is rejected by the unique
 *  (session_id, turn_number) constraint instead of silently reordering chat. */
export async function createClaudeRunMission(
  db: Db,
  input: {
    sessionId: string;
    mode: ClaudeRunMode;
    prompt: string;
    model: string;
    effort?: ClaudeEffort | null;
    permissionMode: ClaudePermissionMode;
    config?: Record<string, unknown>;
    actorId?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    // Serializes turn allocation and the active-turn check across API and queue
    // workers. The partial unique index in migrate() remains the final backstop.
    await tx.execute(sql`select id from claude_sessions where id = ${input.sessionId} for update`);
    const [session] = await tx
      .select()
      .from(claudeSessions)
      .where(eq(claudeSessions.id, input.sessionId))
      .limit(1);
    if (!session) throw new Error(`Claude session ${input.sessionId} not found`);
    const provider = codingProvider(session.provider);
    const backend = codingBackend(session.backend);
    assertProviderBackend(provider, backend);
    const persistedModel = normalizedCodingModel(provider, session.model);
    if (persistedModel !== session.model) {
      throw new Error(`Claude session ${session.id} has a non-canonical coding model snapshot`);
    }
    const model = normalizedCodingModel(provider, input.model);
    await tx.execute(sql`select id from projects where id = ${session.projectId} for update`);
    const active = await tx
      .select({ id: claudeRuns.id })
      .from(claudeRuns)
      .innerJoin(claudeSessions, eq(claudeRuns.sessionId, claudeSessions.id))
      .where(
        and(
          eq(claudeSessions.projectId, session.projectId),
          inArray(claudeRuns.status, ["queued", "awaiting_approval", "running"]),
        ),
      )
      .limit(1);
    if (active.length > 0) throw new ClaudeSessionBusyError(session.id);
    const [turn] = await tx
      .select({ value: sql<number>`coalesce(max(${claudeRuns.turnNumber}), 0)` })
      .from(claudeRuns)
      .where(eq(claudeRuns.sessionId, session.id));
    const turnNumber = Number(turn?.value ?? 0) + 1;
    const payload = {
      sessionId: session.id,
      provider,
      backend,
      turnNumber,
      mode: input.mode,
      prompt: input.prompt,
      model,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode,
      config: input.config ?? {},
      actorId: input.actorId ?? null,
    };
    const [mission] = await tx
      .insert(missions)
      .values({
        workspaceId: session.workspaceId,
        kind: "claude",
        subjectId: session.projectId,
        workflowVersionId: null,
        parentMissionId: null,
        status: "queued",
        trigger: {
          mode: "claude-code",
          sessionId: session.id,
          provider,
          backend,
          turnNumber,
        },
        input: payload,
        cursor: {},
      })
      .returning();
    const [run] = await tx
      .insert(claudeRuns)
      .values({
        sessionId: session.id,
        missionId: mission!.id,
        provider,
        backend,
        turnNumber,
        mode: input.mode,
        prompt: input.prompt,
        status: "queued",
        model,
        effort: input.effort ?? null,
        permissionMode: input.permissionMode,
        config: input.config ?? {},
      })
      .returning();
    await tx
      .update(claudeSessions)
      .set({
        model,
        effort: input.effort ?? null,
        permissionMode: input.permissionMode,
        updatedAt: new Date(),
      })
      .where(eq(claudeSessions.id, session.id));
    return { mission: mission!, run: run! };
  });
}

/** Atomically claims a queued/approved turn for one queue worker. */
export async function claimClaudeRun(
  db: Db,
  input: { runId: string; missionId: string; startedAt: Date },
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(claudeRuns)
      .set({
        status: "running",
        executionGeneration: sql`${claudeRuns.executionGeneration} + 1`,
        startedAt: input.startedAt,
        error: null,
        updatedAt: input.startedAt,
      })
      .where(
        and(
          eq(claudeRuns.id, input.runId),
          eq(claudeRuns.missionId, input.missionId),
          inArray(claudeRuns.status, ["queued", "awaiting_approval"]),
        ),
      )
      .returning({ executionGeneration: claudeRuns.executionGeneration });
    if (!claimed) return null;
    await tx
      .update(missions)
      .set({ status: "running", startedAt: input.startedAt })
      .where(eq(missions.id, input.missionId));
    return Number(claimed.executionGeneration);
  });
}

/** One pending Claude approval per mission/node, with gate state repaired in
 *  the same transaction after worker restarts or competing deliveries. */
export async function ensureClaudeApproval(
  db: Db,
  input: { runId: string; missionId: string; nodeId: string; prompt: string; tier: string },
) {
  return db.transaction(async (tx) => {
    // Match finishClaudeRun's run -> mission lock order. Besides avoiding a
    // cancellation/gate deadlock, the run lock makes the state check and gate
    // transition one compare-and-transition operation across duplicate queue
    // deliveries.
    await tx.execute(sql`select id from claude_runs where id = ${input.runId} for update`);
    const [run] = await tx
      .select()
      .from(claudeRuns)
      .where(eq(claudeRuns.id, input.runId))
      .limit(1);
    if (!run || run.missionId !== input.missionId) {
      throw new Error(`Claude run ${input.runId} does not belong to mission ${input.missionId}`);
    }
    await tx.execute(sql`select id from missions where id = ${input.missionId} for update`);
    const [mission] = await tx
      .select()
      .from(missions)
      .where(eq(missions.id, input.missionId))
      .limit(1);
    if (!mission) throw new Error(`Claude mission ${input.missionId} not found`);

    const eligibleRun = run.status === "queued" || run.status === "awaiting_approval";
    const eligibleMission = ["queued", "awaiting_approval"].includes(mission.status);
    if (!eligibleRun || !eligibleMission || mission.cancelRequested) {
      // A pending authorization for terminal/cancelled work must not remain in
      // the operator inbox. `rejected` is the existing closed-without-execution
      // state; the mission cancellation audit records why it was retired.
      await tx
        .update(approvals)
        .set({ status: "rejected", decidedAt: new Date() })
        .where(
          and(
            eq(approvals.missionId, input.missionId),
            eq(approvals.nodeId, input.nodeId),
            eq(approvals.status, "pending"),
          ),
        );
      return {
        eligible: false as const,
        approval: null,
        created: false,
        cancelRequested: mission.cancelRequested,
        runStatus: run.status,
      };
    }

    const [existing] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.missionId, input.missionId), eq(approvals.nodeId, input.nodeId)))
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    let approval = existing;
    let created = false;
    if (!approval) {
      [approval] = await tx
        .insert(approvals)
        .values({
          missionId: input.missionId,
          nodeId: input.nodeId,
          prompt: input.prompt,
          tier: input.tier,
          status: "pending",
        })
        .returning();
      created = true;
    }
    if (approval?.status === "pending") {
      await tx.update(missions).set({ status: "awaiting_approval" }).where(eq(missions.id, input.missionId));
      await tx
        .update(claudeRuns)
        .set({ status: "awaiting_approval", updatedAt: new Date() })
        .where(eq(claudeRuns.id, input.runId));
    }
    return {
      eligible: true as const,
      approval: approval!,
      created,
      cancelRequested: false,
      runStatus: approval?.status === "pending" ? "awaiting_approval" : run.status,
    };
  });
}

/** Commits the run/session/mission terminal state together. A guarded status
 *  mismatch returns without mutation. When another worker already committed a
 *  terminal transition, mission state is still reconciled so a crash cannot
 *  leave a terminal run behind a running mission. */
export async function finishClaudeRun(
  db: Db,
  input: {
    runId: string;
    sessionId: string;
    missionId: string;
    status: "succeeded" | "failed" | "cancelled";
    result: ClaudeRunResult | null;
    error: string | null;
    finishedAt: Date;
    /** Exact compare-and-transition status observed by the caller. */
    expectedStatuses: readonly [ClaudeRunStatus];
    /** Required for a running -> terminal transition and forbidden otherwise.
     * This is the generation returned by claimClaudeRun. */
    expectedGeneration?: number;
  },
): Promise<{ transitioned: boolean; status: ClaudeRunStatus }> {
  const expectedStatus = input.expectedStatuses[0];
  if (expectedStatus === "running") {
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration! < 0) {
      throw new Error("Finishing a running Claude run requires its nonnegative execution generation");
    }
  } else if (input.expectedGeneration !== undefined) {
    throw new Error("Claude execution generation may only guard a running terminal transition");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from claude_runs where id = ${input.runId} for update`);
    const [current] = await tx
      .select()
      .from(claudeRuns)
      .where(eq(claudeRuns.id, input.runId))
      .limit(1);
    if (!current) throw new Error(`Claude run ${input.runId} not found`);
    const alreadyTerminal = TERMINAL_RUN_STATUSES.includes(current.status as (typeof TERMINAL_RUN_STATUSES)[number]);
    if (
      current.status !== expectedStatus ||
      (expectedStatus === "running" && current.executionGeneration !== input.expectedGeneration)
    ) {
      return { transitioned: false, status: current.status as ClaudeRunStatus };
    }
    const status = alreadyTerminal
      ? (current.status as "succeeded" | "failed" | "cancelled")
      : input.status;
    const result = alreadyTerminal ? (current.result as ClaudeRunResult | null) : input.result;
    const error = alreadyTerminal ? current.error : input.error;
    const finishedAt = current.finishedAt ?? input.finishedAt;
    const [session] = await tx
      .select()
      .from(claudeSessions)
      .where(eq(claudeSessions.id, input.sessionId))
      .limit(1);
    if (!session) throw new Error(`Claude session ${input.sessionId} not found`);
    if (!alreadyTerminal) {
      const legacyClaude = current.provider === "anthropic" && current.backend === "claude";
      const actorLabel = legacyClaude ? "claude-code" : `${current.provider}-${current.backend}`;
      const usageModel = legacyClaude || current.model.startsWith(`${current.provider}/`)
        ? current.model
        : `${current.provider}/${current.model}`;
      const [updated] = await tx
        .update(claudeRuns)
        .set({
          status,
          result,
          resultText: result?.result ?? null,
          isError: result?.isError ?? (status === "failed"),
          usage: result?.usage ?? null,
          costUsd: result?.totalCostUsd ?? null,
          durationMs: result?.durationMs ?? null,
          durationApiMs: result?.durationApiMs ?? null,
          numTurns: result?.numTurns ?? null,
          error,
          finishedAt,
          updatedAt: input.finishedAt,
        })
        .where(
          and(
            eq(claudeRuns.id, input.runId),
            eq(claudeRuns.status, current.status),
            eq(claudeRuns.executionGeneration, current.executionGeneration),
          ),
        )
        .returning({ id: claudeRuns.id });
      if (!updated) return { transitioned: false, status: current.status as ClaudeRunStatus };
      await tx.insert(auditLog).values({
        workspaceId: session.workspaceId,
        actorKind: "system",
        actorLabel,
        missionId: input.missionId,
        action: legacyClaude ? "claude.run.finished" : `${current.provider}.run.finished`,
        target: input.sessionId,
        detail: {
          runId: input.runId,
          provider: current.provider,
          backend: current.backend,
          status,
          costUsd: result?.totalCostUsd ?? null,
          error,
        },
      });
      if (result?.usage) {
        await tx.insert(auditLog).values({
          workspaceId: session.workspaceId,
          actorKind: "system",
          actorLabel,
          missionId: input.missionId,
          action: "llm.call",
          target: current.model,
          detail: {
            servedBy: current.model,
            provider: current.provider,
            backend: current.backend,
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            },
            costUsd: result.totalCostUsd,
            cli: legacyClaude ? "claude-code" : current.backend,
          },
        });
        await tx.insert(usageLedger).values({
          workspaceId: session.workspaceId,
          agentId: null,
          missionId: input.missionId,
          model: usageModel,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      }
    }
    // Close any authorization that can no longer execute. This keeps the
    // approval inbox consistent with terminal mission state, including legacy
    // rows reconciled by a duplicate delivery.
    await tx
      .update(approvals)
      .set({ status: "rejected", decidedAt: finishedAt })
      .where(and(eq(approvals.missionId, input.missionId), eq(approvals.status, "pending")));
    if (!alreadyTerminal) {
      await tx
        .update(claudeSessions)
        .set({ updatedAt: input.finishedAt })
        .where(eq(claudeSessions.id, session.id));
    }
    await tx
      .update(missions)
      .set({
        status,
        output: result
          ? {
              sessionId: input.sessionId,
              runId: input.runId,
              result: result.result,
              usage: result.usage,
              costUsd: result.totalCostUsd,
            }
          : null,
        error,
        finishedAt,
      })
      .where(eq(missions.id, input.missionId));
    return { transitioned: !alreadyTerminal, status };
  });
}

/** Retry is valid only for the latest turn and only when the session has no
 *  other active work. Run and mission reset together so queue state cannot
 *  diverge from the durable Claude turn. */
export async function resetClaudeRunForRetry(
  db: Db,
  missionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return db.transaction(async (tx) => {
    // Serialize against terminal reconciliation before taking the session
    // lock. finishClaudeRun uses the same run -> session order, so a stale
    // queue delivery cannot deadlock with or overwrite this retry reset.
    await tx.execute(sql`select id from claude_runs where mission_id = ${missionId} for update`);
    const [run] = await tx
      .select()
      .from(claudeRuns)
      .where(eq(claudeRuns.missionId, missionId))
      .limit(1);
    if (!run) return { ok: false, reason: "Claude run not found" };
    if (run.status !== "failed" && run.status !== "cancelled") {
      return { ok: false, reason: `Only failed/cancelled Claude runs can be retried (status: ${run.status})` };
    }
    await tx.execute(sql`select id from claude_sessions where id = ${run.sessionId} for update`);
    const [session] = await tx
      .select()
      .from(claudeSessions)
      .where(eq(claudeSessions.id, run.sessionId))
      .limit(1);
    if (!session) return { ok: false, reason: "Claude session not found" };
    await tx.execute(sql`select id from projects where id = ${session.projectId} for update`);
    const [latest] = await tx
      .select({ value: sql<number>`coalesce(max(${claudeRuns.turnNumber}), 0)` })
      .from(claudeRuns)
      .where(eq(claudeRuns.sessionId, run.sessionId));
    if (run.turnNumber !== Number(latest?.value ?? 0)) {
      return { ok: false, reason: "Only the latest Claude turn can be retried" };
    }
    const active = await tx
      .select({ id: claudeRuns.id })
      .from(claudeRuns)
      .innerJoin(claudeSessions, eq(claudeRuns.sessionId, claudeSessions.id))
      .where(
        and(
          eq(claudeSessions.projectId, session.projectId),
          ne(claudeRuns.id, run.id),
          inArray(claudeRuns.status, ["queued", "awaiting_approval", "running"]),
        ),
      )
      .limit(1);
    if (active.length > 0) return { ok: false, reason: "Another Claude turn is active" };
    if (run.mode === "execute") {
      // A retry is a new authorization decision. The append-only audit log
      // retains the prior decision after its gate row is removed.
      await tx
        .delete(approvals)
        .where(
          and(
            eq(approvals.missionId, missionId),
            eq(approvals.nodeId, "claude.session.start"),
          ),
        );
    }
    await tx
      .update(claudeRuns)
      .set({
        status: "queued",
        result: null,
        resultText: null,
        isError: null,
        usage: null,
        costUsd: null,
        durationMs: null,
        durationApiMs: null,
        numTurns: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(claudeRuns.id, run.id));
    await tx
      .update(missions)
      .set({
        status: "queued",
        error: null,
        finishedAt: null,
        cancelRequested: false,
        retryCount: sql`${missions.retryCount} + 1`,
      })
      .where(eq(missions.id, missionId));
    return { ok: true };
  });
}

export async function getClaudeRun(db: Db, id: string) {
  const [row] = await db.select().from(claudeRuns).where(eq(claudeRuns.id, id)).limit(1);
  return row ?? null;
}

export async function getClaudeRunByMission(db: Db, missionId: string) {
  const [row] = await db
    .select()
    .from(claudeRuns)
    .where(eq(claudeRuns.missionId, missionId))
    .limit(1);
  return row ?? null;
}

export async function listClaudeRuns(db: Db, sessionId: string) {
  return db
    .select()
    .from(claudeRuns)
    .where(eq(claudeRuns.sessionId, sessionId))
    .orderBy(asc(claudeRuns.turnNumber));
}

/** Startup recovery inventory. A `running` row is a durable claim that must
 * either have a copy-back ledger or be terminated and terminalized before a
 * restarted runner can safely accept duplicate delivery. */
export async function listRunningClaudeRuns(db: Db, limit = 1_000) {
  const bounded = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  return db
    .select()
    .from(claudeRuns)
    .where(eq(claudeRuns.status, "running"))
    .orderBy(asc(claudeRuns.createdAt))
    .limit(bounded);
}

export async function hasActiveClaudeRun(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: claudeRuns.id })
    .from(claudeRuns)
    .where(
      and(
        eq(claudeRuns.sessionId, sessionId),
        inArray(claudeRuns.status, ["queued", "awaiting_approval", "running"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function updateClaudeRun(
  db: Db,
  id: string,
  patch: Record<string, unknown>,
) {
  // All run state is now transitioned through claimClaudeRun,
  // finishClaudeRun, or resetClaudeRunForRetry. Keeping a generic patch seam
  // would bypass the status+generation compare-and-transition invariant.
  const attempted = Object.keys(patch)[0];
  if (attempted) throw new Error(`Claude run snapshot field ${attempted} is immutable`);
  return getClaudeRun(db, id);
}

export async function appendClaudeEvent(
  db: Db,
  input: {
    sessionId: string;
    runId: string;
    stream: ClaudeEventStream;
    eventType: string;
    raw: string;
    payload?: unknown;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from claude_sessions where id = ${input.sessionId} for update`);
    const [last] = await tx
      .select({ value: sql<number>`coalesce(max(${claudeEvents.sequence}), 0)` })
      .from(claudeEvents)
      .where(eq(claudeEvents.sessionId, input.sessionId));
    const [row] = await tx
      .insert(claudeEvents)
      .values({
        sessionId: input.sessionId,
        runId: input.runId,
        sequence: Number(last?.value ?? 0) + 1,
        stream: input.stream,
        eventType: input.eventType,
        raw: input.raw,
        payload: input.payload ?? null,
      })
      .returning();
    return row!;
  });
}

export async function listClaudeEvents(
  db: Db,
  sessionId: string,
  opts: { after?: number; before?: number; limit?: number; tail?: boolean } = {},
) {
  const after = Math.max(0, opts.after ?? 0);
  const before = opts.before && opts.before > 0 ? opts.before : null;
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
  const newestFirst = opts.tail === true || before !== null;
  const rows = await db
    .select()
    .from(claudeEvents)
    .where(
      and(
        eq(claudeEvents.sessionId, sessionId),
        gt(claudeEvents.sequence, after),
        ...(before === null ? [] : [lt(claudeEvents.sequence, before)]),
      ),
    )
    .orderBy(newestFirst ? desc(claudeEvents.sequence) : asc(claudeEvents.sequence))
    .limit(limit);
  return newestFirst ? rows.reverse() : rows;
}
