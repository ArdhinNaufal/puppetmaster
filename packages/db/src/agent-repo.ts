import { and, asc, desc, eq, ilike } from "drizzle-orm";
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

export async function saveMemory(db: Db, agentId: string, content: string) {
  const [row] = await db.insert(agentMemories).values({ agentId, content }).returning();
  return row!;
}

/** Long-term recall. Keyword search for now; pgvector similarity lands when an
 *  embedding provider is configured (the vector column already exists). */
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
