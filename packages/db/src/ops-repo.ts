import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { budgets, evalRuns, usageLedger } from "./schema.js";

// --- Eval runs (Stage 5, G7) ------------------------------------------------------

export async function insertEvalRun(
  db: Db,
  input: {
    workspaceId: string;
    suite: string;
    k: number;
    passed: number;
    total: number;
    results: unknown;
  },
) {
  const [row] = await db.insert(evalRuns).values(input).returning();
  return row!;
}

export async function listEvalRuns(db: Db, workspaceId: string, limit = 20) {
  return db
    .select()
    .from(evalRuns)
    .where(eq(evalRuns.workspaceId, workspaceId))
    .orderBy(desc(evalRuns.createdAt))
    .limit(limit);
}

// --- Usage ledger + budgets (Stage 5, G8) -----------------------------------------

export async function recordUsage(
  db: Db,
  input: {
    workspaceId: string;
    agentId?: string | null;
    missionId?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
  },
) {
  await db.insert(usageLedger).values({
    workspaceId: input.workspaceId,
    agentId: input.agentId ?? null,
    missionId: input.missionId ?? null,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  });
}

function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Month-to-date token total for the workspace or one agent. */
export async function monthTokens(db: Db, workspaceId: string, agentId?: string): Promise<number> {
  const cond = agentId
    ? and(
        eq(usageLedger.workspaceId, workspaceId),
        eq(usageLedger.agentId, agentId),
        gte(usageLedger.createdAt, monthStart()),
      )
    : and(eq(usageLedger.workspaceId, workspaceId), gte(usageLedger.createdAt, monthStart()));
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(input_tokens + output_tokens), 0)` })
    .from(usageLedger)
    .where(cond);
  return Number(row?.n ?? 0);
}

/** Month-to-date usage grouped by agent + model for the cost view. */
export async function monthUsageBreakdown(db: Db, workspaceId: string) {
  return db
    .select({
      agentId: usageLedger.agentId,
      model: usageLedger.model,
      inputTokens: sql<number>`sum(input_tokens)`,
      outputTokens: sql<number>`sum(output_tokens)`,
      calls: sql<number>`count(*)`,
    })
    .from(usageLedger)
    .where(and(eq(usageLedger.workspaceId, workspaceId), gte(usageLedger.createdAt, monthStart())))
    .groupBy(usageLedger.agentId, usageLedger.model)
    .orderBy(desc(sql`sum(input_tokens + output_tokens)`));
}

export async function createBudget(
  db: Db,
  input: { workspaceId: string; agentId?: string | null; monthlyTokenLimit: number },
) {
  const [row] = await db
    .insert(budgets)
    .values({
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      monthlyTokenLimit: input.monthlyTokenLimit,
    })
    .returning();
  return row!;
}

export async function listBudgets(db: Db, workspaceId: string) {
  return db.select().from(budgets).where(eq(budgets.workspaceId, workspaceId));
}

export async function deleteBudget(db: Db, id: string) {
  await db.delete(budgets).where(eq(budgets.id, id));
}

/** Budgets applying to one agent: its own plus the workspace-wide one. */
export async function budgetsForAgent(db: Db, workspaceId: string, agentId: string) {
  return db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.workspaceId, workspaceId),
        or(isNull(budgets.agentId), eq(budgets.agentId, agentId)),
      ),
    );
}
