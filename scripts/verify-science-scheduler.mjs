#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import {
  InlineScienceScheduler,
  QueueScienceScheduler,
  scienceSchedulerConnectionOptions,
  scienceSchedulerJobId,
} from "../packages/kernel/dist/index.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

assert.equal(
  scienceSchedulerJobId(RUN_ID, null),
  `science-${RUN_ID}-claim`,
);
assert.equal(
  scienceSchedulerJobId(RUN_ID, 7),
  `science-${RUN_ID}-7`,
);
assert.notEqual(
  scienceSchedulerJobId(RUN_ID, 7),
  scienceSchedulerJobId(RUN_ID, 8),
);
assert.throws(() => scienceSchedulerJobId("", null), /run ID/);
assert.throws(() => scienceSchedulerJobId(RUN_ID, -1), /generation/);

let attempts = 0;
const errors = [];
let resolveSucceeded;
const succeeded = new Promise((resolve) => {
  resolveSucceeded = resolve;
});
const scheduler = new InlineScienceScheduler(
  async (runId, expectedGeneration) => {
    assert.equal(runId, RUN_ID);
    assert.equal(expectedGeneration, 7);
    attempts++;
    if (attempts < 3) throw new Error(`transient-${attempts}`);
    resolveSucceeded();
    return { nextPollMs: null };
  },
  (message, error) => {
    errors.push({
      message,
      error: error instanceof Error ? error.message : String(error),
    });
  },
  { transientRetryMs: 1 },
);

try {
  assert.deepEqual(await scheduler.health(), {
    ok: false,
    adapter: "inline",
    state: "not_started",
    pending: 0,
    active: 0,
    detail: "inline science scheduler is not started",
  });
  await scheduler.start();
  assert.equal((await scheduler.health()).ok, true);
  await scheduler.enqueue(RUN_ID, 7);
  let timeout;
  await Promise.race([
    succeeded,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("inline scheduler did not retry a transient tick")),
        2_000,
      );
    }),
  ]);
  clearTimeout(timeout);
  await scheduler.close();
  assert.equal((await scheduler.health()).state, "closing");
  assert.equal((await scheduler.health()).ok, false);
  assert.equal(attempts, 3);
  assert.deepEqual(
    errors.map((entry) => entry.error),
    ["transient-1", "transient-2"],
  );
  assert.ok(
    errors.every((entry) => entry.message.includes(RUN_ID)),
    "retry diagnostics must retain the affected run ID",
  );
} finally {
  await scheduler.close().catch(() => {});
}

const producerConnection = scienceSchedulerConnectionOptions(
  "redis://science-user:science-password@127.0.0.1:6380/2",
  "producer",
);
assert.equal(producerConnection.maxRetriesPerRequest, 1);
assert.equal(producerConnection.enableOfflineQueue, false);
assert.equal(producerConnection.autoResendUnfulfilledCommands, false);
assert.equal(producerConnection.connectTimeout, 1_500);
assert.equal(producerConnection.commandTimeout, 1_500);
const workerConnection = scienceSchedulerConnectionOptions(
  "redis://127.0.0.1:6380/2",
  "worker",
);
assert.equal(workerConnection.maxRetriesPerRequest, null);
assert.equal(workerConnection.enableOfflineQueue, undefined);
assert.equal(workerConnection.commandTimeout, undefined);

// A TCP endpoint that accepts connections but never speaks Redis exercises the
// readiness bound rather than relying on a fast ECONNREFUSED failure.
const stalledSockets = new Set();
const stalledRedis = createServer((socket) => {
  stalledSockets.add(socket);
  socket.on("close", () => stalledSockets.delete(socket));
});
await new Promise((resolve, reject) => {
  stalledRedis.once("error", reject);
  stalledRedis.listen(0, "127.0.0.1", resolve);
});
const stalledAddress = stalledRedis.address();
assert.ok(stalledAddress && typeof stalledAddress === "object");
const queueErrors = [];
const queueScheduler = new QueueScienceScheduler(
  `redis://127.0.0.1:${stalledAddress.port}`,
  async () => ({ nextPollMs: null }),
  {
    onError: (message, error) => {
      queueErrors.push({ message, error });
    },
  },
);
try {
  // Exercise only the producer/readiness path. Starting the deliberately
  // retry-unbounded worker against a black hole would correctly leave its
  // BullMQ stalled-check timer alive for the duration of the test fixture.
  queueScheduler.started = true;
  const healthStarted = performance.now();
  const stalledHealth = await queueScheduler.health();
  const healthElapsedMs = performance.now() - healthStarted;
  assert.equal(stalledHealth.ok, false);
  assert.match(stalledHealth.detail ?? "", /timed out|Command timed out/i);
  assert.ok(
    healthElapsedMs < 3_000,
    `stalled Redis health took ${healthElapsedMs.toFixed(0)}ms`,
  );

  const enqueueStarted = performance.now();
  await assert.rejects(
    queueScheduler.enqueue(RUN_ID, 9),
    /timed out|Command timed out/i,
  );
  const enqueueElapsedMs = performance.now() - enqueueStarted;
  assert.ok(
    enqueueElapsedMs < 3_000,
    `stalled Redis enqueue took ${enqueueElapsedMs.toFixed(0)}ms`,
  );
} finally {
  await queueScheduler.close().catch(() => {});
  for (const socket of stalledSockets) socket.destroy();
  await new Promise((resolve) => stalledRedis.close(resolve));
}

console.log(
  "SCIENCE SCHEDULER PASS: deterministic generation job IDs, transient retry, and bounded Redis producer/readiness failure",
);
