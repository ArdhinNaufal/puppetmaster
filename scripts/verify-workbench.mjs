#!/usr/bin/env node
// WP3b.1 verification - drives the built DockerCommandExecutor against a real
// Docker daemon. The eval harness cannot exercise containers, so this is the
// acceptance check for the workbench executor. Run on a Docker-capable host.
// The script rebuilds the local workbench image when its declared sources
// change, then verifies the resulting executor against a live Docker daemon.
//
// This script imports ONLY the kernel (no web app), so build just the kernel -
// avoids the apps/web build entirely (its @fontsource imports need a synced
// `pnpm install`, unrelated to the workbench):
//
//   pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-workbench.mjs
//
// Proves, end-to-end through the executor CODE (with Docker inspect used only
// for independent boundary evidence): ensure() creates a capped, non-root,
// --network none container; run() propagates real exit codes; destroy() cleans
// up. Exit 0 = all assertions hold; 3 = no Docker daemon (skip).

import { spawnSync } from "node:child_process";
import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";
import { aiderAdapter, isolateAiderRepositoryCommand } from "../packages/kernel/dist/coding-cli.js";
import { ensureDockerImage } from "./docker-image-preflight.mjs";

const projectId = `spike-${Date.now()}`;
const SECRET_A = "scope-a-initial";
const SECRET_B = "scope-b-hidden";
const ANTHROPIC_SENTINEL = `anthropic-scrub-${Date.now()}`;
const OPENAI_SENTINEL = `openai-symlink-${Date.now()}`;
const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";
const ISOLATION_CONFIG = { dockerBin: DOCKER_BIN, egressAllow: [], network: "none" };
const wb = new DockerCommandExecutor({
  ...ISOLATION_CONFIG,
  secrets: {
    PM_SCOPE_A: SECRET_A,
    PM_SCOPE_B: SECRET_B,
    ANTHROPIC_API_KEY: ANTHROPIC_SENTINEL,
    OPENAI_API_KEY: OPENAI_SENTINEL,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
  },
});
let fails = 0;
const ok = (m) => console.log(`  ok - ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};
const docker = (args) => spawnSync(DOCKER_BIN, args, { encoding: "utf8" });

// `docker exec` returns a normal non-zero result when the daemon is down, so it
// is not a valid reachability probe. Ask the daemon directly and distinguish a
// host skip from a verifier failure.
const daemon = docker(["info", "--format", "{{.ServerVersion}}"]);
if (daemon.error?.code === "ENOENT") {
  console.error("SKIP: docker binary not found. Run on a Docker-capable host.");
  process.exit(3);
}
if (daemon.status !== 0 || !daemon.stdout.trim()) {
  console.error(`SKIP: docker daemon not usable (${daemon.stderr.trim() || `exit ${daemon.status}`}). Run on a Docker-capable host.`);
  process.exit(3);
}

let bodyError = null;
try {
  ensureDockerImage({
    image: process.env.WORKBENCH_IMAGE ?? "puppetmaster-workbench:spike",
    dockerfile: "docker/workbench.Dockerfile",
    context: ".",
    inputs: ["docker/workbench-sync.mjs"],
  });

  console.log("== ensure() creates the workbench ==");
  const name = await wb.ensure(projectId);
  const status = await wb.status(projectId);
  status === "running" ? ok(`container ${name} running`) : bad(`status is ${status}, expected running`);

  console.log("== Docker boundary has resource caps and no network ==");
  const inspected = docker(["inspect", name]);
  if (inspected.status !== 0) {
    bad(`could not inspect ${name}: ${inspected.stderr.trim()}`);
  } else {
    try {
      const row = JSON.parse(inspected.stdout)[0];
      const host = row?.HostConfig ?? {};
      const capped = Number(host.Memory) > 0 && Number(host.NanoCpus) > 0 && Number(host.PidsLimit) > 0;
      const isolated = host.NetworkMode === "none";
      capped ? ok(`caps memory=${host.Memory} nanoCpus=${host.NanoCpus} pids=${host.PidsLimit}`) : bad("one or more resource caps are absent");
      isolated ? ok("network mode is none") : bad(`network mode is ${host.NetworkMode ?? "missing"}, expected none`);
    } catch (err) {
      bad(`invalid Docker inspect response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("== ensure() is idempotent ==");
  const name2 = await wb.ensure(projectId);
  name2 === name ? ok("second ensure() returned the same container") : bad("ensure() not idempotent");

  console.log("== non-root user inside ==");
  const id = await wb.run({ projectId, command: "id -u" });
  const uid = id.stdout.trim();
  id.code === 0 && /^\d+$/.test(uid) && uid !== "0"
    ? ok(`uid=${uid}`)
    : bad(`non-root probe failed (exit=${id.code}, uid=${JSON.stringify(uid)}, stderr=${id.stderr.trim()})`);

  console.log("== secrets are process-scoped and refresh without entering container config ==");
  const unscoped = await wb.run({
    projectId,
    command: "test -z \"$PM_SCOPE_A$PM_SCOPE_B$ANTHROPIC_API_KEY$OPENAI_API_KEY\"",
  });
  unscoped.code === 0 ? ok("unscoped command received no provider secrets") : bad("secret leaked into base container env");
  const scopedExecutionId = `scope-${Date.now()}`;
  const scoped = await wb.run({
    projectId,
    executionId: scopedExecutionId,
    executionGeneration: 1,
    containerProfile: "openai",
    secretNames: ["PM_SCOPE_A"],
    command: "test \"$PM_SCOPE_A\" = scope-a-initial && test -z \"$PM_SCOPE_B\"",
  });
  const scopedVolumes = docker([
    "volume", "inspect",
    `pm-exec-vol-${scopedExecutionId}`,
    `pm-exec-state-${scopedExecutionId}`,
  ]);
  const scopedMetadata = scopedVolumes.status === 0 ? scopedVolumes.stdout : "";
  scoped.code === 0 &&
      !scopedMetadata.includes(SECRET_A) &&
      !scopedMetadata.includes(SECRET_B) &&
      !scopedMetadata.includes("puppetmaster.scratch.recovery")
    ? ok("selected secret reached only the provider exec; scratch/state metadata remained credential-free")
    : bad("per-exec secret scope or credential-free volume metadata failed");
  const beforeRotation = (await wb.run({ projectId, command: "hostname" })).stdout.trim();
  const rotated = new DockerCommandExecutor({
    ...ISOLATION_CONFIG,
    secrets: { PM_SCOPE_A: "scope-a-rotated", PM_SCOPE_B: SECRET_B },
  });
  await rotated.ensure(projectId);
  const afterRotation = (await rotated.run({ projectId, command: "hostname" })).stdout.trim();
  const refreshed = await rotated.run({
    projectId,
    executionId: `rotated-${Date.now()}`,
    executionGeneration: 1,
    containerProfile: "openai",
    secretNames: ["PM_SCOPE_A"],
    command: "test \"$PM_SCOPE_A\" = scope-a-rotated",
  });
  beforeRotation === afterRotation && refreshed.code === 0
    ? ok("credential rotation applied to the existing container on the next exec")
    : bad("credential rotation required stale container environment");

  console.log("== Claude Plan is read-only and forces subprocess credential scrubbing ==");
  const claudePlanId = `claude-plan-${Date.now()}`;
  const claudePlanName = `pm-exec-${claudePlanId}`;
  const claudePlanMarker = `PM_CLAUDE_PLAN_${Date.now()}`;
  const claudePlanController = new AbortController();
  let signalClaudePlanReady;
  const claudePlanReady = new Promise((resolve) => { signalClaudePlanReady = resolve; });
  const claudePlan = wb.runStreaming(
    {
      projectId,
      executionId: claudePlanId,
      containerProfile: "claude",
      readOnlyProject: true,
      secretNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"],
      signal: claudePlanController.signal,
      timeoutMs: 15_000,
      command:
        `test \"$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB\" = 1 && ` +
        `test \"$ANTHROPIC_API_KEY\" = '${ANTHROPIC_SENTINEL}' && ` +
        "if touch /workbench/.claude-plan-write; then exit 41; fi; " +
        `echo '${claudePlanMarker}'; sleep 30`,
    },
    (chunk) => {
      if (chunk.text.includes(claudePlanMarker)) signalClaudePlanReady();
    },
  );
  await Promise.race([
    claudePlanReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Claude Plan boundary probe did not start")), 5_000)),
  ]);
  const claudePlanInspect = docker(["inspect", claudePlanName]);
  if (claudePlanInspect.status !== 0) {
    bad(`could not inspect Claude Plan container: ${claudePlanInspect.stderr.trim()}`);
  } else {
    const row = JSON.parse(claudePlanInspect.stdout)[0];
    const projectMount = row?.Mounts?.find((mount) => mount.Destination === "/workbench");
    const env = row?.Config?.Env ?? [];
    const cmd = row?.Config?.Cmd ?? [];
    const holderMetadataClean =
      !env.some((entry) => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)=/.test(entry)) &&
      !JSON.stringify(cmd).includes(ANTHROPIC_SENTINEL) &&
      !JSON.stringify(cmd).includes(claudePlanMarker) &&
      JSON.stringify(cmd) === JSON.stringify(["sleep", "infinity"]);
    projectMount?.RW === false && holderMetadataClean
      ? ok("Plan mount is RO; credentials, scrub policy, and provider command are absent from holder metadata")
      : bad(`Claude Plan holder policy mismatch (mount RW=${String(projectMount?.RW)}, metadataClean=${holderMetadataClean})`);
  }
  let blockedWriterSettled = false;
  const blockedWriter = wb.run({
    projectId,
    command: "printf lock-released > .copyback-lock-probe",
  }).then((result) => {
    blockedWriterSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  blockedWriterSettled === false
    ? ok("shared Plan lock blocked a concurrent durable writer")
    : bad("durable writer bypassed the provider project lock");
  claudePlanController.abort();
  await claudePlan;
  const releasedWriter = await blockedWriter;
  const noPlanWrite = await wb.run({ projectId, command: "test ! -e .claude-plan-write" });
  const cleanedLockProbe = await wb.run({
    projectId,
    command: "test \"$(cat .copyback-lock-probe)\" = lock-released && rm -f .copyback-lock-probe",
  });
  noPlanWrite.code === 0 && releasedWriter.code === 0 && cleanedLockProbe.code === 0
    ? ok("Plan stayed read-only and the blocked writer resumed only after lock release")
    : bad("Claude Plan/write lock boundary failed");

  console.log("== Claude Execute edits scratch and reaches durable workbench only through signed copy-back ==");
  const claudeExecuteId = `claude-execute-${Date.now()}`;
  const claudeExecute = await wb.run({
    projectId,
    executionId: claudeExecuteId,
    executionGeneration: 1,
    containerProfile: "claude",
    readOnlyProject: false,
    secretNames: ["ANTHROPIC_API_KEY"],
    command:
      `test \"$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB\" = 1 && ` +
      "printf execute-write > /workbench/.claude-execute-write",
  });
  const claudeExecuteSnapshot = await wb.getExecutionSnapshot(projectId, claudeExecuteId, 1);
  const claudeExecuteApply = await wb.applyExecutionResult(
    projectId,
    claudeExecuteId,
    1,
    claudeExecuteSnapshot.snapshotReceipt,
  );
  if (claudeExecuteApply.committed && claudeExecuteApply.commitReceipt) {
    await wb.acknowledgeExecutionCopyback(projectId, claudeExecuteId, 1, claudeExecuteApply.commitReceipt);
  }
  const executeWrite = await wb.run({
    projectId,
    command: "test \"$(cat .claude-execute-write)\" = execute-write && rm -f .claude-execute-write",
  });
  await wb.cleanupExecutionArtifacts(claudeExecuteId);
  claudeExecute.code === 0 && claudeExecuteApply.committed === true && executeWrite.code === 0
    ? ok("Execute scratch is writable, scrub mode is forced, and signed copy-back commits the edit")
    : bad(`Claude Execute policy probe failed (execute=${claudeExecute.code}, apply=${claudeExecuteApply.code}, durable=${executeWrite.code})`);

  console.log("== provider snapshot rejects a /proc environment symlink without leaking its secret ==");
  const leakSeeded = await wb.run({ projectId, command: "ln -s /proc/self/environ provider-leak.py" });
  let leakFailure = "";
  try {
    await wb.run({
      projectId,
      executionId: `symlink-leak-${Date.now()}`,
      executionGeneration: 1,
      containerProfile: "openai",
      secretNames: ["OPENAI_API_KEY"],
      command: "true",
    });
  } catch (error) {
    leakFailure = error instanceof Error ? error.message : String(error);
  }
  const leakPreserved = await wb.run({
    projectId,
    command: "test \"$(readlink provider-leak.py)\" = /proc/self/environ && rm -f provider-leak.py",
  });
  leakSeeded.code === 0 && /unsafe symbolic link provider-leak\.py/i.test(leakFailure) &&
      !leakFailure.includes(OPENAI_SENTINEL) && leakPreserved.code === 0
    ? ok("unsafe symlink failed before provider launch and its target content stayed secret")
    : bad(`unsafe symlink guard failed: ${leakFailure.slice(0, 300)}`);

  console.log("== run() reports a passing command (exit 0) ==");
  const pass = await wb.run({ projectId, command: 'node -e "process.exit(0)"' });
  pass.code === 0 ? ok("exit 0 propagated") : bad(`expected 0, got ${pass.code}`);

  console.log("== run() reports a failing command (non-zero) ==");
  const fail = await wb.run({ projectId, command: 'node -e "process.exit(7)"' });
  fail.code === 7 ? ok("exit 7 propagated") : bad(`expected 7, got ${fail.code}`);

  console.log("== Aider exit-zero CLI errors cannot reach trusted copy-back ==");
  await wb.run({ projectId, command: "printf original > semantic-guard.txt" });
  const semanticId = `semantic-${Date.now()}`;
  const aider = aiderAdapter.buildCommand("attempt an edit", {
    maxTurns: 1,
    model: "openai/gpt-5.6",
    permissionMode: "acceptEdits",
  });
  const isolated = isolateAiderRepositoryCommand(aider, semanticId, "execute");
  const semantic = await wb.run({
    projectId,
    executionId: semanticId,
    executionGeneration: 1,
    containerProfile: "openai",
    command:
      "mkdir -p /tmp/pm-fake-bin && " +
      "printf '#!/bin/sh\\nprintf changed > semantic-guard.txt\\necho aider: error: rejected configuration >&2\\nexit 0\\n' " +
      "> /tmp/pm-fake-bin/aider && chmod 700 /tmp/pm-fake-bin/aider && " +
      `PATH=/tmp/pm-fake-bin:$PATH; ${isolated}`,
  });
  const semanticSnapshot = await wb.getExecutionSnapshot(projectId, semanticId, 1);
  const forcedApply = await wb.applyExecutionResult(
    projectId,
    semanticId,
    1,
    semanticSnapshot.snapshotReceipt,
  );
  if (forcedApply.committed && forcedApply.commitReceipt) {
    await wb.acknowledgeExecutionCopyback(projectId, semanticId, 1, forcedApply.commitReceipt);
  }
  const semanticGuard = await wb.run({ projectId, command: "test \"$(cat semantic-guard.txt)\" = original" });
  await wb.cleanupExecutionArtifacts(semanticId);
  semantic.code !== 0 && forcedApply.code === 0 && semanticGuard.code === 0
    ? ok("semantic failure stayed non-zero and scratch held no approved edits")
    : bad(`semantic failure guard failed (run=${semantic.code}, apply=${forcedApply.code}, guard=${semanticGuard.code})`);

  console.log("== runStreaming() abort kills the managed in-container process group ==");
  const executionId = `cancel-${Date.now()}`;
  const marker = `PM_${executionId.replace(/-/g, "_")}`;
  const controller = new AbortController();
  let sawReady;
  const ready = new Promise((resolve) => {
    sawReady = resolve;
  });
  const streaming = wb.runStreaming(
    {
      projectId,
      executionId,
      executionGeneration: 1,
      containerProfile: "openai",
      signal: controller.signal,
      timeoutMs: 15_000,
      command: `node -e "console.log('${marker}'); setInterval(() => {}, 1000)"`,
    },
    (chunk) => {
      if (chunk.text.includes(marker)) sawReady();
    },
  );
  let readinessTimer;
  try {
    await Promise.race([
      ready,
      // OpenAI Execute prepares and verifies a signed scratch snapshot before
      // the provider command begins. Docker Desktop can take materially longer
      // than the old five-second UI-style budget without being unhealthy.
      new Promise((_, reject) => {
        readinessTimer = setTimeout(() => reject(new Error("streaming process did not start")), 20_000);
      }),
    ]);
  } catch (error) {
    controller.abort();
    await streaming.catch(() => {});
    throw error;
  } finally {
    clearTimeout(readinessTimer);
  }
  controller.abort();
  const [cancelled] = await Promise.all([
    streaming,
    wb.cleanupExecutionArtifacts(executionId),
  ]);
  const executionGone = await wb.executionStatus(executionId);
  const cancellationVolumes = [
    `pm-exec-vol-${executionId}`,
    `pm-exec-state-${executionId}`,
  ].map((volume) => ({
    volume,
    probe: docker(["volume", "inspect", volume]),
  }));
  const cancellationVolumesGone = cancellationVolumes.every(({ probe }) =>
    probe.status !== 0 && /no such volume/i.test(`${probe.stdout}\n${probe.stderr}`),
  );
  executionGone === "absent" && cancellationVolumesGone && cancelled.code !== 0
    ? ok("abort removed the isolated holder and both scratch volumes before resolving")
    : bad(
      `abort cleanup failed (exit=${cancelled.code}, holder=${executionGone}, volumes=${cancellationVolumes
        .filter(({ probe }) => probe.status === 0)
        .map(({ volume }) => volume)
        .join(",") || "gone"})`,
    );

  console.log("== Claude config persists only in Claude-profile execution containers ==");
  const baseConfig = await wb.run({
    projectId,
    command: "test ! -e /home/bench/.puppetmaster/acceptance",
  });
  const config = await wb.run({
    projectId,
    executionId: `claude-config-write-${Date.now()}`,
    containerProfile: "claude",
    readOnlyProject: true,
    command: "mkdir -p /home/bench/.puppetmaster && printf probe > /home/bench/.puppetmaster/acceptance",
  });
  const openaiConfig = await wb.run({
    projectId,
    executionId: `openai-config-check-${Date.now()}`,
    executionGeneration: 1,
    containerProfile: "openai",
    command: "test ! -e /home/bench/.puppetmaster/acceptance",
  });
  const claudeConfig = await wb.run({
    projectId,
    executionId: `claude-config-read-${Date.now()}`,
    containerProfile: "claude",
    readOnlyProject: true,
    command: "test \"$(cat /home/bench/.puppetmaster/acceptance)\" = probe",
  });
  baseConfig.code === 0 && config.code === 0 && openaiConfig.code === 0 && claudeConfig.code === 0
    ? ok("Claude config persists for Claude and is absent from base/OpenAI containers")
    : bad(`provider config boundary failed: ${[baseConfig, config, openaiConfig, claudeConfig].map((row) => row.stderr).join(" | ")}`);

  console.log("== immutable container config changes reconcile without losing named volumes ==");
  await wb.run({ projectId, command: "printf retained > /workbench/.pm-volume-marker" });
  const beforeReconfigure = (await wb.run({ projectId, command: "hostname" })).stdout.trim();
  const reconfigured = new DockerCommandExecutor({
    ...ISOLATION_CONFIG,
    memory: "513m",
    secrets: { PM_SCOPE_A: "scope-a-rotated" },
  });
  await reconfigured.ensure(projectId);
  const afterReconfigure = (await reconfigured.run({ projectId, command: "hostname" })).stdout.trim();
  const retained = await reconfigured.run({ projectId, command: "test \"$(cat /workbench/.pm-volume-marker)\" = retained" });
  beforeReconfigure !== afterReconfigure && retained.code === 0
    ? ok("container replaced and project volume retained")
    : bad("container config reconciliation did not preserve the project volume");

  console.log("== a deterministic check runs inside (fail-before / pass-after) ==");
  const setup =
    'printf "export function add(a,b){ return a-b; }\\n" > add.mjs && ' +
    'printf "import test from \\"node:test\\";import assert from \\"node:assert\\";' +
    'import { add } from \\"./add.mjs\\";test(\\"add\\",()=>assert.strictEqual(add(2,3),5));\\n" > add.test.mjs';
  await wb.run({ projectId, command: setup });
  const before = await wb.run({ projectId, command: "node --test" });
  const fixed = await wb.run({ projectId, command: 'printf "export function add(a,b){ return a+b; }\\n" > add.mjs' });
  void fixed;
  const after = await wb.run({ projectId, command: "node --test" });
  before.code !== 0 && after.code === 0
    ? ok("check fails on the bug, passes on the fix - the executor drives real checks")
    : bad(`fail-before/pass-after broken (before=${before.code}, after=${after.code})`);
} catch (error) {
  bodyError = error;
  console.error(`WORKBENCH BODY ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  console.log("== destroy() cleans up ==");
  try {
    await wb.destroy(projectId);
  } catch (cleanupError) {
    if (bodyError) {
      throw new AggregateError([bodyError, cleanupError], "workbench body and destroy both failed");
    }
    throw cleanupError;
  }
  const gone = await wb.status(projectId);
  gone === "absent" ? ok("container + volume removed") : bad(`status after destroy is ${gone}`);
}

if (bodyError) throw bodyError;

if (fails > 0) {
  console.error("WORKBENCH EXECUTOR: FAIL");
  process.exit(1);
}
console.log("WORKBENCH EXECUTOR PASS: lifecycle/non-root/provider-isolation/abort/exit-codes/check/destroy");
