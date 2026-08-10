import {
  appendAudit,
  getAgent,
  getMission,
  getWorkflowWithGraph,
  type Db,
} from "@puppetmaster/db";
import type { AuditEntry, EventBus } from "@puppetmaster/kernel";

/**
 * Bind the kernel's AuditSink to the append-only audit_log table. When a bus
 * is given, llm.call/tool.call appends are additionally broadcast as safe
 * `audit.appended` summaries for the live PROCESS WATCH (docs/PROCESS-WATCH.md)
 * — identifiers and numbers only, never prompts/args/results.
 */
export function createAuditSink(db: Db, bus?: EventBus): (entry: AuditEntry) => Promise<void> {
  return async (entry) => {
    await appendAudit(db, entry);
    if (!bus || (entry.action !== "llm.call" && entry.action !== "tool.call")) return;
    const detail = (entry.detail ?? {}) as {
      usage?: { inputTokens?: number; outputTokens?: number };
      servedBy?: string;
      gated?: boolean;
    };
    try {
      await bus.publish({
        type: "audit.appended",
        workspaceId: entry.workspaceId,
        at: new Date().toISOString(),
        action: entry.action,
        actorKind: entry.actorKind,
        actorLabel: entry.actorLabel ?? null,
        target: entry.target ?? null,
        missionId: entry.missionId ?? null,
        ...(entry.action === "llm.call"
          ? {
              model: detail.servedBy ?? entry.target ?? undefined,
              inputTokens: detail.usage?.inputTokens,
              outputTokens: detail.usage?.outputTokens,
            }
          : {}),
        ...(entry.action === "tool.call" && detail.gated ? { tier: "gated" } : {}),
      });
    } catch {
      /* watch broadcast is best-effort */
    }
  };
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
      } else if (m.kind === "claude") {
        const trigger = m.trigger && typeof m.trigger === "object"
          ? m.trigger as Record<string, unknown>
          : {};
        const actorLabel = trigger.provider === "openai" && trigger.backend === "aider"
          ? "openai-aider"
          : "claude-code";
        ctx = { workspaceId: m.workspaceId, actorKind: "system", actorId: m.subjectId, actorLabel };
      } else if (m.kind === "science") {
        ctx = {
          workspaceId: m.workspaceId,
          actorKind: "system",
          actorId: m.subjectId,
          actorLabel: "science-run",
        };
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
