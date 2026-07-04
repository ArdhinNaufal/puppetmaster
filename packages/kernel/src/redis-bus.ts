import { Redis } from "ioredis";
import type { BusEvent, EventBus } from "./bridge.js";

const STREAM_KEY = "puppetmaster:bus";
const MAXLEN = 10_000;

/**
 * Redis-streams implementation of the kernel bus. `publish` appends to a single
 * capped stream; each subscriber runs a blocking `XREAD` loop from the latest id
 * so events fan out across every server process. Matches the EventBus interface
 * so the rest of the kernel is transport-agnostic (docs/ARCHITECTURE.md §3.3).
 */
export class RedisEventBus implements EventBus {
  private readonly writer: Redis;
  private readonly reader: Redis;
  private handlers = new Set<(event: BusEvent) => void>();
  private running = false;
  private lastId = "$";

  constructor(url: string) {
    this.writer = new Redis(url, { maxRetriesPerRequest: null });
    this.reader = new Redis(url, { maxRetriesPerRequest: null });
  }

  async publish(event: BusEvent): Promise<void> {
    await this.writer.xadd(
      STREAM_KEY,
      "MAXLEN",
      "~",
      String(MAXLEN),
      "*",
      "data",
      JSON.stringify(event),
    );
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.handlers.add(handler);
    if (!this.running) void this.loop();
    return () => this.handlers.delete(handler);
  }

  private async loop(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const res = (await this.reader.xread(
          "BLOCK",
          5000,
          "STREAMS",
          STREAM_KEY,
          this.lastId,
        )) as [string, [string, string[]][]][] | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            this.lastId = id;
            const dataIdx = fields.indexOf("data");
            if (dataIdx === -1) continue;
            try {
              const event = JSON.parse(fields[dataIdx + 1]!) as BusEvent;
              for (const handler of this.handlers) handler(event);
            } catch {
              // ignore malformed entries
            }
          }
        }
      } catch {
        if (!this.running) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async close(): Promise<void> {
    this.running = false;
    this.reader.disconnect();
    this.writer.disconnect();
  }
}
