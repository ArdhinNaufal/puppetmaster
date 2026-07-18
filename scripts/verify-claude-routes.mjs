#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createDb,
  createProject,
  ensureDefaultWorkspace,
  finishClaudeRun,
  getClaudeRunByMission,
  getClaudeSession,
  getMission,
  listClaudeRuns,
  listClaudeSessions,
  migrate,
  resetClaudeRunForRetry,
} from "../packages/db/dist/index.js";
import {
  registerClaudeCodeRoutes,
  terminalizeClaudeQueueFailure,
} from "../apps/server/dist/claude-code-routes.js";

const requireFromServer = createRequire(new URL("../apps/server/package.json", import.meta.url));
const Fastify = requireFromServer("fastify");
const handle = await createDb({ ephemeral: true });
const app = Fastify({ logger: false });

try {
  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "Route verification");
  const project = await createProject(handle.db, {
    workspaceId,
    name: "Fixture",
    repoRef: "https://example.invalid/fixture.git",
  });
  const runtime = {
    enabled: () => true,
    inspectWorkbench: async () => ({ status: "absent", gitStatus: "", diffStat: "", diff: "", error: null }),
  };
  let queueOffline = true;
  const enqueued = [];
  const runner = {
    enqueue: async (missionId) => {
      if (queueOffline) throw new Error("fixture queue offline");
      enqueued.push(missionId);
    },
  };
  const providers = {
    anthropic: {
      authenticationConfigured: true,
      networkConfigured: true,
      runtimeConfigured: true,
      detectedCliVersion: "2.1.205",
      defaultModel: "sonnet",
      modelOptions: ["sonnet", "opus"],
      endpointHost: "api.anthropic.com",
    },
    openai: {
      authenticationConfigured: false,
      networkConfigured: true,
      runtimeConfigured: true,
      detectedCliVersion: "0.86.1",
      defaultModel: "openai/gpt-5",
      modelOptions: ["openai/gpt-5", "openai/gpt-5-mini"],
      endpointHost: "api.openai.com",
    },
  };
  registerClaudeCodeRoutes(app, {
    db: handle.db,
    workspaceId,
    runtime,
    runner,
    providers,
    egressAllow: ["api.anthropic.com", "api.openai.com"],
  });
  await app.ready();

  const finishQueuedMission = async (missionId) => {
    const run = await getClaudeRunByMission(handle.db, missionId);
    assert.ok(run, `missing Claude run for mission ${missionId}`);
    const session = await getClaudeSession(handle.db, run.sessionId);
    assert.ok(session, `missing Claude session ${run.sessionId}`);
    await finishClaudeRun(handle.db, {
      runId: run.id,
      sessionId: session.id,
      missionId,
      status: "succeeded",
      result: null,
      error: null,
      finishedAt: new Date(),
      expectedStatuses: ["queued"],
    });
  };

  const catalog = await app.inject({ method: "GET", url: "/api/claude-code/catalog" });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().trustBoundary.rawPromptTextIncluded, false);
  const invalidCatalog = await app.inject({ method: "GET", url: "/api/claude-code/catalog?unknown=true" });
  assert.equal(invalidCatalog.statusCode, 400);
  const invalidList = await app.inject({ method: "GET", url: "/api/claude-code/sessions?limit=invalid" });
  assert.equal(invalidList.statusCode, 400);
  const unknownListQuery = await app.inject({ method: "GET", url: "/api/claude-code/sessions?unknown=true" });
  assert.equal(unknownListQuery.statusCode, 400);

  const invalidSessionRequests = [
    { method: "GET", url: "/api/claude-code/sessions/not-a-uuid" },
    { method: "GET", url: "/api/claude-code/sessions/not-a-uuid/events" },
    { method: "GET", url: "/api/claude-code/sessions/not-a-uuid/workbench" },
    { method: "PUT", url: "/api/claude-code/sessions/not-a-uuid", payload: { title: "invalid" } },
    { method: "POST", url: "/api/claude-code/sessions/not-a-uuid/messages", payload: { prompt: "invalid" } },
  ];
  for (const request of invalidSessionRequests) {
    const invalid = await app.inject(request);
    assert.equal(invalid.statusCode, 400, `${request.method} ${request.url} must reject an invalid UUID`);
    assert.equal(invalid.json().error, "invalid session id");
  }

  const unknownCreateQuery = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions?unknown=true",
    payload: { projectId: project.id, prompt: "Unknown mutation queries must fail" },
  });
  assert.equal(unknownCreateQuery.statusCode, 400);
  assert.equal((await listClaudeSessions(handle.db, workspaceId)).length, 0);

  providers.anthropic.authenticationConfigured = false;
  providers.anthropic.authenticationError =
    "Claude Code Bedrock authentication is not configured; set AWS_BEARER_TOKEN_BEDROCK or both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.";
  const transportAuthFailure = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: {
      projectId: project.id,
      prompt: "Transport-specific authentication errors must reach the caller",
    },
  });
  assert.equal(transportAuthFailure.statusCode, 503);
  assert.equal(transportAuthFailure.json().error, providers.anthropic.authenticationError);
  assert.equal((await listClaudeSessions(handle.db, workspaceId)).length, 0);
  providers.anthropic.authenticationConfigured = true;
  delete providers.anthropic.authenticationError;

  const response = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: {
      projectId: project.id,
      prompt: "Queue failure must not wedge the session",
      mode: "plan",
      model: "sonnet",
    },
  });
  assert.equal(response.statusCode, 503);
  const sessions = await listClaudeSessions(handle.db, workspaceId);
  assert.equal(sessions.length, 1);
  const runs = await listClaudeRuns(handle.db, sessions[0].id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.match(runs[0].error ?? "", /queue handoff failed/);
  assert.equal((await getMission(handle.db, runs[0].missionId))?.status, "failed");
  const queueFailure = response.json();
  assert.equal(queueFailure.sessionId, sessions[0].id);
  assert.equal(queueFailure.runId, runs[0].id);
  assert.equal(queueFailure.missionId, runs[0].missionId);

  // The public default stays backward-compatible: an omitted provider is an Anthropic/Claude snapshot.
  assert.equal(sessions[0].provider, "anthropic");
  assert.equal(sessions[0].backend, "claude");
  assert.equal(runs[0].provider, "anthropic");
  assert.equal(runs[0].backend, "claude");
  const invalidUpdate = await app.inject({
    method: "PUT",
    url: `/api/claude-code/sessions/${sessions[0].id}`,
    payload: { title: "Unknown fields must fail", provider: "openai" },
  });
  assert.equal(invalidUpdate.statusCode, 400);
  const unknownUpdateQuery = await app.inject({
    method: "PUT",
    url: `/api/claude-code/sessions/${sessions[0].id}?unknown=true`,
    payload: { title: "Unknown query must fail" },
  });
  assert.equal(unknownUpdateQuery.statusCode, 400);

  const invalidBackendInput = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: {
      projectId: project.id,
      prompt: "Backend is selected by provider",
      provider: "anthropic",
      backend: "aider",
    },
  });
  assert.equal(invalidBackendInput.statusCode, 400);

  const anthropicOpenAiModel = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: {
      projectId: project.id,
      prompt: "Do not cross provider model namespaces",
      provider: "anthropic",
      model: "openai/gpt-5",
    },
  });
  assert.equal(anthropicOpenAiModel.statusCode, 400);
  assert.match(anthropicOpenAiModel.json().error, /do not accept OpenAI model identifiers/);

  queueOffline = false;

  // Provider readiness is isolated: Anthropic was accepted above, while OpenAI needs its own credentials and egress.
  const openAiPayload = {
    projectId: project.id,
    provider: "openai",
    prompt: "Use the OpenAI coding backend",
    mode: "plan",
    model: "gpt-5",
  };
  const missingOpenAiAuth = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: openAiPayload,
  });
  assert.equal(missingOpenAiAuth.statusCode, 503);
  assert.match(missingOpenAiAuth.json().error, /OPENAI_API_KEY/);

  providers.openai.authenticationConfigured = true;
  providers.openai.networkConfigured = false;
  const missingOpenAiEgress = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: openAiPayload,
  });
  assert.equal(missingOpenAiEgress.statusCode, 503);
  assert.match(missingOpenAiEgress.json().error, /api\.openai\.com/);
  assert.match(missingOpenAiEgress.json().error, /WORKBENCH_EGRESS_ALLOW/);
  providers.openai.networkConfigured = true;

  const unsupportedMaxTurns = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: { ...openAiPayload, maxTurns: 4 },
  });
  assert.equal(unsupportedMaxTurns.statusCode, 400);
  assert.match(unsupportedMaxTurns.json().error, /do not support maxTurns or maxBudgetUsd/);

  const unsupportedBudget = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: { ...openAiPayload, maxBudgetUsd: 2 },
  });
  assert.equal(unsupportedBudget.statusCode, 400);
  assert.match(unsupportedBudget.json().error, /do not support maxTurns or maxBudgetUsd/);

  const foreignProviderPrefix = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: { ...openAiPayload, model: "anthropic/claude-sonnet-4" },
  });
  assert.equal(foreignProviderPrefix.statusCode, 400);
  assert.match(foreignProviderPrefix.json().error, /only accept OpenAI models/);

  const emptyOpenAiModel = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: { ...openAiPayload, model: "openai/" },
  });
  assert.equal(emptyOpenAiModel.statusCode, 400);
  assert.match(emptyOpenAiModel.json().error, /include a name/);

  const openAiResponse = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: openAiPayload,
  });
  assert.equal(openAiResponse.statusCode, 202);
  const openAiCreated = openAiResponse.json();
  assert.equal(openAiCreated.session.provider, "openai");
  assert.equal(openAiCreated.session.backend, "aider");
  assert.equal(openAiCreated.session.model, "openai/gpt-5");
  assert.equal(openAiCreated.run.provider, "openai");
  assert.equal(openAiCreated.run.backend, "aider");
  assert.equal(openAiCreated.run.model, "openai/gpt-5");
  assert.equal(Object.hasOwn(openAiCreated.run.config, "maxTurns"), false);
  assert.equal(Object.hasOwn(openAiCreated.run.config, "maxBudgetUsd"), false);
  assert.deepEqual(enqueued, [openAiCreated.missionId]);

  const sessionsBeforeBusy = (await listClaudeSessions(handle.db, workspaceId)).length;
  const busyNewSession = await app.inject({
    method: "POST",
    url: "/api/claude-code/sessions",
    payload: {
      projectId: project.id,
      prompt: "This must not leak an empty session",
      mode: "plan",
      model: "sonnet",
    },
  });
  assert.equal(busyNewSession.statusCode, 409);
  assert.equal((await listClaudeSessions(handle.db, workspaceId)).length, sessionsBeforeBusy);

  const storedOpenAiRuns = await listClaudeRuns(handle.db, openAiCreated.session.id);
  assert.equal(storedOpenAiRuns.length, 1);
  assert.equal(storedOpenAiRuns[0].provider, "openai");
  assert.equal(storedOpenAiRuns[0].backend, "aider");
  assert.equal(storedOpenAiRuns[0].model, "openai/gpt-5");
  await finishQueuedMission(openAiCreated.missionId);

  const invalidSessionQuery = await app.inject({
    method: "GET",
    url: `/api/claude-code/sessions/${openAiCreated.session.id}?unknown=true`,
  });
  assert.equal(invalidSessionQuery.statusCode, 400);
  const unknownMessageQuery = await app.inject({
    method: "POST",
    url: `/api/claude-code/sessions/${openAiCreated.session.id}/messages?unknown=true`,
    payload: { prompt: "Unknown message queries must fail" },
  });
  assert.equal(unknownMessageQuery.statusCode, 400);
  assert.equal((await listClaudeRuns(handle.db, openAiCreated.session.id)).length, 1);

  providers.openai.authenticationConfigured = false;
  const providerSwitch = await app.inject({
    method: "POST",
    url: `/api/claude-code/sessions/${openAiCreated.session.id}/messages`,
    payload: {
      prompt: "Try to switch this continuation to Anthropic",
      mode: "plan",
      provider: "anthropic",
    },
  });
  assert.equal(providerSwitch.statusCode, 400);
  assert.equal(providerSwitch.json().error, "invalid coding turn");
  assert.equal((await listClaudeRuns(handle.db, openAiCreated.session.id)).length, 1);
  providers.openai.authenticationConfigured = true;

  queueOffline = true;
  const failedContinuation = await app.inject({
    method: "POST",
    url: `/api/claude-code/sessions/${openAiCreated.session.id}/messages`,
    payload: {
      prompt: "This continuation must expose its durable retry identifiers",
      mode: "plan",
    },
  });
  assert.equal(failedContinuation.statusCode, 503);
  const failedContinuationBody = failedContinuation.json();
  assert.equal(failedContinuationBody.sessionId, openAiCreated.session.id);
  const failedContinuationRuns = await listClaudeRuns(handle.db, openAiCreated.session.id);
  assert.equal(failedContinuationRuns.length, 2);
  assert.equal(failedContinuationRuns[1].status, "failed");
  assert.equal(failedContinuationBody.runId, failedContinuationRuns[1].id);
  assert.equal(failedContinuationBody.missionId, failedContinuationRuns[1].missionId);
  assert.deepEqual(
    await resetClaudeRunForRetry(handle.db, failedContinuationBody.missionId),
    { ok: true },
  );
  const retryQueueFailure = await terminalizeClaudeQueueFailure(handle.db, {
    runId: failedContinuationBody.runId,
    sessionId: failedContinuationBody.sessionId,
    missionId: failedContinuationBody.missionId,
    error: new Error("fixture retry queue offline"),
    prefix: "retry queue handoff failed",
    expectedStatuses: ["queued"],
  });
  assert.equal(retryQueueFailure.completion.transitioned, true);
  assert.equal((await getClaudeRunByMission(handle.db, failedContinuationBody.missionId))?.status, "failed");
  assert.equal((await getMission(handle.db, failedContinuationBody.missionId))?.status, "failed");
  assert.match(
    (await getClaudeRunByMission(handle.db, failedContinuationBody.missionId))?.error ?? "",
    /retry queue handoff failed: fixture retry queue offline/,
  );
  queueOffline = false;

  const continuation = await app.inject({
    method: "POST",
    url: `/api/claude-code/sessions/${openAiCreated.session.id}/messages`,
    payload: {
      prompt: "Continue with the original provider snapshot",
      mode: "plan",
    },
  });
  assert.equal(continuation.statusCode, 202);
  const continued = continuation.json();
  assert.equal(continued.session.provider, "openai");
  assert.equal(continued.session.backend, "aider");
  assert.equal(continued.session.model, "openai/gpt-5");
  assert.equal(continued.run.provider, "openai");
  assert.equal(continued.run.backend, "aider");
  assert.equal(continued.run.model, "openai/gpt-5");

  const continuedRuns = await listClaudeRuns(handle.db, openAiCreated.session.id);
  assert.equal(continuedRuns.length, 3);
  assert.deepEqual(continuedRuns.map((run) => run.provider), ["openai", "openai", "openai"]);
  assert.deepEqual(continuedRuns.map((run) => run.backend), ["aider", "aider", "aider"]);
  await finishQueuedMission(continued.missionId);

  console.log(
    "CLAUDE ROUTES PASS: strict UUID/query/body validation, create/continue/retry queue-failure terminalization, provider readiness, project-lock cleanup, and immutable continuation snapshots",
  );
} finally {
  await app.close();
  await handle.close();
}
