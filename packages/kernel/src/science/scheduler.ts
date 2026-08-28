import {
  DelayedError,
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
} from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { redactScienceDiagnostic } from "./http-boundary.js";

export interface ScienceTickResult {
  /** Null means the run is terminal or waiting for an external decision. */
  nextPollMs: number | null;
}

export type ScienceTick = (
  runId: string,
  expectedGeneration: number | null,
) => Promise<ScienceTickResult>;

export interface ScienceSchedulerHealth {
  ok: boolean;
  adapter: "bullmq" | "inline";
  state: "not_started" | "running" | "closing";
  pending: number;
  active: number;
  detail?: string;
}

export interface ScienceScheduler {
  /** Begin consuming after startup reconciliation has registered pending work. */
  start(): Promise<void>;
  enqueue(runId: string, expectedGeneration?: number | null, delayMs?: number): Promise<void>;
  health(): Promise<ScienceSchedulerHealth>;
  close(): Promise<void>;
}

export function scienceSchedulerConnectionOptions(
  url: string,
  role: "producer" | "worker",
): RedisOptions {
  const parsed = new URL(url);
  const common: RedisOptions = {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : undefined,
  };
  if (role === "worker") {
    // BullMQ workers use blocking commands and must be allowed to reconnect
    // without flushing an active blocking request.
    return { ...common, maxRetriesPerRequest: null };
  }
  return {
    ...common,
    // HTTP/readiness and reconciliation callers must never queue commands
    // behind an unavailable Redis connection. The client itself keeps
    // reconnecting, but every individual producer command is bounded.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: REDIS_PRODUCER_COMMAND_TIMEOUT_MS,
    commandTimeout: REDIS_PRODUCER_COMMAND_TIMEOUT_MS,
  };
}

const SCIENCE_QUEUE_NAME = "puppetmaster-science";
const DEFAULT_TRANSIENT_RETRY_MS = 500;
const HEALTH_TIMEOUT_MS = 2_000;
const REDIS_PRODUCER_COMMAND_TIMEOUT_MS = 1_500;

function scienceSchedulerQueueIdentifier(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  const normalized = value?.trim() || fallback;
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(normalized)) {
    throw new Error(
      `science scheduler ${label} must be 1-120 ASCII letters, digits, underscores, or hyphens`,
    );
  }
  return normalized;
}

async function waitForRedisReady(connection: Redis): Promise<void> {
  if (connection.status === "ready") return;
  if (connection.status === "end") {
    throw new Error("science queue producer connection is closed");
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      connection.off("ready", onReady);
      connection.off("error", onError);
      connection.off("end", onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("science queue producer connection ended before it was ready"));
    };
    connection.once("ready", onReady);
    connection.once("error", onError);
    connection.once("end", onEnd);
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `science queue producer readiness timed out after ${HEALTH_TIMEOUT_MS}ms`,
        ),
      );
    }, HEALTH_TIMEOUT_MS);
    timer.unref?.();
    // Close the event-registration race if Redis became ready synchronously.
    if (connection.status === "ready") onReady();
  });
}

export function scienceSchedulerJobId(
  runId: string,
  expectedGeneration: number | null,
): string {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId || normalizedRunId.includes(":")) {
    throw new Error("science scheduler run ID must be non-empty and cannot contain ':'");
  }
  if (
    expectedGeneration !== null &&
    (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
  ) {
    throw new Error("science scheduler generation must be a non-negative safe integer");
  }
  return `science-${normalizedRunId}-${expectedGeneration ?? "claim"}`;
}

/**
 * Short-lived BullMQ ticks. Computation continues under a provider handle;
 * workers poll durably instead of keeping an HTTP request, MCP call, or one
 * queue job open for the lifetime of the computation.
 */
