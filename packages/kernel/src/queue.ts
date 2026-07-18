import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Db } from "@puppetmaster/db";
import { startAgentTick, startWorkflow } from "./orchestrator.js";

/** Parse a redis:// URL into BullMQ connection options (its blocking clients
 *  require maxRetriesPerRequest: null). BullMQ owns the resulting connections. */
function connectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname || "127.0.0.1",
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}

export type CronSubjectKind = "workflow" | "agent";

/**
 * Runs missions off a queue so execution is durable and decoupled from HTTP.
 * The `run` dependency dispatches a mission id to the right executor (workflow
 * engine or agent runtime) based on the mission's kind. `QueueRunner` uses
 * BullMQ on Redis; `InlineRunner` executes in-process for Redis-free dev.
 */
export interface WorkflowRunner {
  /** Begin consuming queued work. Queue-backed runners are deliberately
   * constructed paused so startup reconciliation can finish first. */
  start(): Promise<void>;
  enqueue(missionId: string): Promise<void>;
  scheduleCron(kind: CronSubjectKind, subjectId: string, cron: string): Promise<void>;
  unscheduleCron(kind: CronSubjectKind, subjectId: string): Promise<void>;
  close(): Promise<void>;
}

export type MissionDispatcher = (missionId: string) => Promise<unknown>;

const QUEUE_NAME = "puppetmaster-workflows";

export class QueueRunner implements WorkflowRunner {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private started = false;
  private closing = false;
  private runPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(url: string, deps: { run: MissionDispatcher; db: Db }) {
    const connection = connectionFromUrl(url);
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        if (job.name === "cron") {
          const kind = (job.data.kind ?? "workflow") as CronSubjectKind;
          const mission =
            kind === "agent"
              ? await startAgentTick(deps.db, {
                  agentId: job.data.subjectId ?? job.data.workflowId,
                  trigger: { mode: "cron" },
                  payload: {},
                })
              : await startWorkflow(deps.db, {
                  workflowId: job.data.subjectId ?? job.data.workflowId,
                  trigger: { mode: "cron" },
                  payload: {},
                });
          return deps.run(mission.id);
        }
        return deps.run(job.data.missionId);
      },
      // Recovery must run before Redis can deliver an existing job. The server
      // explicitly calls start() only after that reconciliation boundary.
      { connection, autorun: false },
    );
    this.worker.on("failed", (job, err) => {
      console.error(`[queue] job ${job?.id} failed:`, err.message);
    });
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    if (this.started) return;
    this.started = true;
    this.runPromise = this.worker.run();
    // `Worker.run()` remains pending for the worker lifetime. Attach a handler
    // immediately so an infrastructure-level worker failure is never an
    // unhandled rejection; individual job failures use the event above.
    void this.runPromise.catch((err) => {
      if (!this.closing) {
        console.error("[queue] worker stopped unexpectedly:", err instanceof Error ? err.message : err);
      }
    });
  }

  async enqueue(missionId: string): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    await this.queue.add(
      "run",
      { missionId },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 500, removeOnFail: 500 },
    );
  }

  async scheduleCron(kind: CronSubjectKind, subjectId: string, cron: string): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    await this.queue.upsertJobScheduler(
      `cron:${kind}:${subjectId}`,
      { pattern: cron },
      { name: "cron", data: { kind, subjectId } },
    );
  }

  async unscheduleCron(kind: CronSubjectKind, subjectId: string): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    await this.queue.removeJobScheduler(`cron:${kind}:${subjectId}`);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.worker.close();
      if (this.runPromise) await this.runPromise.catch(() => {});
      await this.queue.close();
    })();
    return this.closePromise;
  }
}

/** In-process runner for local dev without Redis; cron scheduling is a no-op. */
export class InlineRunner implements WorkflowRunner {
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly run: MissionDispatcher) {}

  async start(): Promise<void> {
    if (this.closing) throw new Error("inline workflow runner is closing");
  }

  async enqueue(missionId: string): Promise<void> {
    if (this.closing) throw new Error("inline workflow runner is closing");
    // Preserve enqueue's non-blocking handoff semantics while retaining the
    // dispatch promise so close() can drain it before dependencies disappear.
    const dispatch = Promise.resolve().then(() => this.run(missionId));
    this.active.add(dispatch);
    void dispatch
      .catch((err) => {
        console.error(`[inline] mission ${missionId} failed:`, err);
      })
      .finally(() => {
        this.active.delete(dispatch);
      });
  }

  async scheduleCron(): Promise<void> {
    /* cron triggers require the queue runner (Redis) */
  }

  async unscheduleCron(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Set the guard before taking the snapshot. No later enqueue can add work
    // outside the drain set once shutdown has begun.
    this.closing = true;
    this.closePromise = Promise.allSettled([...this.active]).then(() => undefined);
    return this.closePromise;
  }
}
