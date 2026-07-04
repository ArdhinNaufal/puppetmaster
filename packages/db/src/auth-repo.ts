import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { memberships, sessions, uiPreferences, users } from "./schema.js";

// --- Users ---------------------------------------------------------------------

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(users);
  return Number(row?.n ?? 0);
}

export async function createUser(
  db: Db,
  input: { email: string; name: string; passwordHash: string },
) {
  const [row] = await db
    .insert(users)
    .values({ email: input.email.toLowerCase(), name: input.name, passwordHash: input.passwordHash })
    .returning();
  return row!;
}

export async function getUserByEmail(db: Db, email: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function getUser(db: Db, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function deleteUser(db: Db, id: string) {
  await db.delete(users).where(eq(users.id, id));
}

// --- Sessions --------------------------------------------------------------------

export async function createSession(
  db: Db,
  input: { token: string; userId: string; expiresAt: Date },
) {
  const [row] = await db.insert(sessions).values(input).returning();
  return row!;
}

/** Resolve a live session token to its user, or null when missing/expired. */
export async function getSessionUser(db: Db, token: string) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.token, token));
}

// --- Memberships -----------------------------------------------------------------

export async function upsertMembership(
  db: Db,
  input: { userId: string; workspaceId: string; role: string },
) {
  const [row] = await db
    .insert(memberships)
    .values(input)
    .onConflictDoUpdate({
      target: [memberships.userId, memberships.workspaceId],
      set: { role: input.role },
    })
    .returning();
  return row!;
}

export async function getMembership(db: Db, userId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Workspace members joined with user identity, for the Admin roster. */
export async function listMembers(db: Db, workspaceId: string) {
  return db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(memberships.createdAt);
}

export async function removeMembership(db: Db, userId: string, workspaceId: string) {
  await db
    .delete(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
}

// --- UI preferences ----------------------------------------------------------------

export async function getUiPreferences(db: Db, userId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(uiPreferences)
    .where(and(eq(uiPreferences.userId, userId), eq(uiPreferences.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function saveUiPreferences(
  db: Db,
  input: { userId: string; workspaceId: string; layout: unknown },
) {
  const [row] = await db
    .insert(uiPreferences)
    .values({ userId: input.userId, workspaceId: input.workspaceId, layout: input.layout })
    .onConflictDoUpdate({
      target: [uiPreferences.userId, uiPreferences.workspaceId],
      set: { layout: input.layout, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
