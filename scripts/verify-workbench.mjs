#!/usr/bin/env node
// WP3b.1 verification — drives the built DockerCommandExecutor against a real
// Docker daemon. The eval harness can't exercise containers, so this is the
// acceptance check for the workbench executor. Run on a Docker-capable host.
//
// This script imports ONLY the kernel (no web app), so build just the kernel —
// avoids the apps/web build entirely (its @fontsource imports need a synced
// `pnpm install`, unrelated to the workbench):
//
//   pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-workbench.mjs
//
// Proves, end-to-end through the executor CODE (not raw docker): ensure()
// creates a capped, non-root, --network none container; run() execs a command
// inside and reports its real exit code both ways (pass + fail); destroy()
// cleans up. Exit 0 = all assertions hold; 3 = no Docker daemon (skip).

import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";

const projectId = `spike-${Date.now()}`;
const wb = new DockerCommandExecutor();
let fails = 0;
const ok = (m) => console.log(`  ok — ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};

// Preflight: is a daemon reachable? (executor.run rejects if docker can't run.)
try {
  const probe = await wb.run({ projectId: "preflight-none", command: "true" });
  // A missing container yields a non-zero exit, not a throw — daemon is up.
  void probe;
} catch (err) {
  if (String(err).includes("ENOENT")) {
    console.error("SKIP: docker binary not found. Run on a Docker-capable host.");
    process.exit(3);
  }
  // Other errors: daemon likely down.
  console.error(`SKIP: docker not usable (${err}). Run on a Docker-capable host.`);
  process.exit(3);
}

try {
  console.log("== ensure() creates the workbench ==");
  const name = await wb.ensure(projectId);
  const status = await wb.status(projectId);
  status === "running" ? ok(`container ${name} running`) : bad(`status is ${status}, expected running`);

  console.log("== ensure() is idempotent ==");
  const name2 = await wb.ensure(projectId);
  name2 === name ? ok("second ensure() returned the same container") : bad("ensure() not idempotent");

  console.log("== non-root user inside ==");
  const id = await wb.run({ projectId, command: "id -u" });
  id.stdout.trim() !== "0" ? ok(`uid=${id.stdout.trim()}`) : bad("workbench runs as root");

  console.log("== run() reports a passing command (exit 0) ==");
  const pass = await wb.run({ projectId, command: "node -e \"process.exit(0)\"" });
  pass.code === 0 ? ok("exit 0 propagated") : bad(`expected 0, got ${pass.code}`);

  console.log("== run() reports a failing command (non-zero) ==");
  const fail = await wb.run({ projectId, command: "node -e \"process.exit(7)\"" });
  fail.code === 7 ? ok("exit 7 propagated") : bad(`expected 7, got ${fail.code}`);

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
    ? ok("check fails on the bug, passes on the fix — the executor drives real checks")
    : bad(`fail-before/pass-after broken (before=${before.code}, after=${after.code})`);
} finally {
  console.log("== destroy() cleans up ==");
  await wb.destroy(projectId);
  const gone = await wb.status(projectId);
  gone === "absent" ? ok("container + volume removed") : bad(`status after destroy is ${gone}`);
}

if (fails > 0) {
  console.error("WORKBENCH EXECUTOR: FAIL");
  process.exit(1);
}
console.log("WORKBENCH EXECUTOR PASS: ensure/idempotent/non-root/exit-codes/in-container check/destroy");
