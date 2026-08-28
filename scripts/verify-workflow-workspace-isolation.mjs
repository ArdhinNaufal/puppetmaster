#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  createDb,
  createWorkflow,
  getMission,
  getWorkflowWaitForMission,
  listQueuedGenericMissionsForRecovery,
  listReadyWorkflowWaits,
  migrate,
  missions,
  recoverExpiredWorkflowWaitClaims,
  scienceComputeProfiles,
  scienceRuns,
  scienceStudies,
  users,
  workflowWaits,
  workspaces,
} from "../packages/db/dist/index.js";
import {
  QueueRunner,
  createWorkspaceMissionDispatcher,
  startWorkflow,
  workflowCronSchedulerId,
  workflowQueueConnectionOptions,
  workflowQueueName,
} from "../packages/kernel/dist/index.js";

const kernelRequire = createRequire(
  new URL("../packages/kernel/package.json", import.meta.url),
);
const { Queue } = kernelRequire("bullmq");
const LIVE_TIMEOUT_MS = 15_000;

const ids = {
  user: randomUUID(),
  workspaceA: randomUUID(),
  workspaceB: randomUUID(),
  studyB: randomUUID(),
  profileB: randomUUID(),
};
const resourceRequest = {
  cpuMillicores: 500,
  memoryMb: 512,
  gpuCount: 0,
  wallTimeSeconds: 60,
};
const graph = {
  nodes: [{
    id: "trigger",
    kind: "trigger",
    label: "Manual",
    config: { mode: "manual" },
    position: { x: 40, y: 40 },
  }],
  edges: [],
};

