#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  claudeRuns,
  claimClaudeRun,
  commitWorkbenchCopybackAndFinishClaudeRun,
  createClaudeRunMission,
  createClaudeSession,
  createDb,
  createProject,
  createWorkbenchCopybackIntent,
  ensureDefaultWorkspace,
  getClaudeRunByMission,
  getMission,
  getWorkbenchCopybackByRunGeneration,
  markWorkbenchCopybackFilesCommitted,
  migrate,
  missions,
  prepareWorkbenchCopyback,
} from "../packages/db/dist/index.js";
import {
  ClaudeCodeRuntime,
  WorkbenchTerminationError,
  claudeAttemptExecutionId,
  workbenchCopybackIdentity,
} from "../packages/kernel/dist/index.js";

const handle = await createDb({ ephemeral: true });
const recovered = new Map();
const cleaned = [];
const terminated = [];
const terminationCalls = [];
const COMMIT = "fixture-authenticated-commit-receipt";

try {
  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "Copy-back recovery verification");
  const project = await createProject(handle.db, {
    workspaceId,
    name: "Recovery fixture",
    repoRef: "https://example.invalid/recovery.git",
  });
  const session = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "Recovery",
    provider: "openai",
    backend: "aider",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "acceptEdits",
  });

  const seed = async (name, { filesCommitted = false } = {}) => {
    const created = await createClaudeRunMission(handle.db, {
      sessionId: session.id,
      mode: "execute",
      prompt: name,
      model: "openai/gpt-5.6",
      effort: null,
      permissionMode: "acceptEdits",
      config: {},
    });
    const generation = await claimClaudeRun(handle.db, {
      runId: created.run.id,
      missionId: created.mission.id,
      startedAt: new Date(),
    });
    assert.equal(generation, 1);
    const executionId = claudeAttemptExecutionId(created.mission.id, generation);
    const identity = workbenchCopybackIdentity(project.id, executionId, generation);
    const intent = await createWorkbenchCopybackIntent(handle.db, {
      projectId: project.id,
      claudeRunId: created.run.id,
      executionId,
      executionIdentitySha256: identity,
      executionGeneration: generation,
      expectedRunStatus: "running",
      baseline: { snapshotReceipt: `snapshot-${name}` },
    });
    const guard = {
      id: intent.row.id,
      projectId: project.id,
      claudeRunId: created.run.id,
      executionId,
      executionIdentitySha256: identity,
      executionGeneration: generation,
      expectedRunStatus: "running",
    };
    const result = {
      subtype: "success",
      result: `${name} result`,
      isError: false,
      stopReason: "end_turn",
      totalCostUsd: null,
      durationMs: 100,
      durationApiMs: null,
      numTurns: null,
      usage: null,
      structuredOutput: null,
      raw: { fixture: name },
    };
    await prepareWorkbenchCopyback(handle.db, guard, {
      candidate: { identity },
      pendingCompletion: { status: "succeeded", result, error: null, finishedAt: new Date() },
    });
    if (filesCommitted) await markWorkbenchCopybackFilesCommitted(handle.db, guard, COMMIT);
    return { ...created, generation, executionId, guard, result };
  };

  const executor = {
    status: async () => "running",
    ensure: async () => "fixture",
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    runStreaming: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    terminateManagedProcess: async (projectId, executionId, options) => {
      terminated.push(executionId);
      terminationCalls.push({ projectId, executionId, options });
      return true;
    },
    recoverExecutionCopyback: async (_projectId, executionId) => {
      const state = recovered.get(executionId) ?? "committed";
      if (state === "tampered") throw new WorkbenchTerminationError("invalid journal signature");
      return {
        state,
        statusReceipt: `status-${executionId}`,
        commitReceipt: state === "committed" ? COMMIT : null,
      };
    },
    acknowledgeExecutionCopyback: async () => ({
      state: "acked",
      statusReceipt: "acked",
      commitReceipt: null,
    }),
    cleanupExecutionArtifacts: async (executionId) => { cleaned.push(executionId); },
  };
  const runtime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async () => {} },
    executor,
  });

  console.log("== crash after filesystem commit restores the terminal DB result ==");
  const committed = await seed("committed-before-db", { filesCommitted: true });
  recovered.set(committed.executionId, "committed");
  assert.equal((await getClaudeRunByMission(handle.db, committed.mission.id))?.status, "running");
  await runtime.reconcilePendingCopybacks();
  assert.equal((await getClaudeRunByMission(handle.db, committed.mission.id))?.status, "succeeded");
  assert.equal((await getMission(handle.db, committed.mission.id))?.status, "succeeded");
  assert.equal((await getWorkbenchCopybackByRunGeneration(handle.db, committed.run.id, 1))?.state, "cleaned");

  console.log("== cancellation racing after the commit marker cannot rewrite success ==");
  const cancelRace = await seed("cancel-after-commit", { filesCommitted: true });
  recovered.set(cancelRace.executionId, "committed");
  assert.equal(await runtime.cancel(cancelRace.mission.id), true);
  assert.equal(terminated.includes(cancelRace.executionId), true);
  assert.equal((await getClaudeRunByMission(handle.db, cancelRace.mission.id))?.status, "succeeded");

  console.log("== pre-commit interruption proves rollback and fails the run ==");
  const rolledBack = await seed("rollback-before-commit");
  recovered.set(rolledBack.executionId, "rolled-back");
  await runtime.reconcilePendingCopybacks();
  assert.equal((await getClaudeRunByMission(handle.db, rolledBack.mission.id))?.status, "failed");
  assert.equal((await getWorkbenchCopybackByRunGeneration(handle.db, rolledBack.run.id, 1))?.state, "cleaned");

  console.log("== DB commit before filesystem ack resumes cleanup idempotently ==");
  const ackPending = await seed("db-before-ack", { filesCommitted: true });
  await commitWorkbenchCopybackAndFinishClaudeRun(handle.db, ackPending.guard, COMMIT);
  assert.equal((await getWorkbenchCopybackByRunGeneration(handle.db, ackPending.run.id, 1))?.state, "db_committed");
  await runtime.reconcilePendingCopybacks();
  assert.equal((await getWorkbenchCopybackByRunGeneration(handle.db, ackPending.run.id, 1))?.state, "cleaned");

  console.log("== provider crash before copy-back intent terminates and terminalizes the exact generation ==");
  const orphan = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "orphan-before-intent",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "plan",
    config: {},
  });
  const orphanGeneration = await claimClaudeRun(handle.db, {
    runId: orphan.run.id,
    missionId: orphan.mission.id,
    startedAt: new Date(),
  });
  assert.equal(orphanGeneration, 1);
  const orphanExecutionId = claudeAttemptExecutionId(orphan.mission.id, orphanGeneration);
  const orphanRecovery = await runtime.reconcilePendingCopybacks();
  assert.equal(orphanRecovery.orphaned, 1);
  assert.equal(terminated.includes(orphanExecutionId), true);
  assert.equal(cleaned.includes(orphanExecutionId), true);
  assert.equal((await getClaudeRunByMission(handle.db, orphan.mission.id))?.status, "failed");
  assert.equal((await getMission(handle.db, orphan.mission.id))?.status, "failed");
  assert.equal(await runtime.runMission(orphan.mission.id), "failed");

  console.log("== legacy generation-zero orphan uses the force-stop fallback identity ==");
  const legacyHandle = await createDb({ ephemeral: true });
  try {
    await migrate(legacyHandle);
    const legacyWorkspaceId = await ensureDefaultWorkspace(legacyHandle.db, "Legacy recovery verification");
    const legacyProject = await createProject(legacyHandle.db, {
      workspaceId: legacyWorkspaceId,
      name: "Legacy recovery fixture",
      repoRef: "https://example.invalid/legacy.git",
    });
    const legacySession = await createClaudeSession(legacyHandle.db, {
      workspaceId: legacyWorkspaceId,
      projectId: legacyProject.id,
      title: "Legacy recovery",
      provider: "openai",
      backend: "aider",
      model: "openai/gpt-5.6",
      effort: null,
      permissionMode: "plan",
    });
    const legacy = await createClaudeRunMission(legacyHandle.db, {
      sessionId: legacySession.id,
      mode: "plan",
      prompt: "legacy-orphan",
      model: "openai/gpt-5.6",
      effort: null,
      permissionMode: "plan",
      config: {},
    });
    const legacyStarted = new Date();
    // This isolated fixture has exactly one run and one mission, so a table-wide
    // update can model the pre-generation schema without importing test-only SQL.
    await legacyHandle.db
      .update(claudeRuns)
      .set({ status: "running", executionGeneration: 0, startedAt: legacyStarted, updatedAt: legacyStarted });
    await legacyHandle.db
      .update(missions)
      .set({ status: "running", startedAt: legacyStarted });
    const legacyRuntime = new ClaudeCodeRuntime({
      db: legacyHandle.db,
      bus: { publish: async () => {} },
      executor,
    });
    const legacyRecovery = await legacyRuntime.reconcilePendingCopybacks();
    assert.equal(legacyRecovery.orphaned, 1);
    assert.equal((await getClaudeRunByMission(legacyHandle.db, legacy.mission.id))?.status, "failed");
    assert.equal(
      terminationCalls.some((call) =>
        call.executionId === legacy.mission.id && call.options?.allowLegacyProjectFallback === true),
      true,
    );
  } finally {
    await legacyHandle.close();
  }

  console.log("== tampered recovery evidence is quarantined without terminalizing the run ==");
  const tampered = await seed("tampered-journal");
  recovered.set(tampered.executionId, "tampered");
  await assert.rejects(() => runtime.reconcilePendingCopybacks(), /invalid journal signature/);
  assert.equal((await getClaudeRunByMission(handle.db, tampered.mission.id))?.status, "running");
  assert.equal((await getWorkbenchCopybackByRunGeneration(handle.db, tampered.run.id, 1))?.state, "quarantined");
  assert.equal(cleaned.includes(tampered.executionId), false);

  console.log("WORKBENCH COPYBACK RECOVERY PASS: commit-wins + rollback + DB/ack resume + orphan termination + quarantine");
} finally {
  await handle.close();
}