export class QueueScienceScheduler implements ScienceScheduler {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly producerConnection: Redis;
  private producerReadyPromise: Promise<void> | null = null;
  private started = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(
    url: string,
    tick: ScienceTick,
    opts?: {
      concurrency?: number;
      transientRetryMs?: number;
      onError?: (message: string, error: unknown) => void;
      /** Test/deployment isolation hook. Omit to retain the production queue. */
      queueName?: string;
      /** BullMQ key prefix. Omit to retain BullMQ's default prefix. */
      queuePrefix?: string;
    },
  ) {
    const queueName = scienceSchedulerQueueIdentifier(
      opts?.queueName,
      SCIENCE_QUEUE_NAME,
      "queue name",
    );
    const queuePrefix = opts?.queuePrefix === undefined
      ? undefined
      : scienceSchedulerQueueIdentifier(
          opts.queuePrefix,
          "",
          "queue prefix",
        );
    const producerConnection = scienceSchedulerConnectionOptions(url, "producer");
    const workerConnection: ConnectionOptions = scienceSchedulerConnectionOptions(
      url,
      "worker",
    );
    const transientRetryMs = Math.max(
      1,
      Math.min(opts?.transientRetryMs ?? DEFAULT_TRANSIENT_RETRY_MS, 60_000),
    );
    this.producerConnection = new Redis(producerConnection);
    this.queue = new Queue(queueName, {
      // BullMQ and the workspace currently resolve separate patch releases of
      // ioredis; the runtime client contract is compatible despite their
      // nominally incompatible private TypeScript members.
      connection: this.producerConnection as unknown as ConnectionOptions,
      // Readiness is checked immediately before every producer operation.
      // Skipping BullMQ's internal wait avoids pinning an uncancellable
      // initialization promise while Redis reconnects in the background.
      skipWaitingForReady: true,
      // The worker connection still performs BullMQ's Redis version check.
      skipVersionCheck: true,
      ...(queuePrefix ? { prefix: queuePrefix } : {}),
    });
    this.worker = new Worker(
      queueName,
      async (job: Job, token?: string) => {
        let result: ScienceTickResult;
        try {
          result = await tick(
            String(job.data.runId),
            typeof job.data.expectedGeneration === "number"
              ? job.data.expectedGeneration
              : null,
          );
        } catch (error) {
          opts?.onError?.(`science tick ${job.id ?? "unknown"} failed`, error);
          if (this.closing) throw error;
          // Keep the same durable job and deterministic ID. DelayedError tells
          // BullMQ that the processor deliberately moved the active job rather
          // than completing or consuming an attempt.
          await job.moveToDelayed(Date.now() + transientRetryMs, token);
          throw new DelayedError();
        }
        if (result.nextPollMs !== null && !this.closing) {
          await job.moveToDelayed(
            Date.now() + Math.max(0, result.nextPollMs),
            token,
          );
          throw new DelayedError();
        }
        return result;
      },
      {
        connection: workerConnection,
        autorun: false,
        concurrency: Math.max(1, Math.min(opts?.concurrency ?? 4, 32)),
        ...(queuePrefix ? { prefix: queuePrefix } : {}),
      },
    );
    this.queue.on("error", (error) => {
      opts?.onError?.("science queue producer connection failed", error);
    });
    this.worker.on("error", (error) => {
      opts?.onError?.("science queue worker connection failed", error);
    });
    this.worker.on("failed", (job, error) => {
      opts?.onError?.(`science tick ${job?.id ?? "unknown"} failed`, error);
    });
  }

  private async ensureProducerReady(): Promise<void> {
    if (this.producerConnection.status === "ready") return;
    if (!this.producerReadyPromise) {
      const pending = waitForRedisReady(this.producerConnection).finally(() => {
        if (this.producerReadyPromise === pending) this.producerReadyPromise = null;
      });
      this.producerReadyPromise = pending;
    }
    await this.producerReadyPromise;
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error("science queue scheduler is closing");
    if (this.started) return;
    this.started = true;
    this.runPromise = this.worker.run();
    void this.runPromise.catch(() => {
      /* worker-level failure is surfaced through health/logging by the host */
    });
  }