function routeBlock(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing route boundary: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing route boundary: ${end}`);
  return source.slice(from, to);
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
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`${label} was not observed within ${timeoutMs} ms`);
}

async function verifyLiveRedisIsolation(db, missionAId, missionBId) {
  const redisUrl = process.env.WORKFLOW_REDIS_URL?.trim() ?? "";
  if (!redisUrl) {
    console.log("WORKFLOW REDIS LIVE: NOT RUN (WORKFLOW_REDIS_URL unset)");
    return;
  }
  assert.equal(
    process.env.WORKFLOW_REDIS_ALLOW_SCOPED_DELETE,
    "1",
    "WORKFLOW_REDIS_ALLOW_SCOPED_DELETE=1 is required; the verifier removes only its random workspace queues",
  );

  // Parsing here fails before a queue is opened, and the production helper
  // enforces redis:// or rediss:// while preserving TLS for the latter.
  const connection = workflowQueueConnectionOptions(redisUrl);
  const queueAName = workflowQueueName(ids.workspaceA);
  const queueBName = workflowQueueName(ids.workspaceB);
  const observerA = new Queue(queueAName, { connection });
  const observerB = new Queue(queueBName, { connection });
  const seenA = [];
  const seenB = [];
  const runnerA = new QueueRunner(redisUrl, {
    db,
    workspaceId: ids.workspaceA,
    run: createWorkspaceMissionDispatcher(db, ids.workspaceA, async (mission) => {
      seenA.push(mission.id);
      return mission.id;
    }),
  });
  const runnerB = new QueueRunner(redisUrl, {
    db,
    workspaceId: ids.workspaceB,
    run: createWorkspaceMissionDispatcher(db, ids.workspaceB, async (mission) => {
      seenB.push(mission.id);
      return mission.id;
    }),
  });
  let completed = false;
  try {
    await withTimeout(
      Promise.all([observerA.waitUntilReady(), observerB.waitUntilReady()]),
      "workflow queue observers",
    );
    await Promise.all([
      runnerA.enqueue(missionAId, `live-${randomUUID()}`),
      runnerB.enqueue(missionBId, `live-${randomUUID()}`),
    ]);
    await Promise.all([runnerA.start(), runnerB.start()]);
    await waitFor(
      () => seenA.length === 1 && seenB.length === 1,
      "workspace-bound workflow deliveries",
    );
    assert.deepEqual(seenA, [missionAId], "workspace A runner consumed workspace B's mission");
    assert.deepEqual(seenB, [missionBId], "workspace B runner consumed workspace A's mission");
    completed = true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(
      `workflow Redis live isolation failed: ${raw.split(redisUrl).join("[redacted]")}`,
    );
  } finally {
    await Promise.allSettled([runnerA.close(), runnerB.close()]);
    const cleanup = await Promise.allSettled([
      withTimeout(observerA.obliterate({ force: true }), `${queueAName} cleanup`),
      withTimeout(observerB.obliterate({ force: true }), `${queueBName} cleanup`),
    ]);
    await Promise.allSettled([observerA.close(), observerB.close()]);
    if (completed) {
      for (const result of cleanup) {
        assert.equal(result.status, "fulfilled", "random workspace queue cleanup failed");
      }
    }
  }
  console.log(
    "WORKFLOW REDIS LIVE PASS: two workspace-bound QueueRunner instances consumed only their own mission and removed only their random queues",
  );
}

const handle = await createDb({ ephemeral: true });
try {
  await migrate(handle);
  const { db } = handle;
  await db.insert(users).values({
    id: ids.user,
    email: `workflow-workspace-${ids.user}@example.test`,
    name: "Workflow workspace verifier",
    passwordHash: "fixture:fixture",
  });
  await db.insert(workspaces).values([
    { id: ids.workspaceA, name: "Workspace A" },
    { id: ids.workspaceB, name: "Workspace B" },
  ]);
  await db.insert(scienceStudies).values({
    id: ids.studyB,
    workspaceId: ids.workspaceB,
    name: "Workspace B wait fixture",
    createdBy: ids.user,
  });
  await db.insert(scienceComputeProfiles).values({
    id: ids.profileB,
    workspaceId: ids.workspaceB,
    name: "Workspace B profile",
    providerKind: "local_container",
    imageDigest: `sha256:${"c".repeat(64)}`,
    kernelName: "python3",
    resourceBounds: resourceRequest,
    config: { network: "none" },
  });

  const workflowA = await createWorkflow(db, {
    workspaceId: ids.workspaceA,
    name: "Workspace A workflow",
    graph,
  });
  const workflowB = await createWorkflow(db, {
    workspaceId: ids.workspaceB,
    name: "Workspace B workflow",
    graph,
  });

  const missionsBeforeForeignStart = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.workspaceId, ids.workspaceB));
  await assert.rejects(
    startWorkflow(db, {
      workspaceId: ids.workspaceA,
      workflowId: workflowB.workflow.id,
      trigger: { mode: "manual" },
      payload: {},
    }),
    /not found.*this workspace/i,
  );
  const missionsAfterForeignStart = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.workspaceId, ids.workspaceB));
  assert.equal(
    missionsAfterForeignStart.length,
    missionsBeforeForeignStart.length,
    "a foreign workflow start must not create a mission",
  );

  const ownMission = await startWorkflow(db, {
    workspaceId: ids.workspaceA,
    workflowId: workflowA.workflow.id,
    trigger: { mode: "manual" },
    payload: {},
  });
  const foreignMission = await startWorkflow(db, {
    workspaceId: ids.workspaceB,
    workflowId: workflowB.workflow.id,
    trigger: { mode: "manual" },
    payload: {},
  });
  const approvalPaused = await startWorkflow(db, {
    workspaceId: ids.workspaceA,
    workflowId: workflowA.workflow.id,
    trigger: { mode: "manual" },
    payload: {},
  });
  const cancelRequested = await startWorkflow(db, {
    workspaceId: ids.workspaceA,
    workflowId: workflowA.workflow.id,
    trigger: { mode: "manual" },
    payload: {},
  });
  const claudeMissionId = randomUUID();
  const scienceMissionId = randomUUID();
  await db.insert(missions).values([
    {
      id: claudeMissionId,
      workspaceId: ids.workspaceA,
      kind: "claude",
      subjectId: randomUUID(),
      workflowVersionId: null,
      status: "queued",
      trigger: { mode: "manual" },
      input: {},
      cursor: {},
    },
    {
      id: scienceMissionId,
      workspaceId: ids.workspaceA,
      kind: "science",
      subjectId: randomUUID(),
      workflowVersionId: null,
      status: "queued",
      trigger: { mode: "science" },
      input: {},
      cursor: {},
    },
  ]);
  await db.update(missions).set({ status: "awaiting_approval" })
    .where(eq(missions.id, approvalPaused.id));
  await db.update(missions).set({ cancelRequested: true })
    .where(eq(missions.id, cancelRequested.id));
  assert.deepEqual(
    (await listQueuedGenericMissionsForRecovery(db, {
      workspaceId: ids.workspaceA,
      limit: 20,
    })).map((mission) => mission.id).sort(),
    [ownMission.id, claudeMissionId].sort(),
    "startup recovery omitted Claude or admitted foreign, Science, approval-paused, or cancel-requested work",
  );
  assert.deepEqual(
    (await listQueuedGenericMissionsForRecovery(db, {
      workspaceId: ids.workspaceB,
      limit: 20,
    })).map((mission) => mission.id),
    [foreignMission.id],
  );
  let dispatchCalls = 0;
  const dispatchA = createWorkspaceMissionDispatcher(db, ids.workspaceA, async (mission) => {
    dispatchCalls++;
    return mission.id;
  });
  await assert.rejects(dispatchA(foreignMission.id), /not found.*this workspace/i);
  assert.equal(dispatchCalls, 0, "foreign dispatch reached the workspace A executor");
  assert.equal((await getMission(db, foreignMission.id))?.status, "queued");
  assert.equal(await dispatchA(ownMission.id), ownMission.id);
  assert.equal(dispatchCalls, 1);

  await verifyLiveRedisIsolation(db, ownMission.id, foreignMission.id);

  async function createTerminalRun() {
    const runId = randomUUID();
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      workspaceId: ids.workspaceB,
      kind: "science",
      subjectId: runId,
      workflowVersionId: null,
      status: "succeeded",
      trigger: { mode: "science" },
      input: { runId },
      cursor: {},
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await db.insert(scienceRuns).values({
      id: runId,
      studyId: ids.studyB,
      missionId,
      computeProfileId: ids.profileB,
      profileSnapshot: {
        profileId: ids.profileB,
        providerKind: "local_container",
        imageDigest: `sha256:${"c".repeat(64)}`,
        kernelName: "python3",
        resourceBounds: resourceRequest,
        config: { network: "none" },
      },
      resourceRequest,
      state: "succeeded",
      executionGeneration: 1,
      idempotencyKey: `workspace-isolation-${runId}`,
      parameters: {},
      createdBy: ids.user,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    return runId;
  }

  const readyRunId = await createTerminalRun();
  await db.update(missions).set({ status: "waiting" }).where(eq(missions.id, foreignMission.id));
  await db.insert(workflowWaits).values({
    missionId: foreignMission.id,
    nodeId: "science_status",
    kind: "science_run_terminal",
    targetRunId: readyRunId,
    state: "ready",
    generation: 1,
  });
  assert.deepEqual(
    await listReadyWorkflowWaits(db, { workspaceId: ids.workspaceA }),
    [],
    "workspace A listed workspace B's ready wait",
  );
  assert.equal(
    (await listReadyWorkflowWaits(db, {
      workspaceId: ids.workspaceA,
      runId: readyRunId,
    })).length,
    0,
    "a known foreign run UUID bypassed ready-wait workspace scope",
  );
  assert.equal(
    (await listReadyWorkflowWaits(db, { workspaceId: ids.workspaceB })).length,
    1,
  );

  const claimedMission = await startWorkflow(db, {
    workspaceId: ids.workspaceB,
    workflowId: workflowB.workflow.id,
    trigger: { mode: "manual" },
    payload: {},
  });
  const claimedRunId = await createTerminalRun();
  const expiredClaim = new Date(Date.now() - 60_000);
  await db.update(missions).set({ status: "running" }).where(eq(missions.id, claimedMission.id));
  await db.insert(workflowWaits).values({
    missionId: claimedMission.id,
    nodeId: "science_status",
    kind: "science_run_terminal",
    targetRunId: claimedRunId,
    state: "claimed",
    generation: 3,
    claimToken: randomUUID(),
    claimExpiresAt: expiredClaim,
  });
  assert.equal(
    (await recoverExpiredWorkflowWaitClaims(db, {
      workspaceId: ids.workspaceA,
      now: new Date(),
    })).length,
    0,
    "workspace A recovered workspace B's expired claim",
  );
  assert.equal((await getWorkflowWaitForMission(db, claimedMission.id))?.state, "claimed");
  assert.equal(
    (await recoverExpiredWorkflowWaitClaims(db, {
      workspaceId: ids.workspaceB,
      now: new Date(),
    })).length,
    1,
  );
  assert.equal((await getWorkflowWaitForMission(db, claimedMission.id))?.state, "ready");
  assert.equal((await getMission(db, claimedMission.id))?.status, "waiting");

  assert.notEqual(workflowQueueName(ids.workspaceA), workflowQueueName(ids.workspaceB));
  assert.match(workflowQueueName(ids.workspaceA), /^puppetmaster-workflows-[0-9a-f-]{36}$/);
  assert.notEqual(
    workflowCronSchedulerId(ids.workspaceA, "workflow", workflowA.workflow.id),
    workflowCronSchedulerId(ids.workspaceB, "workflow", workflowB.workflow.id),
  );
  assert.ok(
    workflowCronSchedulerId(ids.workspaceA, "workflow", workflowA.workflow.id).length <= 200,
  );
  assert.throws(() => workflowQueueName("../foreign"), /workspace id must be a UUID/i);

  const mainSource = await readFile(
    new URL("../apps/server/src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    routeBlock(mainSource, 'app.get("/api/workflows/:id"', 'app.put("/api/workflows/:id"'),
    /getWorkspaceWorkflowWithGraph\(id\)/,
  );
  assert.match(
    routeBlock(mainSource, 'app.put("/api/workflows/:id"', '/** Reveal the webhook URL'),
    /getWorkspaceWorkflow\(id\)/,
  );
  assert.match(
    routeBlock(mainSource, 'app.get("/api/workflows/:id/webhook"', '/** Rotate'),
    /getWorkspaceWorkflow\(id\)/,
  );
  assert.match(
    routeBlock(mainSource, 'app.post("/api/workflows/:id/webhook/rotate"', '/** NL'),
    /getWorkspaceWorkflow\(id\)/,
  );
  const runRoute = routeBlock(
    mainSource,
    'app.post("/api/workflows/:id/run"', '// --- Webhook trigger',
  );
  assert.match(runRoute, /getWorkspaceWorkflow\(id\)/);
  assert.match(runRoute, /startWorkflow\(db, \{\s*workspaceId,/);
  const hookRoute = routeBlock(
    mainSource,
    'app.post("/api/hooks/:workflowId"', '// --- Agents',
  );
  assert.match(hookRoute, /getWorkspaceWorkflow\(workflowId\)/);
  assert.ok(
    hookRoute.indexOf("getWorkspaceWorkflow(workflowId)") <
      hookRoute.indexOf("verifyWebhookSignature"),
    "foreign webhook ownership must fail before secret verification",
  );
  const templatePublish = routeBlock(
    mainSource,
    'app.post("/api/templates"', 'app.delete("/api/templates/:id"',
  );
  assert.match(templatePublish, /wf\.workflow\.workspaceId !== workspaceId/);
  assert.match(templatePublish, /agent\.workspaceId !== workspaceId/);
  assert.match(
    mainSource,
    /new QueueRunner\(REDIS_URL, \{ run: dispatch, db, workspaceId \}\)/,
  );
  assert.match(
    mainSource,
    /listReadyWorkflowWaits\(db, \{ workspaceId, runId, limit: 500 \}\)/,
  );
  assert.match(
    mainSource,
    /recoverExpiredWorkflowWaitClaims\(db, \{ workspaceId, limit: 500 \}\)/,
  );
  assert.match(
    mainSource,
    /listQueuedGenericMissionsForRecovery\(db, \{\s*workspaceId,\s*limit: QUEUED_MISSION_RECOVERY_LIMIT \+ 1,/,
  );
  assert.match(mainSource, /startup-queued-\$\{mission\.id\}/);

  console.log(
    "WORKFLOW WORKSPACE ISOLATION PASS: scoped ready/recovery queries, bounded queued workflow/agent/Claude namespace migration, fail-closed start/dispatch, namespaced Redis queue and cron identities, owned workflow routes, and owned template sources",
  );
} finally {
  await handle.close();
}
