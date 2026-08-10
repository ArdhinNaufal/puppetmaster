#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PASS_COUNT = 3;
const CHILD_TIMEOUT_MS = 180_000;
const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const suites = [
  {
    id: "geometry",
    script: "scripts/verify-science-geometry.mjs",
    nodeArgs: ["--no-warnings", "--experimental-strip-types"],
    markers: [
      {
        label: "bounded client geometry diagnostics",
        pattern:
          /^SCIENCE GEOMETRY PASS: bounded ASCII VTK\/STL diagnostics, STEP topology, caps, and explicit fallback$/m,
        evidence: ["geometry-preview"],
      },
    ],
    sourceRequirements: [
      /parseGeometryPreview/,
      /SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS/,
      /not a CAD tessellation or geometry kernel/,
      /binary data; use the remote renderer/,
    ],
  },
  {
    id: "contracts",
    script: "scripts/verify-science-contracts.mjs",
    markers: [
      {
        label: "strict shared/config contracts",
        pattern: /^science contracts: ok$/m,
        evidence: ["malformed-contract-refusal"],
      },
    ],
    sourceRequirements: [
      /ScienceManifest\.parse/,
      /SCIENCE_RUNTIME_TOKEN/,
      /SCIENCE_PUBLIC_BASE_URL/,
    ],
  },
  {
    id: "lifecycle",
    script: "scripts/verify-science-lifecycle.mjs",
    markers: [
      {
        label: "transactional database lifecycle",
        pattern: /^science lifecycle \(pglite\): ok$/m,
        evidence: ["database-predicates", "workspace-storage-quota"],
      },
    ],
    sourceRequirements: [
      /expectConflict\(/,
      /resolveScienceRunApproval/,
      /acquireScienceRunLease/,
      /getScienceRunForWorkspace\(handle\.db,\s*workspaceB\.id/,
      /manifestHash/,
      /racingUploads = await Promise\.allSettled/,
    ],
  },
  {
    id: "atomic-audit",
    script: "scripts/verify-science-audit-atomicity.mjs",
    markers: [
      {
        label: "database-atomic mutation audit",
        pattern:
          /^SCIENCE ATOMIC AUDIT PASS: migration rollback\/serialization, 10 table triggers, actor-attributed workspace admission and commit\/rollback\/context reset, bounded event\/run\/upload-lease\/cleanup auditing, and committed semantic insert\/update\/cascade-delete audits$/m,
        evidence: ["atomic-audit", "workspace-admission"],
      },
    ],
    sourceRequirements: [
      /SCHEMA_MIGRATIONS/,
      /Promise\.all/,
      /science_domain_audit_mutation/,
      /science_workspace_admissions/,
      /deliberate science mutation rollback/,
    ],
  },
  {
    id: "scheduler",
    script: "scripts/verify-science-scheduler.mjs",
    markers: [
      {
        label: "durable deterministic scheduling",
        pattern:
          /^SCIENCE SCHEDULER PASS: deterministic generation job IDs, transient retry, and bounded Redis producer\/readiness failure$/m,
        evidence: ["scheduler-durability"],
      },
    ],
    sourceRequirements: [
      /scienceSchedulerJobId/,
      /transient retry/i,
      /assert\.equal\(attempts,\s*3\)/,
    ],
  },
  {
    id: "artifacts",
    script: "scripts/verify-science-artifacts.mjs",
    markers: [
      {
        label: "bounded immutable artifact boundary",
        pattern:
          /^SCIENCE ARTIFACT PASS: streaming quarantine, checksum, immutability, range, bounded S3, scoped refs$/m,
        evidence: ["artifact-boundary"],
      },
    ],
    sourceRequirements: [
      /createHash\("sha256"\)/,
      /assert\.rejects/,
      /verifyArtifactReference/,
    ],
  },
  {
    id: "mcp",
    script: "scripts/verify-science-mcp-concurrency.mjs",
    markers: [
      {
        label: "reference-only MCP results and tool tiers",
        pattern:
          /^SCIENCE MCP PASS: serialized attribution, per-tool tiers, bounded reference-only results$/m,
        evidence: ["tool-tier-selection", "no-raw-data-through-tools"],
      },
    ],
    sourceRequirements: [
      /write_approved/,
      /destructive_confirmed/,
      /artifact.*reference/i,
      /exceeded.*artifact reference/i,
    ],
  },
  {
    id: "service",
    script: "scripts/verify-science-service.mjs",
    minimumOkLines: 43,
    markers: [
      {
        label: "declared format refusal",
        pattern:
          /^ok - declared artifact format is validated before readiness$/m,
        evidence: ["unsafe-input-refusal"],
      },
      {
        label: "secret-bearing configuration refusal",
        pattern:
          /^ok - secret-bearing compute configuration is rejected$/m,
        evidence: ["unsafe-input-refusal"],
      },
      {
        label: "approval-gated complete manifest",
        pattern:
          /^ok - scheduler drives approved run to checksummed outputs and complete manifest$/m,
        evidence: ["approval-gate", "manifest-completeness"],
      },
      {
        label: "public tool projection and selection",
        pattern:
          /^ok - public science tool results contain no internal paths, handles, or secrets$/m,
        evidence: ["tool-tier-selection", "no-raw-data-through-tools"],
      },
      {
        label: "durable ambiguous-submit recovery",
        pattern:
          /^ok - lost submit response recovers only through the same provider instance$/m,
        evidence: ["submit-attempt-fencing"],
      },
      {
        label: "provider-instance submit fence",
        pattern:
          /^ok - ambiguous submit is admin-fenced across provider instance drift$/m,
        evidence: ["submit-attempt-fencing"],
      },
      {
        label: "ambiguous-submit cancellation recovery",
        pattern:
          /^ok - cancellation after an ambiguous submit recovers and cancels the same execution$/m,
        evidence: ["submit-attempt-fencing"],
      },
      {
        label: "honest provenance comparison",
        pattern:
          /^ok - reproduce and provenance comparison distinguish output identity$/m,
        evidence: ["honest-comparison"],
      },
      {
        label: "pre-stream workspace quota reservation",
        pattern:
          /^ok - provider output quota is reserved before opening the stream$/m,
        evidence: ["workspace-storage-quota"],
      },
      {
        label: "confirmed ready-version retention",
        pattern:
          /^ok - checksum-confirmed retention tombstones unreferenced ready bytes$/m,
        evidence: ["workspace-storage-quota"],
      },
      {
        label: "semantic-audit degradation fence",
        pattern:
          /^ok - semantic audit failure cannot turn a committed mutation into a retryable error$/m,
        evidence: ["atomic-audit"],
      },
      {
        label: "database readiness failure and recovery",
        pattern:
          /^ok - database readiness fails closed and recovers on the next probe$/m,
        evidence: ["service-lifecycle"],
      },
      {
        label: "driver-bounded database readiness",
        pattern:
          /^ok - postgres readiness is driver-bounded against a blackholed endpoint$/m,
        evidence: ["service-lifecycle"],
      },
      {
        label: "every-phase restart reconciliation",
        pattern:
          /^ok - restart reconciliation covers every non-terminal run phase$/m,
        evidence: ["service-lifecycle"],
      },
      {
        label: "service acceptance completion",
        pattern:
          /^SCIENCE SERVICE PASS: upload, quarantine, signed ranges, execution, provenance, reproduction, cancellation, fencing, restart recovery, isolation, render, and tool redaction$/m,
        evidence: ["service-lifecycle"],
      },
    ],
    sourceRequirements: [
      /\["study\.list", "read_auto"\]/,
      /\["artifact\.inspect", "read_auto"\]/,
      /\["run\.quote", "read_auto"\]/,
      /\["run\.submit", "write_approved"\]/,
      /\["run\.status", "read_auto"\]/,
      /\["run\.cancel", "destructive_confirmed"\]/,
      /\["manifest\.read", "read_auto"\]/,
      /\["render\.open", "write_approved"\]/,
      /toolSubmission\.run\.state,\s*"awaiting_approval"/,
      /storageKey\|providerHandle\|leaseOwner/,
      /quota-rejected provider quarantine must be discarded/,
    ],
  },
  {
    id: "routes",
    script: "scripts/verify-science-routes.mjs",
    markers: [
      {
        label: "strict HTTP validation and sanitized projection",
        pattern:
          /^SCIENCE ROUTES PASS: strict validation, workspace admission, immutable version history, streaming upload, range reads, sanitized projections, run dossier, manifest comparison, render ownership, rate limits, and audit$/m,
        evidence: ["malformed-contract-refusal", "no-raw-data-through-tools", "workspace-admission"],
      },
    ],
    sourceRequirements: [
      /statusCode,\s*400/,
      /workspace-admission/,
      /providerHandle/,
      /storageKey/,
      /statusCode,\s*429/,
    ],
  },
  {
    id: "authz",
    script: "scripts/verify-science-authz.mjs",
    markers: [
      {
        label: "member-visible admin-controlled workspace admission",
        pattern:
          /^ok - workspace admission defaults denied, is member-visible, and changes are admin-only$/m,
        evidence: ["workspace-admission", "authorization"],
      },
      {
        label: "deterministic admission concurrency",
        pattern:
          /^ok - admission SET ordering, overlapping GET\/guard, and cross-instance visibility are deterministic$/m,
        evidence: ["workspace-admission"],
      },
      {
        label: "revocation convergence boundary",
        pattern:
          /^ok - revoking workspace admission preserves reads and blocks new work$/m,
        evidence: ["workspace-admission"],
      },
      {
        label: "real-session approval path",
        pattern:
          /^ok - builder completes study, upload, generic approval, execution, and manifest flow$/m,
        evidence: ["approval-gate", "manifest-completeness"],
      },
      {
        label: "audit payload redaction",
        pattern:
          /^ok - durable audit entries exist without paths, tokens, handles, or binary payloads$/m,
        evidence: ["no-raw-data-through-tools"],
      },
      {
        label: "workspace predicate isolation",
        pattern:
          /^ok - child UUIDs, approvals, and membership are workspace isolated$/m,
        evidence: ["database-predicates"],
      },
      {
        label: "authorization acceptance completion",
        pattern:
          /^SCIENCE AUTHZ PASS: real sessions, role gates, workspace admission, builder workflow, generic approval, workspace isolation, signed audiences, and audit redaction$/m,
        evidence: ["authorization"],
      },
    ],
    sourceRequirements: [
      /workspace-admission/,
      /serviceAPeer/,
      /\/api\/approvals\//,
      /statusCode\s*===\s*404/,
      /assertNoForbiddenAuditKeys/,
      /BINARY_SENTINEL/,
    ],
  },
  {
    id: "ui-admission",
    script: "scripts/verify-science-ui.mjs",
    markers: [
      {
        label: "FUI workspace admission boundary",
        pattern:
          /^science fui workspace admission acceptance: 12\/12 assertions passed\.$/m,
        evidence: ["workspace-admission-ui"],
      },
    ],
    sourceRequirements: [
      /count\(view, "newWorkEnabled=\{newWorkEnabled\}"\) === 6/,
      /admin admission changes require bounded reason/,
      /purge cancel comparison and render close remain outside admission gate/,
      /HoldButton cancels on disable and unmount with timeout-side stale guard/,
    ],
  },
  {
    id: "recovery",
    script: "scripts/verify-science-recovery.mjs",
    markers: [
      {
        label: "cold metadata and artifact backup",
        pattern:
          /^ok - cold backup copies closed PGlite metadata and immutable artifact trees$/m,
        evidence: ["cold-backup-restore"],
      },
      {
        label: "byte-exact manifest restore",
        pattern:
          /^ok - restored manifest hash and every linked artifact byte match the source$/m,
        evidence: ["cold-backup-restore", "manifest-completeness"],
      },
      {
        label: "read-only rollback boundary",
        pattern:
          /^ok - read-only rollback preserves reads and export but rejects new work$/m,
        evidence: ["rollback-safety", "unsafe-input-refusal"],
      },
      {
        label: "accepted-run rollback cancellation",
        pattern:
          /^ok - read-only rollback can terminate a previously accepted queued run$/m,
        evidence: ["rollback-safety"],
      },
      {
        label: "recovery acceptance completion",
        pattern:
          /^SCIENCE RECOVERY PASS: cold PGlite\/artifact backup, byte-exact restore, manifest-hash verification, read-only export, write refusal, and accepted-run cancellation$/m,
        evidence: ["cold-backup-restore", "rollback-safety"],
      },
    ],
    sourceRequirements: [
      /await liveHandle\.close\(\)/,
      /sha256CanonicalJson/,
      /submissionsEnabled: false/,
      /cancelRun/,
    ],
  },
];

const requiredEvidence = new Set([
  "malformed-contract-refusal",
  "unsafe-input-refusal",
  "database-predicates",
  "scheduler-durability",
  "artifact-boundary",
  "tool-tier-selection",
  "no-raw-data-through-tools",
  "approval-gate",
  "manifest-completeness",
  "service-lifecycle",
  "authorization",
  "cold-backup-restore",
  "rollback-safety",
  "atomic-audit",
  "submit-attempt-fencing",
  "workspace-storage-quota",
  "honest-comparison",
  "geometry-preview",
  "workspace-admission",
  "workspace-admission-ui",
]);

function outputTail(value, maxLines = 80) {
  return value.split(/\r?\n/).slice(-maxLines).join("\n");
}

async function assertSuiteSource(suite) {
  const source = await readFile(join(repositoryRoot, suite.script), "utf8");
  for (const pattern of suite.sourceRequirements ?? []) {
    assert.match(
      source,
      pattern,
      `${suite.id} verifier no longer contains required assertion source ${pattern}`,
    );
  }
}

function deterministicEnvironment() {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const name of [
    "DATABASE_URL",
    "PGLITE_DATA_DIR",
    "SCIENCE_TEST_DATABASE_URL",
    "SCIENCE_RUNTIME_URL",
    "SCIENCE_RENDER_URL",
    "SCIENCE_ARTIFACT_ROOT",
    "SCIENCE_STORAGE_DRIVER",
  ]) {
    delete env[name];
  }
  return env;
}

async function runChild(suite) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [...(suite.nodeArgs ?? []), suite.script], {
      cwd: repositoryRoot,
      env: deterministicEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer = null;
    const startedAt = Date.now();
    const stop = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CHILD_OUTPUT_BYTES) {
        stop(new Error(
          `${suite.id} emitted more than ${MAX_CHILD_OUTPUT_BYTES} bytes`,
        ));
        return target;
      }
      return target + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", stop);
    timer = setTimeout(() => {
      stop(new Error(`${suite.id} exceeded ${CHILD_TIMEOUT_MS} ms`));
    }, CHILD_TIMEOUT_MS);
    timer.unref?.();
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(
          `${suite.id} exited with code ${code ?? "null"} signal ${signal ?? "none"}\n` +
            `stdout tail:\n${outputTail(stdout)}\n` +
            `stderr tail:\n${outputTail(stderr)}`,
        ));
        return;
      }
      accept({
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

for (const suite of suites) await assertSuiteSource(suite);

const durations = new Map(suites.map((suite) => [suite.id, []]));
for (let pass = 1; pass <= PASS_COUNT; pass++) {
  const observedEvidence = new Set();
  for (const suite of suites) {
    const result = await runChild(suite);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(
      combined,
      /data:[^;,\s]+;base64,/i,
      `${suite.id} verifier emitted an inline binary payload`,
    );
    for (const marker of suite.markers) {
      assert.match(
        combined,
        marker.pattern,
        `${suite.id} completed without marker: ${marker.label}\n` +
          `output tail:\n${outputTail(combined)}`,
      );
      for (const evidence of marker.evidence) observedEvidence.add(evidence);
    }
    if (suite.minimumOkLines !== undefined) {
      const okLines = combined.match(/^ok - /gm)?.length ?? 0;
      assert.ok(
        okLines >= suite.minimumOkLines,
        `${suite.id} emitted ${okLines} acceptance lines; expected at least ` +
          `${suite.minimumOkLines}`,
      );
    }
    durations.get(suite.id).push(result.durationMs);
    console.log(
      `ok - golden pass ${pass}/${PASS_COUNT} ${suite.id}: ` +
        `${suite.markers.length} marker(s), ${result.durationMs} ms`,
    );
  }
  assert.deepEqual(
    [...requiredEvidence].filter((entry) => !observedEvidence.has(entry)),
    [],
    `golden pass ${pass} is missing required evidence`,
  );
  console.log(
    `ok - golden pass ${pass}/${PASS_COUNT} covers ` +
      `${observedEvidence.size} required behavioral evidence classes`,
  );
}

for (const [suite, samples] of durations) {
  assert.equal(samples.length, PASS_COUNT);
  assert.ok(samples.every((sample) => Number.isSafeInteger(sample) && sample >= 0));
  console.log(`evidence - ${suite} durations_ms=${samples.join(",")}`);
}

console.log(
  `SCIENCE GOLDEN PASS^${PASS_COUNT}: ${suites.length} isolated deterministic suites; ` +
    `${requiredEvidence.size} evidence classes verified on every pass`,
);