  async enqueue(
    runId: string,
    expectedGeneration: number | null = null,
    delayMs = 0,
  ): Promise<void> {
    if (this.closing) throw new Error("science queue scheduler is closing");
    await this.ensureProducerReady();
    if (this.closing) throw new Error("science queue scheduler is closing");
    await this.queue.add(
      "tick",
      { runId, expectedGeneration },
      {
        jobId: scienceSchedulerJobId(runId, expectedGeneration),
        delay: Math.max(0, delayMs),
        attempts: 5,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async health(): Promise<ScienceSchedulerHealth> {
    const state = this.closing
      ? "closing"
      : this.started
        ? "running"
        : "not_started";
    if (state !== "running") {
      return {
        ok: false,
        adapter: "bullmq",
        state,
        pending: 0,
        active: 0,
        detail: `science queue scheduler is ${state.replace("_", " ")}`,
      };
    }
    try {
      await this.ensureProducerReady();
      const counts = await this.queue.getJobCounts(
        "waiting",
        "delayed",
        "active",
        "paused",
      );
      return {
        ok: true,
        adapter: "bullmq",
        state,
        pending:
          (counts.waiting ?? 0) +
          (counts.delayed ?? 0) +
          (counts.paused ?? 0),
        active: counts.active ?? 0,
      };
    } catch (error) {
      return {
        ok: false,
        adapter: "bullmq",
        state,
        pending: 0,
        active: 0,
        detail: redactScienceDiagnostic(error, 1_000),
      };
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.worker.close();
        if (this.runPromise) await this.runPromise.catch(() => {});
        await this.queue.close();
      } finally {
        // The producer client is shared with BullMQ, so Queue.close() does not
        // own it. Always stop its reconnect loop, including partial teardown.
        this.producerConnection.disconnect();
      }
    })();
    return this.closePromise;
  }
}

export class InlineScienceScheduler implements ScienceScheduler {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly pending: Array<{
    runId: string;
    expectedGeneration: number | null;
    delayMs: number;
  }> = [];
  private started = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly transientRetryMs: number;

  constructor(
    private readonly tick: ScienceTick,
    private readonly onError?: (message: string, error: unknown) => void,
    opts?: { transientRetryMs?: number },
  ) {
    this.transientRetryMs = Math.max(
      1,
      Math.min(opts?.transientRetryMs ?? DEFAULT_TRANSIENT_RETRY_MS, 60_000),
    );
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error("inline science scheduler is closing");
    if (this.started) return;
    this.started = true;
    for (const item of this.pending.splice(0)) this.schedule(item);
  }

  async enqueue(
    runId: string,
    expectedGeneration: number | null = null,
    delayMs = 0,
  ): Promise<void> {
    if (this.closing) throw new Error("inline science scheduler is closing");
    const item = { runId, expectedGeneration, delayMs: Math.max(0, delayMs) };
    if (!this.started) {
      this.pending.push(item);
      return;
    }
    this.schedule(item);
  }

  private schedule(item: {
    runId: string;
    expectedGeneration: number | null;
    delayMs: number;
  }): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closing) return;
      let running: Promise<void>;
      running = this.tick(item.runId, item.expectedGeneration)
        .then(async (result) => {
          if (result.nextPollMs !== null && !this.closing) {
            await this.enqueue(item.runId, item.expectedGeneration, result.nextPollMs);
          }
        })
        .catch((error) => {
          this.onError?.(`science tick for ${item.runId} failed`, error);
          if (!this.closing) {
            this.schedule({
              runId: item.runId,
              expectedGeneration: item.expectedGeneration,
              delayMs: this.transientRetryMs,
            });
          }
        })
        .finally(() => {
          this.active.delete(running);
        });
      this.active.add(running);
    }, item.delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  async health(): Promise<ScienceSchedulerHealth> {
    const state = this.closing
      ? "closing"
      : this.started
        ? "running"
        : "not_started";
    return {
      ok: state === "running",
      adapter: "inline",
      state,
      pending: this.pending.length + this.timers.size,
      active: this.active.size,
      ...(state === "running"
        ? {}
        : { detail: `inline science scheduler is ${state.replace("_", " ")}` }),
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.length = 0;
    this.closePromise = Promise.allSettled([...this.active]).then(() => undefined);
    return this.closePromise;
  }
}
