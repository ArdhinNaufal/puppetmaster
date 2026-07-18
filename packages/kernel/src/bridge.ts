import type { CodingBackend, CodingProvider, MissionStatus, StepStatus, WorkflowNodeKind } from "@puppetmaster/shared";

/**
 * Typed events flowing on the kernel bus (Redis streams in production, in-memory
 * for single-process dev). Payloads are plain JSON so they serialize onto a
 * Redis stream unchanged. See docs/ARCHITECTURE.md §3.3.
 */
export type BusEvent =
  | { type: "mission.started"; missionId: string; workflowVersionId?: string; agentId?: string; at: string }
  | { type: "mission.finished"; missionId: string; status: MissionStatus; at: string }
  | {
      type: "agent.message";
      agentId: string;
      missionId: string;
      role: "user" | "assistant" | "tool";
      text: string;
      at: string;
    }
  | {
      type: "mission.step";
      missionId: string;
      nodeId: string;
      kind: WorkflowNodeKind;
      status: StepStatus;
      attempt: number;
      at: string;
      error?: string;
    }
  | {
      type: "approval.requested";
      missionId: string;
      nodeId: string;
      approvalId: string;
      prompt: string;
      at: string;
    }
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string }
  /** Streaming assistant text (Stage 6): progressive chunks of the reply
   *  being generated; the persisted agent.message follows when the turn ends. */
  | { type: "agent.message.delta"; agentId: string; missionId: string; delta: string; at: string }
  | {
      type: "claude.run.started";
      sessionId: string;
      runId: string;
      missionId: string;
      provider: CodingProvider;
      backend: CodingBackend;
      model: string;
      mode: "plan" | "execute";
      at: string;
    }
  | {
      /** Raw Claude stream events are persisted first, then projected here so
       *  the UI can render current and future CLI schemas without data loss. */
      type: "claude.event";
      sessionId: string;
      runId: string;
      missionId: string;
      provider: CodingProvider;
      backend: CodingBackend;
      seq: number;
      stream: "stdout" | "stderr" | "system";
      eventType: string;
      text?: string;
      payload?: unknown;
      at: string;
    }
  | {
      type: "claude.run.finished";
      sessionId: string;
      runId: string;
      missionId: string;
      provider: CodingProvider;
      backend: CodingBackend;
      status: "succeeded" | "failed" | "cancelled";
      costUsd?: number;
      at: string;
    }
  /** Kernel resource sample (docs/PROCESS-WATCH.md): published ~2.5s while
   *  operators are connected. Real process measurements only. */
  | {
      type: "ops.vitals";
      workspaceId: string;
      at: string;
      cpuPct: number;
      rssMb: number;
      heapMb: number;
      loopLagMs: number;
      upSec: number;
      wsClients: number;
      running: number;
      gated: number;
      queued: number;
    }
  /** Safe summary of an audit append (llm.call / tool.call) for the live
   *  process log. Carries identifiers and numbers only — never prompt text,
   *  arguments, or results (full detail stays in the audit table). */
  | {
      type: "audit.appended";
      workspaceId: string;
      at: string;
      action: string;
      actorKind: "user" | "agent" | "system";
      actorLabel: string | null;
      target: string | null;
      missionId: string | null;
      /** llm.call extras when present. */
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      latencyMs?: number;
      /** tool.call extra when present. */
      tier?: string;
    };

export interface EventBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(handler: (event: BusEvent) => void): () => void;
  close?(): Promise<void>;
}

/** In-memory bus for single-process dev; RedisEventBus is the multi-process impl. */
export class InMemoryEventBus implements EventBus {
  private handlers = new Set<(event: BusEvent) => void>();

  async publish(event: BusEvent): Promise<void> {
    for (const handler of this.handlers) handler(event);
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
