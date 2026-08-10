#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  createDb,
  createUser,
  ensureDefaultWorkspace,
  migrate,
  upsertMembership,
} from "../packages/db/dist/index.js";
import {
  ComputeProviderRegistry,
  DeterministicComputeProvider,
  FilesystemArtifactStore,
  InMemoryEventBus,
  RenderProviderRegistry,
  ScienceService,
  StaticRenderSessionProvider,
} from "../packages/kernel/dist/index.js";
import {
  redactScienceRequestPath,
  registerScienceRoutes,
  resolveRenderGatewayUpstream,
} from "../apps/server/dist/science-routes.js";

const requireFromServer = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const Fastify = requireFromServer("fastify");

assert.equal(
  resolveRenderGatewayUpstream(
    "http://renderer.internal/sessions/session-a/index.html",
    "assets/viewer.js",
  ).toString(),
  "http://renderer.internal/sessions/session-a/index.html/assets/viewer.js",
);
for (const suffix of [
  "../../v1/admin",
  "%2e%2e/%2e%2e/v1/admin",
  "%252e%252e/%252e%252e/v1/admin",
  "assets%2f..%2f..%2fv1/admin",
  "assets\\..\\v1\\admin",
]) {
  assert.throws(
    () => resolveRenderGatewayUpstream(
      "http://renderer.internal/sessions/session-a/index.html",
      suffix,
    ),
    /render resource not found/i,
    `render gateway suffix ${suffix} must stay inside the session prefix`,
  );
}
const handle = await createDb({ ephemeral: true });
const artifactRoot = await mkdtemp(join(tmpdir(), "puppetmaster-science-routes-"));
const app = Fastify({ logger: false });

const requestLogPath = redactScienceRequestPath(
  "/api/science/uploads/raw-upload-capability/complete?sig=query-capability",
);
assert.equal(
  requestLogPath,
  "/api/science/uploads/[REDACTED]/complete",
);
assert.equal(requestLogPath.includes("raw-upload-capability"), false);
assert.equal(requestLogPath.includes("query-capability"), false);

const json = (response) => {
  const parsed = response.json();
  assert.equal(
    response.statusCode < 400,
    true,
    `${response.request?.method ?? "request"} failed ${response.statusCode}: ${response.body}`,
  );
  return parsed;
};

