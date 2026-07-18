#!/usr/bin/env node
// WP3b.4 host verification — drives the Claude bench.delegate LIVE path against
// a real Docker daemon (ADR-002/008).
//
// ⚠️ THIS COSTS REAL MONEY. Unlike every other WP3b verify script, this one runs
// a real coding CLI making real model calls, so it needs a live key and will
// spend tokens on your account. Budget for it. The adapters' PARSING logic is
// verified for free by scripts/verify-delegate-parse.mjs — run that first.
//
// Build the workbench image, then run with an Anthropic provider key:
//
//   docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
//   pnpm --filter "@puppetmaster/kernel..." build
//   ANTHROPIC_API_KEY=sk-... node scripts/verify-delegate.mjs
//
// Proves, end-to-end through the executor + adapter CODE:
//   - the chosen CLI is present in the image (`<cli> --version` runs);
//   - the provider key reaches the CLI via the ADR-005 secrets env path;
//   - a trivial delegate task completes within budget (real CLI output);
//   - the adapter parses ok/result (+ turns/usage where the CLI reports them);
//   - the edit actually landed in the workbench.
// Exit 0 = all hold; 1 = a failure; 3 = no daemon or no key (skip).

import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";
import { resolveCodingCli } from "../packages/kernel/dist/coding-cli.js";

const CLI = (process.env.DELEGATE_CLI ?? "claude").trim();
if (CLI !== "claude") {
  console.error(
    "UNSUPPORTED: mutating bench.delegate(aider) requires a durable node-execution owner. " +
      "Use the CLAUDE page OpenAI Execute flow; run pnpm verify:openai-coding for deterministic coverage.",
  );
  process.exit(1);
}
const adapter = resolveCodingCli(CLI);

const PROVIDER = "anthropic";
const KEY_ENV = "ANTHROPIC_API_KEY";
const ALLOW_HOST = "api.anthropic.com";

const KEY = process.env[KEY_ENV];
if (!KEY) {
  console.error(`SKIP: ${KEY_ENV} not set — bench.delegate (${CLI}) needs a live key (spends tokens).`);
  process.exit(3);
}

const projectId = `delegate-${CLI}-${Date.now()}`;
// The key rides the ADR-005 secrets path (vault-injected env at spawn), exactly
// how the server delivers {{credential:NAME}} in production.
const secrets = { [KEY_ENV]: KEY };
const wb = new DockerCommandExecutor({ secrets, egressAllow: [ALLOW_HOST] });

let fails = 0;
const ok = (m) => console.log(`  ok — ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};

// Preflight: daemon reachable?
try {
  await wb.run({ projectId: "preflight-none", command: "true" });
} catch (err) {
  if (String(err).includes("ENOENT")) {
    console.error("SKIP: docker binary not found. Run on a Docker-capable host.");
    process.exit(3);
  }
  console.error(`SKIP: docker not usable (${err}). Run on a Docker-capable host.`);
  process.exit(3);
}

console.log(`== delegate CLI: ${CLI} · provider ${PROVIDER} ==`);

try {
  console.log("== ensure() brings up the workbench (+ egress proxy) ==");
  await wb.ensure(projectId);
  (await wb.status(projectId)) === "running" ? ok("workbench running") : bad("workbench not running");

  console.log("== the chosen CLI is present in the image ==");
  const ver = await wb.run({ projectId, command: `${CLI} --version` });
  ver.code === 0 && ver.stdout.trim()
    ? ok(`${CLI} --version → ${ver.stdout.trim().split("\n")[0]}`)
    : bad(`${CLI} CLI missing/not runnable (code=${ver.code}, err=${ver.stderr.trim().slice(0, 160)})`);

  console.log("== the key reached the workbench via the secrets path ==");
  const keyEnv = await wb.run({
    projectId,
    secretNames: [KEY_ENV],
    command: `test -n "$${KEY_ENV}" && echo present`,
  });
  keyEnv.stdout.trim() === "present" ? ok(`${KEY_ENV} injected`) : bad("key not injected into env");

  console.log("== a trivial delegate task completes within budget (LIVE — spends tokens) ==");
  await wb.run({ projectId, command: "printf 'export const add = (a, b) => a + b;\\n' > add.mjs && git init -q && git add -A && git commit -qm seed" });
  const command = adapter.buildCommand("Add a one-line JSDoc comment above the add function in add.mjs.", {
    maxTurns: 6,
  });
  const started = Date.now();
  const res = await wb.run({ projectId, command, timeoutMs: 300_000, secretNames: [KEY_ENV] });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (res.timedOut) {
    bad(`delegate task timed out after ${secs}s`);
  } else {
    const parsed = adapter.parse(res.stdout, { code: res.code, stderr: res.stderr });
    parsed.ok
      ? ok(`delegate ok in ${secs}s — cli=${parsed.cli}, numTurns=${parsed.numTurns ?? "n/a"}, cost=$${parsed.costUsd ?? "?"}`)
      : bad(`delegate not ok (reason=${parsed.reason}, exit=${res.code}, err=${res.stderr.trim().slice(0, 160)})`);
    const grep = await wb.run({ projectId, command: "grep -c '/\\*\\*\\|//' add.mjs || true" });
    Number(grep.stdout.trim()) > 0 ? ok("a comment landed in add.mjs") : bad("no comment found in add.mjs after delegate");
  }
} finally {
  console.log("== destroy() cleans up ==");
  await wb.destroy(projectId);
  (await wb.status(projectId)) === "absent" ? ok("workbench removed") : bad("workbench not removed");
}

if (fails > 0) {
  console.error(`\nDELEGATE (${CLI}): FAIL`);
  process.exit(1);
}
console.log(`\nDELEGATE PASS (${CLI}): cli-present/key-injected/task-completes/parsed/edit-landed/destroy`);
