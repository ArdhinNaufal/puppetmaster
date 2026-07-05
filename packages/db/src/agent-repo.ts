import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentMemories, agentMessages, agents } from "./schema.js";

export async function createAgent(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    persona: string;
    model: string;
    autonomy?: string;
    toolGrants?: string[];
    schedule?: string | null;
  },
) {
  const [row] = await db
    .insert(agents)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      persona: input.persona,
      model: input.model,
      autonomy: input.autonomy ?? "write_approved",
      toolGrants: input.toolGrants ?? [],
      schedule: input.schedule ?? null,
    })
    .returning();
  return row!;
}

export async function listAgents(db: Db, workspaceId: string) {
  return db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(desc(agents.createdAt));
}

export async function getAgent(db: Db, id: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
}

export async function updateAgent(db: Db, id: string, patch: Partial<typeof agents.$inferInsert>) {
  await db.update(agents).set(patch).where(eq(agents.id, id));
}

export async function deleteAgent(db: Db, id: string) {
  await db.delete(agents).where(eq(agents.id, id));
}

export async function appendAgentMessage(
  db: Db,
  input: { agentId: string; missionId?: string | null; role: string; content: unknown },
) {
  const [row] = await db
    .insert(agentMessages)
    .values({
      agentId: input.agentId,
      missionId: input.missionId ?? null,
      role: input.role,
      content: input.content,
    })
    .returning();
  return row!;
}

/** Short-term memory: the most recent conversation window, oldest first. */
export async function getAgentMessages(db: Db, agentId: string, limit = 40) {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.agentId, agentId))
    .orderBy(desc(agentMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function saveMemory(
  db: Db,
  agentId: string,
  content: string,
  opts: { kind?: string; missionId?: string | null; importance?: number; pinned?: boolean } = {},
) {
  const [row] = await db
    .insert(agentMemories)
    .values({
      agentId,
      content,
      kind: opts.kind ?? "fact",
      missionId: opts.missionId ?? null,
      importance: opts.importance ?? 0.5,
      pinned: opts.pinned ?? false,
    })
    .returning();
  return row!;
}

export async function getMemory(db: Db, memoryId: string) {
  const [row] = await db.select().from(agentMemories).where(eq(agentMemories.id, memoryId)).limit(1);
  return row ?? null;
}

export async function updateMemory(
  db: Db,
  memoryId: string,
  patch: Partial<typeof agentMemories.$inferInsert>,
) {
  await db.update(agentMemories).set(patch).where(eq(agentMemories.id, memoryId));
}

export async function deleteMemory(db: Db, memoryId: string) {
  await db.delete(agentMemories).where(eq(agentMemories.id, memoryId));
}

export async function countMemories(db: Db, agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId));
  return Number(row?.n ?? 0);
}

/** Recency signal for decay-based eviction: recalled memories stay alive. */
export async function touchMemories(db: Db, ids: string[]) {
  if (ids.length === 0) return;
  const now = new Date();
  for (const id of ids) {
    await db.update(agentMemories).set({ lastAccessedAt: now }).where(eq(agentMemories.id, id));
  }
}

/**
 * Enforce the per-agent memory cap (Stage 4 admission control): evict the
 * lowest-scoring unpinned memories, where score = importance × exponential
 * recency decay (30-day half-life-ish, per MemoryBank/Ebbinghaus).
 */
export async function evictMemoryOverflow(db: Db, agentId: string, cap: number): Promise<number> {
  const total = await countMemories(db, agentId);
  const overflow = total - cap;
  if (overflow <= 0) return 0;
  await db.execute(
    sql`DELETE FROM agent_memories WHERE id IN (
          SELECT id FROM agent_memories
          WHERE agent_id = ${agentId} AND NOT pinned
          ORDER BY importance * exp(-extract(epoch FROM (now() - coalesce(last_accessed_at, created_at))) / 2592000.0) ASC
          LIMIT ${overflow}
        )`,
  );
  return overflow;
}

/** Persist a memory's embedding into the pgvector column (raw SQL: the column is
 *  added by an ALTER outside the Drizzle schema). Best-effort — swallows the
 *  error when pgvector is unavailable so keyword recall still works. */
export async function setMemoryEmbedding(
  db: Db,
  memoryId: string,
  vectorLiteral: string,
): Promise<boolean> {
  try {
    await db.execute(
      sql`UPDATE agent_memories SET embedding = ${vectorLiteral}::vector WHERE id = ${memoryId}`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Semantic recall over the pgvector column (cosine distance). Returns rows with
 * a `score` in [0,1]; throws when the vector column/extension is unavailable so
 * the caller can fall back to keyword search.
 */
export async function searchMemoriesByVector(
  db: Db,
  agentId: string,
  vectorLiteral: string,
  limit = 5,
  kind?: string,
): Promise<{ id: string; content: string; score: number }[]> {
  const res = await db.execute(
    sql`SELECT id, content, 1 - (embedding <=> ${vectorLiteral}::vector) AS score
        FROM agent_memories
        WHERE agent_id = ${agentId} AND embedding IS NOT NULL
        ${kind ? sql`AND kind = ${kind}` : sql``}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}`,
  );
  const rows = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
  return (rows as { id: string; content: string; score: number | string }[]).map((r) => ({
    id: r.id,
    content: r.content,
    score: Number(r.score),
  }));
}

/** Long-term recall. Keyword search; pgvector similarity is preferred by the
 *  runtime when an embedding provider is configured (see searchMemoriesByVector). */
export async function searchMemories(db: Db, agentId: string, query: string, limit = 5) {
  if (!query.trim()) {
    return db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agentId))
      .orderBy(desc(agentMemories.createdAt))
      .limit(limit);
  }
  return db
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.agentId, agentId), ilike(agentMemories.content, `%${query}%`)))
    .orderBy(desc(agentMemories.createdAt))
    .limit(limit);
}

export async function listMemories(db: Db, agentId: string, limit = 50) {
  return db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(asc(agentMemories.createdAt))
    .limit(limit);
}
