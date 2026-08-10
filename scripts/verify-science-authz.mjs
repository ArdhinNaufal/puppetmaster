#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  appendAudit,
  createDb,
  createUser,
  ensureDefaultWorkspace,
  getApproval,
  getMission,
  listAudit,
  migrate,
  setScienceWorkspaceAdmission,
  upsertMembership,
  workspaces,
} from "../packages/db/dist/index.js";
import {
  ComputeProviderRegistry,
  DeterministicComputeProvider,
  FilesystemArtifactStore,
  InMemoryEventBus,
  InlineScienceScheduler,
  RenderProviderRegistry,
  ScienceService,
  StaticRenderSessionProvider,
} from "../packages/kernel/dist/index.js";
import {
  hashPassword,
  registerAuth,
} from "../apps/server/dist/auth.js";
import { registerScienceRoutes } from "../apps/server/dist/science-routes.js";

const requireFromServer = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const Fastify = requireFromServer("fastify");

const PASSWORD = "authz-fixture-password";
const STORAGE_SECRET = "authz-storage-reference-secret";
const GATEWAY_SECRET = "authz-render-gateway-secret";
const BINARY_SENTINEL = "AUTHZ_BINARY_SENTINEL_DO_NOT_AUDIT";
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const RESOURCE_BOUNDS = {
  cpuMillicores: 2_000,
  memoryMb: 4_096,
  gpuCount: 0,
  wallTimeSeconds: 600,
};
const RESOURCE_REQUEST = {
  cpuMillicores: 500,
  memoryMb: 512,
  gpuCount: 0,
  wallTimeSeconds: 60,
};
const CONFIG = {
  enabled: true,
  submissionsEnabled: true,
  maxUploadBytes: 8 * 1024 * 1024,
  maxWorkspaceStorageBytes: 64 * 1024 * 1024,
  uploadTtlSeconds: 600,
  renderTtlSeconds: 300,
  maxConcurrentRunsPerWorkspace: 8,
  maxConcurrentRenderSessionsPerWorkspace: 16,
  pollIntervalMs: 2,
};
const isolationDefects = [];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseJson(response, expectedStatus) {
  assert.equal(
    response.statusCode,
    expectedStatus,
    `${response.request?.method ?? "request"} ${response.url ?? ""} returned ` +
      `${response.statusCode}: ${response.body}`,
  );
  return response.body ? response.json() : null;
}

function recordIsolationResponse(response, label) {
  if (response.statusCode === 403 || response.statusCode === 404) return;
  isolationDefects.push(
    `${label} returned ${response.statusCode}: ${response.body}`,
  );
}

function sessionCookie(response) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  assert.ok(value, "login did not set a session cookie");
  const cookie = value.split(";", 1)[0];
  assert.match(cookie, /^pm_session=[0-9a-f]{64}$/);
  return cookie;
}

function createComputeRegistry() {
  const registry = new ComputeProviderRegistry();
  registry.register(new DeterministicComputeProvider({
    kind: "local_container",
    provisioningMs: 0,
    runningMs: 0,
  }));
  return registry;
}

function createRenderRegistry() {
  const registry = new RenderProviderRegistry();
  registry.register(new StaticRenderSessionProvider());
  return registry;
}

function createService({ db, workspaceId, store, workerId }) {
  return new ScienceService({
    db,
    workspaceId,
    store,
    computeProviders: createComputeRegistry(),
    renderProviders: createRenderRegistry(),
    bus: new InMemoryEventBus(),
    config: CONFIG,
    workerId,
    gatewaySecret: GATEWAY_SECRET,
    audit: (entry) => appendAudit(db, entry),
  });
}

async function login(app, email, expectedRole) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
  });
  const body = responseJson(response, 200);
  assert.equal(body.role, expectedRole);
  const cookie = sessionCookie(response);
  const me = responseJson(await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie },
  }), 200);
  assert.equal(me.user.email, email);
  assert.equal(me.role, expectedRole);
  return cookie;
}

