import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Db } from "@puppetmaster/db";
import { startAgentTick, startWorkflow } from "./orchestrator.js";

/** Parse a redis:// URL into BullMQ connection options (its blocking clients
 *  require maxRetriesPerRequest: null). BullMQ owns the resulting connections. */
export function workflowQueueConnectionOptions(url: string): ConnectionOptions {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    throw new Error("workflow queue URL must use redis:// or rediss://");
  }
  return {
    host: u.hostname || "127.0.0.1",
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
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
  enqueue(missionId: string, dedupeKey?: string): Promise<void>;
  scheduleCron(kind: CronSubjectKind, subjectId: string, cron: string): Promise<void>;
  unscheduleCron(kind: CronSubjectKind, subjectId: string): Promise<void>;
  close(): Promise<void>;
}

export type MissionDispatcher = (missionId: string) => Promise<unknown>;

const QUEUE_NAME_PREFIX = "puppetmaster-workflows";
const QUEUE_DEDUPE_KEY = /^[A-Za-z0-9_-]{1,200}$/;
const QUEUE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedQueueUuid(value: string, label: string): string {
  if (!QUEUE_UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}

/** Redis queue namespace owned by one exact workspace. */
export function workflowQueueName(workspaceId: string): string {
  return `${QUEUE_NAME_PREFIX}-${checkedQueueUuid(workspaceId, "workspace id")}`;
}

/** Bounded scheduler identity; also workspace-qualified for diagnostics/export. */
export function workflowCronSchedulerId(
  workspaceId: string,
  kind: CronSubjectKind,
  subjectId: string,
): string {
  const workspace = checkedQueueUuid(workspaceId, "workspace id");
  const subject = checkedQueueUuid(subjectId, `${kind} id`);
  return `cron:${workspace}:${kind}:${subject}`;
}

function checkedDedupeKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!QUEUE_DEDUPE_KEY.test(value)) {
    throw new Error("workflow queue dedupe key must contain only letters, numbers, underscores, or hyphens");
  }
  return value;
}

export class QueueRunner implements WorkflowRunner {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly workspaceId: string;
  private started = false;
  private closing = false;
  private runPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(url: string, deps: { run: MissionDispatcher; db: Db; workspaceId: string }) {
    const connection = workflowQueueConnectionOptions(url);
    this.workspaceId = checkedQueueUuid(deps.workspaceId, "workspace id");
    const queueName = workflowQueueName(this.workspaceId);
    this.queue = new Queue(queueName, { connection });
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        if (job.name === "cron") {
          const kind = (job.data.kind ?? "workflow") as CronSubjectKind;
          const mission =
            kind === "agent"
              ? await startAgentTick(deps.db, {
                  workspaceId: this.workspaceId,
                  agentId: job.data.subjectId ?? job.data.workflowId,
                  trigger: { mode: "cron" },
                  payload: {},
                })
              : await startWorkflow(deps.db, {
                  workspaceId: this.workspaceId,
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

  async enqueue(missionId: string, dedupeKey?: string): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    const jobId = checkedDedupeKey(dedupeKey);
    if (jobId) {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state !== "completed" && state !== "failed") return;
        await existing.remove().catch(() => {});
      }
    }
    await this.queue.add(
      "run",
      { missionId },
      {
        ...(jobId ? { jobId } : {}),
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  }

  async scheduleCron(kind: CronSubjectKind, subjectId: string, cron: string): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    await this.queue.upsertJobScheduler(
      workflowCronSchedulerId(this.workspaceId, kind, subjectId),
      { pattern: cron },
      { name: "cron", data: { kind, subjectId } },
    );
  }

  async unscheduleCron(kind: CronSubjectKind, subjectId: string): Promise<void> {
    if (this.closing) throw new Error("workflow queue runner is closing");
    await this.queue.removeJobScheduler(
      workflowCronSchedulerId(this.workspaceId, kind, subjectId),
    );
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
  private readonly activeKeys = new Set<string>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly run: MissionDispatcher) {}

  async start(): Promise<void> {
    if (this.closing) throw new Error("inline workflow runner is closing");
  }

  async enqueue(missionId: string, dedupeKey?: string): Promise<void> {
    if (this.closing) throw new Error("inline workflow runner is closing");
    const key = checkedDedupeKey(dedupeKey);
    if (key && this.activeKeys.has(key)) return;
    if (key) this.activeKeys.add(key);
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
        if (key) this.activeKeys.delete(key);
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
