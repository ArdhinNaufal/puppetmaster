#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createClaudeRunMission,
  createClaudeSession,
  createDb,
  createProject,
  ensureClaudeApproval,
  ensureDefaultWorkspace,
  findApprovalForNode,
  getClaudeRunByMission,
  listApprovals,
  migrate,
  requestMissionCancel,
  resolveApproval,
} from "../packages/db/dist/index.js";
import {
  ClaudeCodeRuntime,
  WorkbenchTerminationError,
  claudeAttemptExecutionId,
  persistedClaudeExecutionId,
  workbenchCopybackIdentity,
} from "../packages/kernel/dist/index.js";

const fixtureSnapshot = async (projectId, executionId, executionGeneration) => ({
  projectId,
  executionId,
  executionGeneration,
  executionIdentitySha256: workbenchCopybackIdentity(projectId, executionId, executionGeneration),
  snapshotReceipt: `fixture-snapshot-${executionId}`,
});

const handle = await createDb({ ephemeral: true });
let signalProcessStarted;
const processStarted = new Promise((resolve) => { signalProcessStarted = resolve; });
let terminationFinished = false;
const observedExecutionIds = [];
const executor = {
  status: async () => "running",
  ensure: async () => "fixture-workbench",
  run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  runStreaming: async (input) => {
    observedExecutionIds.push(input.executionId);
    if (input.command === "puppetmaster-sync recover /workbench") {
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (input.command === "git rev-parse --is-inside-work-tree") {
      return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
    }
    signalProcessStarted();
    await new Promise((resolve) => {
      if (input.signal.aborted) resolve();
      else input.signal.addEventListener("abort", resolve, { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    terminationFinished = true;
    return { code: 143, stdout: "", stderr: "", timedOut: false };
  },
  terminateManagedProcess: async () => true,
};

try {
  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "Claude cancellation race verification");
  assert.equal(
    persistedClaudeExecutionId("00000000-0000-4000-8000-000000000001", 0),
    "00000000-0000-4000-8000-000000000001",
    "pre-upgrade generation-zero rows must retain their legacy process identity",
  );
  const project = await createProject(handle.db, { workspaceId, name: "Cancellation fixture" });
  const session = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "Cancellation fixture",
    provider: "anthropic",
    backend: "claude",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
  });
  const runtime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor,
  });

  console.log("== active cancellation remains running until process termination resolves ==");
  const active = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Wait until cancelled",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  const running = runtime.runMission(active.mission.id);
  await processStarted;
  const activeClaim = await getClaudeRunByMission(handle.db, active.mission.id);
  assert.equal(activeClaim?.status, "running");
  assert.equal(activeClaim?.executionGeneration, 1);
  assert.ok(observedExecutionIds.includes(claudeAttemptExecutionId(active.mission.id, 1)));
  assert.equal(await runtime.cancel(active.mission.id), true);
  assert.equal(terminationFinished, false);
  assert.equal(await runtime.markCancelled(active.mission.id), false, "stale route state must not terminalize a running process");
  assert.equal((await getClaudeRunByMission(handle.db, active.mission.id))?.status, "running");
  assert.equal(await running, "cancelled");
  assert.equal(terminationFinished, true);
  assert.equal((await getClaudeRunByMission(handle.db, active.mission.id))?.status, "cancelled");

  console.log("== queued cancellation uses the atomic non-running transition ==");
  const queued = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Cancel before start",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  assert.equal(await runtime.markCancelled(queued.mission.id), true);
  assert.equal((await getClaudeRunByMission(handle.db, queued.mission.id))?.status, "cancelled");
  assert.equal(await runtime.markCancelled(queued.mission.id), false);

  console.log("== cancelling an approval-gated run retires its pending authorization ==");
  const gated = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "execute",
    prompt: "Cancel while awaiting approval",
    model: "sonnet",
    effort: null,
    permissionMode: "acceptEdits",
    config: { timeoutMs: 30_000 },
  });
  assert.equal(await runtime.runMission(gated.mission.id), "awaiting_approval");
  assert.equal(
    (await listApprovals(handle.db, "pending")).filter((row) => row.missionId === gated.mission.id).length,
    1,
  );
  assert.equal(await runtime.markCancelled(gated.mission.id), true);
  assert.equal(
    (await listApprovals(handle.db, "pending")).filter((row) => row.missionId === gated.mission.id).length,
    0,
  );

  console.log("== approval creation observes a concurrent durable cancel request ==");
  const gateRace = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "execute",
    prompt: "Cancel immediately before gate creation",
    model: "sonnet",
    effort: null,
    permissionMode: "acceptEdits",
    config: { timeoutMs: 30_000 },
  });
  await requestMissionCancel(handle.db, gateRace.mission.id);
  const refusedGate = await ensureClaudeApproval(handle.db, {
    runId: gateRace.run.id,
    missionId: gateRace.mission.id,
    nodeId: "claude.session.start",
    prompt: "Must not be created",
    tier: "write_approved",
  });
  assert.equal(refusedGate.eligible, false);
  assert.equal(refusedGate.cancelRequested, true);
  assert.equal(refusedGate.approval, null);
  assert.equal((await getClaudeRunByMission(handle.db, gateRace.mission.id))?.status, "queued");
  assert.equal(await runtime.markCancelled(gateRace.mission.id), true);

  console.log("== ordinary provisioning errors fail terminally instead of wedging the project ==");
  const provisioning = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Fail before process creation",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  const provisioningRuntime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor: {
      ...executor,
      ensure: async () => { throw new Error("configured workbench image is missing"); },
    },
  });
  assert.equal(await provisioningRuntime.runMission(provisioning.mission.id), "failed");
  assert.equal((await getClaudeRunByMission(handle.db, provisioning.mission.id))?.status, "failed");

  console.log("== OpenAI cancellation during trusted copy-back aborts the apply signal and rolls up cancelled ==");
  const openaiSession = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "OpenAI copy-back cancellation fixture",
    provider: "openai",
    backend: "aider",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "acceptEdits",
  });
  const openaiRun = await createClaudeRunMission(handle.db, {
    sessionId: openaiSession.id,
    mode: "execute",
    prompt: "Apply an edit, then wait at copy-back",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "acceptEdits",
    config: { timeoutMs: 30_000 },
  });
  let signalApplyStarted;
  const applyStarted = new Promise((resolve) => { signalApplyStarted = resolve; });
  let observedApplySignal;
  let observedApplyExecutionId;
  let cleanedExecutionId;
  let cleaned = false;
  const openaiRuntime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor: {
      status: async () => "running",
      ensure: async () => "fixture-workbench",
      run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      runStreaming: async (input, onChunk) => {
        assert.notEqual(input.command, "puppetmaster-sync recover /workbench");
        if (input.command === "git rev-parse --is-inside-work-tree") {
          return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
        }
        await onChunk({ stream: "stdout", text: "Aider v0.86.1\nApplied edit to fixture.ts\n" });
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      getExecutionSnapshot: fixtureSnapshot,
      applyExecutionResult: async (_projectId, executionId, _generation, _snapshotReceipt, signal) => {
        observedApplyExecutionId = executionId;
        observedApplySignal = signal;
        signalApplyStarted();
        await new Promise((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", resolve, { once: true });
        });
        return { code: 143, stdout: "", stderr: "", timedOut: false, committed: false };
      },
      cleanupExecutionArtifacts: async (executionId) => {
        cleaned = true;
        cleanedExecutionId = executionId;
      },
      terminateManagedProcess: async () => true,
    },
  });
  assert.equal(await openaiRuntime.runMission(openaiRun.mission.id), "awaiting_approval");
  const openaiApproval = await findApprovalForNode(handle.db, openaiRun.mission.id, "claude.session.start");
  assert.ok(openaiApproval);
  await resolveApproval(handle.db, openaiApproval.id, true);
  const applying = openaiRuntime.runMission(openaiRun.mission.id);
  await applyStarted;
  assert.equal(await openaiRuntime.cancel(openaiRun.mission.id), true);
  assert.equal(await applying, "cancelled");
  assert.equal(observedApplySignal?.aborted, true);
  assert.equal(cleaned, true);
  assert.equal(observedApplyExecutionId, claudeAttemptExecutionId(openaiRun.mission.id, 1));
  assert.equal(cleanedExecutionId, observedApplyExecutionId);
  assert.equal((await getClaudeRunByMission(handle.db, openaiRun.mission.id))?.status, "cancelled");

  console.log("== unproven copy-back rollback keeps the run and recovery artifacts active ==");
  const unproven = await createClaudeRunMission(handle.db, {
    sessionId: openaiSession.id,
    mode: "execute",
    prompt: "Simulate an unproven trusted rollback",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "acceptEdits",
    config: { timeoutMs: 30_000 },
  });
  let unprovenCleaned = false;
  let terminatedUnprovenExecutionId;
  const unprovenRuntime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor: {
      status: async () => "running",
      ensure: async () => "fixture-workbench",
      run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      runStreaming: async (input, onChunk) => {
        if (input.command === "git rev-parse --is-inside-work-tree") {
          return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
        }
        await onChunk({ stream: "stdout", text: "Aider v0.86.1\nApplied edit to fixture.ts\n" });
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      getExecutionSnapshot: fixtureSnapshot,
      applyExecutionResult: async () => {
        throw new WorkbenchTerminationError("rollback proof unavailable");
      },
      cleanupExecutionArtifacts: async () => { unprovenCleaned = true; },
      recoverExecutionCopyback: async () => ({
        state: "rolled-back",
        statusReceipt: "fixture-status",
        commitReceipt: null,
      }),
      terminateManagedProcess: async (_projectId, executionId) => {
        terminatedUnprovenExecutionId = executionId;
        return true;
      },
    },
  });
  assert.equal(await unprovenRuntime.runMission(unproven.mission.id), "awaiting_approval");
  const unprovenApproval = await findApprovalForNode(handle.db, unproven.mission.id, "claude.session.start");
  assert.ok(unprovenApproval);
  await resolveApproval(handle.db, unprovenApproval.id, true);
  assert.equal(await unprovenRuntime.runMission(unproven.mission.id), "running");
  assert.equal(unprovenCleaned, false, "recovery key volume must survive an unproven rollback");
  assert.equal((await getClaudeRunByMission(handle.db, unproven.mission.id))?.status, "running");
  assert.equal(await unprovenRuntime.cancel(unproven.mission.id), true);
  assert.equal(terminatedUnprovenExecutionId, claudeAttemptExecutionId(unproven.mission.id, 1));
  assert.equal((await getClaudeRunByMission(handle.db, unproven.mission.id))?.status, "cancelled");

  console.log("== runtime shutdown aborts and drains an active provider before returning ==");
  const shutdownRun = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Wait until shutdown",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  let signalShutdownStarted;
  const shutdownStarted = new Promise((resolve) => { signalShutdownStarted = resolve; });
  let shutdownSignal;
  const shutdownRuntime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor: {
      status: async () => "running",
      ensure: async () => "fixture-workbench",
      run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      runStreaming: async (input) => {
        if (input.command === "git rev-parse --is-inside-work-tree") {
          return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
        }
        shutdownSignal = input.signal;
        signalShutdownStarted();
        await new Promise((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", resolve, { once: true });
        });
        return { code: 143, stdout: "", stderr: "", timedOut: false };
      },
      terminateManagedProcess: async () => true,
    },
  });
  const activeAtShutdown = shutdownRuntime.runMission(shutdownRun.mission.id);
  await shutdownStarted;
  shutdownRuntime.beginShutdown();
  await shutdownRuntime.drain();
  assert.equal(shutdownSignal?.aborted, true);
  assert.equal(await activeAtShutdown, "cancelled");
  await assert.rejects(() => shutdownRuntime.runMission(shutdownRun.mission.id), /shutting down/);

  console.log("== non-zero Claude exit cannot be masked by a success result event ==");
  const lyingExit = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Emit success, then exit non-zero",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  const lyingRuntime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor: {
      status: async () => "running",
      ensure: async () => "fixture-workbench",
      run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      runStreaming: async (input, onChunk) => {
        if (input.command === "git rev-parse --is-inside-work-tree") {
          return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
        }
        await onChunk({
          stream: "stdout",
          text: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "not authoritative" })}\n`,
        });
        return { code: 9, stdout: "", stderr: "", timedOut: false };
      },
      terminateManagedProcess: async () => true,
    },
  });
  assert.equal(await lyingRuntime.runMission(lyingExit.mission.id), "failed");
  assert.match((await getClaudeRunByMission(handle.db, lyingExit.mission.id))?.error ?? "", /exited 9 despite reporting/);

  console.log("CLAUDE CANCELLATION RACES PASS: process proof + approval/cancel guards + apply abort propagation + honest exit status");
} finally {
  await handle.close();
}