async function uploadDirect(service, {
  studyId,
  actorId,
  logicalName,
  bytes,
}) {
  const artifact = await service.createArtifact({
    studyId,
    logicalName,
    kind: "notebook",
    format: "ipynb",
    actorId,
  });
  const begun = await service.beginUpload({
    artifactId: artifact.id,
    expectedSizeBytes: bytes.length,
    expectedSha256: digest(bytes),
    actorId,
  });
  await service.writeUpload(
    begun.uploadToken,
    Readable.from([bytes]),
    actorId,
  );
  const completed = await service.completeUpload({
    uploadToken: begun.uploadToken,
    mediaType: "application/x-ipynb+json",
    metadata: { fixture: "cross-workspace-authz" },
    actorId,
  });
  return { artifact, ...completed };
}

function injectUrl(referenceUrl) {
  const parsed = new URL(referenceUrl, "http://puppetmaster.invalid");
  return `${parsed.pathname}${parsed.search}`;
}

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, output);
  }
  return output;
}

function assertNoForbiddenAuditKeys(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenAuditKeys(entry, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(
      key,
      /(token|password|providerHandle|storageKey|quarantineKey|binary|body|path)/i,
      `audit field ${[...path, key].join(".")} can expose sensitive runtime data`,
    );
    assertNoForbiddenAuditKeys(entry, [...path, key]);
  }
}

/**
 * The production generic approval route is currently inline in main.ts rather
 * than exported. Mount its science branch here so this verifier still crosses
 * Fastify's real /api/approvals RBAC rule, durable approval/mission lookups,
 * workspace scoping, and ScienceService approval transition.
 */
function registerGenericScienceApprovalFixture(app, {
  db,
  workspaceId,
  service,
}) {
  app.post("/api/approvals/:id", async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};
    if (typeof body.approved !== "boolean") {
      return reply
        .code(400)
        .send({ error: "approved must be provided as an explicit boolean" });
    }
    const approval = await getApproval(db, id);
    if (!approval) return reply.code(404).send({ error: "approval not found" });
    const mission = await getMission(db, approval.missionId);
    if (!mission || mission.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: "approval not found" });
    }
    if (mission.kind !== "science") {
      return reply.code(409).send({ error: "fixture accepts science approvals only" });
    }
    const run = await service.getRunByMission(mission.id);
    if (!run) {
      return reply
        .code(409)
        .send({ error: "science approval is missing its durable run" });
    }
    const result = await service.resolveApproval({
      runId: run.id,
      approvalId: approval.id,
      approved: body.approved,
      actorId: request.authUser.id,
    });
    return {
      ok: true,
      approved: body.approved,
      runId: result.run.id,
      state: result.run.state,
    };
  });
}

const dbHandle = await createDb({ ephemeral: true });
const artifactRoot = await mkdtemp(join(tmpdir(), "puppetmaster-science-authz-"));
const app = Fastify({ logger: false });
let scheduler = null;

