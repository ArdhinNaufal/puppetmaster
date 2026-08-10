#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  createDb,
  createUser,
  migrate,
  setScienceWorkspaceAdmission,
  workspaces,
} from "../packages/db/dist/index.js";
import {
  ComputeProviderRegistry,
  DeterministicComputeProvider,
  FilesystemArtifactStore,
  InMemoryEventBus,
  RenderProviderRegistry,
  ScienceService,
  StaticRenderSessionProvider,
  sha256CanonicalJson,
} from "../packages/kernel/dist/index.js";

const STORAGE_SECRET = "science-recovery-storage-secret";
const GATEWAY_SECRET = "science-recovery-gateway-secret";
const IMAGE_DIGEST = `sha256:${"7".repeat(64)}`;
const RESOURCE_BOUNDS = {
  cpuMillicores: 4_000,
  memoryMb: 8_192,
  gpuCount: 0,
  wallTimeSeconds: 3_600,
};
const RESOURCE_REQUEST = {
  cpuMillicores: 1_000,
  memoryMb: 1_024,
  gpuCount: 0,
  wallTimeSeconds: 60,
};
const WRITABLE_CONFIG = {
  enabled: true,
  submissionsEnabled: true,
  maxUploadBytes: 8 * 1024 * 1024,
  maxWorkspaceStorageBytes: 64 * 1024 * 1024,
  uploadTtlSeconds: 60,
  renderTtlSeconds: 60,
  maxConcurrentRunsPerWorkspace: 4,
  maxConcurrentRenderSessionsPerWorkspace: 8,
  pollIntervalMs: 1,
};
const READ_ONLY_CONFIG = {
  ...WRITABLE_CONFIG,
  submissionsEnabled: false,
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createComputeProviders() {
  const registry = new ComputeProviderRegistry();
  registry.register(new DeterministicComputeProvider({
    kind: "local_container",
    provisioningMs: 0,
    runningMs: 0,
  }));
  return registry;
}

function createRenderProviders() {
  const registry = new RenderProviderRegistry();
  registry.register(new StaticRenderSessionProvider());
  return registry;
}

function createService({ db, workspaceId, artifactRoot, config, workerId }) {
  return new ScienceService({
    db,
    workspaceId,
    store: new FilesystemArtifactStore({
      root: artifactRoot,
      referenceSecret: STORAGE_SECRET,
    }),
    computeProviders: createComputeProviders(),
    renderProviders: createRenderProviders(),
    bus: new InMemoryEventBus(),
    config,
    workerId,
    gatewaySecret: GATEWAY_SECRET,
  });
}

async function uploadNotebook(service, studyId, actorId, bytes) {
  const artifact = await service.createArtifact({
    studyId,
    logicalName: "recovery-input.ipynb",
    kind: "notebook",
    format: "ipynb",
    actorId,
  });
  const begun = await service.beginUpload({
    artifactId: artifact.id,
    expectedSizeBytes: bytes.length,
    expectedSha256: sha256(bytes),
    actorId,
  });
  await service.writeUpload(begun.uploadToken, Readable.from([bytes]), actorId);
  const completed = await service.completeUpload({
    uploadToken: begun.uploadToken,
    mediaType: "application/x-ipynb+json",
    metadata: { filename: "recovery-input.ipynb", fixture: "cold-backup-v1" },
    actorId,
  });
  assert.equal(completed.version.status, "ready");
  assert.equal(completed.version.sha256, sha256(bytes));
  return completed.version;
}

function runIntent({ studyId, profileId, inputVersionId, actorId, idempotencyKey }) {
  return {
    studyId,
    computeProfileId: profileId,
    resourceRequest: RESOURCE_REQUEST,
    inputs: [{
      artifactVersionId: inputVersionId,
      semanticRole: "notebook",
    }],
    parameters: {
      sourceRevision: "89abcdef0123456789abcdef0123456789abcdef",
      randomSeeds: { solver: 42 },
      units: { displacement: "m", time: "s" },
    },
    idempotencyKey,
    actorId,
  };
}

async function approve(service, submission, actorId) {
  const resolved = await service.resolveApproval({
    runId: submission.run.id,
    approvalId: submission.approval.id,
    approved: true,
    actorId,
  });
  assert.equal(resolved.run.state, "queued");
  return resolved.run;
}

async function driveTo(service, runId, expectedState, maxTicks = 20) {
  for (let tick = 0; tick < maxTicks; tick++) {
    const current = await service.getRun(runId);
    if (current.state === expectedState) return current;
    if (["succeeded", "failed", "cancelled"].includes(current.state)) {
      assert.fail(
        `science recovery run reached ${current.state}, expected ${expectedState}: ` +
          `${current.error ?? "no recorded error"}`,
      );
    }
    await service.tick(runId, null);
  }
  const current = await service.getRun(runId);
  assert.fail(
    `science recovery run did not reach ${expectedState} after ${maxTicks} ticks; ` +
      `last state ${current.state}`,
  );
}

async function hashTree(root) {
  const entries = [];
  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        await walk(absolute);
        continue;
      }
      assert.equal(
        child.isFile(),
        true,
        `backup fixture contains a non-file entry: ${absolute}`,
      );
      const name = relative(root, absolute).split(sep).join("/");
      const bytes = await readFile(absolute);
      entries.push(`${name}\0${bytes.length}\0${sha256(bytes)}\n`);
    }
  }
  await walk(root);
  assert.ok(entries.length > 0, `backup source ${root} contains no files`);
  return createHash("sha256").update(entries.join("")).digest("hex");
}

