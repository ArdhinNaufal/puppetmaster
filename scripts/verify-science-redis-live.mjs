#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  QueueScienceScheduler,
  scienceSchedulerConnectionOptions,
  scienceSchedulerJobId,
} from "../packages/kernel/dist/index.js";

const kernelRequire = createRequire(
  new URL("../packages/kernel/package.json", import.meta.url),
);
const { Queue } = kernelRequire("bullmq");
const { Redis } = kernelRequire("ioredis");

const redisUrl = process.env.SCIENCE_TEST_REDIS_URL?.trim() ?? "";
const LIVE_TIMEOUT_MS = 15_000;

function requireLiveConfiguration() {
  assert.ok(
    redisUrl,
    "SCIENCE_TEST_REDIS_URL is required for the opt-in live Redis verifier",
  );
  assert.equal(
    process.env.SCIENCE_TEST_REDIS_ALLOW_SCOPED_DELETE,
    "1",
    "SCIENCE_TEST_REDIS_ALLOW_SCOPED_DELETE=1 is required; the verifier removes only its unique BullMQ queue",
  );
  let parsed;
  try {
    parsed = new URL(redisUrl);
  } catch {
    assert.fail("SCIENCE_TEST_REDIS_URL must be an absolute redis:// or rediss:// URL");
  }
  assert.ok(
    parsed.protocol === "redis:" || parsed.protocol === "rediss:",
    "SCIENCE_TEST_REDIS_URL must use redis:// or rediss://",
  );
}

function withTimeout(promise, label, timeoutMs = LIVE_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(check, label, timeoutMs = LIVE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let latest = "not observed";
  while (Date.now() < deadline) {
    latest = await check();
    if (latest === true) return;
    await delay(25);
  }
  throw new Error(`${label} was not observed; last state ${String(latest)}`);
}

async function scanKeys(connection, pattern) {
  let cursor = "0";
  const keys = [];
  do {
    const [nextCursor, page] = await connection.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...page);
    assert.ok(keys.length <= 1_000, "isolated live Redis queue exceeded its key bound");
  } while (cursor !== "0");
  return keys.sort();
}

async function jobState(queue, jobId) {
  const job = await queue.getJob(jobId);
  return job ? job.getState() : "absent";
}

async function closeScheduler(scheduler) {
  if (scheduler) await withTimeout(scheduler.close(), "science scheduler close");
}

