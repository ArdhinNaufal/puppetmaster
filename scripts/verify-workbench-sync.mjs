#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tool = path.resolve("docker/workbench-sync.mjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "puppetmaster-sync-"));
const root = path.join(fixture, "workbench");
const provider = path.join(fixture, "provider");
const TOKEN = "mission-123";
const RECOVERY_TOKEN = "interrupted";
const KEY = "fixture-copyback-key";
const OWNER = "puppetmaster-workbench-sync-v2";
fs.mkdirSync(path.join(root, ".git"), { recursive: true });
fs.writeFileSync(path.join(root, ".git", "keep"), "git-original");
const protectedFiles = [
  ".env",
  ".env.local",
  ".aider.conf.yml",
  ".aider.conf.yaml",
  ".aider.model.settings.yml",
  ".aider.model.metadata.json",
  ".aiderignore",
  ".aider.tags.cache.v4",
  ".aider.chat.history.md",
];
for (const name of protectedFiles) {
  fs.writeFileSync(path.join(root, name), `protected-original:${name}`);
}
fs.writeFileSync(path.join(root, "changed.txt"), "old");
fs.writeFileSync(path.join(root, "deleted.txt"), "delete-me");
fs.mkdirSync(path.join(root, "nested"), { recursive: true });
fs.writeFileSync(path.join(root, "nested", ".env.local"), "nested-env-original");
fs.writeFileSync(path.join(root, "nested", ".aiderignore"), "nested-aider-original");
fs.mkdirSync(path.join(root, "nested", ".git"), { recursive: true });
fs.writeFileSync(path.join(root, "nested", ".git", "keep"), "nested-git-original");
fs.mkdirSync(path.join(root, ".puppetmaster-apply-v1-untrusted"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".puppetmaster-apply-v1-untrusted", "private-backup"),
  "legacy-journal-private-state",
);
fs.writeFileSync(path.join(root, "nested", "code.txt"), "nested-code-old");
fs.writeFileSync(path.join(root, "link-target.txt"), "linked-content");
let safeSymlinkSupported = true;
try {
  fs.symlinkSync("link-target.txt", path.join(root, "safe-link.txt"));
} catch (error) {
  if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  safeSymlinkSupported = false;
}

function run(...args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
}

function runV3(args, options = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PUPPETMASTER_SYNC_RECOVERY_KEY: options.key ?? KEY.repeat(4),
      ...(options.failpoint
        ? {
            PUPPETMASTER_SYNC_TEST_MODE: "1",
            PUPPETMASTER_SYNC_FAILPOINT: options.failpoint,
          }
        : {}),
    },
  });
}

function receiptFrom(stdout, prefix) {
  const match = new RegExp(`^${prefix} ([A-Za-z0-9_-]+\\.[a-f0-9]{64})$`, "m").exec(stdout);
  assert.ok(match?.[1], `${prefix} receipt missing from ${JSON.stringify(stdout)}`);
  return match[1];
}

function receiptPayload(receipt) {
  return JSON.parse(Buffer.from(receipt.slice(0, receipt.lastIndexOf(".")), "base64url").toString("utf8"));
}

function assertProtectedControls() {
  assert.equal(fs.readFileSync(path.join(root, ".git", "keep"), "utf8"), "git-original");
  for (const name of protectedFiles) {
    assert.equal(
      fs.readFileSync(path.join(root, name), "utf8"),
      `protected-original:${name}`,
      `${name} must not be replaced by provider output`,
    );
  }
  assert.equal(fs.readFileSync(path.join(root, "nested", ".env.local"), "utf8"), "nested-env-original");
  assert.equal(fs.readFileSync(path.join(root, "nested", ".aiderignore"), "utf8"), "nested-aider-original");
  assert.equal(fs.readFileSync(path.join(root, "nested", ".git", "keep"), "utf8"), "nested-git-original");
  assert.equal(
    fs.readFileSync(path.join(root, ".puppetmaster-apply-v1-untrusted", "private-backup"), "utf8"),
    "legacy-journal-private-state",
  );
}

function ownerValue(token) {
  const signature = crypto.createHmac("sha256", KEY).update(`${OWNER}\0${token}`).digest("hex");
  return `${OWNER}:${signature}`;
}

