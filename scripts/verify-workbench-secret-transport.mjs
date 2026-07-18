#!/usr/bin/env node

import assert from "node:assert/strict";
import { DockerCommandExecutor } from "../packages/kernel/dist/index.js";

const SECRET_NAME = "OPENAI_API_KEY";
const SECRET_VALUE = "pm-secret-transport-sentinel-never-in-argv";
const PROMPT = "pm-provider-prompt-sentinel";
const calls = [];
let holder = "absent";
let holderName = null;
let holderLabels = {};

const missing = () => ({
  code: 1,
  stdout: "",
  stderr: "Error: No such object: fixture",
  timedOut: false,
});
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });

function inspectResult() {
  if (holder === "absent") return missing();
  return ok(JSON.stringify([{
    State: { Running: holder === "running" },
    Config: {
      Labels: holderLabels,
      Env: ["PATH=/usr/local/bin:/usr/bin"],
      Cmd: ["sleep", "infinity"],
    },
  }]));
}

const transport = {
  async run(_bin, args, opts = {}) {
    calls.push({ kind: "run", args: [...args], env: { ...(opts.env ?? {}) } });
    if (args[0] === "inspect") return inspectResult();
    if (args[0] === "create") {
      holder = "created";
      holderName = args[args.indexOf("--name") + 1];
      holderLabels = Object.fromEntries(
        args.flatMap((value, index) => value === "--label" ? [args[index + 1]] : [])
          .filter(Boolean)
          .map((entry) => {
            const split = entry.indexOf("=");
            return [entry.slice(0, split), entry.slice(split + 1)];
          }),
      );
      return ok(holderName);
    }
    if (args[0] === "start") {
      holder = "running";
      return ok(holderName ?? "fixture");
    }
    if (args[0] === "stop" || args[0] === "kill" || args[0] === "rm") {
      holder = "absent";
      return ok();
    }
    return ok();
  },
  async runStreaming(_bin, args, opts) {
    calls.push({ kind: "stream", args: [...args], env: { ...(opts.env ?? {}) } });
    await opts.onChunk({ stream: "stdout", text: "provider-ok\n" });
    return ok("provider-ok\n");
  },
};

console.log("== ordinary docker exec transports selected values by environment name only ==");
const executor = new DockerCommandExecutor({
  secrets: {
    [SECRET_NAME]: SECRET_VALUE,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "caller-controlled-zero",
  },
}, transport);
await executor.run({
  projectId: "fixture",
  command: "true",
  secretNames: [SECRET_NAME],
});
const ordinary = calls.at(-1);
assert.deepEqual(ordinary.args.slice(0, 4), ["exec", "-e", SECRET_NAME, "-w"]);
assert.equal(ordinary.args.some((arg) => arg.includes(SECRET_VALUE)), false);
assert.equal(ordinary.env[SECRET_NAME], SECRET_VALUE);

console.log("== isolated holder metadata is secret- and provider-command-free ==");
const streamed = await executor.runStreaming({
  projectId: "fixture",
  executionId: "mission-attempt-1",
  containerProfile: "claude",
  readOnlyProject: true,
  command: `printf %s ${PROMPT}`,
  secretNames: [SECRET_NAME, "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"],
}, () => {});
assert.equal(streamed.code, 0);
const create = calls.find((call) => call.kind === "run" && call.args[0] === "create");
const provider = calls.find((call) => call.kind === "stream");
assert.ok(create, "isolated holder was not created");
assert.ok(provider, "provider was not executed through docker exec");
assert.deepEqual(create.args.slice(-3), ["puppetmaster-workbench:spike", "sleep", "infinity"]);
assert.equal(create.args.some((arg) => arg.includes(SECRET_NAME)), false);
assert.equal(create.args.some((arg) => arg.includes(SECRET_VALUE)), false);
assert.equal(create.args.some((arg) => arg.includes(PROMPT)), false);
assert.equal(provider.args.some((arg) => arg.includes(SECRET_VALUE)), false);
assert.equal(provider.args.includes(SECRET_NAME), true);
assert.equal(provider.args.some((arg) => arg.includes(PROMPT)), true);
assert.equal(provider.env[SECRET_NAME], SECRET_VALUE);
assert.equal(provider.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
assert.equal(holder, "absent", "isolated holder must be removed after provider exit");

console.log("== every Docker control subprocess starts from the scrubbed base environment ==");
for (const call of calls.filter((entry) => entry.args[0] !== "exec")) {
  assert.equal(call.env[SECRET_NAME], undefined);
  assert.equal(call.env.openai_api_key, undefined);
}
assert.equal(calls.some((call) => call.args.some((arg) => arg.includes(SECRET_VALUE))), false);

console.log("== isolated holder owns AbortSignal even if the Docker client stream has already detached ==");
let ownerHolder = "absent";
let ownerLabels = {};
let releaseDetachedStream;
const detachedStreamGate = new Promise((resolve) => { releaseDetachedStream = resolve; });
let observeHolderRemoval;
const holderRemoved = new Promise((resolve) => { observeHolderRemoval = resolve; });
const ownerInspect = () => ownerHolder === "absent"
  ? missing()
  : ok(JSON.stringify([{
    State: { Running: ownerHolder === "running" },
    Config: {
      Labels: ownerLabels,
      Env: ["PATH=/usr/local/bin:/usr/bin"],
      Cmd: ["sleep", "infinity"],
    },
  }]));
const ownerTransport = {
  async run(_bin, args) {
    if (args[0] === "inspect") return ownerInspect();
    if (args[0] === "create") {
      ownerHolder = "created";
      ownerLabels = Object.fromEntries(
        args.flatMap((value, index) => value === "--label" ? [args[index + 1]] : [])
          .filter(Boolean)
          .map((entry) => {
            const split = entry.indexOf("=");
            return [entry.slice(0, split), entry.slice(split + 1)];
          }),
      );
      return ok();
    }
    if (args[0] === "start") {
      ownerHolder = "running";
      return ok();
    }
    if (args[0] === "stop" || args[0] === "kill") {
      ownerHolder = "stopped";
      return ok();
    }
    if (args[0] === "rm") {
      ownerHolder = "absent";
      observeHolderRemoval();
      return ok();
    }
    return ok();
  },
  async runStreaming(_bin, _args, opts) {
    await opts.onChunk({ stream: "stdout", text: "detached-ready\n" });
    await detachedStreamGate;
    return ok("detached-ready\n");
  },
};
const ownerExecutor = new DockerCommandExecutor({}, ownerTransport);
const ownerController = new AbortController();
const ownerStream = ownerExecutor.runStreaming({
  projectId: "owner-fixture",
  executionId: "owner-attempt-1",
  containerProfile: "claude",
  readOnlyProject: true,
  signal: ownerController.signal,
  command: "true",
}, (chunk) => {
  if (chunk.text.includes("detached-ready")) ownerController.abort();
});
let ownerTimeoutId;
const ownerTimeout = new Promise((_, reject) => {
  ownerTimeoutId = setTimeout(() => reject(new Error("AbortSignal did not terminate the detached holder")), 1_000);
});
try {
  await Promise.race([holderRemoved, ownerTimeout]);
} finally {
  clearTimeout(ownerTimeoutId);
}
assert.equal(ownerHolder, "absent", "AbortSignal must remove the holder before the detached stream settles");
releaseDetachedStream();
await ownerStream;

console.log("WORKBENCH SECRET TRANSPORT PASS: names-only exec env + secret-free holder + scrubbed Docker clients + owner cancellation");
