#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Mission,
  MissionStep,
  SCIENCE_RUN_TRANSITIONS,
  ScienceArtifactVersion,
  ScienceManifest,
  ScienceRunEvent,
  ScienceUpload,
  canTransitionScienceRun,
  canonicalScienceJson,
} from "../packages/shared/dist/index.js";
import {
  HttpComputeProvider,
  HttpRenderSessionProvider,
  createArtifactStoreFromEnv,
  createComputeProvidersFromEnv,
  createRenderProvidersFromEnv,
  compareManifests,
  redactScienceDiagnostic,
} from "../packages/kernel/dist/index.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  study: "00000000-0000-4000-8000-000000000002",
  run: "00000000-0000-4000-8000-000000000003",
  mission: "00000000-0000-4000-8000-000000000004",
  profile: "00000000-0000-4000-8000-000000000005",
  user: "00000000-0000-4000-8000-000000000006",
};
const shaA = "a".repeat(64);

assert.equal(Mission.parse({
  id: ids.mission,
  workspaceId: ids.workspace,
  kind: "science",
  subjectId: ids.run,
  workflowVersionId: null,
  parentMissionId: null,
  status: "queued",
  trigger: null,
  input: {},
  output: null,
  error: null,
  cursor: {},
  cancelRequested: false,
  retryCount: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(),
}).kind, "science");
assert.equal(MissionStep.parse({
  id: "00000000-0000-4000-8000-000000000007",
  missionId: ids.mission,
  nodeId: "science.run",
  kind: "science",
  status: "pending",
  attempt: 0,
  input: {},
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
}).kind, "science");

for (const [from, targets] of Object.entries(SCIENCE_RUN_TRANSITIONS)) {
  for (const target of Object.keys(SCIENCE_RUN_TRANSITIONS)) {
    assert.equal(
      canTransitionScienceRun(from, target),
      targets.includes(target),
      `${from} -> ${target}`,
    );
  }
}
assert.equal(canTransitionScienceRun("draft", "awaiting_approval"), true);
assert.equal(canTransitionScienceRun("draft", "running"), false);
assert.equal(canTransitionScienceRun("succeeded", "running"), false);

const left = { z: 1, a: { y: [3, { b: 2, a: 1 }], x: true } };
const right = { a: { x: true, y: [3, { a: 1, b: 2 }] }, z: 1 };
assert.equal(canonicalScienceJson(left), canonicalScienceJson(right));
assert.equal(
  createHash("sha256").update(canonicalScienceJson(left)).digest("hex"),
  createHash("sha256").update(canonicalScienceJson(right)).digest("hex"),
);
const comparedNumerics = compareManifests(
  { inputs: [], parameters: {}, compute: {}, environment: {}, outputs: [] },
  {
    inputs: [],
    parameters: {},
    compute: {},
    environment: {},
    outputs: [],
    validations: [{
      kind: "numerical-equivalence",
      passed: true,
      metric: "relative-l2",
      tolerance: { relative: 1e-6, absolute: 1e-9 },
      observed: 4.2e-7,
      units: "dimensionless",
      rawPayload: { mustNotEscape: true },
    }],
  },
);
assert.equal(comparedNumerics.numericallyEquivalent, true);
assert.deepEqual(comparedNumerics.numericalValidation, {
  passed: true,
  metric: "relative-l2",
  tolerance: { relative: 1e-6, absolute: 1e-9 },
  observed: 4.2e-7,
  units: "dimensionless",
});
for (const incomplete of [
  { kind: "numerical-equivalence", passed: true, tolerance: 1e-6 },
  { kind: "numerical-equivalence", passed: true, metric: "relative-l2" },
  { kind: "numerical-equivalence", passed: true, metric: "relative-l2", tolerance: {} },
]) {
  const unsupported = compareManifests(
    { validations: [{ ...incomplete, metric: "baseline-only", tolerance: 1 }] },
    { validations: [incomplete] },
  );
  assert.equal(unsupported.numericallyEquivalent, null);
  assert.equal(unsupported.numericalValidation, null);
}

