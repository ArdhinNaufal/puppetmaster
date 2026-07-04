import type { MissionStatus, StepStatus, WorkflowNodeKind } from "@puppetmaster/shared";

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
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string };

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