async function main() {
  requireLiveConfiguration();

  const scope = randomUUID().replaceAll("-", "");
  const queueName = `science-live-${scope}`;
  const queuePrefix = `puppetmaster-science-live-${scope}`;
  const queueKeyPattern = `${queuePrefix}:${queueName}:*`;
  const sentinelKey = `puppetmaster-science-live-sentinel-${scope}`;
  const schedulerOptions = {
    concurrency: 2,
    transientRetryMs: 800,
    queueName,
    queuePrefix,
  };

  const control = new Redis({
    ...scienceSchedulerConnectionOptions(redisUrl, "producer"),
    lazyConnect: true,
  });
  control.on("error", () => {
    // Command failures are asserted through awaited operations below.
  });
  let observer = null;
  let scheduler = null;
  let completed = false;

  try {
    await withTimeout(control.connect(), "live Redis connection");
    assert.equal(await withTimeout(control.ping(), "live Redis PING"), "PONG");
    const persistence = await withTimeout(
      control.info("persistence"),
      "live Redis persistence inspection",
    );
    assert.match(
      persistence,
      /(?:^|\r?\n)aof_enabled:1(?:\r?\n|$)/,
      "live Redis must have AOF enabled for the MVP durability lane",
    );
    assert.deepEqual(await scanKeys(control, queueKeyPattern), []);
    await control.set(sentinelKey, "verifier-owned", "EX", 300);

    observer = new Queue(queueName, {
      connection: scienceSchedulerConnectionOptions(redisUrl, "worker"),
      prefix: queuePrefix,
    });
    await withTimeout(observer.waitUntilReady(), "BullMQ observer readiness");
    console.log("ok - live Redis reports AOF persistence and accepts an isolated BullMQ queue");

    const duplicateRunId = randomUUID();
    let duplicateCalls = 0;
    let resolveDuplicateEntered;
    const duplicateEntered = new Promise((resolve) => {
      resolveDuplicateEntered = resolve;
    });
    let releaseDuplicate;
    const duplicateRelease = new Promise((resolve) => {
      releaseDuplicate = resolve;
    });
    scheduler = new QueueScienceScheduler(
      redisUrl,
      async (runId, expectedGeneration) => {
        assert.equal(runId, duplicateRunId);
        assert.equal(expectedGeneration, 7);
        duplicateCalls++;
        resolveDuplicateEntered();
        await duplicateRelease;
        return { nextPollMs: null };
      },
      schedulerOptions,
    );
    assert.equal((await scheduler.health()).state, "not_started");
    await scheduler.start();
    const runningHealth = await scheduler.health();
    assert.deepEqual(
      {
        ok: runningHealth.ok,
        adapter: runningHealth.adapter,
        state: runningHealth.state,
      },
      { ok: true, adapter: "bullmq", state: "running" },
    );
    await Promise.all(
      Array.from({ length: 8 }, () => scheduler.enqueue(duplicateRunId, 7)),
    );
    await withTimeout(duplicateEntered, "duplicate BullMQ delivery");
    assert.equal(
      await jobState(observer, scienceSchedulerJobId(duplicateRunId, 7)),
      "active",
    );
    assert.equal(duplicateCalls, 1, "duplicate enqueue created a second live tick");
    releaseDuplicate();
    await waitFor(
      async () =>
        (await jobState(observer, scienceSchedulerJobId(duplicateRunId, 7))) ===
        "absent",
      "duplicate job completion",
    );
    assert.equal(duplicateCalls, 1);
    await closeScheduler(scheduler);
    scheduler = null;
    console.log("ok - concurrent duplicate enqueue creates one live BullMQ tick");

    const pollRunId = randomUUID();
    let initialPollCalls = 0;
    let resolveInitialPoll;
    const initialPoll = new Promise((resolve) => {
      resolveInitialPoll = resolve;
    });
    scheduler = new QueueScienceScheduler(
      redisUrl,
      async (runId, expectedGeneration) => {
        assert.equal(runId, pollRunId);
        assert.equal(expectedGeneration, 3);
        initialPollCalls++;
        resolveInitialPoll();
        return { nextPollMs: 800 };
      },
      schedulerOptions,
    );
    await scheduler.start();
    await scheduler.enqueue(pollRunId, 3);
    await withTimeout(initialPoll, "initial delayed poll tick");
    const pollJobId = scienceSchedulerJobId(pollRunId, 3);
    await waitFor(
      async () => (await jobState(observer, pollJobId)) === "delayed",
      "durable delayed poll state",
    );
    await closeScheduler(scheduler);
    scheduler = null;
    assert.equal(await jobState(observer, pollJobId), "delayed");

    let recoveredPollCalls = 0;
    let resolveRecoveredPoll;
    const recoveredPoll = new Promise((resolve) => {
      resolveRecoveredPoll = resolve;
    });
    scheduler = new QueueScienceScheduler(
      redisUrl,
      async (runId, expectedGeneration) => {
        assert.equal(runId, pollRunId);
        assert.equal(expectedGeneration, 3);
        recoveredPollCalls++;
        resolveRecoveredPoll();
        return { nextPollMs: null };
      },
      schedulerOptions,
    );
    await scheduler.start();
    await withTimeout(recoveredPoll, "delayed poll recovery after scheduler restart");
    await waitFor(
      async () => (await jobState(observer, pollJobId)) === "absent",
      "recovered delayed poll completion",
    );
    assert.equal(initialPollCalls, 1);
    assert.equal(recoveredPollCalls, 1);
    await closeScheduler(scheduler);
    scheduler = null;
    console.log("ok - a delayed poll survives scheduler teardown and is consumed after restart");

    const retryRunId = randomUUID();
    const retryErrors = [];
    let initialRetryCalls = 0;
    let resolveInitialRetry;
    const initialRetry = new Promise((resolve) => {
      resolveInitialRetry = resolve;
    });
    scheduler = new QueueScienceScheduler(
      redisUrl,
      async (runId, expectedGeneration) => {
        assert.equal(runId, retryRunId);
        assert.equal(expectedGeneration, 9);
        initialRetryCalls++;
        resolveInitialRetry();
        throw new Error("deliberate-live-redis-transient");
      },
      {
        ...schedulerOptions,
        onError: (message, error) => {
          retryErrors.push({
            message,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );
    await scheduler.start();
    await scheduler.enqueue(retryRunId, 9);
    await withTimeout(initialRetry, "initial transient BullMQ tick");
    const retryJobId = scienceSchedulerJobId(retryRunId, 9);
    await waitFor(
      async () => (await jobState(observer, retryJobId)) === "delayed",
      "durable transient retry state",
    );
    await closeScheduler(scheduler);
    scheduler = null;
    assert.equal(await jobState(observer, retryJobId), "delayed");
    assert.ok(
      retryErrors.some(
        (entry) =>
          entry.message.includes(retryJobId) &&
          entry.error === "deliberate-live-redis-transient",
      ),
      "transient live tick did not retain bounded job attribution",
    );

    let recoveredRetryCalls = 0;
    let resolveRecoveredRetry;
    const recoveredRetry = new Promise((resolve) => {
      resolveRecoveredRetry = resolve;
    });
    scheduler = new QueueScienceScheduler(
      redisUrl,
      async (runId, expectedGeneration) => {
        assert.equal(runId, retryRunId);
        assert.equal(expectedGeneration, 9);
        recoveredRetryCalls++;
        resolveRecoveredRetry();
        return { nextPollMs: null };
      },
      schedulerOptions,
    );
    await scheduler.start();
    await withTimeout(recoveredRetry, "transient retry recovery after scheduler restart");
    await waitFor(
      async () => (await jobState(observer, retryJobId)) === "absent",
      "recovered transient retry completion",
    );
    assert.equal(initialRetryCalls, 1);
    assert.equal(recoveredRetryCalls, 1);
    assert.equal(await control.get(sentinelKey), "verifier-owned");
    await closeScheduler(scheduler);
    scheduler = null;
    console.log("ok - a transient live tick retains its job identity across scheduler restart");

    completed = true;
  } finally {
    await closeScheduler(scheduler).catch(() => {});
    if (observer) {
      await withTimeout(
        observer.obliterate({ force: true }),
        "isolated BullMQ queue cleanup",
      );
      await withTimeout(observer.close(), "BullMQ observer close");
    }
    if (control.status !== "end") {
      const sentinel = await control.get(sentinelKey).catch(() => null);
      if (completed) assert.equal(sentinel, "verifier-owned");
      const remaining = await scanKeys(control, queueKeyPattern).catch(() => []);
      if (completed) assert.deepEqual(remaining, []);
      await control.del(sentinelKey).catch(() => {});
      control.disconnect(false);
    }
  }

  console.log("ok - cleanup removed only the verifier's unique BullMQ queue, then its exact sentinel");
  console.log(
    "SCIENCE REDIS LIVE PASS: AOF-backed BullMQ duplicate suppression and delayed/retry recovery across scheduler restart with scoped cleanup",
  );
}

main().catch((error) => {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redisUrl ? raw.split(redisUrl).join("[redacted]") : raw;
  console.error(`SCIENCE REDIS LIVE FAIL: ${redacted.slice(0, 2_000)}`);
  process.exitCode = 1;
});