try {
  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "Science route verification");
  const owner = await createUser(handle.db, {
    email: "science-owner@example.invalid",
    name: "Science Owner",
    passwordHash: "fixture",
  });
  const other = await createUser(handle.db, {
    email: "science-other@example.invalid",
    name: "Science Other",
    passwordHash: "fixture",
  });
  await upsertMembership(handle.db, {
    userId: owner.id,
    workspaceId,
    role: "owner",
  });
  await upsertMembership(handle.db, {
    userId: other.id,
    workspaceId,
    role: "builder",
  });

  const compute = new ComputeProviderRegistry();
  compute.register(new DeterministicComputeProvider({
    kind: "local_container",
    provisioningMs: 0,
    runningMs: 0,
  }));
  const render = new RenderProviderRegistry();
  render.register(new StaticRenderSessionProvider());
  const audits = [];
  const service = new ScienceService({
    db: handle.db,
    workspaceId,
    store: new FilesystemArtifactStore({
      root: artifactRoot,
      referenceSecret: "science-route-reference-secret",
    }),
    computeProviders: compute,
    renderProviders: render,
    bus: new InMemoryEventBus(),
    config: {
      enabled: true,
      submissionsEnabled: true,
      maxUploadBytes: 8 * 1024 * 1024,
      maxWorkspaceStorageBytes: 64 * 1024 * 1024,
      uploadTtlSeconds: 600,
      renderTtlSeconds: 300,
      maxConcurrentRunsPerWorkspace: 2,
      maxConcurrentRenderSessionsPerWorkspace: 8,
      pollIntervalMs: 1,
    },
    gatewaySecret: "science-route-gateway-secret",
    audit: async (entry) => {
      audits.push(entry);
    },
  });

  let activeUser = owner;
  app.decorateRequest("authUser", null);
  app.addHook("onRequest", async (request) => {
    request.authUser = {
      id: activeUser.id,
      email: activeUser.email,
      name: activeUser.name,
      role: activeUser.id === owner.id ? "owner" : "builder",
    };
  });
  registerScienceRoutes(app, { service });
  await app.ready();

  const defaultAdmission = json(await app.inject({
    method: "GET",
    url: "/api/science/workspace-admission",
  })).admission;
  assert.deepEqual(defaultAdmission, {
    workspaceId,
    admitted: false,
    updatedAt: null,
  });
  assert.equal((await app.inject({
    method: "PATCH",
    url: "/api/science/workspace-admission",
    payload: { admitted: true, reason: "", updatedBy: owner.id },
  })).statusCode, 400, "admission PATCH must be strict and require a bounded reason");
  const enabledAdmission = json(await app.inject({
    method: "PATCH",
    url: "/api/science/workspace-admission",
    payload: {
      admitted: true,
      reason: "enable deterministic route verification",
    },
  })).admission;
  assert.equal(enabledAdmission.workspaceId, workspaceId);
  assert.equal(enabledAdmission.admitted, true);
  assert.equal(typeof enabledAdmission.updatedAt, "string");
  assert.deepEqual(
    Object.keys(enabledAdmission).sort(),
    ["admitted", "updatedAt", "workspaceId"],
    "admission projection must omit row id and initiating actor",
  );
  assert.equal(
    json(await app.inject({
      method: "GET",
      url: "/api/science/workspace-admission",
    })).admission.admitted,
    true,
    "route GET must read the persisted decision",
  );

  const invalidStudy = await app.inject({
    method: "GET",
    url: "/api/science/studies/not-a-uuid",
  });
  assert.equal(invalidStudy.statusCode, 400);

  const study = json(await app.inject({
    method: "POST",
    url: "/api/science/studies",
    payload: {
      name: "Cantilever verification",
      description: "Deterministic science route fixture",
      classification: "non_regulated",
    },
  })).study;

  const profile = json(await app.inject({
    method: "POST",
    url: "/api/science/compute-profiles",
    payload: {
      name: "Pinned Python fixture",
      providerKind: "local_container",
      imageDigest: `sha256:${"1".repeat(64)}`,
      kernelName: "python3",
      resourceBounds: {
        cpuMillicores: 2_000,
        memoryMb: 4096,
        gpuCount: 0,
        wallTimeSeconds: 600,
      },
      config: {
        dependencyLock: {
          python: "3.12.4",
          numpy: "2.0.1",
        },
      },
      enabled: true,
    },
  })).profile;
  assert.equal("providerHandle" in profile, false);

  const artifact = json(await app.inject({
    method: "POST",
    url: `/api/science/studies/${study.id}/artifacts`,
    payload: {
      logicalName: "cantilever.ipynb",
      kind: "notebook",
      format: "ipynb",
    },
  })).artifact;

  const bytes = Buffer.from(
    JSON.stringify({
      cells: [],
      metadata: { kernelspec: { name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const uploadIntent = json(await app.inject({
    method: "POST",
    url: `/api/science/artifacts/${artifact.id}/uploads`,
    payload: {
      filename: "cantilever.ipynb",
      expectedSizeBytes: bytes.length,
      expectedSha256: digest,
      mediaType: "application/x-ipynb+json",
    },
  }));
  assert.match(uploadIntent.uploadUrl, /^\/api\/science\/uploads\//);
  assert.equal("tokenHash" in uploadIntent.upload, false);
  assert.equal("quarantineKey" in uploadIntent.upload, false);

  const streamed = await app.inject({
    method: "PUT",
    url: uploadIntent.uploadUrl,
    headers: { "content-type": "application/octet-stream" },
    payload: bytes,
  });
  assert.equal(streamed.statusCode, 200, streamed.body);
  const version = json(await app.inject({
    method: "POST",
    url: `/api/science/uploads/${encodeURIComponent(uploadIntent.uploadToken)}/complete`,
    payload: {
      mediaType: "application/x-ipynb+json",
      metadata: { filename: "cantilever.ipynb" },
    },
  }));
  assert.equal(version.sha256, digest);
  assert.equal("storageKey" in version, false);

  const range = await app.inject({
    method: "GET",
    url: `/api/science/artifact-versions/${version.id}/content`,
    headers: { range: "bytes=0-15" },
  });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers["content-range"], `bytes 0-15/${bytes.length}`);
  assert.equal(
    range.headers["content-disposition"],
    `attachment; filename="science-artifact-${version.id}"`,
  );
  assert.match(range.headers["content-security-policy"], /\bsandbox\b/);
  assert.match(range.headers["content-security-policy"], /\bdefault-src 'none'/);
  assert.equal(range.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(range.rawPayload, bytes.subarray(0, 16));
  const unsatisfiable = await app.inject({
    method: "GET",
    url: `/api/science/artifact-versions/${version.id}/content`,
    headers: { range: `bytes=${bytes.length + 1}-` },
  });
  assert.equal(unsatisfiable.statusCode, 416);
  assert.equal(unsatisfiable.headers["content-range"], `bytes */${bytes.length}`);

  const artifactList = json(await app.inject({
    method: "GET",
    url: `/api/science/studies/${study.id}/artifacts?limit=10`,
  }));
  assert.equal(artifactList.items[0].latestVersion.sha256, digest);
  assert.equal("storageKey" in artifactList.items[0].latestVersion, false);

  const revisedBytes = Buffer.from(
    JSON.stringify({
      cells: [],
      metadata: {
        kernelspec: { name: "python3" },
        revision: "immutable-version-2",
      },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  const revisedDigest = createHash("sha256").update(revisedBytes).digest("hex");
  const revisedUpload = json(await app.inject({
    method: "POST",
    url: `/api/science/artifacts/${artifact.id}/uploads`,
    payload: {
      filename: "cantilever-v2.ipynb",
      expectedSizeBytes: revisedBytes.length,
      expectedSha256: revisedDigest,
      mediaType: "application/x-ipynb+json",
    },
  }));
  assert.equal((await app.inject({
    method: "PUT",
    url: revisedUpload.uploadUrl,
    headers: { "content-type": "application/octet-stream" },
    payload: revisedBytes,
  })).statusCode, 200);
  const revisedVersion = json(await app.inject({
    method: "POST",
    url: `/api/science/uploads/${encodeURIComponent(revisedUpload.uploadToken)}/complete`,
    payload: {
      mediaType: "application/x-ipynb+json",
      metadata: { filename: "cantilever-v2.ipynb" },
      parentVersionId: version.id,
    },
  }));
  assert.equal(revisedVersion.version, 2);
  assert.equal(revisedVersion.parentVersionId, version.id);

  const latestVersionPage = json(await app.inject({
    method: "GET",
    url: `/api/science/artifacts/${artifact.id}/versions?limit=1`,
  }));
  assert.equal(latestVersionPage.items.length, 1);
  assert.equal(latestVersionPage.items[0].id, revisedVersion.id);
  assert.equal(latestVersionPage.nextOffset, 1);
  assert.equal("storageKey" in latestVersionPage.items[0], false);
  const olderVersionPage = json(await app.inject({
    method: "GET",
    url: `/api/science/artifacts/${artifact.id}/versions?offset=1&limit=1`,
  }));
  assert.equal(olderVersionPage.items.length, 1);
  assert.equal(olderVersionPage.items[0].id, version.id);
  assert.equal(olderVersionPage.nextOffset, null);
  assert.equal("storageKey" in olderVersionPage.items[0], false);

  const submitted = json(await app.inject({
    method: "POST",
    url: `/api/science/studies/${study.id}/runs`,
    payload: {
      computeProfileId: profile.id,
      resourceRequest: {
        cpuMillicores: 500,
        memoryMb: 512,
        gpuCount: 0,
        wallTimeSeconds: 60,
      },
      inputs: [{
        artifactVersionId: version.id,
        semanticRole: "notebook",
      }],
      parameters: {
        randomSeeds: { solver: 42 },
        units: { displacement: "m" },
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      },
      idempotencyKey: "route-fixture-run-v1",
    },
  }));
  assert.equal(submitted.run.state, "awaiting_approval");
  assert.equal(submitted.run.providerHandle, null);
  assert.equal("leaseOwner" in submitted.run, false);

  await service.resolveApproval({
    runId: submitted.run.id,
    approvalId: submitted.approvalId,
    approved: true,
    actorId: owner.id,
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await service.getRun(submitted.run.id);
    if (["succeeded", "failed", "cancelled"].includes(current.state)) break;
    await service.tick(current.id, null);
  }

  const dossier = json(await app.inject({
    method: "GET",
    url: `/api/science/runs/${submitted.run.id}`,
  })).run;
  assert.equal(dossier.state, "succeeded");
  assert.equal(dossier.providerHandle, null);
  assert.equal(dossier.inputs.length, 1);
  assert.equal(dossier.outputs.length, 2);
  assert.ok(dossier.recentEvents.length > 0);
  assert.equal(
    JSON.stringify(dossier).includes(artifactRoot.replaceAll("\\", "\\\\")),
    false,
  );

  const manifest = json(await app.inject({
    method: "GET",
    url: `/api/science/runs/${submitted.run.id}/manifest`,
  })).manifest;
  assert.equal(manifest.complete, true);
  assert.equal(manifest.outputs.length, 2);

  const reproduced = json(await app.inject({
    method: "POST",
    url: `/api/science/runs/${submitted.run.id}/reproduce`,
    payload: { idempotencyKey: "route-fixture-reproduction-v1" },
  }));
  assert.equal(reproduced.run.state, "awaiting_approval");
  await service.resolveApproval({
    runId: reproduced.run.id,
    approvalId: reproduced.approvalId,
    approved: true,
    actorId: owner.id,
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await service.getRun(reproduced.run.id);
    if (["succeeded", "failed", "cancelled"].includes(current.state)) break;
    await service.tick(current.id, null);
  }
  const comparison = json(await app.inject({
    method: "POST",
    url: `/api/science/runs/${submitted.run.id}/reproduce`,
    payload: { candidateRunId: reproduced.run.id },
  }));
  assert.equal(comparison.leftRunId, submitted.run.id);
  assert.equal(comparison.rightRunId, reproduced.run.id);
  assert.equal(comparison.comparison.sameInputs, true);
  assert.equal(comparison.comparison.sameParameters, true);
  assert.equal(comparison.comparison.sameEnvironment, true);
  assert.equal(comparison.comparison.sameOutputs, false);
  assert.equal(comparison.comparison.numericallyEquivalent, null);
  assert.equal(comparison.comparison.numericalValidation, null);

  const rendered = json(await app.inject({
    method: "POST",
    url: `/api/science/runs/${submitted.run.id}/render-sessions`,
    payload: { artifactVersionId: dossier.outputs[1].artifactVersionId },
  }));
  assert.match(rendered.renderUrl, new RegExp(`^/api/science/render-sessions/${rendered.session.id}/gateway$`));
  assert.equal("providerHandle" in rendered.session, false);
  assert.equal("audience" in rendered.session, false);

  activeUser = other;
  const foreignGateway = await app.inject({
    method: "GET",
    url: rendered.renderUrl,
  });
  assert.equal(foreignGateway.statusCode, 404);
  activeUser = owner;
  const ownerGateway = await app.inject({
    method: "GET",
    url: rendered.renderUrl,
  });
  assert.equal(ownerGateway.statusCode, 302);
  assert.match(ownerGateway.headers.location, /^\/api\/science\/artifact-versions\//);

  const convergenceArtifact = json(await app.inject({
    method: "POST",
    url: `/api/science/studies/${study.id}/artifacts`,
    payload: {
      logicalName: "accepted-before-revoke.bin",
      kind: "dataset",
      format: "binary",
    },
  })).artifact;
  const convergenceBytes = Buffer.from("accepted upload may converge after admission revoke");
  const convergenceDigest = createHash("sha256")
    .update(convergenceBytes)
    .digest("hex");
  const convergenceIntent = json(await app.inject({
    method: "POST",
    url: `/api/science/artifacts/${convergenceArtifact.id}/uploads`,
    payload: {
      expectedSizeBytes: convergenceBytes.length,
      expectedSha256: convergenceDigest,
      mediaType: "application/octet-stream",
    },
  }));
  const pendingInput = {
    studyId: study.id,
    computeProfileId: profile.id,
    resourceRequest: {
      cpuMillicores: 500,
      memoryMb: 512,
      gpuCount: 0,
      wallTimeSeconds: 60,
    },
    inputs: [{ artifactVersionId: version.id, semanticRole: "notebook" }],
    actorId: owner.id,
  };
  const rejectionCandidate = await service.submitRun({
    ...pendingInput,
    idempotencyKey: "route-reject-after-revoke",
  });
  const blockedApprovalCandidate = await service.submitRun({
    ...pendingInput,
    idempotencyKey: "route-approve-after-revoke",
  });

  const disabledAdmission = json(await app.inject({
    method: "PATCH",
    url: "/api/science/workspace-admission",
    payload: {
      admitted: false,
      reason: "close deterministic route pilot",
    },
  })).admission;
  assert.equal(disabledAdmission.admitted, false);
  assert.equal("updatedBy" in disabledAdmission, false);
  assert.equal(json(await app.inject({
    method: "GET",
    url: `/api/science/studies/${study.id}`,
  })).study.id, study.id);
  assert.equal((await app.inject({
    method: "POST",
    url: "/api/science/studies",
    payload: { name: "blocked after revoke" },
  })).statusCode, 503);
  assert.equal((await app.inject({
    method: "POST",
    url: `/api/science/runs/${submitted.run.id}/reproduce`,
    payload: { idempotencyKey: "blocked-reproduction-after-revoke" },
  })).statusCode, 503);
  assert.equal((await app.inject({
    method: "POST",
    url: `/api/science/runs/${submitted.run.id}/render-sessions`,
    payload: { artifactVersionId: dossier.outputs[1].artifactVersionId },
  })).statusCode, 503);
  assert.equal((await app.inject({
    method: "PATCH",
    url: `/api/science/compute-profiles/${profile.id}`,
    payload: { name: "blocked profile update after revoke" },
  })).statusCode, 503);

  json(await app.inject({
    method: "PUT",
    url: convergenceIntent.uploadUrl,
    headers: { "content-type": "application/octet-stream" },
    payload: convergenceBytes,
  }));
  const convergedVersion = json(await app.inject({
    method: "POST",
    url: `/api/science/uploads/${encodeURIComponent(convergenceIntent.uploadToken)}/complete`,
    payload: {
      mediaType: "application/octet-stream",
      metadata: { acceptedBeforeRevocation: true },
    },
  }));
  assert.equal(convergedVersion.sha256, convergenceDigest);
  const rejectedApproval = await service.resolveApproval({
    runId: rejectionCandidate.run.id,
    approvalId: rejectionCandidate.approval.id,
    approved: false,
    actorId: owner.id,
  });
  assert.notEqual(rejectedApproval.run.state, "queued");
  await assert.rejects(
    () => service.resolveApproval({
      runId: blockedApprovalCandidate.run.id,
      approvalId: blockedApprovalCandidate.approval.id,
      approved: true,
      actorId: owner.id,
    }),
    /not admitted for this workspace/i,
  );
  const cancelled = json(await app.inject({
    method: "POST",
    url: `/api/science/runs/${blockedApprovalCandidate.run.id}/cancel`,
    payload: {
      generation: blockedApprovalCandidate.run.executionGeneration,
      reason: "cleanup after rejected post-revoke approval",
    },
  }));
  assert.equal(cancelled.run.state, "cancelled");
  assert.equal(json(await app.inject({
    method: "DELETE",
    url: `/api/science/render-sessions/${rendered.session.id}`,
  })).session.state, "revoked");
  assert.equal(json(await app.inject({
    method: "GET",
    url: `/api/science/runs/${submitted.run.id}/manifest`,
  })).manifest.complete, true);
  console.log("ok - admission revoke blocks new work while accepted upload, rejection, cancel, render close, reads, and manifest converge");

  assert.ok(audits.some((entry) => entry.action === "science.run.submit"));
  assert.ok(audits.some((entry) => entry.action === "science.render.open"));
  assert.equal(
    audits.some((entry) => JSON.stringify(entry).includes(uploadIntent.uploadToken)),
    false,
  );

  const limitedApp = Fastify({ logger: false });
  limitedApp.decorateRequest("authUser", null);
  limitedApp.addHook("onRequest", async (request) => {
    request.authUser = {
      id: owner.id,
      email: owner.email,
      name: owner.name,
      role: "owner",
    };
  });
  registerScienceRoutes(limitedApp, {
    service: {
      listStudies: async () => ({ items: [], nextOffset: null }),
      createStudy: async (input) => ({
        id: "00000000-0000-4000-8000-000000000099",
        name: input.name,
      }),
    },
    rateLimit: { readPerMinute: 2, writePerMinute: 1 },
  });
  await limitedApp.ready();
  try {
    assert.equal((await limitedApp.inject({
      method: "GET",
      url: "/api/science/studies",
    })).statusCode, 200);
    assert.equal((await limitedApp.inject({
      method: "GET",
      url: "/api/science/studies",
    })).statusCode, 200);
    const limitedRead = await limitedApp.inject({
      method: "GET",
      url: "/api/science/studies",
    });
    assert.equal(limitedRead.statusCode, 429);
    assert.ok(Number(limitedRead.headers["retry-after"]) > 0);
    assert.equal((await limitedApp.inject({
      method: "POST",
      url: "/api/science/studies",
      payload: { name: "first write" },
    })).statusCode, 201);
    assert.equal((await limitedApp.inject({
      method: "POST",
      url: "/api/science/studies",
      payload: { name: "second write" },
    })).statusCode, 429);
  } finally {
    await limitedApp.close();
  }

  console.log(
    "SCIENCE ROUTES PASS: strict validation, workspace admission, immutable version history, streaming upload, " +
    "range reads, sanitized projections, run dossier, manifest comparison, render ownership, rate limits, and audit",
  );
} finally {
  await app.close().catch(() => {});
  await handle.close();
  const resolvedRoot = join(artifactRoot);
  assert.ok(
    resolvedRoot.startsWith(join(tmpdir())),
    "refusing to remove a route fixture outside the system temp directory",
  );
  await rm(resolvedRoot, { recursive: true, force: true });
}
