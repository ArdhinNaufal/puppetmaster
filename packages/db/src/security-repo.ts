import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { approvalPolicies, credentials, mcpToolPins } from "./schema.js";

// --- Credentials vault (Stage 1, G3) -------------------------------------------
// Values are sealed by the kernel vault before they reach this repo; nothing
// here ever exposes plaintext, and list() omits the ciphertext entirely.

export async function upsertCredential(
  db: Db,
  input: { workspaceId: string; name: string; encrypted: string },
) {
  const existing = await getCredential(db, input.workspaceId, input.name);
  if (existing) {
    await db
      .update(credentials)
      .set({ encrypted: input.encrypted, updatedAt: new Date() })
      .where(eq(credentials.id, existing.id));
    return { id: existing.id, name: input.name, created: false };
  }
  const [row] = await db.insert(credentials).values(input).returning();
  return { id: row!.id, name: input.name, created: true };
}

/** Full row including ciphertext — for the vault's resolver only. */
export async function getCredential(db: Db, workspaceId: string, name: string) {
  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.name, name)))
    .limit(1);
  return row ?? null;
}

/** Metadata only — the API list surface never includes the ciphertext. */
export async function listCredentials(db: Db, workspaceId: string) {
  return db
    .select({
      id: credentials.id,
      name: credentials.name,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(eq(credentials.workspaceId, workspaceId))
    .orderBy(credentials.name);
}

export async function deleteCredential(db: Db, workspaceId: string, name: string) {
  const existing = await getCredential(db, workspaceId, name);
  if (!existing) return false;
  await db.delete(credentials).where(eq(credentials.id, existing.id));
  return true;
}

// --- MCP tool-description pins (Stage 1, G1) ------------------------------------

export type PinCheck = "new" | "unchanged" | "drifted";

/** Compare a tool's current description hash against its pin; record the pin
 *  on first sight, update it after drift (so each change alerts once). */
export async function checkAndPinToolHash(
  db: Db,
  server: string,
  tool: string,
  hash: string,
): Promise<{ result: PinCheck; previousHash?: string }> {
  const [existing] = await db
    .select()
    .from(mcpToolPins)
    .where(and(eq(mcpToolPins.server, server), eq(mcpToolPins.tool, tool)))
    .limit(1);
  if (!existing) {
    await db.insert(mcpToolPins).values({ server, tool, hash });
    return { result: "new" };
  }
  if (existing.hash === hash) return { result: "unchanged" };
  await db
    .update(mcpToolPins)
    .set({ hash, updatedAt: new Date() })
    .where(eq(mcpToolPins.id, existing.id));
  return { result: "drifted", previousHash: existing.hash };
}

// --- Approval auto-allow policies (Stage 1, G2) ---------------------------------

export async function createApprovalPolicy(
  db: Db,
  input: {
    workspaceId: string;
    agentId?: string | null;
    tool: string;
    predicates: unknown;
    description?: string;
  },
) {
  const [row] = await db
    .insert(approvalPolicies)
    .values({
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      tool: input.tool,
      predicates: input.predicates ?? [],
      description: input.description ?? "",
    })
    .returning();
  return row!;
}

export async function listApprovalPolicies(db: Db, workspaceId: string) {
  return db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.workspaceId, workspaceId))
    .orderBy(desc(approvalPolicies.createdAt));
}

/** Enabled policies applicable to one agent (its own + workspace-wide). */
export async function listPoliciesForAgent(db: Db, workspaceId: string, agentId: string) {
  return db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.workspaceId, workspaceId),
        eq(approvalPolicies.enabled, true),
        or(isNull(approvalPolicies.agentId), eq(approvalPolicies.agentId, agentId)),
      ),
    );
}

export async function updateApprovalPolicy(
  db: Db,
  id: string,
  patch: Partial<typeof approvalPolicies.$inferInsert>,
) {
  await db.update(approvalPolicies).set(patch).where(eq(approvalPolicies.id, id));
}

export async function getApprovalPolicy(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.id, id))
    .limit(1);
  return row ?? null;
}

export async function deleteApprovalPolicy(db: Db, id: string) {
  await db.delete(approvalPolicies).where(eq(approvalPolicies.id, id));
}
