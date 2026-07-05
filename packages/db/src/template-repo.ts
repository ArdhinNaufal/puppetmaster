import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { templates } from "./schema.js";

export interface TemplateInput {
  workspaceId?: string | null;
  kind: "workflow" | "agent";
  name: string;
  description?: string;
  category?: string;
  spec: unknown;
  builtin?: boolean;
}

export async function createTemplate(db: Db, input: TemplateInput) {
  const [row] = await db
    .insert(templates)
    .values({
      workspaceId: input.workspaceId ?? null,
      kind: input.kind,
      name: input.name,
      description: input.description ?? "",
      category: input.category ?? "general",
      spec: input.spec,
      builtin: input.builtin ?? false,
    })
    .returning();
  return row!;
}

/** First-party (global) templates plus any the workspace has published. */
export async function listTemplates(db: Db, workspaceId: string) {
  return db
    .select()
    .from(templates)
    .where(or(isNull(templates.workspaceId), eq(templates.workspaceId, workspaceId)))
    .orderBy(desc(templates.builtin), desc(templates.createdAt));
}

export async function getTemplate(db: Db, id: string) {
  const [row] = await db.select().from(templates).where(eq(templates.id, id)).limit(1);
  return row ?? null;
}

export async function deleteTemplate(db: Db, id: string) {
  await db.delete(templates).where(eq(templates.id, id));
}

async function countBuiltins(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(templates)
    .where(eq(templates.builtin, true));
  return Number(row?.n ?? 0);
}

/** Idempotently seed the first-party catalog: only inserts a builtin whose
 *  name isn't already present, so re-runs and added seeds are both safe. */
export async function seedBuiltinTemplates(db: Db, seeds: TemplateInput[]): Promise<number> {
  if (seeds.length === 0) return 0;
  const existing = await db
    .select({ name: templates.name })
    .from(templates)
    .where(and(eq(templates.builtin, true), isNull(templates.workspaceId)));
  const have = new Set(existing.map((r) => r.name));
  let inserted = 0;
  for (const seed of seeds) {
    if (have.has(seed.name)) continue;
    await createTemplate(db, { ...seed, workspaceId: null, builtin: true });
    inserted++;
  }
  return inserted;
}

export { countBuiltins as countBuiltinTemplates };
