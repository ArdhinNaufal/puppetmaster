#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  cancelWorkflowMissionWait,
  createDb,
  createMission,
  createWorkflow,
  getMission,
  getMissionSteps,
  getWorkflowWaitForMission,
  listReadyWorkflowWaits,
  markWorkflowWaitsReadyForScienceRun,
  migrate,
  missions,
  nodeExecutions,
  recoverExpiredWorkflowWaitClaims,
  resetMissionForRetry,
  scienceComputeProfiles,
  scienceRuns,
  scienceStudies,
  users,
  workflowWaits,
  workspaces,
} from "../packages/db/dist/index.js";
import {
  BuiltinToolRegistry,
  InMemoryEventBus,
  InlineRunner,
  WorkflowExecutor,
  lintWorkflowGraph,
} from "../packages/kernel/dist/index.js";

const ids = {
  user: randomUUID(),
  workspace: randomUUID(),
  study: randomUUID(),
  profile: randomUUID(),
};
const resourceRequest = {
  cpuMillicores: 500,
  memoryMb: 512,
  gpuCount: 0,
  wallTimeSeconds: 60,
};
const manifestByRun = new Map();

function completeManifest(runId, missionId) {
  return {
    schemaVersion: 1,
    studyId: ids.study,
    runId,
    missionId,
    inputs: [],
    outputs: [],
    codeArtifactVersionId: null,
    sourceRevision: null,
    compute: {
      profileId: ids.profile,
      providerKind: "local_container",
      imageDigest: `sha256:${"c".repeat(64)}`,
      kernelName: "python3",
      resourceBounds: resourceRequest,
      config: { network: "none" },
      requestedResources: resourceRequest,
      adapterVersion: "durable-wait-verifier-v1",
      dependencyLock: {},
    },
    parameters: {},
    units: {},
    randomSeeds: {},
    environment: {},
    actorId: ids.user,
    approvalIds: [],
    policyIds: [],
    toolCalls: ["science.run.status"],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    history: [],
    validations: [],
    limitations: [],
    complete: true,
    gaps: [],
  };
}

const graph = {
  nodes: [
    {
      id: "trigger",
      kind: "trigger",
      label: "Manual",
      config: { mode: "manual" },
      position: { x: 40, y: 80 },
    },
    {
      id: "science_status",
      kind: "action",
      label: "Wait for Science run",
      config: {
        server: "science",
        tool: "run.status",
        args: { runId: "{{input.runId}}" },
        defer: { kind: "science_run_terminal" },
      },
      position: { x: 260, y: 80 },
    },
    {
      id: "continuation",
      kind: "action",
      label: "Continue once",
      config: {
        server: "probe",
        tool: "continue",
        args: { runId: "{{input.run.id}}" },
      },
      position: { x: 500, y: 80 },
    },
  ],
  edges: [
    { from: "trigger", to: "science_status", condition: null },
    { from: "science_status", to: "continuation", condition: null },
  ],
};

const unsafeDeferred = structuredClone(graph);
unsafeDeferred.nodes[1].config = {
  server: "probe",
  tool: "continue",
  args: {},
  defer: { kind: "science_run_terminal" },
};
assert.ok(
  lintWorkflowGraph(unsafeDeferred).some(
    (issue) => issue.code === "unsafe-deferred-action" && issue.severity === "error",
  ),
  "linter must reject defer on any tool except science.run.status",
);

