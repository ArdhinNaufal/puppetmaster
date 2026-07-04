import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Db } from "@puppetmaster/db";
import type { WorkflowExecutor } from "./executor.js";
import { startWorkflow } from "./orchestrator.js";

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

/**
 * Runs missions off a queue so execution is durable and decoupled from HTTP.
 * `QueueRunner` uses BullMQ on Redis (retries + backoff at the job level, plus
 * cron trigger scheduling); `InlineRunner` executes in-process for Redis-free
 * local dev.
 */
export interface WorkflowRunner {
  enqueue(missionId: string): Promise<void>;
  scheduleCron(workflowId: string, cron: string): Promise<void>;
  unscheduleCron(workflowId: string): Promise<void>;
  close(): Promise<void>;
}

const QUEUE_NAME = "puppetmaster-workflows";

export class QueueRunner implements WorkflowRunner {
  private readonly queue: Queue;
  private readonly worker: Worker;

  constructor(url: string, deps: { executor: WorkflowExecutor; db: Db }) {
    const connection = connectionFromUrl(url);
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        if (job.name === "cron") {
          const mission = await startWorkflow(deps.db, {
            workflowId: job.data.workflowId,
            trigger: { mode: "cron" },
            payload: {},
          });
          return deps.executor.runMission(mission.id);
        }
        return deps.executor.runMission(job.data.missionId);
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

  async scheduleCron(workflowId: string, cron: string): Promise<void> {
    await this.queue.upsertJobScheduler(
      `cron:${workflowId}`,
      { pattern: cron },
      { name: "cron", data: { workflowId } },
    );
  }

  async unscheduleCron(workflowId: string): Promise<void> {
    await this.queue.removeJobScheduler(`cron:${workflowId}`);
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}

/** In-process runner for local dev without Redis; cron scheduling is a no-op. */
export class InlineRunner implements WorkflowRunner {
  constructor(private readonly executor: WorkflowExecutor) {}

  async enqueue(missionId: string): Promise<void> {
    void this.executor.runMission(missionId).catch((err) => {
      console.error(`[inline] mission ${missionId} failed:`, err);
    });
  }

  async scheduleCron(): Promise<void> {
    /* cron triggers require the queue runner (Redis) */
  }

  async unscheduleCron(): Promise<void> {}

  async close(): Promise<void> {}
}