try {
  await migrate(dbHandle);
  const workspaceAId = await ensureDefaultWorkspace(
    dbHandle.db,
    "Science authorization workspace A",
  );
  const [workspaceB] = await dbHandle.db
    .insert(workspaces)
    .values({ name: "Science authorization workspace B" })
    .returning();

  const passwordHash = await hashPassword(PASSWORD);
  const admin = await createUser(dbHandle.db, {
    email: "science-admin@example.test",
    name: "Science Admin",
    passwordHash,
  });
  const builder = await createUser(dbHandle.db, {
    email: "science-builder@example.test",
    name: "Science Builder",
    passwordHash,
  });
  const member = await createUser(dbHandle.db, {
    email: "science-member@example.test",
    name: "Science Member",
    passwordHash,
  });
  const foreignOwner = await createUser(dbHandle.db, {
    email: "science-foreign@example.test",
    name: "Foreign Workspace Owner",
    passwordHash,
  });
  for (const [userId, workspaceId, role] of [
    [admin.id, workspaceAId, "admin"],
    [builder.id, workspaceAId, "builder"],
    [member.id, workspaceAId, "member"],
    [foreignOwner.id, workspaceB.id, "owner"],
  ]) {
    await upsertMembership(dbHandle.db, { userId, workspaceId, role });
  }

  await setScienceWorkspaceAdmission(dbHandle.db, {
    workspaceId: workspaceB.id,
    admitted: true,
    updatedBy: foreignOwner.id,
  });
  const store = new FilesystemArtifactStore({
    root: artifactRoot,
    referenceSecret: STORAGE_SECRET,
  });
  const serviceA = createService({
    db: dbHandle.db,
    workspaceId: workspaceAId,
    store,
    workerId: "authz-workspace-a",
  });
  const serviceB = createService({
    db: dbHandle.db,
    workspaceId: workspaceB.id,
    store,
    workerId: "authz-workspace-b",
  });
  const schedulerErrors = [];
  scheduler = new InlineScienceScheduler(
    (runId, generation) => serviceA.tick(runId, generation),
    (message, error) => schedulerErrors.push({ message, error }),
  );
  serviceA.attachScheduler(scheduler);
  await scheduler.start();

  await registerAuth(app, { db: dbHandle.db, workspaceId: workspaceAId });
  registerScienceRoutes(app, { service: serviceA });
  registerGenericScienceApprovalFixture(app, {
    db: dbHandle.db,
    workspaceId: workspaceAId,
    service: serviceA,
  });
  app.get("/api/health", async () => ({
    ok: true,
    service: "science-authz-fixture",
  }));
  app.get("/api/readiness", async () => ({
    ok: true,
    service: "science-authz-fixture",
    science: await serviceA.health(),
  }));
  app.get("/api/readyz", async () => ({
    ok: true,
    service: "science-authz-fixture",
  }));
  await app.ready();

  const publicHealth = responseJson(await app.inject({
    method: "GET",
    url: "/api/health",
  }), 200);
  assert.equal(publicHealth.ok, true);
  assert.equal(responseJson(await app.inject({
    method: "GET",
    url: "/api/readyz",
  }), 200).ok, true);
  responseJson(await app.inject({
    method: "GET",
    url: "/api/readiness",
  }), 401);
  responseJson(await app.inject({
    method: "GET",
    url: "/api/science/studies",
  }), 401);
  responseJson(await app.inject({
    method: "POST",
    url: "/api/science/studies",
    payload: { name: "Unauthenticated mutation" },
  }), 401);
  console.log("ok - unauthenticated science reads and mutations return 401");

  const adminCookie = await login(app, admin.email, "admin");
  const builderCookie = await login(app, builder.email, "builder");
  const memberCookie = await login(app, member.email, "member");
  const authenticatedReadiness = responseJson(await app.inject({
    method: "GET",
    url: "/api/readiness",
    headers: { cookie: memberCookie },
  }), 200);
  assert.equal(authenticatedReadiness.science.ok, true);
  console.log("ok - public liveness is cheap while dependency readiness requires a session");
  const foreignLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: foreignOwner.email, password: PASSWORD },
  });
  responseJson(foreignLogin, 403);
  console.log("ok - real login sessions resolve workspace membership and roles");

  const builderDeniedAdmission = responseJson(await app.inject({
    method: "GET",
    url: "/api/science/workspace-admission",
    headers: { cookie: builderCookie },
  }), 200).admission;
  assert.deepEqual(builderDeniedAdmission, {
    workspaceId: workspaceAId,
    admitted: false,
    updatedAt: null,
  });
  assert.equal(responseJson(await app.inject({
    method: "GET",
    url: "/api/science/workspace-admission",
    headers: { cookie: memberCookie },
  }), 200).admission.admitted, false);
  responseJson(await app.inject({
    method: "PATCH",
    url: "/api/science/workspace-admission",
    headers: { cookie: builderCookie },
    payload: { admitted: true, reason: "builder must not admit a workspace" },
  }), 403);
  const deniedAdmission = responseJson(await app.inject({
    method: "GET",
    url: "/api/science/workspace-admission",
    headers: { cookie: adminCookie },
  }), 200).admission;
  assert.equal(deniedAdmission.workspaceId, workspaceAId);
  assert.equal(deniedAdmission.admitted, false);
  assert.equal(deniedAdmission.updatedAt, null);
  assert.deepEqual(
    Object.keys(deniedAdmission).sort(),
    ["admitted", "updatedAt", "workspaceId"],
  );
  responseJson(await app.inject({
    method: "POST",
    url: "/api/science/studies",
    headers: { cookie: builderCookie },
    payload: { name: "Default-denied builder study" },
  }), 503);
  const admissionEnableReason = "authorize bounded Science pilot";
  const enabledAdmission = responseJson(await app.inject({
    method: "PATCH",
    url: "/api/science/workspace-admission",
    headers: { cookie: adminCookie },
    payload: { admitted: true, reason: admissionEnableReason },
  }), 200).admission;
  assert.equal(enabledAdmission.workspaceId, workspaceAId);
  assert.equal(enabledAdmission.admitted, true);
  assert.equal(typeof enabledAdmission.updatedAt, "string");
  assert.equal("id" in enabledAdmission, false);
  assert.equal("updatedBy" in enabledAdmission, false);
  assert.equal(
    responseJson(await app.inject({
      method: "GET",
      url: "/api/science/workspace-admission",
      headers: { cookie: adminCookie },
    }), 200).admission.admitted,
    true,
    "an admitted decision must survive a repository-backed GET",
  );
  const workspaceBAdmission = await serviceB.getWorkspaceAdmission();
  assert.equal(workspaceBAdmission.workspaceId, workspaceB.id);
  assert.equal(workspaceBAdmission.admitted, true);
  assert.ok(workspaceBAdmission.id);
  assert.notEqual(
    enabledAdmission.workspaceId,
    workspaceBAdmission.workspaceId,
    "workspace A admission route must not disclose workspace B's independent decision",
  );
  console.log("ok - workspace admission defaults denied, is member-visible, and changes are admin-only");

  const serviceAPeer = createService({
    db: dbHandle.db,
    workspaceId: workspaceAId,
    store,
    workerId: "authz-workspace-a-peer",
  });
  const peerEnabledStudy = await serviceAPeer.createStudy({
    name: "Cross-instance enabled admission probe",
    actorId: admin.id,
  });
  assert.equal(peerEnabledStudy.workspaceId, workspaceAId);

  const queuedDisable = serviceA.setWorkspaceAdmission({
    admitted: false,
    actorId: admin.id,
    reason: "concurrent guard disable probe",
  });
  const overlappingDeniedGet = serviceA.getWorkspaceAdmission();
  const overlappingDeniedGuard = assert.rejects(
    () => serviceA.createStudy({
      name: "Must wait for queued disable",
      actorId: builder.id,
    }),
    /not admitted for this workspace/i,
  );
  const [disabledDecision, deniedObservation] = await Promise.all([
    queuedDisable,
    overlappingDeniedGet,
    overlappingDeniedGuard,
  ]);
  assert.equal(disabledDecision.admitted, false);
  assert.equal(deniedObservation.admitted, false);
  await assert.rejects(
    () => serviceAPeer.createStudy({
      name: "Cross-instance revoked admission probe",
      actorId: admin.id,
    }),
    /not admitted for this workspace/i,
    "a second service must observe another instance's committed revoke",
  );

  const queuedEnable = serviceA.setWorkspaceAdmission({
    admitted: true,
    actorId: admin.id,
    reason: "concurrent guard enable probe",
  });
  const overlappingEnabledGet = serviceA.getWorkspaceAdmission();
  const overlappingEnabledGuard = serviceA.createStudy({
    name: "Must wait for queued enable",
    actorId: builder.id,
  });
  const [enabledDecision, enabledObservation, enabledGuardStudy] = await Promise.all([
    queuedEnable,
    overlappingEnabledGet,
    overlappingEnabledGuard,
  ]);
  assert.equal(enabledDecision.admitted, true);
  assert.equal(enabledObservation.admitted, true);
  assert.equal(enabledGuardStudy.workspaceId, workspaceAId);
  assert.equal((await serviceAPeer.createStudy({
    name: "Cross-instance re-enabled admission probe",
    actorId: admin.id,
  })).workspaceId, workspaceAId);

  const [orderedDisable, orderedEnable] = await Promise.all([
    serviceA.setWorkspaceAdmission({
      admitted: false,
      actorId: admin.id,
      reason: "ordered concurrent disable",
    }),
    serviceA.setWorkspaceAdmission({
      admitted: true,
      actorId: admin.id,
      reason: "ordered concurrent enable",
    }),
  ]);
  assert.equal(orderedDisable.admitted, false);
  assert.equal(orderedEnable.admitted, true);
  assert.equal(
    (await serviceA.getWorkspaceAdmission()).admitted,
    true,
    "serialized SET call order must match the final persisted decision",
  );
  console.log("ok - admission SET ordering, overlapping GET/guard, and cross-instance visibility are deterministic");

  const profilePayload = {
    name: "Authorization deterministic profile",
    providerKind: "local_container",
    imageDigest: IMAGE_DIGEST,
    kernelName: "python3",
    resourceBounds: RESOURCE_BOUNDS,
    config: {
      dependencyLock: {
        python: "3.12.4",
        numpy: "2.0.1",
      },
    },
    enabled: true,
  };
  responseJson(await app.inject({
    method: "POST",
    url: "/api/science/compute-profiles",
    headers: { cookie: builderCookie },
    payload: profilePayload,
  }), 403);
  const profile = responseJson(await app.inject({
    method: "POST",
    url: "/api/science/compute-profiles",
    headers: { cookie: adminCookie },
    payload: profilePayload,
  }), 201).profile;
  const updatedProfile = responseJson(await app.inject({
    method: "PATCH",
    url: `/api/science/compute-profiles/${profile.id}`,
    headers: { cookie: adminCookie },
    payload: { name: "Authorization deterministic profile v2" },
  }), 200).profile;
  assert.equal(updatedProfile.name, "Authorization deterministic profile v2");
  responseJson(await app.inject({
    method: "PATCH",
    url: `/api/science/compute-profiles/${profile.id}`,
    headers: { cookie: builderCookie },
    payload: { name: "Builder must not change profiles" },
  }), 403);
  console.log("ok - admin manages compute profiles while builder is forbidden");

  const study = responseJson(await app.inject({
    method: "POST",
    url: "/api/science/studies",
    headers: { cookie: builderCookie },
    payload: {
      name: "Builder authorization study",
      description: "HTTP authorization fixture",
      classification: "non_regulated",
    },
  }), 201).study;
  const artifact = responseJson(await app.inject({
    method: "POST",
    url: `/api/science/studies/${study.id}/artifacts`,
    headers: { cookie: builderCookie },
    payload: {
      logicalName: "authz-notebook.ipynb",
      kind: "notebook",
      format: "ipynb",
    },
  }), 201).artifact;
  const notebookBytes = Buffer.from(JSON.stringify({
    cells: [{
      cell_type: "markdown",
      metadata: {},
      source: [BINARY_SENTINEL],
    }],
    metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
    nbformat: 4,
    nbformat_minor: 5,
  }), "utf8");
  const uploadIntent = responseJson(await app.inject({
    method: "POST",
    url: `/api/science/artifacts/${artifact.id}/uploads`,
    headers: { cookie: builderCookie },
    payload: {
      filename: "authz-notebook.ipynb",
      expectedSizeBytes: notebookBytes.length,
      expectedSha256: digest(notebookBytes),
      mediaType: "application/x-ipynb+json",
    },
  }), 201);
  responseJson(await app.inject({
    method: "PUT",
    url: uploadIntent.uploadUrl,
    headers: {
      cookie: builderCookie,
      "content-type": "application/octet-stream",
    },
    payload: notebookBytes,
  }), 200);
  const version = responseJson(await app.inject({
    method: "POST",
    url: `/api/science/uploads/${encodeURIComponent(uploadIntent.uploadToken)}/complete`,
    headers: { cookie: builderCookie },
    payload: {
      mediaType: "application/x-ipynb+json",
      metadata: { filename: "authz-notebook.ipynb" },
    },
  }), 200);
  assert.equal(version.sha256, digest(notebookBytes));
  assert.equal("storageKey" in version, false);

  const submitted = responseJson(await app.inject({
    method: "POST",
    url: `/api/science/studies/${study.id}/runs`,
    headers: { cookie: builderCookie },
    payload: {
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      inputs: [{
        artifactVersionId: version.id,
        semanticRole: "notebook",
      }],
      parameters: {
        randomSeeds: { solver: 42 },
        units: { displacement: "m" },
      },
      idempotencyKey: "authz-builder-run-v1",
    },
  }), 201);
  assert.equal(submitted.run.state, "awaiting_approval");

  responseJson(await app.inject({
    method: "POST",
    url: `/api/approvals/${submitted.approvalId}`,
    headers: { cookie: memberCookie },
    payload: { approved: true },
  }), 403);
  const approvalDecision = responseJson(await app.inject({
    method: "POST",
    url: `/api/approvals/${submitted.approvalId}`,
    headers: { cookie: builderCookie },
    payload: { approved: true },
  }), 200);
  assert.equal(approvalDecision.runId, submitted.run.id);
  assert.equal(approvalDecision.approved, true);

  const runDeadline = Date.now() + 5_000;
  let dossier;
  while (Date.now() < runDeadline) {
    const response = await app.inject({
      method: "GET",
      url: `/api/science/runs/${submitted.run.id}`,
      headers: { cookie: builderCookie },
    });
    dossier = responseJson(response, 200).run;
    if (["succeeded", "failed", "cancelled"].includes(dossier.state)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  assert.equal(dossier.state, "succeeded");
  assert.equal(dossier.providerHandle, null);
  assert.equal(dossier.outputs.length, 2);
  const manifest = responseJson(await app.inject({
    method: "GET",
    url: `/api/science/runs/${submitted.run.id}/manifest`,
    headers: { cookie: builderCookie },
  }), 200).manifest;
  assert.equal(manifest.complete, true);
  assert.equal(manifest.outputs.length, 2);
  assert.equal(schedulerErrors.length, 0);
  console.log(
    "ok - builder completes study, upload, generic approval, execution, and manifest flow",
  );

  const retentionUpload = await uploadDirect(serviceA, {
    studyId: study.id,
    actorId: admin.id,
    logicalName: "authz-retention.ipynb",
    bytes: notebookBytes,
  });
  responseJson(await app.inject({
    method: "DELETE",
    url: `/api/science/artifact-versions/${retentionUpload.version.id}`,
    headers: { cookie: builderCookie },
    payload: { confirmSha256: retentionUpload.version.sha256 },
  }), 403);
  responseJson(await app.inject({
    method: "DELETE",
    url: `/api/science/artifact-versions/${retentionUpload.version.id}`,
    headers: { cookie: adminCookie },
    payload: { confirmSha256: "0".repeat(64) },
  }), 409);
  const expiredRetention = responseJson(await app.inject({
    method: "DELETE",
    url: `/api/science/artifact-versions/${retentionUpload.version.id}`,
    headers: { cookie: adminCookie },
    payload: { confirmSha256: retentionUpload.version.sha256 },
  }), 200);
  assert.equal(expiredRetention.artifactVersion.status, "expired");
  assert.equal("storageKey" in expiredRetention.artifactVersion, false);
  const retainedTombstone = responseJson(await app.inject({
    method: "GET",
    url: `/api/science/artifact-versions/${retentionUpload.version.id}`,
    headers: { cookie: adminCookie },
  }), 200).artifactVersion;
  assert.equal(retainedTombstone.status, "expired");
  assert.equal(retainedTombstone.version, retentionUpload.version.version);
  assert.equal("storageKey" in retainedTombstone, false);
  await assert.rejects(
    store.open(retentionUpload.version.storageKey),
    /ENOENT|404|failed/i,
  );
  console.log("ok - admin checksum retention expires bytes while builder is forbidden");

  const memberStudies = responseJson(await app.inject({
    method: "GET",
    url: "/api/science/studies",
    headers: { cookie: memberCookie },
  }), 200);
  assert.ok(memberStudies.items.some((entry) => entry.id === study.id));
  const memberProfiles = responseJson(await app.inject({
    method: "GET",
    url: "/api/science/compute-profiles",
    headers: { cookie: memberCookie },
  }), 200);
  assert.ok(memberProfiles.items.some((entry) => entry.id === profile.id));
  const memberRun = responseJson(await app.inject({
    method: "GET",
    url: `/api/science/runs/${submitted.run.id}`,
    headers: { cookie: memberCookie },
  }), 200).run;
  assert.equal(memberRun.state, "succeeded");
  const memberContent = await app.inject({
    method: "GET",
    url: `/api/science/artifact-versions/${version.id}/content`,
    headers: { cookie: memberCookie },
  });
  assert.equal(memberContent.statusCode, 200, memberContent.body);
  assert.deepEqual(memberContent.rawPayload, notebookBytes);
  responseJson(await app.inject({
    method: "POST",
    url: "/api/science/studies",
    headers: { cookie: memberCookie },
    payload: { name: "Member mutation must fail" },
  }), 403);
  console.log("ok - member reads science resources but cannot mutate them");

  const foreignStudy = await serviceB.createStudy({
    name: "Foreign workspace science study",
    actorId: foreignOwner.id,
  });
  const foreignBytes = Buffer.from(JSON.stringify({
    cells: [{
      cell_type: "code",
      execution_count: null,
      metadata: { workspace: "B" },
      outputs: [],
      source: [`${BINARY_SENTINEL}-FOREIGN`],
    }],
    metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
    nbformat: 4,
    nbformat_minor: 5,
  }), "utf8");
  const foreignUpload = await uploadDirect(serviceB, {
    studyId: foreignStudy.id,
    actorId: foreignOwner.id,
    logicalName: "foreign-notebook.ipynb",
    bytes: foreignBytes,
  });
  const foreignProfile = await serviceB.createComputeProfile({
    name: "Foreign deterministic profile",
    providerKind: "local_container",
    imageDigest: IMAGE_DIGEST,
    kernelName: "python3",
    resourceBounds: RESOURCE_BOUNDS,
    config: {},
    actorId: foreignOwner.id,
  });
  const foreignSubmission = await serviceB.submitRun({
    studyId: foreignStudy.id,
    computeProfileId: foreignProfile.id,
    resourceRequest: RESOURCE_REQUEST,
    inputs: [{
      artifactVersionId: foreignUpload.version.id,
      semanticRole: "notebook",
    }],
    idempotencyKey: "authz-foreign-run-v1",
    actorId: foreignOwner.id,
  });

  responseJson(await app.inject({
    method: "GET",
    url: `/api/science/studies/${foreignStudy.id}`,
    headers: { cookie: builderCookie },
  }), 404);
  responseJson(await app.inject({
    method: "GET",
    url: `/api/science/artifact-versions/${foreignUpload.version.id}`,

    headers: { cookie: builderCookie },
  }), 404);
  recordIsolationResponse(await app.inject({
    method: "POST",
    url: `/api/science/artifacts/${foreignUpload.artifact.id}/uploads`,
    headers: { cookie: builderCookie },
    payload: {
      expectedSizeBytes: foreignBytes.length,
      expectedSha256: digest(foreignBytes),
    },
  }), "foreign artifact child UUID");
  responseJson(await app.inject({
    method: "POST",
    url: `/api/approvals/${foreignSubmission.approval.id}`,
    headers: { cookie: builderCookie },
    payload: { approved: true },
  }), 404);

  const internalVersion = await serviceA.getArtifactVersion(version.id);
  const ownReference = await store.reference(internalVersion.storageKey, {
    versionId: internalVersion.id,
    sha256: internalVersion.sha256,
    size: internalVersion.sizeBytes,
    audience: "science-authz:workspace-a",
    ttlSeconds: 60,
  });
  const signedContent = await app.inject({
    method: "GET",
    url: injectUrl(ownReference.url),
  });
  assert.equal(signedContent.statusCode, 200, signedContent.body);
  assert.deepEqual(signedContent.rawPayload, notebookBytes);

  const tamperedAudience = new URL(
    ownReference.url,
    "http://puppetmaster.invalid",
  );
  tamperedAudience.searchParams.set("audience", "science-authz:workspace-b");
  responseJson(await app.inject({
    method: "GET",
    url: `${tamperedAudience.pathname}${tamperedAudience.search}`,
  }), 404);

  const foreignReference = await store.reference(
    foreignUpload.version.storageKey,
    {
      versionId: foreignUpload.version.id,
      sha256: foreignUpload.version.sha256,
      size: foreignUpload.version.sizeBytes,
      audience: "science-authz:workspace-b",
      ttlSeconds: 60,
    },
  );
  responseJson(await app.inject({
    method: "GET",
    url: injectUrl(foreignReference.url),
  }), 404);
  console.log("ok - signed references bind audience and workspace");

  const revokeCleanupUpload = await uploadDirect(serviceA, {
    studyId: study.id,
    actorId: admin.id,
    logicalName: "post-revoke-cleanup.ipynb",
    bytes: notebookBytes,
  });
  const admissionDisableReason = "pilot window closed after authorization verification";
  const disabledAdmission = responseJson(await app.inject({
    method: "PATCH",
    url: "/api/science/workspace-admission",
    headers: { cookie: adminCookie },
    payload: { admitted: false, reason: admissionDisableReason },
  }), 200).admission;
  assert.equal(disabledAdmission.admitted, false);
  assert.equal("updatedBy" in disabledAdmission, false);
  assert.equal(
    responseJson(await app.inject({
      method: "GET",
      url: `/api/science/studies/${study.id}`,
      headers: { cookie: builderCookie },
    }), 200).study.id,
    study.id,
    "workspace revocation must preserve existing reads",
  );
  responseJson(await app.inject({
    method: "POST",
    url: "/api/science/studies",
    headers: { cookie: builderCookie },
    payload: { name: "Builder work after pilot revocation" },
  await assert.rejects(
    () => serviceA.quote({
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
    }),
    /not admitted for this workspace/i,
    "revocation must block provider quote traffic as part of new-work admission",
  );
  }), 503);
  const postRevokeCleanup = responseJson(await app.inject({
    method: "DELETE",
    url: `/api/science/artifact-versions/${revokeCleanupUpload.version.id}`,
    headers: { cookie: adminCookie },
    payload: { confirmSha256: revokeCleanupUpload.version.sha256 },
  }), 200).artifactVersion;
  assert.equal(postRevokeCleanup.status, "expired");
  assert.equal(
    (await serviceA.getArtifactVersion(revokeCleanupUpload.version.id)).status,
    "expired",
  );
  assert.equal(
    responseJson(await app.inject({
      method: "GET",
      url: "/api/science/workspace-admission",
      headers: { cookie: memberCookie },
    }), 200).admission.admitted,
    false,
  );
  console.log("ok - revoking workspace admission preserves reads and blocks new work");

  const internalRun = await serviceA.getRun(submitted.run.id);
  assert.ok(internalRun.providerHandle);
  const audits = await listAudit(dbHandle.db, workspaceAId, { limit: 200 });
  const actions = new Set(audits.map((entry) => entry.action));
  for (const action of [
    "auth.login",
    "science.compute-profile.create",
    "science.compute-profile.update",
    "science.study.create",
    "science.artifact.create",
    "science.artifact.upload.begin",
    "science.artifact.upload.complete",
    "science.artifact.version.expire",
    "science.run.submit",
    "science.run.approval",
    "science.workspace.admission.update",
    "science.run.finish",
  ]) {
    assert.ok(actions.has(action), `missing expected audit action ${action}`);
  }
  assert.ok(
    audits.some((entry) =>
      entry.action === "science.workspace.admission.update" &&
      entry.actorId === admin.id &&
      entry.detail?.reason === admissionDisableReason &&
      entry.detail?.admitted === false
    ),
    "admission changes must retain initiating admin, bounded reason, and decision",
  );
  assert.ok(audits.length >= 10);
  for (const entry of audits) assertNoForbiddenAuditKeys(entry.detail);
  const auditStrings = collectStrings(audits);
  for (const value of auditStrings) {
    for (const forbidden of [
      artifactRoot,
      resolve(artifactRoot),
      uploadIntent.uploadToken,
      internalVersion.storageKey,
      internalRun.providerHandle,
      PASSWORD,
      STORAGE_SECRET,
      GATEWAY_SECRET,
      BINARY_SENTINEL,
    ]) {
      assert.equal(
        value.includes(forbidden),
        false,
        `audit value exposed forbidden data: ${forbidden}`,
      );
    }
    assert.doesNotMatch(
      value,
      /(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var)\/)/,
      `audit value exposed a host path: ${value}`,
    );
    assert.doesNotMatch(value, /data:[^;,]+;base64,/i);
  }
  console.log(
    "ok - durable audit entries exist without paths, tokens, handles, or binary payloads",
  );

  assert.deepEqual(
    isolationDefects,
    [],
    `workspace isolation returned a conflict instead of not-found/forbidden:\n` +
      isolationDefects.join("\n"),
  );
  console.log(
    "ok - child UUIDs, approvals, and membership are workspace isolated",
  );
  console.log(
    "SCIENCE AUTHZ PASS: real sessions, role gates, workspace admission, builder workflow, " +
      "generic approval, workspace isolation, signed audiences, and audit redaction",
  );
} finally {
  if (scheduler) await scheduler.close().catch(() => {});
  await app.close().catch(() => {});
  await dbHandle.close();
  const resolvedRoot = resolve(artifactRoot);
  assert.ok(
    resolvedRoot.startsWith(resolve(tmpdir())),
    "refusing to remove an authorization fixture outside the system temp directory",
  );
  await rm(resolvedRoot, { recursive: true, force: true });
}
