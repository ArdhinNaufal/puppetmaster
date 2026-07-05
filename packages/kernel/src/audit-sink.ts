/**
 * Audit sink (docs/ARCHITECTURE.md §3.6). The kernel emits audit entries for
 * LLM calls, tool calls, and approval requests through this interface; the
 * server binds it to the append-only `audit_log` table. Best-effort by
 * contract — an implementation must never throw into the caller's hot path.
 */
export interface AuditEntry {
  workspaceId: string;
  actorKind: "user" | "agent" | "system";
  actorId?: string | null;
  actorLabel?: string | null;
  missionId?: string | null;
  /** dotted verb: "llm.call" | "tool.call" | "approval.requested" | … */
  action: string;
  target?: string | null;
  detail?: unknown;
}

export type AuditSink = (entry: AuditEntry) => void | Promise<void>;