try {
  console.log("== provider snapshot excludes root and nested control state ==");
  fs.mkdirSync(provider);
  const snapshotted = run("snapshot", root, provider);
  assert.equal(snapshotted.status, 0, snapshotted.stderr);
  const baseline = /^PUPPETMASTER_BASELINE ([0-9a-f]{64})$/m.exec(snapshotted.stdout)?.[1];
  assert.ok(baseline, `snapshot did not return a baseline: ${snapshotted.stdout}`);
  assert.equal(fs.existsSync(path.join(provider, ".git")), false);
  for (const name of protectedFiles) assert.equal(fs.existsSync(path.join(provider, name)), false, `${name} leaked into snapshot`);
  assert.equal(fs.existsSync(path.join(provider, "nested", ".env.local")), false);
  assert.equal(fs.existsSync(path.join(provider, "nested", ".aiderignore")), false);
  assert.equal(fs.existsSync(path.join(provider, ".puppetmaster-apply-v1-untrusted")), false);
  assert.equal(fs.existsSync(path.join(provider, "nested", ".git")), false);
  if (safeSymlinkSupported) {
    assert.equal(fs.lstatSync(path.join(provider, "safe-link.txt")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(provider, "safe-link.txt")), "link-target.txt");
  }

  console.log("== an escaping provider-visible symlink is rejected without reading its target ==");
  const unsafeRoot = path.join(fixture, "unsafe-root");
  const unsafeProvider = path.join(fixture, "unsafe-provider");
  const sentinel = `PUPPETMASTER_SYMLINK_SENTINEL_${Date.now()}`;
  fs.mkdirSync(unsafeRoot);
  fs.mkdirSync(unsafeProvider);
  fs.writeFileSync(path.join(unsafeRoot, "ordinary.txt"), "ordinary");
  let unsafeSymlinkSupported = true;
  try {
    fs.symlinkSync("/proc/self/environ", path.join(unsafeRoot, "leak.py"));
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    unsafeSymlinkSupported = false;
  }
  if (unsafeSymlinkSupported) {
    const unsafe = spawnSync(process.execPath, [tool, "snapshot", unsafeRoot, unsafeProvider], {
      encoding: "utf8",
      env: { ...process.env, PUPPETMASTER_TEST_SENTINEL: sentinel },
    });
    assert.notEqual(unsafe.status, 0, "escaping symlink snapshot must fail closed");
    assert.match(unsafe.stderr, /unsafe symbolic link leak\.py/);
    assert.equal(`${unsafe.stdout}\n${unsafe.stderr}`.includes(sentinel), false, "symlink target content leaked");
  }

  console.log("== successful copy-back replaces code and preserves every protected control ==");
  fs.writeFileSync(path.join(provider, "changed.txt"), "new");
  fs.rmSync(path.join(provider, "deleted.txt"));
  fs.writeFileSync(path.join(provider, "created.txt"), "created");
  fs.writeFileSync(path.join(provider, "nested", "code.txt"), "nested-code-new");
  for (const name of protectedFiles) fs.writeFileSync(path.join(provider, name), `provider-injected:${name}`);
  fs.writeFileSync(path.join(provider, "nested", ".env.local"), "provider-injected-nested-env");
  fs.writeFileSync(path.join(provider, "nested", ".aiderignore"), "provider-injected-nested-aider");
  fs.mkdirSync(path.join(provider, "nested", ".git"), { recursive: true });
  fs.writeFileSync(path.join(provider, "nested", ".git", "keep"), "provider-injected-nested-git");
  const applied = run("apply", provider, root, TOKEN, baseline, KEY);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(path.join(root, "changed.txt"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(root, "created.txt"), "utf8"), "created");
  assert.equal(fs.existsSync(path.join(root, "deleted.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "nested", "code.txt"), "utf8"), "nested-code-new");
  if (safeSymlinkSupported) {
    assert.equal(fs.lstatSync(path.join(root, "safe-link.txt")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(root, "safe-link.txt")), "link-target.txt");
  }
  assertProtectedControls();
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".puppetmaster-apply-v2-")), false);

  console.log("== stale provider output cannot overwrite concurrent durable changes ==");
  const concurrentProvider = path.join(fixture, "concurrent-provider");
  fs.mkdirSync(concurrentProvider);
  const concurrentSnapshot = run("snapshot", root, concurrentProvider);
  assert.equal(concurrentSnapshot.status, 0, concurrentSnapshot.stderr);
  const concurrentBaseline = /^PUPPETMASTER_BASELINE ([0-9a-f]{64})$/m.exec(concurrentSnapshot.stdout)?.[1];
  assert.ok(concurrentBaseline);
  fs.writeFileSync(path.join(concurrentProvider, "changed.txt"), "stale-provider-edit");
  fs.writeFileSync(path.join(root, "changed.txt"), "concurrent-durable-edit");
  const rejected = run("apply", concurrentProvider, root, "concurrent", concurrentBaseline, KEY);
  assert.notEqual(rejected.status, 0, "baseline mismatch must fail closed");
  assert.match(rejected.stderr, /durable workbench changed after provider snapshot/);
  assert.equal(fs.readFileSync(path.join(root, "changed.txt"), "utf8"), "concurrent-durable-edit");

  console.log("== an attacker-authored exact-token journal is rejected without mutation ==");
  const attackerToken = "attacker";
  const attackerJournal = path.join(root, `.puppetmaster-apply-v2-${attackerToken}`);
  fs.mkdirSync(path.join(attackerJournal, "backup"), { recursive: true });
  fs.writeFileSync(path.join(attackerJournal, "owner"), `${OWNER}:public-or-forged-signature`);
  fs.writeFileSync(path.join(attackerJournal, "swapping"), "1");
  fs.writeFileSync(path.join(attackerJournal, "backup", "changed.txt"), "attacker-selected-content");
  const beforeAttack = fs.readFileSync(path.join(root, "changed.txt"), "utf8");
  const refused = run("recover", root, attackerToken, KEY);
  assert.notEqual(refused.status, 0, "forged journal recovery must fail closed");
  assert.match(refused.stderr, /refusing unauthenticated copy-back journal/);
  assert.equal(fs.readFileSync(path.join(root, "changed.txt"), "utf8"), beforeAttack);
  assert.equal(fs.existsSync(attackerJournal), true, "untrusted journal must not be interpreted or deleted");
  fs.rmSync(attackerJournal, { recursive: true, force: true });

  console.log("== authenticated interrupted journal rolls the durable root back ==");
  const journal = path.join(root, `.puppetmaster-apply-v2-${RECOVERY_TOKEN}`);
  fs.mkdirSync(path.join(journal, "backup"), { recursive: true });
  fs.mkdirSync(path.join(journal, "next"), { recursive: true });
  fs.writeFileSync(path.join(journal, "owner"), ownerValue(RECOVERY_TOKEN));
  fs.writeFileSync(path.join(journal, "swapping"), "1");
  fs.writeFileSync(path.join(journal, "backup", "changed.txt"), "safe-before-interruption");
  fs.writeFileSync(path.join(journal, "backup", "created.txt"), "created");
  fs.cpSync(path.join(root, "nested"), path.join(journal, "backup", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "changed.txt"), "partial-new-state");
  fs.writeFileSync(path.join(root, "partial.txt"), "partial");
  const recovered = run("recover", root, RECOVERY_TOKEN, KEY);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(path.join(root, "changed.txt"), "utf8"), "safe-before-interruption");
  assert.equal(fs.existsSync(path.join(root, "partial.txt")), false);
  assert.equal(fs.existsSync(journal), false);
  assertProtectedControls();

  console.log("== v3 signed commit survives recovery and is removed only after DB acknowledgment ==");
  const v3Root = path.join(fixture, "v3-root");
  const v3Provider = path.join(fixture, "v3-provider");
  const v3Project = "project-v3";
  const v3Execution = "mission-v3-attempt-1";
  const v3Generation = "1";
  fs.mkdirSync(v3Root);
  fs.mkdirSync(v3Provider);
  fs.writeFileSync(path.join(v3Root, "code.txt"), "v3-old");
  fs.writeFileSync(path.join(v3Root, ".env"), "v3-protected");
  const v3Snapshot = runV3([
    "snapshot-v3", v3Root, v3Provider, v3Project, v3Execution, v3Generation,
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(v3Snapshot.status, 0, v3Snapshot.stderr);
  const v3SnapshotReceipt = receiptFrom(v3Snapshot.stdout, "PUPPETMASTER_SNAPSHOT_V3");
  fs.writeFileSync(path.join(v3Provider, "code.txt"), "v3-new");
  fs.writeFileSync(path.join(v3Provider, "created.txt"), "created");
  fs.writeFileSync(path.join(v3Provider, ".env"), "provider-must-not-replace");
  const v3Applied = runV3([
    "apply-v3", v3Provider, v3Root, v3Project, v3Execution, v3Generation,
    v3SnapshotReceipt, "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(v3Applied.status, 0, v3Applied.stderr);
  const v3CommitReceipt = receiptFrom(v3Applied.stdout, "PUPPETMASTER_COMMIT_V3");
  assert.equal(fs.readFileSync(path.join(v3Root, "code.txt"), "utf8"), "v3-new");
  assert.equal(fs.readFileSync(path.join(v3Root, ".env"), "utf8"), "v3-protected");
  const v3RecoveredCommit = runV3([
    "recover-v3", v3Root, v3Project, v3Execution, v3Generation,
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(v3RecoveredCommit.status, 0, v3RecoveredCommit.stderr);
  assert.equal(receiptPayload(receiptFrom(v3RecoveredCommit.stdout, "PUPPETMASTER_STATUS_V3")).state, "committed");
  assert.equal(fs.readFileSync(path.join(v3Root, "code.txt"), "utf8"), "v3-new", "committed files must never roll back");
  const v3Acked = runV3([
    "ack-v3", v3Root, v3Project, v3Execution, v3Generation, v3CommitReceipt,
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(v3Acked.status, 0, v3Acked.stderr);
  assert.equal(receiptPayload(receiptFrom(v3Acked.stdout, "PUPPETMASTER_STATUS_V3")).state, "acked");
  assert.equal(fs.readdirSync(v3Root).some((name) => name.startsWith(".puppetmaster-apply-v3-")), false);

  console.log("== v3 crash before commit rolls back; crash after commit preserves files ==");
  const crashCase = (name, failpoint) => {
    const crashRoot = path.join(fixture, `${name}-root`);
    const crashProvider = path.join(fixture, `${name}-provider`);
    const execution = `${name}-attempt`;
    fs.mkdirSync(crashRoot);
    fs.mkdirSync(crashProvider);
    fs.writeFileSync(path.join(crashRoot, "code.txt"), `${name}-old`);
    const snap = runV3([
      "snapshot-v3", crashRoot, crashProvider, v3Project, execution, "2",
      "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
    ]);
    assert.equal(snap.status, 0, snap.stderr);
    const snapshotReceipt = receiptFrom(snap.stdout, "PUPPETMASTER_SNAPSHOT_V3");
    fs.writeFileSync(path.join(crashProvider, "code.txt"), `${name}-new`);
    const appliedCrash = runV3([
      "apply-v3", crashProvider, crashRoot, v3Project, execution, "2", snapshotReceipt,
      "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
    ], { failpoint });
    assert.equal(appliedCrash.status, 86, appliedCrash.stderr);
    return { crashRoot, execution };
  };
  const beforeCommit = crashCase("before-commit", "before-committed");
  const beforeRecovered = runV3([
    "recover-v3", beforeCommit.crashRoot, v3Project, beforeCommit.execution, "2",
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(beforeRecovered.status, 0, beforeRecovered.stderr);
  assert.equal(receiptPayload(receiptFrom(beforeRecovered.stdout, "PUPPETMASTER_STATUS_V3")).state, "rolled-back");
  assert.equal(fs.readFileSync(path.join(beforeCommit.crashRoot, "code.txt"), "utf8"), "before-commit-old");

  const afterCommit = crashCase("after-commit", "after-committed");
  const afterStatus = runV3([
    "status-v3", afterCommit.crashRoot, v3Project, afterCommit.execution, "2",
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(afterStatus.status, 0, afterStatus.stderr);
  const afterPayload = receiptPayload(receiptFrom(afterStatus.stdout, "PUPPETMASTER_STATUS_V3"));
  assert.equal(afterPayload.state, "committed");
  assert.equal(fs.readFileSync(path.join(afterCommit.crashRoot, "code.txt"), "utf8"), "after-commit-new");
  const interruptedAck = runV3([
    "ack-v3", afterCommit.crashRoot, v3Project, afterCommit.execution, "2", afterPayload.commitReceipt,
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ], { failpoint: "after-ack-rename" });
  assert.equal(interruptedAck.status, 86, interruptedAck.stderr);
  const cleanupStatus = runV3([
    "status-v3", afterCommit.crashRoot, v3Project, afterCommit.execution, "2",
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(cleanupStatus.status, 0, cleanupStatus.stderr);
  assert.equal(receiptPayload(receiptFrom(cleanupStatus.stdout, "PUPPETMASTER_STATUS_V3")).state, "cleanup-pending");
  const resumedAck = runV3([
    "ack-v3", afterCommit.crashRoot, v3Project, afterCommit.execution, "2", afterPayload.commitReceipt,
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.equal(resumedAck.status, 0, resumedAck.stderr);
  assert.equal(fs.readFileSync(path.join(afterCommit.crashRoot, "code.txt"), "utf8"), "after-commit-new");

  console.log("== tampered v3 journal is quarantinable and never interpreted ==");
  const tampered = crashCase("tampered", "after-prepared");
  const tamperedToken = crypto.createHash("sha256")
    .update(`puppetmaster-workbench-sync-v3\0${v3Project}\0${tampered.execution}\0${2}`)
    .digest("hex");
  const tamperedJournal = path.join(tampered.crashRoot, `.puppetmaster-apply-v3-${tamperedToken}`);
  fs.appendFileSync(path.join(tamperedJournal, "intent.json"), " ");
  const refusedV3 = runV3([
    "recover-v3", tampered.crashRoot, v3Project, tampered.execution, "2",
    "env:PUPPETMASTER_SYNC_RECOVERY_KEY",
  ]);
  assert.notEqual(refusedV3.status, 0);
  assert.match(refusedV3.stderr, /unauthenticated v3 copy-back intent|non-canonical v3 copy-back intent/);
  assert.equal(fs.readFileSync(path.join(tampered.crashRoot, "code.txt"), "utf8"), "tampered-old");
  assert.equal(fs.existsSync(tamperedJournal), true, "tampered journal must remain for quarantine evidence");

  console.log("WORKBENCH SYNC PASS: sanitized snapshots + v2 rollback + v3 commit-wins recovery/ack/tamper guards");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
