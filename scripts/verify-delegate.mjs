#!/usr/bin/env node
// WP3b.4 host verification — drives bench.delegate's LIVE path against a real
// Docker daemon with the pinned coding CLI inside the workbench (ADR-002).
//
// ⚠️ THIS COSTS REAL MONEY. Unlike every other WP3b verify script, this one runs
// the actual `claude` CLI making real model calls, so it needs a live key and
// will spend tokens on your account. Budget for it. The PARSING logic is verified
// for free by scripts/verify-delegate-parse.mjs — run that first.
//
// Build the workbench image WITH the CLI layer (the ARG defaults to the pinned
// version; override deliberately), then run with a key:
//
//   docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
//   pnpm --filter "@puppetmaster/kernel..." build
//   ANTHROPIC_API_KEY=sk-... node scripts/verify-delegate.mjs
//
// Proves, end-to-end through the executor + tool CODE:
//   - the pinned CLI is present in the image (`claude --version` runs);
//   - the key reaches the CLI via the ADR-005 secrets env-injection path;
//   - a trivial delegate task completes within budget (real stream-json);
//   - parseDelegateStream lands ok/numTurns/usage/result from the LIVE transcript.
// Exit 0 = all hold; 1 = a failure; 3 = no daemon or no key (skip).

import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";
import { parseDelegateStream } from "../packages/kernel/dist/bench-tools.js";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("SKIP: ANTHROPIC_API_KEY not set — bench.delegate needs a live key (spends tokens).");
  process.exit(3);
}

const projectId = `delegate-${Date.now()}`;
// The key rides the ADR-005 secrets path (vault-injected env at spawn), exactly
// how the server will deliver {{credential:ANTHROPIC_API_KEY}} in production.
// Egress must reach the Anthropic API — allowlist it (proxy sidecar comes up).
const wb = new DockerCommandExecutor({
  secrets: { ANTHROPIC_API_KEY: KEY },
  egressAllow: ["api.anthropic.com"],
});
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

try {
  console.log("== ensure() brings up the workbench (+ egress proxy) ==");
  await wb.ensure(projectId);
  (await wb.status(projectId)) === "running" ? ok("workbench running") : bad("workbench not running");

  console.log("== the pinned CLI is present in the image ==");
  const ver = await wb.run({ projectId, command: "claude --version" });
  ver.code === 0 && ver.stdout.trim()
    ? ok(`claude --version → ${ver.stdout.trim()}`)
    : bad(`claude CLI missing/not runnable (code=${ver.code}, err=${ver.stderr.trim().slice(0, 160)})`);

  console.log("== the key reached the workbench via the secrets path ==");
  const keyEnv = await wb.run({ projectId, command: 'test -n "$ANTHROPIC_API_KEY" && echo present' });
  keyEnv.stdout.trim() === "present" ? ok("ANTHROPIC_API_KEY injected") : bad("key not injected into env");

  console.log("== a trivial delegate task completes within budget (LIVE — spends tokens) ==");
  // Seed a file so there is a concrete, cheap edit to make.
  await wb.run({ projectId, command: "printf 'export const add = (a, b) => a + b;\\n' > add.mjs" });
  const maxTurns = 6;
  const command =
    "claude -p 'Add a one-line JSDoc comment above the add function in add.mjs.' " +
    "--output-format stream-json --verbose " +
    `--max-turns ${maxTurns} --permission-mode acceptEdits`;
  const started = Date.now();
  const res = await wb.run({ projectId, command, timeoutMs: 300_000 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (res.timedOut) {
    bad(`delegate task timed out after ${secs}s`);
  } else {
    const parsed = parseDelegateStream(res.stdout);
    parsed.ok
      ? ok(`delegate ok in ${secs}s — numTurns=${parsed.numTurns}, cost=$${parsed.costUsd ?? "?"}`)
      : bad(`delegate not ok (reason=${parsed.reason}, exit=${res.code}, err=${res.stderr.trim().slice(0, 160)})`);
    typeof parsed.numTurns === "number" && parsed.numTurns >= 1
      ? ok(`numTurns parsed from live transcript = ${parsed.numTurns}`)
      : bad(`numTurns not parsed from live transcript (got ${parsed.numTurns})`);
    parsed.usage && typeof parsed.usage === "object"
      ? ok(`usage parsed from live transcript`)
      : bad(`usage not parsed from live transcript (got ${JSON.stringify(parsed.usage)})`);
    // The edit actually landed in the workbench.
    const grep = await wb.run({ projectId, command: "grep -c '/\\*\\*\\|//' add.mjs || true" });
    Number(grep.stdout.trim()) > 0 ? ok("a comment landed in add.mjs") : bad("no comment found in add.mjs after delegate");
  }
} finally {
  console.log("== destroy() cleans up ==");
  await wb.destroy(projectId);
  (await wb.status(projectId)) === "absent" ? ok("workbench removed") : bad("workbench not removed");
}

if (fails > 0) {
  console.error("\nDELEGATE: FAIL");
  process.exit(1);
}
console.log("\nDELEGATE PASS: cli-present/key-injected/task-completes/turns+usage-parsed/edit-landed/destroy");
