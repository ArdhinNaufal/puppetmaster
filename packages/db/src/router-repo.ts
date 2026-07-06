import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { routerProfiles } from "./schema.js";

// --- Router profiles (Stage 9A, 9ROUTER-ADOPTION.md) --------------------------------

export async function createRouterProfile(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    description?: string;
    candidates: { model: string; costClass: string }[];
    minClassForGatedTools?: string | null;
  },
) {
  const [row] = await db
    .insert(routerProfiles)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? "",
      candidates: input.candidates,
      minClassForGatedTools: input.minClassForGatedTools ?? null,
    })
    .returning();
  return row!;
}

export async function listRouterProfiles(db: Db, workspaceId: string) {
  return db
    .select()
    .from(routerProfiles)
    .where(eq(routerProfiles.workspaceId, workspaceId))
    .orderBy(desc(routerProfiles.createdAt));
}

export async function getRouterProfile(db: Db, id: string) {
  const [row] = await db.select().from(routerProfiles).where(eq(routerProfiles.id, id)).limit(1);
  return row ?? null;
}

/** Call-time resolution for `model: "profile:NAME"` — enabled profiles only. */
export async function getRouterProfileByName(db: Db, workspaceId: string, name: string) {
  const [row] = await db
    .select()
    .from(routerProfiles)
    .where(
      and(
        eq(routerProfiles.workspaceId, workspaceId),
        eq(routerProfiles.name, name),
        eq(routerProfiles.enabled, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updateRouterProfile(
  db: Db,
  id: string,
  patch: Partial<typeof routerProfiles.$inferInsert>,
) {
  await db.update(routerProfiles).set(patch).where(eq(routerProfiles.id, id));
}

export async function deleteRouterProfile(db: Db, id: string) {
  await db.delete(routerProfiles).where(eq(routerProfiles.id, id));
}
