import {
  appendAudit,
  getAgent,
  getMission,
  getWorkflowWithGraph,
  type Db,
} from "@puppetmaster/db";
import type { AuditEntry, EventBus } from "@puppetmaster/kernel";

/** Bind the kernel's AuditSink to the append-only audit_log table. */
export function createAuditSink(db: Db): (entry: AuditEntry) => Promise<void> {
  return (entry) => appendAudit(db, entry).then(() => {});
}

interface MissionActor {
  workspaceId: string;
  actorKind: "agent" | "system";
  actorId: string;
  actorLabel: string;
}

/**
 * Project mission lifecycle and approval-request events off the bus into the
 * audit log (ARCHITECTURE.md §3.6). LLM/tool-call entries are written directly
 * by the kernel via the AuditSink; approval *decisions* and auth/member actions
 * are written at their endpoints with the acting user's identity.
 */
export function startAuditProjector(bus: EventBus, db: Db): () => void {
  const cache = new Map<string, MissionActor | null>();

  const actorFor = async (missionId: string): Promise<MissionActor | null> => {
    if (cache.has(missionId)) return cache.get(missionId)!;
    const m = await getMission(db, missionId);
    let ctx: MissionActor | null = null;
    if (m) {
      if (m.kind === "agent") {
        const a = await getAgent(db, m.subjectId);
        ctx = { workspaceId: m.workspaceId, actorKind: "agent", actorId: m.subjectId, actorLabel: a?.name ?? "agent" };
      } else {
        const wf = await getWorkflowWithGraph(db, m.subjectId);
        ctx = { workspaceId: m.workspaceId, actorKind: "system", actorId: m.subjectId, actorLabel: `workflow:${wf?.workflow.name ?? "?"}` };
      }
    }
    cache.set(missionId, ctx);
    return ctx;
  };

  return bus.subscribe((event) => {
    void (async () => {
      try {
        if (event.type === "mission.started" || event.type === "mission.finished") {
          const ctx = await actorFor(event.missionId);
          if (!ctx) return;
          await appendAudit(db, {
            ...ctx,
            missionId: event.missionId,
            action: event.type,
            detail: event.type === "mission.finished" ? { status: event.status } : null,
          });
        } else if (event.type === "approval.requested") {
          const ctx = await actorFor(event.missionId);
          if (!ctx) return;
          await appendAudit(db, {
            ...ctx,
            missionId: event.missionId,
            action: "approval.requested",
            target: event.nodeId,
            detail: { prompt: event.prompt },
          });
        }
      } catch {
        /* audit projection is best-effort */
      }
    })();
  });
}