assert.throws(() => ScienceArtifactVersion.parse({
  id: ids.run,
  artifactId: ids.study,
  version: 0,
  status: "ready",
  storageKey: "object",
  sha256: shaA,
  sizeBytes: 1,
  mediaType: "application/octet-stream",
  metadata: {},
  parentVersionId: null,
  createdBy: ids.user,
  createdAt: new Date(),
  readyAt: new Date(),
}));
assert.throws(() => ScienceUpload.parse({
  id: ids.run,
  workspaceId: ids.workspace,
  artifactId: ids.study,
  artifactVersionId: null,
  tokenHash: "raw-token-must-not-parse",
  expectedSizeBytes: 1,
  expectedSha256: shaA,
  quarantineKey: "q/object",
  receivedBytes: 0,
  state: "pending",
  error: null,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
}));

const manifestBase = {
  schemaVersion: 1,
  studyId: ids.study,
  runId: ids.run,
  missionId: ids.mission,
  inputs: [],
  outputs: [],
  codeArtifactVersionId: null,
  sourceRevision: null,
  compute: {
    profileId: ids.profile,
    providerKind: "local_container",
    imageDigest: `sha256:${shaA}`,
    kernelName: "python3",
    resourceBounds: {
      cpuMillicores: 1000,
      memoryMb: 1024,
      gpuCount: 0,
      wallTimeSeconds: 60,
    },
    config: {},
    requestedResources: {
      cpuMillicores: 500,
      memoryMb: 512,
      gpuCount: 0,
      wallTimeSeconds: 30,
    },
    adapterVersion: "test-1",
    dependencyLock: {},
  },
  parameters: {},
  units: {},
  randomSeeds: {},
  environment: {},
  actorId: ids.user,
  approvalIds: [],
  policyIds: [],
  toolCalls: [],
  startedAt: null,
  finishedAt: new Date().toISOString(),
  history: [],
  validations: [],
  limitations: [],
};
assert.throws(() => ScienceManifest.parse({ ...manifestBase, complete: true, gaps: ["missing"] }));
assert.throws(() => ScienceManifest.parse({ ...manifestBase, complete: false, gaps: [] }));
assert.equal(
  ScienceManifest.parse({ ...manifestBase, complete: false, gaps: ["source revision unavailable"] })
    .complete,
  false,
);

assert.throws(() => ScienceRunEvent.parse({
  id: ids.run,
  workspaceId: ids.workspace,
  studyId: ids.study,
  runId: ids.run,
  missionId: ids.mission,
  sequence: 1,
  eventType: "science.run.log",
  executionGeneration: 1,
  state: "running",
  payload: { text: "x".repeat(17_000) },
  createdAt: new Date(),
}));

assert.throws(
  () => createComputeProvidersFromEnv({
    NODE_ENV: "production",
    SCIENCE_RUNTIME_URL: "http://science-runtime:8080",
  }),
  /SCIENCE_RUNTIME_TOKEN/,
);
assert.throws(
  () => createRenderProvidersFromEnv({
    NODE_ENV: "production",
    SCIENCE_RENDER_URL: "http://science-render:8080",
  }),
  /SCIENCE_RENDER_TOKEN/,
);
assert.throws(
  () => createComputeProvidersFromEnv({
    NODE_ENV: "production",
    SCIENCE_RUNTIME_URL: "http://science-runtime:8080",
    SCIENCE_RUNTIME_TOKEN: "runtime-token",
  }),
  /SCIENCE_RUNTIME_ADMISSION=approved/,
);
assert.throws(
  () => createRenderProvidersFromEnv({
    NODE_ENV: "production",
    SCIENCE_RENDER_URL: "http://science-render:8080",
    SCIENCE_RENDER_TOKEN: "render-token",
  }),
  /SCIENCE_RENDER_ADMISSION=approved/,
);
assert.throws(
  () => createArtifactStoreFromEnv({
    SCIENCE_RUNTIME_URL: "http://science-runtime:8090",
  }, "science-contract-signing-secret"),
  /SCIENCE_PUBLIC_BASE_URL/,
);
assert.throws(
  () => createArtifactStoreFromEnv({
    SCIENCE_PUBLIC_BASE_URL: "https://user:password@control.invalid",
  }, "science-contract-signing-secret"),
  /without credentials/,
);
const externallyReachableStore = createArtifactStoreFromEnv({
  SCIENCE_ARTIFACT_ROOT: "apps/server/.science-contract-unused",
  SCIENCE_PUBLIC_BASE_URL: "http://control-plane.internal:43119/puppetmaster",
}, "science-contract-signing-secret");
const externallyReachableReference = await externallyReachableStore.reference(
  "objects/workspace/artifact/checksum",
  {
    versionId: ids.run,
    sha256: shaA,
    size: 1,
    audience: "science-contract-runtime",
    ttlSeconds: 60,
  },
);
assert.match(
  externallyReachableReference.url,
  /^http:\/\/control-plane\.internal:43119\/puppetmaster\/api\/science\/artifact-versions\//,
);
const redactedDiagnostic = redactScienceDiagnostic(
  'Authorization: Bearer auth-secret; {"token":"json-secret"} ' +
  "https://runtime.invalid/failure?sig=signed-secret&key=query-secret " +
  "Bearer standalone-secret C:\\Users\\operator\\private.txt",
);
for (const secret of [
  "auth-secret",
  "json-secret",
  "signed-secret",
  "query-secret",
  "standalone-secret",
  "private.txt",
]) {
  assert.equal(
    redactedDiagnostic.includes(secret),
    false,
    `science diagnostic leaked ${secret}`,
  );
}
assert.match(redactedDiagnostic, /\[REDACTED\]/);
assert.match(redactedDiagnostic, /\[HOST_PATH\]/);

