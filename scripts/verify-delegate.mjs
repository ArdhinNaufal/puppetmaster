#!/usr/bin/env node
// WP3b.4 host verification — drives bench.delegate's LIVE path against a real
// Docker daemon with a pluggable coding CLI inside the workbench (ADR-002/008).
//
// ⚠️ THIS COSTS REAL MONEY. Unlike every other WP3b verify script, this one runs
// a real coding CLI making real model calls, so it needs a live key and will
// spend tokens on your account. Budget for it. The adapters' PARSING logic is
// verified for free by scripts/verify-delegate-parse.mjs — run that first.
//
// Pick the CLI with DELEGATE_CLI (default claude). Build the workbench image
// with that CLI's layer, then run with the matching provider key:
//
//   # claude (Anthropic)
//   docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
//   pnpm --filter "@puppetmaster/kernel..." build
//   ANTHROPIC_API_KEY=sk-... node scripts/verify-delegate.mjs
//
//   # aider on any provider (here OpenAI); DELEGATE_MODEL picks the model
//   DELEGATE_CLI=aider DELEGATE_MODEL=openai/gpt-4o OPENAI_API_KEY=sk-... \
//     node scripts/verify-delegate.mjs
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
const adapter = resolveCodingCli(CLI);

// Per-CLI provider wiring: which key must be present, and which host to allow.
// aider's provider follows DELEGATE_MODEL (openai/*, anthropic/*, gemini/*, …).
const MODEL = process.env.DELEGATE_MODEL ?? "openai/gpt-4o";
const PROVIDER = CLI === "aider" ? MODEL.split("/")[0] : "anthropic";
const KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[PROVIDER] ?? "OPENAI_API_KEY";
const ALLOW_HOST = { anthropic: "api.anthropic.com", openai: "api.openai.com", gemini: "generativelanguage.googleapis.com" }[PROVIDER] ?? "api.openai.com";

const KEY = process.env[KEY_ENV];
if (!KEY) {
  console.error(`SKIP: ${KEY_ENV} not set — bench.delegate (${CLI}) needs a live key (spends tokens).`);
  process.exit(3);
}

const projectId = `delegate-${CLI}-${Date.now()}`;
// The key rides the ADR-005 secrets path (vault-injected env at spawn), exactly
// how the server delivers {{credential:NAME}} in production. aider also needs
// DELEGATE_MODEL in its env (the adapter's --model reads it).
const secrets = { [KEY_ENV]: KEY };
if (CLI === "aider") secrets.DELEGATE_MODEL = MODEL;
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

console.log(`== delegate CLI: ${CLI}${CLI === "aider" ? ` (model ${MODEL})` : ""} · provider ${PROVIDER} ==`);

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
  const keyEnv = await wb.run({ projectId, command: `test -n "$${KEY_ENV}" && echo present` });
  keyEnv.stdout.trim() === "present" ? ok(`${KEY_ENV} injected`) : bad("key not injected into env");

  console.log("== a trivial delegate task completes within budget (LIVE — spends tokens) ==");
  await wb.run({ projectId, command: "printf 'export const add = (a, b) => a + b;\\n' > add.mjs && git init -q && git add -A && git commit -qm seed" });
  const command = adapter.buildCommand("Add a one-line JSDoc comment above the add function in add.mjs.", { maxTurns: 6 });
  const started = Date.now();
  const res = await wb.run({ projectId, command, timeoutMs: 300_000 });
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
