import type { Mission } from "@puppetmaster/shared";

/** Typed events flowing on the kernel bus (Redis streams in production). */
export type BusEvent =
  | { type: "mission.started"; mission: Mission }
  | { type: "mission.finished"; mission: Mission }
  | { type: "approval.requested"; missionId: string; action: string }
  | { type: "approval.resolved"; missionId: string; approved: boolean };

export interface EventBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(handler: (event: BusEvent) => void): () => void;
}

/** In-memory bus for M0/local development; swapped for Redis streams in M1. */
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
