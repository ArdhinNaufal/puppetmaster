#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  ClaudeSessionBusyError,
  appendClaudeEvent,
  claimClaudeRun,
  createClaudeRunMission,
  createClaudeSession,
  createDb,
  createProject,
  ensureClaudeApproval,
  ensureDefaultWorkspace,
  finishClaudeRun,
  getClaudeRun,
  getClaudeSession,
  getMission,
  listClaudeEvents,
  listApprovals,
  listAudit,
  migrate,
  monthTokens,
  resetClaudeRunForRetry,
  updateClaudeRun,
  updateClaudeSession,
} from "../packages/db/dist/index.js";
import { claudeAttemptExecutionId } from "../packages/kernel/dist/index.js";

const handle = await createDb({ ephemeral: true });
try {
  await migrate(handle);
  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "Claude verification");
  const project = await createProject(handle.db, { workspaceId, name: "Fixture" });
  const session = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "Durability fixture",
    model: "sonnet",
    effort: "high",
    permissionMode: "plan",
  });
  assert.equal(session.provider, "anthropic");
  assert.equal(session.backend, "claude");

  const first = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Inspect only",
    model: "sonnet",
    effort: "high",
    permissionMode: "plan",
    config: { maxTurns: 3 },
  });
  assert.equal(first.run.provider, "anthropic");
  assert.equal(first.run.backend, "claude");
  assert.equal(first.run.executionGeneration, 0);
  assert.equal(first.mission.trigger.provider, "anthropic");
  assert.equal(first.mission.trigger.backend, "claude");
  assert.equal(first.mission.input.provider, "anthropic");
  assert.equal(first.mission.input.backend, "claude");

  const guardedSessionBefore = await getClaudeSession(handle.db, session.id);
  const guardedMissionBefore = await getMission(handle.db, first.mission.id);
  const guardedFinish = await finishClaudeRun(handle.db, {
    runId: first.run.id,
    sessionId: session.id,
    missionId: first.mission.id,
    status: "cancelled",
    result: null,
    error: "must not transition from queued",
    finishedAt: new Date(),
    expectedStatuses: ["awaiting_approval"],
  });
  assert.deepEqual(guardedFinish, { transitioned: false, status: "queued" });
  assert.equal((await getClaudeRun(handle.db, first.run.id))?.status, "queued");
  assert.equal((await getMission(handle.db, first.mission.id))?.status, "queued");
  assert.equal(
    (await getClaudeSession(handle.db, session.id))?.updatedAt.getTime(),
    guardedSessionBefore?.updatedAt.getTime(),
  );
  assert.equal(
    (await getMission(handle.db, first.mission.id))?.finishedAt,
    guardedMissionBefore?.finishedAt,
  );
  assert.equal((await listAudit(handle.db, workspaceId, { action: "claude.run.finished" })).length, 0);

  await assert.rejects(
    () => createClaudeRunMission(handle.db, {
      sessionId: session.id,
      mode: "plan",
      prompt: "Must be rejected while active",
      model: "sonnet",
      permissionMode: "plan",
    }),
    (error) => error instanceof ClaudeSessionBusyError,
  );

  const gate1 = await ensureClaudeApproval(handle.db, {
    runId: first.run.id,
    missionId: first.mission.id,
    nodeId: "claude.session.start",
    prompt: "Approve fixture",
    tier: "write_approved",
  });
  const gate2 = await ensureClaudeApproval(handle.db, {
    runId: first.run.id,
    missionId: first.mission.id,
    nodeId: "claude.session.start",
    prompt: "Approve fixture",
    tier: "write_approved",
  });
  assert.equal(gate1.created, true);
  assert.equal(gate2.created, false);
  assert.equal(gate1.eligible, true);
  assert.equal(gate2.eligible, true);
  assert.equal(gate1.approval.id, gate2.approval.id);

  const firstGeneration = await claimClaudeRun(handle.db, {
    runId: first.run.id,
    missionId: first.mission.id,
    startedAt: new Date(),
  });
  assert.equal(firstGeneration, 1);
  assert.equal(await claimClaudeRun(handle.db, {
    runId: first.run.id,
    missionId: first.mission.id,
    startedAt: new Date(),
  }), null);
  await assert.rejects(
    () => finishClaudeRun(handle.db, {
      runId: first.run.id,
      sessionId: session.id,
      missionId: first.mission.id,
      status: "failed",
      result: null,
      error: "missing generation must be rejected",
      finishedAt: new Date(),
      expectedStatuses: ["running"],
    }),
    /requires its nonnegative execution generation/,
  );
  assert.equal((await getClaudeRun(handle.db, first.run.id))?.status, "running");

  const appended = await Promise.all(
    Array.from({ length: 20 }, (_, index) => appendClaudeEvent(handle.db, {
      sessionId: session.id,
      runId: first.run.id,
      stream: "stdout",
      eventType: "fixture",
      raw: JSON.stringify({ index }),
      payload: { index },
    })),
  );
  assert.deepEqual(
    appended.map((event) => event.sequence).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1),
    "concurrent appends must allocate gap-free unique sequence numbers",
  );

  const result = {
    subtype: "success",
    result: "done",
    isError: false,
    stopReason: null,
    totalCostUsd: 0.01,
    durationMs: 100,
    durationApiMs: 80,
    numTurns: 1,
    usage: { inputTokens: 10, outputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    structuredOutput: null,
    raw: null,
  };
  const finished = await finishClaudeRun(handle.db, {
    runId: first.run.id,
    sessionId: session.id,
    missionId: first.mission.id,
    status: "succeeded",
    result,
    error: null,
    finishedAt: new Date(),
    expectedStatuses: ["running"],
    expectedGeneration: firstGeneration,
  });
  assert.equal(finished.transitioned, true);
  const sessionTimestampAfterFinish = (await getClaudeSession(handle.db, session.id))?.updatedAt.getTime();
  const duplicate = await finishClaudeRun(handle.db, {
    runId: first.run.id,
    sessionId: session.id,
    missionId: first.mission.id,
    status: "failed",
    result: null,
    error: "must not overwrite",
    finishedAt: new Date(Date.now() + 60_000),
    expectedStatuses: ["succeeded"],
  });
  assert.equal(duplicate.transitioned, false);
  assert.equal((await getClaudeRun(handle.db, first.run.id))?.status, "succeeded");
  assert.equal((await getMission(handle.db, first.mission.id))?.status, "succeeded");
  assert.equal(
    (await getClaudeSession(handle.db, session.id))?.updatedAt.getTime(),
    sessionTimestampAfterFinish,
    "duplicate terminal reconciliation must not reorder the session",
  );
  assert.equal((await listClaudeEvents(handle.db, session.id, { limit: 100 })).length, 20);
  assert.deepEqual(
    (await listClaudeEvents(handle.db, session.id, { tail: true, limit: 5 })).map((event) => event.sequence),
    [16, 17, 18, 19, 20],
  );
  assert.deepEqual(
    (await listClaudeEvents(handle.db, session.id, { before: 16, limit: 5 })).map((event) => event.sequence),
    [11, 12, 13, 14, 15],
  );
  const [defaultFinishedAudit] = await listAudit(handle.db, workspaceId, { action: "claude.run.finished" });
  assert.equal(defaultFinishedAudit?.actorLabel, "claude-code");
  assert.equal(defaultFinishedAudit?.detail.provider, "anthropic");
  assert.equal(defaultFinishedAudit?.detail.backend, "claude");
  const [defaultUsageAudit] = await listAudit(handle.db, workspaceId, { action: "llm.call" });
  assert.equal(defaultUsageAudit?.actorLabel, "claude-code");
  assert.equal(defaultUsageAudit?.detail.provider, "anthropic");
  assert.equal(defaultUsageAudit?.detail.backend, "claude");
  assert.equal(defaultUsageAudit?.detail.cli, "claude-code");
  assert.equal(await monthTokens(handle.db, workspaceId), 14);

  const providerProject = await createProject(handle.db, { workspaceId, name: "Provider fixture" });
  await assert.rejects(
    () => createClaudeSession(handle.db, {
      workspaceId,
      projectId: providerProject.id,
      provider: "openai",
      backend: "claude",
      title: "Invalid provider/backend pair",
      model: "gpt-5",
      permissionMode: "plan",
    }),
    /Invalid coding provider\/backend pair/,
  );
  await assert.rejects(
    () => createClaudeSession(handle.db, {
      workspaceId,
      projectId: providerProject.id,
      provider: "anthropic",
      backend: "claude",
      title: "Invalid Anthropic model",
      model: "openai/gpt-5",
      permissionMode: "plan",
    }),
    /do not accept OpenAI model identifiers/,
  );
  const providerSession = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: providerProject.id,
    provider: "openai",
    backend: "aider",
    title: "OpenAI via Aider",
    model: "gpt-5",
    effort: "high",
    permissionMode: "plan",
  });
  assert.equal(providerSession.provider, "openai");
  assert.equal(providerSession.backend, "aider");
  assert.equal(providerSession.model, "openai/gpt-5");
  await updateClaudeSession(handle.db, providerSession.id, {
    provider: "anthropic",
    backend: "claude",
    title: "Immutable provider fixture",
  });
  const immutableSession = await getClaudeSession(handle.db, providerSession.id);
  assert.equal(immutableSession?.provider, "openai", "session provider must be immutable");
  assert.equal(immutableSession?.backend, "aider", "session backend must be immutable");

  const providerTurn = await createClaudeRunMission(handle.db, {
    sessionId: providerSession.id,
    mode: "plan",
    prompt: "Verify provider snapshot",
    model: "gpt-5",
    effort: "high",
    permissionMode: "plan",
    provider: "anthropic",
    backend: "claude",
  });
  assert.equal(providerTurn.run.provider, "openai");
  assert.equal(providerTurn.run.backend, "aider");
  assert.equal(providerTurn.run.model, "openai/gpt-5");
  assert.equal(providerTurn.mission.trigger.provider, "openai");
  assert.equal(providerTurn.mission.trigger.backend, "aider");
  assert.equal(providerTurn.mission.input.provider, "openai");
  assert.equal(providerTurn.mission.input.backend, "aider");
  await assert.rejects(
    () => updateClaudeRun(handle.db, providerTurn.run.id, {
      provider: "anthropic",
      backend: "claude",
    }),
    /snapshot field provider is immutable/,
  );
  await finishClaudeRun(handle.db, {
    runId: providerTurn.run.id,
    sessionId: providerSession.id,
    missionId: providerTurn.mission.id,
    status: "succeeded",
    result,
    error: null,
    finishedAt: new Date(),
    expectedStatuses: ["queued"],
  });
  const providerFinishedAudit = (
    await listAudit(handle.db, workspaceId, { action: "openai.run.finished" })
  ).find((row) => row.missionId === providerTurn.mission.id);
  assert.equal(providerFinishedAudit?.actorLabel, "openai-aider");
  assert.equal(providerFinishedAudit?.detail.provider, "openai");
  assert.equal(providerFinishedAudit?.detail.backend, "aider");
  const providerUsageAudit = (
    await listAudit(handle.db, workspaceId, { action: "llm.call" })
  ).find((row) => row.missionId === providerTurn.mission.id);
  assert.equal(providerUsageAudit?.detail.provider, "openai");
  assert.equal(providerUsageAudit?.detail.backend, "aider");
  assert.equal(providerUsageAudit?.detail.cli, "aider");

  console.log("== stale claimed generation cannot finish a retried/reclaimed run ==");
  const aba = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Exercise the execution-generation ABA guard",
    model: "sonnet",
    permissionMode: "plan",
  });
  assert.equal(aba.run.executionGeneration, 0);
  const generationA = await claimClaudeRun(handle.db, {
    runId: aba.run.id,
    missionId: aba.mission.id,
    startedAt: new Date(),
  });
  assert.equal(generationA, 1);
  assert.equal((await finishClaudeRun(handle.db, {
    runId: aba.run.id,
    sessionId: session.id,
    missionId: aba.mission.id,
    status: "cancelled",
    result: null,
    error: "worker B cancelled generation A",
    finishedAt: new Date(),
    expectedStatuses: ["running"],
    expectedGeneration: generationA,
  })).transitioned, true);
  assert.deepEqual(await resetClaudeRunForRetry(handle.db, aba.mission.id), { ok: true });
  assert.equal(
    (await getClaudeRun(handle.db, aba.run.id))?.executionGeneration,
    generationA,
    "retry must preserve the prior claim generation",
  );
  const generationC = await claimClaudeRun(handle.db, {
    runId: aba.run.id,
    missionId: aba.mission.id,
    startedAt: new Date(),
  });
  assert.equal(generationC, generationA + 1);
  assert.notEqual(
    claudeAttemptExecutionId(aba.mission.id, generationA),
    claudeAttemptExecutionId(aba.mission.id, generationC),
    "each claimed generation must have a distinct Docker/scratch identity",
  );
  const delayedA = await finishClaudeRun(handle.db, {
    runId: aba.run.id,
    sessionId: session.id,
    missionId: aba.mission.id,
    status: "failed",
    result: null,
    error: "delayed worker A must not finish worker C",
    finishedAt: new Date(),
    expectedStatuses: ["running"],
    expectedGeneration: generationA,
  });
  assert.deepEqual(delayedA, { transitioned: false, status: "running" });
  const afterDelayedA = await getClaudeRun(handle.db, aba.run.id);
  assert.equal(afterDelayedA?.status, "running");
  assert.equal(afterDelayedA?.executionGeneration, generationC);
  assert.equal(afterDelayedA?.error, null);
  assert.equal((await finishClaudeRun(handle.db, {
    runId: aba.run.id,
    sessionId: session.id,
    missionId: aba.mission.id,
    status: "succeeded",
    result,
    error: null,
    finishedAt: new Date(),
    expectedStatuses: ["running"],
    expectedGeneration: generationC,
  })).transitioned, true);

  const competing = await Promise.allSettled([
    createClaudeRunMission(handle.db, {
      sessionId: session.id,
      mode: "execute",
      prompt: "winner A",
      model: "sonnet",
      permissionMode: "acceptEdits",
    }),
    createClaudeRunMission(handle.db, {
      sessionId: session.id,
      mode: "execute",
      prompt: "winner B",
      model: "sonnet",
      permissionMode: "acceptEdits",
    }),
  ]);
  assert.equal(competing.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(competing.filter((row) => row.status === "rejected").length, 1);
  const second = competing.find((row) => row.status === "fulfilled").value;
  const oldRetryGate = await ensureClaudeApproval(handle.db, {
    runId: second.run.id,
    missionId: second.mission.id,
    nodeId: "claude.session.start",
    prompt: "Approve second fixture",
    tier: "write_approved",
  });
  await finishClaudeRun(handle.db, {
    runId: second.run.id,
    sessionId: session.id,
    missionId: second.mission.id,
    status: "cancelled",
    result: null,
    error: "fixture",
    finishedAt: new Date(),
    expectedStatuses: ["awaiting_approval"],
  });
  const inactiveGate = await ensureClaudeApproval(handle.db, {
    runId: second.run.id,
    missionId: second.mission.id,
    nodeId: "claude.session.start",
    prompt: "A terminal run must not be gated again",
    tier: "write_approved",
  });
  assert.equal(inactiveGate.eligible, false);
  assert.equal(inactiveGate.approval, null);
  assert.equal((await getClaudeRun(handle.db, second.run.id))?.status, "cancelled");
  assert.equal(
    (await listApprovals(handle.db, "pending")).filter((row) => row.missionId === second.mission.id).length,
    0,
    "terminalization must retire pending Claude authorization gates",
  );

  const retry = await resetClaudeRunForRetry(handle.db, second.mission.id);
  assert.deepEqual(retry, { ok: true });
  assert.equal((await getClaudeRun(handle.db, second.run.id))?.status, "queued");
  assert.equal((await getMission(handle.db, second.mission.id))?.status, "queued");
  const staleTerminalDelivery = await finishClaudeRun(handle.db, {
    runId: second.run.id,
    sessionId: session.id,
    missionId: second.mission.id,
    status: "cancelled",
    result: null,
    error: "stale terminal delivery",
    finishedAt: new Date(),
    expectedStatuses: ["cancelled"],
  });
  assert.deepEqual(staleTerminalDelivery, { transitioned: false, status: "queued" });
  assert.equal((await getClaudeRun(handle.db, second.run.id))?.status, "queued");

  const sibling = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "Same project",
    model: "sonnet",
    permissionMode: "plan",
  });
  await assert.rejects(
    () => createClaudeRunMission(handle.db, {
      sessionId: sibling.id,
      mode: "plan",
      prompt: "Cannot overlap the same project volume",
      model: "sonnet",
      permissionMode: "plan",
    }),
    (error) => error instanceof ClaudeSessionBusyError,
  );
  const freshRetryGate = await ensureClaudeApproval(handle.db, {
    runId: second.run.id,
    missionId: second.mission.id,
    nodeId: "claude.session.start",
    prompt: "Approve second fixture again",
    tier: "write_approved",
  });
  assert.equal(freshRetryGate.created, true, "retry must require a fresh approval row");
  assert.notEqual(freshRetryGate.approval.id, oldRetryGate.approval.id);

  console.log("CLAUDE PERSISTENCE PASS: provider snapshots, guarded terminal retry, approval retirement, stable timestamps, project lock, atomic audit/usage, concurrency");
} finally {
  await handle.close();
}
