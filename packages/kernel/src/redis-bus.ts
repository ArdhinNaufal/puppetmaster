import { Redis, type RedisOptions } from "ioredis";
import type { BusEvent, EventBus } from "./bridge.js";

const STREAM_KEY = "puppetmaster:bus";
const MAXLEN = 10_000;
export const REDIS_EVENT_PUBLISH_TIMEOUT_MS = 1_500;

export interface RedisEventBusOptions {
  publishTimeoutMs?: number;
  /** Dependency seam for deterministic transport-failure verification. */
  clientFactory?: (url: string, role: "writer" | "reader") => Redis;
}

export function redisEventBusConnectionOptions(
  role: "writer" | "reader",
  publishTimeoutMs = REDIS_EVENT_PUBLISH_TIMEOUT_MS,
): RedisOptions {
  return role === "writer"
    ? {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: publishTimeoutMs,
        commandTimeout: publishTimeoutMs,
      }
    : { maxRetriesPerRequest: null };
}

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
  private readonly publishTimeoutMs: number;

  constructor(url: string, options: RedisEventBusOptions = {}) {
    const publishTimeoutMs = options.publishTimeoutMs ?? REDIS_EVENT_PUBLISH_TIMEOUT_MS;
    if (!Number.isSafeInteger(publishTimeoutMs) || publishTimeoutMs < 1 || publishTimeoutMs > 60_000) {
      throw new Error("Redis event publish timeout must be an integer between 1 and 60000 ms");
    }
    this.publishTimeoutMs = publishTimeoutMs;
    const clientFactory = options.clientFactory ?? ((redisUrl: string, role: "writer" | "reader") =>
      new Redis(redisUrl, redisEventBusConnectionOptions(role, publishTimeoutMs)));
    this.writer = clientFactory(url, "writer");
    this.reader = clientFactory(url, "reader");
  }

  async publish(event: BusEvent): Promise<void> {
    const operation = this.writer.xadd(
      STREAM_KEY,
      "MAXLEN",
      "~",
      String(MAXLEN),
      "*",
      "data",
      JSON.stringify(event),
    );
    // Stream delivery is advisory: authoritative state is committed in the
    // database before callers publish. Redis failure or disconnection must not
    // strand that committed API/tick work, nor retain an unbounded offline
    // command queue while Redis is unavailable.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, this.publishTimeoutMs);
      void operation.then(finish, finish);
    });
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