const handle = await createDb({ ephemeral: true });
try {
  await migrate(handle);
  const { db } = handle;
  await db.insert(users).values({
    id: ids.user,
    email: `workflow-wait-${ids.user}@example.test`,
    name: "Workflow Wait Verifier",
    passwordHash: "fixture:fixture",
  });
  await db.insert(workspaces).values({ id: ids.workspace, name: "Workflow wait verifier" });
  await db.insert(scienceStudies).values({
    id: ids.study,
    workspaceId: ids.workspace,
    name: "Deferred continuation fixture",
    createdBy: ids.user,
  });
  await db.insert(scienceComputeProfiles).values({
    id: ids.profile,
    workspaceId: ids.workspace,
    name: "Deferred verifier profile",
    providerKind: "local_container",
    imageDigest: `sha256:${"c".repeat(64)}`,
    kernelName: "python3",
    resourceBounds: resourceRequest,
    config: { network: "none" },
  });

  const createdWorkflow = await createWorkflow(db, {
    workspaceId: ids.workspace,
    name: "Durable Science wait verifier",
    graph,
  });

  async function createRunFixture(state = "running") {
    const runId = randomUUID();
    const scienceMissionId = randomUUID();
    const runManifest = completeManifest(runId, scienceMissionId);
    manifestByRun.set(runId, runManifest);
    await db.insert(missions).values({
      id: scienceMissionId,
      workspaceId: ids.workspace,
      kind: "science",
      subjectId: runId,
      workflowVersionId: null,
      status: state,
      trigger: { mode: "science" },
      input: { runId },
      cursor: {},
      startedAt: new Date(),
    });
    await db.insert(scienceRuns).values({
      id: runId,
      studyId: ids.study,
      missionId: scienceMissionId,
      computeProfileId: ids.profile,
      profileSnapshot: {
        profileId: ids.profile,
        providerKind: "local_container",
        imageDigest: `sha256:${"c".repeat(64)}`,
        kernelName: "python3",
        resourceBounds: resourceRequest,
        config: { network: "none" },
      },
      resourceRequest,
      providerHandle: "fixture-provider",
      state,
      executionGeneration: 1,
      idempotencyKey: `deferred-${runId}`,
      parameters: {},
      manifest: state === "succeeded" ? runManifest : null,
      createdBy: ids.user,
      startedAt: new Date(),
      finishedAt: ["succeeded", "failed", "cancelled"].includes(state) ? new Date() : null,
    });
    return runId;
  }

  async function createWorkflowMission(runId) {
    return createMission(db, {
      workspaceId: ids.workspace,
      subjectId: createdWorkflow.workflow.id,
      workflowVersionId: createdWorkflow.version.id,
      trigger: { mode: "manual" },
      payload: { runId },
    });
  }

  let statusCalls = 0;
  let continuationCalls = 0;
  const tools = new BuiltinToolRegistry();
  tools.register(
    "science",
    "run.status",
    "Read one Science run dossier.",
    "read_auto",
    { type: "object" },
    async (args) => {
      statusCalls++;
      const [run] = await db
        .select({ id: scienceRuns.id, state: scienceRuns.state, manifest: scienceRuns.manifest })
        .from(scienceRuns)
        .where(eq(scienceRuns.id, String(args.runId)))
        .limit(1);
      assert.ok(run, "status fixture run is missing");
      return { run, events: { items: [], nextOffset: null }, inputs: [], outputs: [] };
    },
  );
  tools.register(
    "probe",
    "continue",
    "Count continuation execution.",
    "read_auto",
    { type: "object" },
    async (args) => {
      continuationCalls++;
      return { continued: true, runId: args.runId };
    },
  );
  assert.deepEqual(
    lintWorkflowGraph(graph, (server, tool) => tools.info(server, tool))
      .filter((issue) => issue.severity === "error"),
    [],
    "the exact read-only deferred status graph must lint cleanly",
  );

  const runId = await createRunFixture("running");
  const workflowMission = await createWorkflowMission(runId);
  const firstExecutor = new WorkflowExecutor({
    db,
    bus: new InMemoryEventBus(),
    tools,
  });
  assert.equal(await firstExecutor.runMission(workflowMission.id), "waiting");
  let parent = await getMission(db, workflowMission.id);
  let wait = await getWorkflowWaitForMission(db, workflowMission.id);
  let steps = await getMissionSteps(db, workflowMission.id);
  assert.equal(parent?.status, "waiting");
  assert.equal(wait?.state, "pending");
  assert.equal(steps.find((step) => step.nodeId === "science_status")?.status, "waiting");
  const committedStatusReads = await db
    .select()
    .from(nodeExecutions)
    .where(and(
      eq(nodeExecutions.missionId, workflowMission.id),
      eq(nodeExecutions.nodeId, "science_status"),
      eq(nodeExecutions.committed, true),
    ));
  assert.equal(committedStatusReads.length, 0, "nonterminal status reads must never enter the output ledger");

  // Prove run terminalization and readiness share one rollback boundary.
  await assert.rejects(
    db.transaction(async (tx) => {
      const scoped = tx;
      await scoped.update(scienceRuns).set({
        state: "succeeded",
        manifest: manifestByRun.get(runId),
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(scienceRuns.id, runId));
      await markWorkflowWaitsReadyForScienceRun(scoped, { runId });
      throw new Error("terminal readiness rollback sentinel");
    }),
    /terminal readiness rollback sentinel/,
  );
  wait = await getWorkflowWaitForMission(db, workflowMission.id);
  const [rolledBackRun] = await db.select().from(scienceRuns).where(eq(scienceRuns.id, runId));
  assert.equal(rolledBackRun.state, "running");
  assert.equal(wait?.state, "pending");

  await db.transaction(async (tx) => {
    const scoped = tx;
    await scoped.update(scienceRuns).set({
      state: "succeeded",
      manifest: manifestByRun.get(runId),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scienceRuns.id, runId));
    await markWorkflowWaitsReadyForScienceRun(scoped, { runId });
  });
  wait = await getWorkflowWaitForMission(db, workflowMission.id);
  assert.equal(wait?.state, "ready");
  assert.equal((await listReadyWorkflowWaits(db, {
    workspaceId: ids.workspace,
    runId,
  })).length, 1);

  // Simulate a process crash exactly after the status cursor transaction and
  // before the next node. The bus throw occurs after that commit.
  let injectedCrash = true;
  const crashBus = {
    async publish(event) {
      if (
        injectedCrash &&
        event.type === "mission.step" &&
        event.nodeId === "science_status" &&
        event.status === "succeeded"
      ) {
        injectedCrash = false;
        throw new Error("crash after deferred status cursor");
      }
    },
  };
  const crashingExecutor = new WorkflowExecutor({ db, bus: crashBus, tools });
  await assert.rejects(
    crashingExecutor.runMission(workflowMission.id),
    /crash after deferred status cursor/,
  );
  parent = await getMission(db, workflowMission.id);
  wait = await getWorkflowWaitForMission(db, workflowMission.id);
  assert.equal(parent?.status, "running");
  assert.equal(wait?.state, "claimed", "cursor commit must retain the continuation claim");
  assert.equal(parent?.cursor?.science_status?.run?.state, "succeeded");
  assert.equal(continuationCalls, 0, "injected crash occurred before continuation");

  const recovered = await recoverExpiredWorkflowWaitClaims(db, {
    workspaceId: ids.workspace,
    now: new Date(Date.now() + 2 * 60_000),
  });
  assert.equal(recovered.length, 1);
  parent = await getMission(db, workflowMission.id);
  wait = await getWorkflowWaitForMission(db, workflowMission.id);
  assert.equal(parent?.status, "waiting");
  assert.equal(wait?.state, "ready");

  const resumedExecutor = new WorkflowExecutor({
    db,
    bus: new InMemoryEventBus(),
    tools,
  });
  assert.equal(await resumedExecutor.runMission(workflowMission.id), "succeeded");
  parent = await getMission(db, workflowMission.id);
  wait = await getWorkflowWaitForMission(db, workflowMission.id);
  assert.equal(parent?.status, "succeeded");
  assert.equal(wait?.state, "consumed");
  assert.equal(continuationCalls, 1, "recovery must execute the continuation exactly once");
  assert.equal(statusCalls, 2, "cursor recovery must not re-read an already committed terminal status");

  // A paused old continuation must fail-stop after its lease is reclaimed by
  // a new continuation. Only the new owner may run the downstream action.
  const splitRunId = await createRunFixture("running");
  const splitParent = await createWorkflowMission(splitRunId);
  assert.equal(await firstExecutor.runMission(splitParent.id), "waiting");
  await db.transaction(async (tx) => {
    await tx.update(scienceRuns).set({
      state: "succeeded",
      manifest: manifestByRun.get(splitRunId),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scienceRuns.id, splitRunId));
    await markWorkflowWaitsReadyForScienceRun(tx, { runId: splitRunId });
  });
  let releaseOldStatusEvent;
  let observeOldStatusCommit;
  const oldStatusEvent = new Promise((resolve) => { observeOldStatusCommit = resolve; });
  const oldStatusGate = new Promise((resolve) => { releaseOldStatusEvent = resolve; });
  const pausedBus = {
    async publish(event) {
      if (
        event.type === "mission.step" &&
        event.nodeId === "science_status" &&
        event.status === "succeeded"
      ) {
        observeOldStatusCommit();
        await oldStatusGate;
      }
    },
  };
  const pausedExecutor = new WorkflowExecutor({ db, bus: pausedBus, tools });
  const oldContinuation = pausedExecutor.runMission(splitParent.id);
  await oldStatusEvent;
  const splitClaim = await getWorkflowWaitForMission(db, splitParent.id);
  assert.equal(splitClaim?.state, "claimed");
  await db.update(workflowWaits).set({
    claimExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(workflowWaits.id, splitClaim.id));
  assert.equal((await recoverExpiredWorkflowWaitClaims(db, {
    workspaceId: ids.workspace,
  })).length, 1);
  const beforeNewOwner = continuationCalls;
  assert.equal(await resumedExecutor.runMission(splitParent.id), "succeeded");
  assert.equal(continuationCalls, beforeNewOwner + 1);
  const oldOwnerRejected = assert.rejects(oldContinuation, /ownership was lost/);
  releaseOldStatusEvent();
  await oldOwnerRejected;
  assert.equal(
    continuationCalls,
    beforeNewOwner + 1,
    "the old owner must not enter downstream execution after lease reclamation",
  );
  assert.equal((await getMission(db, splitParent.id))?.status, "succeeded");

  // Failed children fail their parent deterministically; they never flow into
  // downstream manifest/render work.
  const failedRunId = await createRunFixture("running");
  const failedParent = await createWorkflowMission(failedRunId);
  assert.equal(await firstExecutor.runMission(failedParent.id), "waiting");
  await db.transaction(async (tx) => {
    await tx.update(scienceRuns).set({
      state: "failed",
      error: "fixture compute failure",
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scienceRuns.id, failedRunId));
    await markWorkflowWaitsReadyForScienceRun(tx, { runId: failedRunId });
  });
  assert.equal(await resumedExecutor.runMission(failedParent.id), "failed");
  assert.equal((await getMission(db, failedParent.id))?.status, "failed");
  assert.equal((await getWorkflowWaitForMission(db, failedParent.id))?.state, "consumed");

  const incompleteRunId = await createRunFixture("running");
  const incompleteParent = await createWorkflowMission(incompleteRunId);
  assert.equal(await firstExecutor.runMission(incompleteParent.id), "waiting");
  await db.transaction(async (tx) => {
    const incompleteManifest = {
      ...manifestByRun.get(incompleteRunId),
      complete: false,
      gaps: ["fixture-manifest-gap"],
    };
    await tx.update(scienceRuns).set({
      state: "succeeded",
      manifest: incompleteManifest,
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scienceRuns.id, incompleteRunId));
    await markWorkflowWaitsReadyForScienceRun(tx, { runId: incompleteRunId });
  });
  assert.equal(await resumedExecutor.runMission(incompleteParent.id), "failed");
  const incompleteMission = await getMission(db, incompleteParent.id);
  assert.match(incompleteMission?.error ?? "", /without a complete manifest/);
  assert.equal((await getWorkflowWaitForMission(db, incompleteParent.id))?.state, "consumed");

  // Parent cancellation invalidates the wait but deliberately does not cancel
  // the independently owned child Science run.
  const cancellableRunId = await createRunFixture("running");
  const cancellableParent = await createWorkflowMission(cancellableRunId);
  assert.equal(await firstExecutor.runMission(cancellableParent.id), "waiting");
  const cancelledWait = await cancelWorkflowMissionWait(db, {
    missionId: cancellableParent.id,
  });
  assert.equal(cancelledWait?.state, "cancelled");
  assert.equal((await getMission(db, cancellableParent.id))?.status, "cancelled");
  const [uncancelledChild] = await db
    .select({ state: scienceRuns.state })
    .from(scienceRuns)
    .where(eq(scienceRuns.id, cancellableRunId));
  assert.equal(uncancelledChild.state, "running");

  // Retrying before the independently owned child terminalizes must
  // atomically reactivate the cancelled wait, fence the old generation, and
  // retain the upstream cursor. It must not immediately re-cancel.
  const cancelledGeneration = cancelledWait.generation;
  const retryReset = await resetMissionForRetry(db, cancellableParent.id);
  assert.equal(retryReset.mission.status, "waiting");
  assert.equal(retryReset.mission.cancelRequested, false);
  assert.equal(retryReset.mission.retryCount, 1);
  assert.equal(retryReset.wait?.state, "pending");
  assert.equal(retryReset.wait?.generation, cancelledGeneration + 1);
  assert.equal(retryReset.wait?.claimToken, null);
  assert.equal(retryReset.wait?.claimExpiresAt, null);
  parent = await getMission(db, cancellableParent.id);
  wait = await getWorkflowWaitForMission(db, cancellableParent.id);
  steps = await getMissionSteps(db, cancellableParent.id);
  assert.equal(parent?.status, "waiting");
  assert.equal(parent?.cancelRequested, false);
  assert.equal(Object.hasOwn(parent?.cursor ?? {}, "trigger"), true);
  assert.equal(Object.hasOwn(parent?.cursor ?? {}, "science_status"), false);
  assert.equal(wait?.state, "pending");
  assert.equal(steps.find((step) => step.nodeId === "science_status")?.status, "waiting");
  assert.equal(steps.find((step) => step.nodeId === "science_status")?.error, null);
  await assert.rejects(
    resetMissionForRetry(db, cancellableParent.id),
    /cannot be retried from status waiting/,
    "a second concurrent retry must fail clearly instead of advancing the wait again",
  );
  assert.equal(await resumedExecutor.runMission(cancellableParent.id), "waiting");
  assert.equal((await getMission(db, cancellableParent.id))?.status, "waiting");
  assert.equal((await getWorkflowWaitForMission(db, cancellableParent.id))?.state, "pending");
  const [stillRunningChild] = await db
    .select({ state: scienceRuns.state })
    .from(scienceRuns)
    .where(eq(scienceRuns.id, cancellableRunId));
  assert.equal(stillRunningChild.state, "running", "parent retry must not cancel its Science child");

  await db.transaction(async (tx) => {
    await tx.update(scienceRuns).set({
      state: "succeeded",
      manifest: manifestByRun.get(cancellableRunId),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scienceRuns.id, cancellableRunId));
    await markWorkflowWaitsReadyForScienceRun(tx, { runId: cancellableRunId });
  });
  const beforeRetriedContinuation = continuationCalls;
  assert.equal(await resumedExecutor.runMission(cancellableParent.id), "succeeded");
  assert.equal(continuationCalls, beforeRetriedContinuation + 1);
  assert.equal((await getWorkflowWaitForMission(db, cancellableParent.id))?.state, "consumed");

  // Cancel and retry while an old terminal continuation is paused after its
  // cursor commit. Retry converts the completed wait to consumed and advances
  // its generation; clearing the claim token makes the old owner fail-stop
  // before it can repeat the downstream action.
  const retryFenceRunId = await createRunFixture("running");
  const retryFenceParent = await createWorkflowMission(retryFenceRunId);
  assert.equal(await firstExecutor.runMission(retryFenceParent.id), "waiting");
  await db.transaction(async (tx) => {
    await tx.update(scienceRuns).set({
      state: "succeeded",
      manifest: manifestByRun.get(retryFenceRunId),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(scienceRuns.id, retryFenceRunId));
    await markWorkflowWaitsReadyForScienceRun(tx, { runId: retryFenceRunId });
  });
  let releaseRetryFenceOwner;
  let observeRetryFenceCommit;
  const retryFenceCommitted = new Promise((resolve) => { observeRetryFenceCommit = resolve; });
  const retryFenceGate = new Promise((resolve) => { releaseRetryFenceOwner = resolve; });
  const retryFenceBus = {
    async publish(event) {
      if (
        event.type === "mission.step" &&
        event.nodeId === "science_status" &&
        event.status === "succeeded"
      ) {
        observeRetryFenceCommit();
        await retryFenceGate;
      }
    },
  };
  const retryFenceExecutor = new WorkflowExecutor({ db, bus: retryFenceBus, tools });
  const staleRetryOwner = retryFenceExecutor.runMission(retryFenceParent.id);
  await retryFenceCommitted;
  const claimedBeforeRetry = await getWorkflowWaitForMission(db, retryFenceParent.id);
  assert.equal(claimedBeforeRetry?.state, "claimed");
  assert.ok(claimedBeforeRetry?.claimToken);
  assert.equal((await getMission(db, retryFenceParent.id))?.cursor?.science_status?.run?.state, "succeeded");
  assert.equal(
    (await cancelWorkflowMissionWait(db, { missionId: retryFenceParent.id }))?.state,
    "cancelled",
  );
  const fencedReset = await resetMissionForRetry(db, retryFenceParent.id);
  assert.equal(fencedReset.mission.status, "queued");
  assert.equal(fencedReset.wait?.state, "consumed");
  assert.equal(fencedReset.wait?.generation, claimedBeforeRetry.generation + 1);
  assert.equal(fencedReset.wait?.claimToken, null);
  assert.equal(fencedReset.wait?.claimExpiresAt, null);
  const beforeFencedContinuation = continuationCalls;
  assert.equal(await resumedExecutor.runMission(retryFenceParent.id), "succeeded");
  assert.equal(continuationCalls, beforeFencedContinuation + 1);
  const staleRetryOwnerRejected = assert.rejects(staleRetryOwner, /ownership was lost/);
  releaseRetryFenceOwner();
  await staleRetryOwnerRejected;
  assert.equal(
    continuationCalls,
    beforeFencedContinuation + 1,
    "the pre-retry owner must not execute downstream work after its claim is fenced",
  );

  // Keyed wake notifications are coalesced while an inline dispatch is live.
  let releaseDispatch;
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  let keyedDispatches = 0;
  const runner = new InlineRunner(async () => {
    keyedDispatches++;
    await dispatchGate;
  });
  await runner.start();
  await runner.enqueue(workflowMission.id, "workflow-wait-keyed-verifier");
  await runner.enqueue(workflowMission.id, "workflow-wait-keyed-verifier");
  await Promise.resolve();
  assert.equal(keyedDispatches, 1);
  releaseDispatch();
  await runner.close();

  console.log(
    "WORKFLOW DEFERRED RESUME PASS: migration14 atomic readiness, exact read-only defer, waiting/claim/heartbeat recovery, crash-after-cursor continuation, split-brain fail-stop, terminal fail-closed, atomic cancel-retry reactivation, stale retry-owner fencing, parent-child cancel isolation, and keyed wake coalescing",
  );
} finally {
  await handle.close();
}
