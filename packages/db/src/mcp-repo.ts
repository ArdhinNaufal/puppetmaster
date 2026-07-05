import { desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { mcpServers } from "./schema.js";

// --- Workspace MCP server configs (Stage 7, G10) ----------------------------------

export async function createMcpServer(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    transport: string;
    url?: string | null;
    command?: string | null;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    tier?: string;
  },
) {
  const [row] = await db
    .insert(mcpServers)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      transport: input.transport,
      url: input.url ?? null,
      command: input.command ?? null,
      args: input.args ?? [],
      env: input.env ?? {},
      headers: input.headers ?? {},
      tier: input.tier ?? "read_auto",
    })
    .returning();
  return row!;
}

export async function listMcpServers(db: Db, workspaceId: string) {
  return db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.workspaceId, workspaceId))
    .orderBy(desc(mcpServers.createdAt));
}

export async function getMcpServer(db: Db, id: string) {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  return row ?? null;
}

export async function deleteMcpServer(db: Db, id: string) {
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}