async function snapshotArtifacts(service, dossier) {
  const snapshots = new Map();
  for (const link of [...dossier.inputs, ...dossier.outputs]) {
    assert.ok(link.version, `run link ${link.id} is missing its artifact version`);
    const opened = await service.openArtifactVersion({ versionId: link.version.id });
    const bytes = await streamBytes(opened.read.body);
    assert.equal(bytes.length, link.version.sizeBytes);
    assert.equal(sha256(bytes), link.version.sha256);
    snapshots.set(link.version.id, bytes);
  }
  return snapshots;
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "puppetmaster-science-recovery-"));
const liveDbDir = join(fixtureRoot, "live-db");
const liveArtifactRoot = join(fixtureRoot, "live-artifacts");
const backupDbDir = join(fixtureRoot, "backup-db");
const backupArtifactRoot = join(fixtureRoot, "backup-artifacts");
const restoreDbDir = join(fixtureRoot, "restore-db");
const restoreArtifactRoot = join(fixtureRoot, "restore-artifacts");

let liveHandle = null;
let restoredHandle = null;

try {
  liveHandle = await createDb({ dataDir: liveDbDir });
  assert.equal(liveHandle.driver, "pglite");
  await migrate(liveHandle);

  const [workspace] = await liveHandle.db
    .insert(workspaces)
    .values({ name: "Science cold-backup fixture" })
    .returning();
  const owner = await createUser(liveHandle.db, {
    email: "science-recovery-owner@example.test",
    name: "Science Recovery Owner",
    passwordHash: "not-a-real-password-hash",
  });
  await setScienceWorkspaceAdmission(liveHandle.db, {
    workspaceId: workspace.id,
    admitted: true,
    updatedBy: owner.id,
  });
  const liveService = createService({
    db: liveHandle.db,
    workspaceId: workspace.id,
    artifactRoot: liveArtifactRoot,
    config: WRITABLE_CONFIG,
    workerId: "science-recovery-live",
  });

  const study = await liveService.createStudy({
    name: "Cold backup and rollback study",
    description: "Persistent metadata and immutable artifact recovery fixture",
    actorId: owner.id,
  });
  const notebookBytes = Buffer.from(JSON.stringify({
    cells: [{
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: ["print('deterministic recovery fixture')"],
    }],
    metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
    nbformat: 4,
    nbformat_minor: 5,
  }), "utf8");
  const inputVersion = await uploadNotebook(
    liveService,
    study.id,
    owner.id,
    notebookBytes,
  );
  const profile = await liveService.createComputeProfile({
    name: "Recovery deterministic profile",
    providerKind: "local_container",
    imageDigest: IMAGE_DIGEST,
    kernelName: "python3",
    resourceBounds: RESOURCE_BOUNDS,
    config: {
      dependencyLock: {
        python: "3.12.4",
        numpy: "2.1.0",
      },
      network: "none",
    },
    actorId: owner.id,
  });

  const completedSubmission = await liveService.submitRun(runIntent({
    studyId: study.id,
    profileId: profile.id,
    inputVersionId: inputVersion.id,
    actorId: owner.id,
    idempotencyKey: "science-recovery-completed-v1",
  }));
  assert.equal(completedSubmission.run.state, "awaiting_approval");
  await approve(liveService, completedSubmission, owner.id);
  const completedRun = await driveTo(
    liveService,
    completedSubmission.run.id,
    "succeeded",
  );
  assert.equal(completedRun.manifest?.complete, true);
  assert.deepEqual(completedRun.manifest?.gaps, []);
  assert.match(completedRun.manifestHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(
    sha256CanonicalJson(completedRun.manifest),
    completedRun.manifestHash,
  );
  const completedDossier = await liveService.getRunDossier(completedRun.id, 100);
  assert.equal(completedDossier.inputs.length, 1);
  assert.equal(completedDossier.outputs.length, 2);
  const artifactSnapshots = await snapshotArtifacts(liveService, completedDossier);

  // This accepted but not yet dispatched run proves read-only rollback retains
  // authority to stop work that existed before the rollback.
  const acceptedSubmission = await liveService.submitRun(runIntent({
    studyId: study.id,
    profileId: profile.id,
    inputVersionId: inputVersion.id,
    actorId: owner.id,
    idempotencyKey: "science-recovery-accepted-v1",
  }));
  const acceptedRun = await approve(liveService, acceptedSubmission, owner.id);
  assert.equal(acceptedRun.state, "queued");

  const evidence = {
    workspaceId: workspace.id,
    ownerId: owner.id,
    studyId: study.id,
    profileId: profile.id,
    inputVersionId: inputVersion.id,
    completedRunId: completedRun.id,
    acceptedRunId: acceptedRun.id,
    manifest: completedRun.manifest,
    manifestHash: completedRun.manifestHash,
  };

  await liveHandle.close();
  liveHandle = null;

  // The backup is deliberately cold: every database and artifact writer is
  // closed before either tree is copied.
  await cp(liveDbDir, backupDbDir, { recursive: true, errorOnExist: true });
  await cp(liveArtifactRoot, backupArtifactRoot, {
    recursive: true,
    errorOnExist: true,
  });
  const liveDbDigest = await hashTree(liveDbDir);
  const liveArtifactDigest = await hashTree(liveArtifactRoot);
  assert.equal(await hashTree(backupDbDir), liveDbDigest);
  assert.equal(await hashTree(backupArtifactRoot), liveArtifactDigest);
  console.log("ok - cold backup copies closed PGlite metadata and immutable artifact trees");

  await cp(backupDbDir, restoreDbDir, { recursive: true, errorOnExist: true });
  await cp(backupArtifactRoot, restoreArtifactRoot, {
    recursive: true,
    errorOnExist: true,
  });
  assert.equal(await hashTree(restoreDbDir), liveDbDigest);
  assert.equal(await hashTree(restoreArtifactRoot), liveArtifactDigest);

  restoredHandle = await createDb({ dataDir: restoreDbDir });
  assert.equal(restoredHandle.driver, "pglite");
  const rollbackService = createService({
    db: restoredHandle.db,
    workspaceId: evidence.workspaceId,
    artifactRoot: restoreArtifactRoot,
    config: READ_ONLY_CONFIG,
    workerId: "science-recovery-rollback",
  });

  const restoredStudy = await rollbackService.getStudy(evidence.studyId);
  assert.equal(restoredStudy.name, "Cold backup and rollback study");
  const restoredManifest = await rollbackService.getManifest(evidence.completedRunId);
  assert.equal(restoredManifest.state, "succeeded");
  assert.equal(restoredManifest.complete, true);
  assert.deepEqual(restoredManifest.gaps, []);
  assert.equal(restoredManifest.manifestHash, evidence.manifestHash);
  assert.deepEqual(restoredManifest.manifest, evidence.manifest);
  assert.equal(
    sha256CanonicalJson(restoredManifest.manifest),
    restoredManifest.manifestHash,
  );

  const restoredDossier = await rollbackService.getRunDossier(
    evidence.completedRunId,
    100,
  );
  assert.equal(restoredDossier.inputs.length, 1);
  assert.equal(restoredDossier.outputs.length, 2);
  for (const link of [...restoredDossier.inputs, ...restoredDossier.outputs]) {
    assert.ok(link.version, `restored run link ${link.id} has no version`);
    const expected = artifactSnapshots.get(link.version.id);
    assert.ok(expected, `restored artifact ${link.version.id} was not in the backup snapshot`);
    const opened = await rollbackService.openArtifactVersion({
      versionId: link.version.id,
    });
    const actual = await streamBytes(opened.read.body);
    assert.deepEqual(actual, expected);
    assert.equal(sha256(actual), link.version.sha256);
  }
  const range = await rollbackService.openArtifactVersion({
    versionId: evidence.inputVersionId,
    range: { start: 0, end: Math.min(31, notebookBytes.length - 1) },
  });
  assert.deepEqual(
    await streamBytes(range.read.body),
    notebookBytes.subarray(0, Math.min(32, notebookBytes.length)),
  );
  console.log("ok - restored manifest hash and every linked artifact byte match the source");

  await assert.rejects(
    rollbackService.createStudy({
      name: "Rollback must reject writes",
      actorId: evidence.ownerId,
    }),
    /read-only|submissions are disabled/i,
  );
  await assert.rejects(
    rollbackService.submitRun(runIntent({
      studyId: evidence.studyId,
      profileId: evidence.profileId,
      inputVersionId: evidence.inputVersionId,
      actorId: evidence.ownerId,
      idempotencyKey: "science-recovery-must-be-rejected",
    })),
    /read-only|submissions are disabled/i,
  );
  console.log("ok - read-only rollback preserves reads and export but rejects new work");

  const cancellation = await rollbackService.cancelRun({
    runId: evidence.acceptedRunId,
    actorId: evidence.ownerId,
  });
  assert.equal(cancellation.accepted, true);
  assert.equal(cancellation.run.state, "cancelling");
  const cancelled = await driveTo(
    rollbackService,
    evidence.acceptedRunId,
    "cancelled",
  );
  assert.equal(cancelled.providerHandle, null);
  console.log("ok - read-only rollback can terminate a previously accepted queued run");

  console.log(
    "SCIENCE RECOVERY PASS: cold PGlite/artifact backup, byte-exact restore, " +
      "manifest-hash verification, read-only export, write refusal, and accepted-run cancellation",
  );
} finally {
  if (restoredHandle) await restoredHandle.close().catch(() => {});
  if (liveHandle) await liveHandle.close().catch(() => {});
  const resolvedFixtureRoot = resolve(fixtureRoot);
  const resolvedTempRoot = resolve(tmpdir());
  assert.ok(
    resolvedFixtureRoot.startsWith(`${resolvedTempRoot}${sep}`),
    "refusing to remove a recovery fixture outside the system temp directory",
  );
  await rm(resolvedFixtureRoot, { recursive: true, force: true });
}