const originalFetch = globalThis.fetch;
try {
  const compute = new HttpComputeProvider({
    kind: "local_container",
    baseUrl: "http://runtime.invalid",
    timeoutMs: 5_000,
  });
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { location: "http://metadata.internal/latest" },
  });
  await assert.rejects(
    compute.quote({
      cpuMillicores: 1,
      memoryMb: 1,
      gpuCount: 0,
      wallTimeSeconds: 1,
    }),
    /redirect|configured origin/i,
  );

  globalThis.fetch = async () => new Response(
    JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    compute.quote({
      cpuMillicores: 1,
      memoryMb: 1,
      gpuCount: 0,
      wallTimeSeconds: 1,
    }),
    /control-response limit/i,
  );

  const outputReceipt = {
    logicalName: "chunked-output.bin",
    kind: "result",
    format: "bin",
    mediaType: "application/octet-stream",
    size: 3,
    sha256: createHash("sha256").update(Buffer.from([1, 2, 3])).digest("hex"),
    reference: "http://runtime.invalid/v1/outputs/chunked-output",
    metadata: {},
  };
  const computeFence = { expectedInstanceId: "runtime-contract-a" };
  globalThis.fetch = async () => new Response(
    new Uint8Array([1, 2, 3]),
    { status: 200, headers: { "content-encoding": "identity" } },
  );
  const chunked = await compute.openOutput(outputReceipt, computeFence);
  let chunkedBytes = 0;
  for await (const chunk of chunked) chunkedBytes += chunk.byteLength;
  assert.equal(chunkedBytes, outputReceipt.size);

  globalThis.fetch = async () => new Response(
    new Uint8Array([1, 2, 3]),
    {
      status: 200,
      headers: {
        "content-encoding": "identity",
        "content-length": "not-a-number",
      },
    },
  );
  await assert.rejects(
    compute.openOutput(outputReceipt, computeFence),
    /size differs from its receipt/i,
  );

  let missingComputeFenceFetched = false;
  globalThis.fetch = async () => {
    missingComputeFenceFetched = true;
    throw new Error("an unfenced compute operation must not reach fetch");
  };
  await assert.rejects(
    compute.status("run-remote-a", 1, undefined),
    /instance fence is required/i,
  );
  assert.equal(missingComputeFenceFetched, false);

  const computeSubmission = {
    runId: ids.run,
    missionId: ids.mission,
    generation: 1,
    idempotencyKey: "science-contract:remote-a:1",
    submittedAt: new Date().toISOString(),
    imageDigest: `sha256:${shaA}`,
    kernel: "python3",
    parameters: {},
    resources: {
      cpuMillicores: 1,
      memoryMb: 1,
      gpuCount: 0,
      wallTimeSeconds: 1,
    },
    inputs: [],
  };
  const computeOperations = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("x-science-provider-instance"),
      computeFence.expectedInstanceId,
      `compute operation ${url.pathname} omitted its admitted instance`,
    );
    const operation = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    computeOperations.push(operation);
    if (url.pathname === "/v1/runs" && init?.method === "POST") {
      return Response.json({ handle: "run-remote-a" }, { status: 201 });
    }
    if (url.pathname === "/v1/runs/run-remote-a" && !init?.method) {
      return Response.json({ state: "running", progress: 0.5 });
    }
    if (url.pathname === "/v1/runs/run-remote-a/cancel" && init?.method === "POST") {
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/v1/runs/run-remote-a/outputs" && !init?.method) {
      return Response.json({ outputs: [outputReceipt] });
    }
    if (url.pathname === "/v1/outputs/chunked-output" && !init?.method) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-encoding": "identity",
          "content-length": "3",
        },
      });
    }
    throw new Error(`unexpected compute contract request ${operation}`);
  };
  const remoteSubmit = await compute.submit(computeSubmission, computeFence);
  assert.equal(remoteSubmit.handle, "run-remote-a");
  assert.equal(
    (await compute.status(remoteSubmit.handle, 1, computeFence)).state,
    "running",
  );
  assert.equal(
    (await compute.cancel(remoteSubmit.handle, 1, computeFence)).accepted,
    true,
  );
  assert.equal(
    (await compute.collectOutputs(remoteSubmit.handle, 1, computeFence)).length,
    1,
  );
  let fencedOutputBytes = 0;
  for await (const chunk of await compute.openOutput(outputReceipt, computeFence)) {
    fencedOutputBytes += chunk.byteLength;
  }
  assert.equal(fencedOutputBytes, 3);
  assert.deepEqual(computeOperations, [
    "POST /v1/runs",
    "GET /v1/runs/run-remote-a?generation=1",
    "POST /v1/runs/run-remote-a/cancel",
    "GET /v1/runs/run-remote-a/outputs?generation=1",
    "GET /v1/outputs/chunked-output",
  ]);

  const productionCompute = new HttpComputeProvider({
    kind: "local_container",
    baseUrl: "http://runtime.invalid",
    timeoutMs: 5_000,
    requiredExecutionMode: "isolated_oci",
  });
  globalThis.fetch = async () => Response.json({
    ok: true,
    version: "runtime-without-instance.v1",
    executionMode: "isolated_oci",
    executesUserCode: true,
  });
  const missingInstanceHealth = await productionCompute.health();
  assert.equal(missingInstanceHealth.ok, false);
  assert.equal(
    missingInstanceHealth.instanceId,
    undefined,
    "failed health must not synthesize an operation identity from adapter configuration",
  );

  let productionMutationCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        version: "fixture.v1",
        instanceId: computeFence.expectedInstanceId,
        executionMode: "contract_fixture",
        executesUserCode: false,
      });
    }
    productionMutationCalls++;
    throw new Error("unadmitted production compute reached a mutation");
  };
  const refusedProductionHealth = await productionCompute.health();
  assert.equal(refusedProductionHealth.ok, false);
  await assert.rejects(
    productionCompute.submit(computeSubmission, computeFence),
    /not admitted|contract fixture/i,
  );
  assert.equal(productionMutationCalls, 0);

  globalThis.fetch = async () => new Response(
    "Authorization: Bearer runtime-error-secret?sig=signed-error-secret",
    { status: 500 },
  );
  await assert.rejects(
    compute.quote({
      cpuMillicores: 1,
      memoryMb: 1,
      gpuCount: 0,
      wallTimeSeconds: 1,
    }),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.equal(error.message.includes("runtime-error-secret"), false);
      assert.equal(error.message.includes("signed-error-secret"), false);
      return true;
    },
  );

  const render = new HttpRenderSessionProvider({
    kind: "trame",
    baseUrl: "http://render.invalid",
    timeoutMs: 5_000,
  });
  const renderFence = { expectedInstanceId: "render-fixture-a" };
  const renderOperations = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        version: "render-fixture.v1",
        instanceId: "render-fixture-a",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("x-science-provider-instance"),
      renderFence.expectedInstanceId,
      `render operation ${url.pathname} omitted its admitted instance`,
    );
    const operation = `${init?.method ?? "GET"} ${url.pathname}`;
    renderOperations.push(operation);
    if (url.pathname === "/v1/render-sessions" && init?.method === "POST") {
      return new Response(JSON.stringify({
        state: "ready",
        mode: "remote",
        handle: "render-session-a",
        instanceId: "render-fixture-a",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/v1/render-sessions/render-session-a" && !init?.method) {
      return Response.json({
        state: "ready",
        mode: "remote",
        upstreamUrl: "http://render.invalid/session/render-session-a",
      });
    }
    if (
      url.pathname === "/v1/render-sessions/render-session-a/renew" &&
      init?.method === "POST"
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname === "/v1/render-sessions/render-session-a" &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected render contract request ${operation}`);
  };
  const renderHealth = await render.health();
  assert.equal(renderHealth.ok, true);
  assert.equal(renderHealth.instanceId, "render-fixture-a");
  const renderLaunch = await render.start({
    sessionId: ids.run,
    workspaceId: ids.workspace,
    ownerId: ids.user,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    gatewayToken: "contract-gateway-token",
    source: {
      runId: ids.run,
      artifactVersionId: ids.study,
      format: "vtk",
      mediaType: "model/vnd.vtk",
      size: 1,
      sha256: shaA,
      reference: {
        url: "http://control.invalid/artifact",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sha256: shaA,
        size: 1,
        method: "GET",
      },
    },
  }, renderFence);
  assert.equal(renderLaunch.instanceId, "render-fixture-a");
  assert.equal(
    (await render.status(renderLaunch.providerHandle, renderFence)).state,
    "ready",
  );
  await render.renew(
    renderLaunch.providerHandle,
    new Date(Date.now() + 120_000).toISOString(),
    renderFence,
  );
  await render.close(renderLaunch.providerHandle, renderFence);
  assert.deepEqual(renderOperations, [
    "POST /v1/render-sessions",
    "GET /v1/render-sessions/render-session-a",
    "POST /v1/render-sessions/render-session-a/renew",
    "DELETE /v1/render-sessions/render-session-a",
  ]);

  globalThis.fetch = async () => new Response(null, { status: 202 });
  await assert.rejects(
    render.close(renderLaunch.providerHandle, renderFence),
    /render launcher returned 202/i,
    "accepted is not proof that a remote renderer has stopped",
  );

  let missingRenderFenceFetched = false;
  globalThis.fetch = async () => {
    missingRenderFenceFetched = true;
    throw new Error("an unfenced render operation must not reach fetch");
  };
  await assert.rejects(
    render.status("render-session-a", undefined),
    /immutable instance ID/i,
  );
  assert.equal(missingRenderFenceFetched, false);

  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/health")) {
      return new Response(JSON.stringify({
        ok: true,
        version: "render-fixture.v1",
        instanceId: "invalid instance id",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      state: "ready",
      mode: "remote",
      handle: "render-session-b",
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const invalidRenderHealth = await render.health();
  assert.equal(invalidRenderHealth.ok, false);
  assert.match(invalidRenderHealth.instanceId, /^[a-z0-9._-]{1,100}$/i);
  await assert.rejects(
    render.start({
      sessionId: ids.run,
      workspaceId: ids.workspace,
      ownerId: ids.user,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      gatewayToken: "contract-gateway-token",
      source: {
        runId: ids.run,
        artifactVersionId: ids.study,
        format: "vtk",
        mediaType: "model/vnd.vtk",
        size: 1,
        sha256: shaA,
        reference: {
          url: "http://control.invalid/artifact",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          sha256: shaA,
          size: 1,
          method: "GET",
        },
      },
    }, { expectedInstanceId: "render-fixture-a" }),
    /immutable instance ID/i,
  );

  globalThis.fetch = async () => new Response(null, {
    status: 307,
    headers: { location: "http://metadata.internal/latest" },
  });
  await assert.rejects(
    render.status("session", { expectedInstanceId: "render-fixture-a" }),
    /redirect|configured origin/i,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("science contracts: ok");
