#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createClaudeRunMission,
  createClaudeSession,
  createDb,
  createProject,
  ensureDefaultWorkspace,
  findApprovalForNode,
  getClaudeRunByMission,
  getWorkbenchCopybackByRunGeneration,
  listClaudeEvents,
  migrate,
  resolveApproval,
} from "../packages/db/dist/index.js";
import {
  ClaudeCodeRuntime,
  anthropicSecretNamesForTransport,
  claudeAttemptExecutionId,
  dockerExecEnvironmentPlan,
  managedProviderEnvironment,
  workbenchCopybackIdentity,
} from "../packages/kernel/dist/index.js";

const handle = await createDb({ ephemeral: true });
const busEvents = [];
const executions = [];
const appliedExecutions = [];
const applySignals = [];
const cleanedExecutions = [];
const executor = {
  status: async () => "running",
  ensure: async () => "fixture-workbench",
  run: async ({ command }) => {
    if (command === "git rev-parse --is-inside-work-tree") {
      return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
  runStreaming: async (input, onChunk) => {
    assert.notEqual(input.command, "puppetmaster-sync recover /workbench", "generic repository recovery is forbidden");
    if (input.command === "git rev-parse --is-inside-work-tree") {
      assert.equal(input.containerProfile, "plain");
      return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
    }
    executions.push(input);
    if (input.command.includes("claude -p")) {
      await onChunk({
        stream: "stdout",
        text: `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Claude path preserved",
          session_id: "00000000-0000-4000-8000-000000000001",
          num_turns: 1,
          usage: { input_tokens: 10, output_tokens: 5 },
        })}\n`,
      });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    const editing = input.command.includes("--chat-mode code");
    await onChunk({
      stream: "stdout",
      text: editing
        ? "Aider v0.86.1\nApplied edit to src/example.ts\nTokens: 220 sent, 45 received. Cost: $0.002 message, $0.003 session.\n"
        : "Aider v0.86.1\nThe repository contains one example module.\nTokens: 120 sent, 30 received. Cost: $0.001 message, $0.001 session.\n",
    });
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
  getExecutionSnapshot: async (projectId, executionId, executionGeneration) => ({
    projectId,
    executionId,
    executionGeneration,
    executionIdentitySha256: workbenchCopybackIdentity(projectId, executionId, executionGeneration),
    snapshotReceipt: `fixture-snapshot-${executionId}`,
  }),
  applyExecutionResult: async (_projectId, executionId, _generation, _snapshotReceipt, signal) => {
    appliedExecutions.push(executionId);
    applySignals.push(signal);
    return {
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      committed: true,
      commitReceipt: `fixture-commit-${executionId}`,
    };
  },
  acknowledgeExecutionCopyback: async () => ({
    state: "acked",
    statusReceipt: "fixture-status",
    commitReceipt: null,
  }),
  cleanupExecutionArtifacts: async (executionId) => { cleanedExecutions.push(executionId); },
  terminateManagedProcess: async () => true,
};

try {
  console.log("== managed provider environment forces Claude subprocess scrubbing only for Claude ==");
  assert.deepEqual(managedProviderEnvironment("claude"), { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  assert.deepEqual(managedProviderEnvironment("openai"), {});
  assert.deepEqual(managedProviderEnvironment("plain"), {});
  const secretSentinel = "sentinel-value-never-in-docker-argv";
  const execPlan = dockerExecEnvironmentPlan(
    { PATH: "fixture-path", openai_api_key: "stale-host-value", UNRELATED: "kept" },
    {
      OPENAI_API_KEY: secretSentinel,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "caller-cannot-select-this-value",
    },
    ["OPENAI_API_KEY", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"],
    managedProviderEnvironment("claude"),
  );
  assert.deepEqual(execPlan.args, [
    "-e", "OPENAI_API_KEY",
    "-e", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  ]);
  assert.equal(execPlan.args.some((arg) => arg.includes(secretSentinel)), false);
  assert.equal(execPlan.args.some((arg) => arg.includes("=")), false);
  assert.equal(execPlan.env.OPENAI_API_KEY, secretSentinel);
  assert.equal(execPlan.env.openai_api_key, undefined, "case-variant host secret must be scrubbed");
  assert.equal(execPlan.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(execPlan.env.UNRELATED, "kept");
  assert.throws(
    () => dockerExecEnvironmentPlan({}, { "INVALID-NAME": "secret" }, ["INVALID-NAME"]),
    /invalid managed environment name/,
  );
  assert.deepEqual(anthropicSecretNamesForTransport("bedrock"), [
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ]);

  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "OpenAI runtime verification");
  const project = await createProject(handle.db, {
    workspaceId,
    name: "OpenAI fixture",
    repoRef: "https://example.invalid/fixture.git",
  });
  const session = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "OpenAI coding fixture",
    provider: "openai",
    backend: "aider",
    model: "openai/gpt-5.6",
    effort: "high",
    permissionMode: "plan",
  });
  const runtime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async (event) => busEvents.push(event) },
    executor,
  });

  console.log("== OpenAI plan uses Aider ask mode and persists plain output ==");
  const plan = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Inspect the repository without editing",
    model: "openai/gpt-5.6",
    effort: "high",
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  assert.equal(await runtime.runMission(plan.mission.id), "succeeded");
  assert.match(executions[0].command, /--model 'openai\/gpt-5\.6'/);
  assert.match(executions[0].command, /--chat-mode ask/);
  assert.match(executions[0].command, /--reasoning-effort 'high'/);
  assert.match(executions[0].command, /puppetmaster-aider-turn-/);
  assert.match(executions[0].command, /cp -a -- \./);
  assert.match(executions[0].command, /env -i/);
  assert.match(executions[0].command, /GIT_CONFIG_NOSYSTEM=1/);
  assert.match(executions[0].command, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(executions[0].command, /GIT_CONFIG_KEY_0=core\.hooksPath/);
  assert.match(executions[0].command, /rm -rf -- '\.env'/);
  assert.equal(executions[0].containerProfile, "openai");
  assert.equal(executions[0].secretNames.includes("OPENAI_API_KEY"), true);
  assert.equal(executions[0].secretNames.includes("ANTHROPIC_API_KEY"), false);
  assert.deepEqual(appliedExecutions, [], "Plan must never invoke trusted copy-back");
  const planAttemptId = claudeAttemptExecutionId(plan.mission.id, 1);
  assert.equal(executions[0].executionId, planAttemptId);
  assert.equal(cleanedExecutions.includes(planAttemptId), true);
  const storedPlan = await getClaudeRunByMission(handle.db, plan.mission.id);
  assert.equal(storedPlan?.provider, "openai");
  assert.equal(storedPlan?.backend, "aider");
  assert.equal(storedPlan?.status, "succeeded");
  assert.equal(storedPlan?.executionGeneration, 1);
  assert.match(storedPlan?.resultText ?? "", /repository contains one example module/);
  assert.deepEqual(storedPlan?.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  const planEvents = await listClaudeEvents(handle.db, session.id);
  assert.equal(planEvents.some((event) => event.eventType === "aider.output"), true);

  console.log("== OpenAI execute retains the outer approval and uses Aider code mode ==");
  const execute = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "execute",
    prompt: "Update the example module",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "acceptEdits",
    config: { timeoutMs: 30_000 },
  });
  assert.equal(await runtime.runMission(execute.mission.id), "awaiting_approval");
  const approval = await findApprovalForNode(handle.db, execute.mission.id, "claude.session.start");
  assert.ok(approval);
  await resolveApproval(handle.db, approval.id, true);
  assert.equal(await runtime.runMission(execute.mission.id), "succeeded");
  assert.match(executions[1].command, /--chat-mode code/);
  assert.match(executions[1].command, /puppetmaster-aider-turn-/);
  assert.match(executions[1].command, /puppetmaster-sync apply "\$turn_root\/repo" \/workbench/);
  assert.match(executions[1].command, / - 'scratch-[A-Za-z0-9]+'/);
  assert.equal(executions[1].containerProfile, "openai");
  const executeAttemptId = claudeAttemptExecutionId(execute.mission.id, 1);
  assert.equal(executions[1].executionId, executeAttemptId);
  assert.equal(appliedExecutions.includes(executeAttemptId), true);
  assert.equal(applySignals[0] instanceof AbortSignal, true, "copy-back must receive the mission AbortSignal");
  assert.equal(cleanedExecutions.includes(executeAttemptId), true);
  const committedCopyback = await getWorkbenchCopybackByRunGeneration(handle.db, execute.run.id, 1);
  assert.equal(committedCopyback?.state, "cleaned");
  assert.equal(committedCopyback?.executionId, executeAttemptId);
  assert.equal(committedCopyback?.receipt, `fixture-commit-${executeAttemptId}`);
  const storedExecute = await getClaudeRunByMission(handle.db, execute.mission.id);
  assert.equal(storedExecute?.status, "succeeded");
  assert.equal(storedExecute?.executionGeneration, 1);
  assert.deepEqual(storedExecute?.result?.structuredOutput, { filesChanged: ["src/example.ts"] });

  assert.equal(
    busEvents.some((event) =>
      event.type === "claude.run.started" &&
      event.provider === "openai" &&
      event.backend === "aider"),
    true,
  );
  assert.equal(
    busEvents.some((event) =>
      event.type === "claude.run.finished" &&
      event.provider === "openai" &&
      event.backend === "aider" &&
      event.status === "succeeded"),
    true,
  );

  console.log("== Existing Anthropic sessions retain Claude CLI and receive only Anthropic secrets ==");
  const claudeSession = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "Claude regression fixture",
    provider: "anthropic",
    backend: "claude",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
  });
  const claudePlan = await createClaudeRunMission(handle.db, {
    sessionId: claudeSession.id,
    mode: "plan",
    prompt: "Inspect with the original Claude backend",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  assert.equal(await runtime.runMission(claudePlan.mission.id), "succeeded");
  const claudeExecution = executions.at(-1);
  assert.match(claudeExecution.command, /claude -p/);
  assert.match(claudeExecution.command, /--setting-sources ''/);
  assert.match(claudeExecution.command, /--strict-mcp-config/);
  assert.match(claudeExecution.command, /disableAllHooks/);
  assert.equal(claudeExecution.containerProfile, "claude");
  assert.equal(claudeExecution.readOnlyProject, true, "Anthropic Plan must request a read-only project mount");
  assert.equal(claudeExecution.secretNames.includes("ANTHROPIC_API_KEY"), true);
  assert.equal(claudeExecution.secretNames.includes("OPENAI_API_KEY"), false);

  console.log("== selected Bedrock transport requests no direct or unrelated cloud credentials ==");
  const bedrockSession = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "Bedrock credential scope fixture",
    provider: "anthropic",
    backend: "claude",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
  });
  const bedrockPlan = await createClaudeRunMission(handle.db, {
    sessionId: bedrockSession.id,
    mode: "plan",
    prompt: "Inspect through selected Bedrock transport",
    model: "sonnet",
    effort: null,
    permissionMode: "plan",
    config: { timeoutMs: 30_000 },
  });
  const bedrockRuntime = new ClaudeCodeRuntime({
    db: handle.db,
    bus: { publish: async (event) => busEvents.push(event) },
    executor,
    anthropicTransport: "bedrock",
  });
  assert.equal(await bedrockRuntime.runMission(bedrockPlan.mission.id), "succeeded");
  const bedrockExecution = executions.at(-1);
  assert.deepEqual(bedrockExecution.secretNames, anthropicSecretNamesForTransport("bedrock"));
  for (const unrelated of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_FOUNDRY_API_KEY",
  ]) {
    assert.equal(bedrockExecution.secretNames.includes(unrelated), false, `${unrelated} leaked into Bedrock context`);
  }

  console.log("== Anthropic Execute uses the same approved crash-recoverable copy-back ==");
  const claudeExecute = await createClaudeRunMission(handle.db, {
    sessionId: claudeSession.id,
    mode: "execute",
    prompt: "Apply an approved Claude edit",
    model: "sonnet",
    effort: null,
    permissionMode: "acceptEdits",
    config: { timeoutMs: 30_000 },
  });
  assert.equal(await runtime.runMission(claudeExecute.mission.id), "awaiting_approval");
  const claudeApproval = await findApprovalForNode(handle.db, claudeExecute.mission.id, "claude.session.start");
  assert.ok(claudeApproval);
  await resolveApproval(handle.db, claudeApproval.id, true);
  assert.equal(await runtime.runMission(claudeExecute.mission.id), "succeeded");
  assert.equal(executions.at(-1).containerProfile, "claude");
  assert.equal(executions.at(-1).readOnlyProject, false);
  const claudeExecuteAttemptId = claudeAttemptExecutionId(claudeExecute.mission.id, 1);
  assert.equal(executions.at(-1).executionGeneration, 1);
  assert.equal(appliedExecutions.includes(claudeExecuteAttemptId), true);
  assert.equal(
    (await getWorkbenchCopybackByRunGeneration(handle.db, claudeExecute.run.id, 1))?.state,
    "cleaned",
  );

  console.log("OPENAI CODING RUNTIME PASS: isolated modes, scoped secrets, and shared Anthropic/OpenAI copy-back recovery");
} finally {
  await handle.close();
}
