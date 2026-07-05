import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditLog } from "./schema.js";

export interface AuditInput {
  workspaceId: string;
  actorKind?: "user" | "agent" | "system";
  actorId?: string | null;
  actorLabel?: string | null;
  missionId?: string | null;
  action: string;
  target?: string | null;
  detail?: unknown;
}

/** Append one audit entry. The table is write-only — there is no update/delete. */
export async function appendAudit(db: Db, input: AuditInput) {
  const [row] = await db
    .insert(auditLog)
    .values({
      workspaceId: input.workspaceId,
      actorKind: input.actorKind ?? "system",
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      missionId: input.missionId ?? null,
      action: input.action,
      target: input.target ?? null,
      detail: input.detail ?? null,
    })
    .returning();
  return row!;
}

/** Most-recent-first audit entries, optionally filtered by action prefix. */
export async function listAudit(
  db: Db,
  workspaceId: string,
  opts: { limit?: number; action?: string } = {},
) {
  const where = opts.action
    ? and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, opts.action))
    : eq(auditLog.workspaceId, workspaceId);
  return db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(opts.limit ?? 100);
}
