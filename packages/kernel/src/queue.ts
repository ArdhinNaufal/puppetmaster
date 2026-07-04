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
      { connection },
    );
    this.worker.on("failed", (job, err) => {
      console.error(`[queue] job ${job?.id} failed:`, err.message);
    });
  }

  async enqueue(missionId: string): Promise<void> {
    await this.queue.add(
      "run",
      { missionId },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 500, removeOnFail: 500 },
    );
  }

  async scheduleCron(kind: CronSubjectKind, subjectId: string, cron: string): Promise<void> {
    await this.queue.upsertJobScheduler(
      `cron:${kind}:${subjectId}`,
      { pattern: cron },
      { name: "cron", data: { kind, subjectId } },
    );
  }

  async unscheduleCron(kind: CronSubjectKind, subjectId: string): Promise<void> {
    await this.queue.removeJobScheduler(`cron:${kind}:${subjectId}`);
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}

/** In-process runner for local dev without Redis; cron scheduling is a no-op. */
export class InlineRunner implements WorkflowRunner {
  constructor(private readonly run: MissionDispatcher) {}

  async enqueue(missionId: string): Promise<void> {
    void this.run(missionId).catch((err) => {
      console.error(`[inline] mission ${missionId} failed:`, err);
    });
  }

  async scheduleCron(): Promise<void> {
    /* cron triggers require the queue runner (Redis) */
  }

  async unscheduleCron(): Promise<void> {}

  async close(): Promise<void> {}
}
