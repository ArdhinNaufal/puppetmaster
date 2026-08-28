import assert from "node:assert/strict";
import {
  JUPYTER_ENTERPRISE_GATEWAY_CHANNEL_BOUNDS,
  JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_BLOCKERS,
  JUPYTER_ENTERPRISE_GATEWAY_MAX_RECOVERY_HANDLE_CHARACTERS,
  JupyterEnterpriseGatewayPrerequisiteProvider,
  createComputeProvidersFromEnv,
  createJupyterEnterpriseGatewayPrerequisiteFromEnv,
  createJupyterEnterpriseGatewayRecoveryHandle,
} from "../packages/kernel/dist/index.js";

const instanceId = "jeg-contract-deployment-a";
const token = "jeg.Contract_Token+123/==";
const digest = `sha256:${"a".repeat(64)}`;
const image = `registry.invalid/science/kernel-python@${digest}`;
const kernelName = "science-python";
const kernelId = "11111111-1111-4111-8111-111111111111";
const otherKernelId = "22222222-2222-4222-8222-222222222222";
const missingKernelId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const missingRunId = "55555555-5555-4555-8555-555555555555";
const fence = { expectedInstanceId: instanceId };

const allowedKernelImages = { [kernelName]: image };

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      "x-science-gateway-instance": instanceId,
      ...extraHeaders,
    },
  });
}

function assertRequestBoundary(input, init) {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://gateway.invalid");
  assert.match(url.pathname, /^\/jeg\/api(?:\/|$)/);
  assert.equal(url.searchParams.has("token"), false, "JEG token must not enter a query string");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), `token ${token}`);
  assert.equal(headers.get("x-science-expected-gateway-instance"), instanceId);
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("proxy-authorization"), false);
  assert.equal(init?.redirect, "manual");
  assert.ok(init?.signal instanceof AbortSignal);
}

function apiInfo() {
  return json({ version: "2.14.0", gateway_version: "3.3.0" });
}

function kernelspecs() {
  return json({
    default: kernelName,
    kernelspecs: {
      [kernelName]: {
        name: kernelName,
        spec: {
          argv: ["python", "launcher.py"],
          display_name: "Science Python",
          language: "python",
          metadata: {
            process_proxy: {
              class_name:
                "enterprise_gateway.services.processproxies.k8s.KubernetesProcessProxy",
              config: { image_name: image },
            },
          },
        },
        resources: {},
      },
    },
  });
}

function makeProvider(fetchImpl) {
  return new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://gateway.invalid/jeg/",
    authToken: token,
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages,
    timeoutMs: 5_000,
    fetchImpl,
  });
}

assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "http://gateway.invalid",
    authToken: token,
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages,
  }),
  /HTTPS/,
);
assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://user:password@gateway.invalid/?token=secret",
    authToken: token,
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages,
  }),
  /credentials|query|fragment/,
);
assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://gateway.invalid",
    authToken: "short",
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages,
  }),
  /auth token/,
);
assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://gateway.invalid",
    authToken: "unsafe-token-value\"\\",
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages,
  }),
  /token68/,
  "quote/backslash tokens must be rejected instead of creating escaped-secret variants",
);
assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://gateway.invalid",
    authToken: token,
    admission: "prerequisite-only",
    expectedInstanceId: "contains spaces",
    allowedKernelImages,
  }),
  /instance ID/,
);
assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://gateway.invalid",
    authToken: token,
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages: { [kernelName]: "registry.invalid/science/kernel-python:latest" },
  }),
  /immutable OCI digest/,
);
assert.throws(
  () => new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl: "https://gateway.invalid",
    authToken: token,
    admission: "prerequisite-only",
    expectedInstanceId: instanceId,
    allowedKernelImages: {},
  }),
  /1-32 entries/,
);

assert.equal(
  createJupyterEnterpriseGatewayPrerequisiteFromEnv({
    SCIENCE_ENABLED: "0",
    SCIENCE_JEG_URL: "not a URL",
  }),
  null,
  "disabled Science must make stale JEG configuration inert",
);
assert.throws(
  () => createJupyterEnterpriseGatewayPrerequisiteFromEnv({
    SCIENCE_ENABLED: "1",
    SCIENCE_JEG_URL: "https://gateway.invalid/jeg/",
    SCIENCE_JEG_TOKEN: token,
    SCIENCE_JEG_INSTANCE_ID: instanceId,
    SCIENCE_JEG_KERNEL_IMAGES_JSON: JSON.stringify(allowedKernelImages),
  }),
  /ADMISSION=prerequisite-only/,
);
assert.throws(
  () => createJupyterEnterpriseGatewayPrerequisiteFromEnv({
    SCIENCE_ENABLED: "1",
    SCIENCE_JEG_URL: "https://gateway.invalid/jeg/",
    SCIENCE_JEG_TOKEN: token,
    SCIENCE_JEG_INSTANCE_ID: instanceId,
    SCIENCE_JEG_KERNEL_IMAGES_JSON: JSON.stringify(allowedKernelImages),
    SCIENCE_JEG_ADMISSION: "approved",
  }),
  /prerequisite-only|NO-GO/,
);
const prerequisiteFromEnv = createJupyterEnterpriseGatewayPrerequisiteFromEnv({
  SCIENCE_ENABLED: "1",
  SCIENCE_JEG_URL: "https://gateway.invalid/jeg/",
  SCIENCE_JEG_TOKEN: token,
  SCIENCE_JEG_INSTANCE_ID: instanceId,
  SCIENCE_JEG_KERNEL_IMAGES_JSON: JSON.stringify(allowedKernelImages),
  SCIENCE_JEG_ADMISSION: "prerequisite-only",
  SCIENCE_JEG_TIMEOUT_MS: "5000",
});
assert.ok(prerequisiteFromEnv instanceof JupyterEnterpriseGatewayPrerequisiteProvider);
assert.equal(
  createComputeProvidersFromEnv({
    SCIENCE_ENABLED: "1",
    SCIENCE_JEG_URL: "https://gateway.invalid/jeg/",
    SCIENCE_JEG_TOKEN: token,
    SCIENCE_JEG_INSTANCE_ID: instanceId,
    SCIENCE_JEG_KERNEL_IMAGES_JSON: JSON.stringify(allowedKernelImages),
    SCIENCE_JEG_ADMISSION: "prerequisite-only",
  }).list().some((entry) => entry.kind === "jupyter_enterprise_gateway"),
  false,
  "the prerequisite must never be registered as executable compute",
);

let requestCount = 0;
let mutationCount = 0;
let mode = "probe";
const hostileExecutionState = `${token}\r\nforged-diagnostic`;
const provider = makeProvider(async (input, init) => {
  requestCount++;
  assertRequestBoundary(input, init);
  const url = new URL(String(input));
  if (init?.method && init.method !== "GET") mutationCount++;
  if (url.pathname === "/jeg/api") return apiInfo();
  if (url.pathname === "/jeg/api/kernelspecs") return kernelspecs();
  if (url.pathname === `/jeg/api/kernels/${kernelId}`) {
    if (init?.method === "DELETE") return new Response(null, {
      status: 204,
      headers: { "x-science-gateway-instance": instanceId },
    });
    return json({
      id: kernelId,
      name: kernelName,
      execution_state:
        mode === "status-dead"
          ? "dead"
          : mode === "status-hostile"
            ? hostileExecutionState
            : "idle",
      connections: 0,
      last_activity: "2026-08-14T00:00:00.000Z",
    });
  }
  if (url.pathname === "/jeg/api/kernels") {
    return json([
      {
        id: kernelId,
        name: kernelName,
        execution_state: mode === "discovery-hostile" ? hostileExecutionState : "busy",
      },
      { id: otherKernelId, name: "other-tenant", execution_state: "idle" },
    ]);
  }
  throw new Error(`unexpected JEG request ${init?.method ?? "GET"} ${url.pathname}`);
});

const probe = await provider.probe();
assert.equal(probe.prerequisiteOk, true);
assert.equal(probe.admittedForExecution, false);
assert.equal(probe.gatewayVersion, "3.3.0");
assert.equal(probe.kernelImages[kernelName], image);
assert.equal(probe.blockers.length, JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_BLOCKERS.length);
const health = await provider.health();
assert.equal(health.ok, false);
assert.equal(health.executesUserCode, false);
assert.equal(health.instanceId, instanceId);
assert.match(health.detail, /NO-GO/);
const quote = await provider.quote({
  cpuMillicores: 1000,
  memoryMb: 1024,
  gpuCount: 0,
  wallTimeSeconds: 60,
});
assert.equal(quote.available, false);

const beforeSubmit = requestCount;
await assert.rejects(
  provider.submit({
    runId,
    missionId: "66666666-6666-4666-8666-666666666666",
    generation: 1,
    idempotencyKey: "jeg-contract:run:1",
    submittedAt: "2026-08-14T00:00:00.000Z",
    imageDigest: digest,
    kernel: kernelName,
    parameters: {},
    resources: {
      cpuMillicores: 1000,
      memoryMb: 1024,
      gpuCount: 0,
      wallTimeSeconds: 60,
    },
    inputs: [],
  }, fence),
  /NO-GO|bridge is absent/,
);
assert.equal(requestCount, beforeSubmit, "submit must reject before any network request");
assert.equal(mutationCount, 0, "submit must not start a kernel");

const handle = createJupyterEnterpriseGatewayRecoveryHandle({
  kernelId,
  runId,
  generation: 1,
  idempotencyKey: "jeg-contract:run:1",
  kernelName,
});
const missingHandle = createJupyterEnterpriseGatewayRecoveryHandle({
  kernelId: missingKernelId,
  runId: missingRunId,
  generation: 2,
  idempotencyKey: "jeg-contract:run:2",
  kernelName,
});
const expectedClaim = {
  handle,
  runId,
  generation: 1,
  kernelId,
  kernelName,
};
const missingClaim = {
  handle: missingHandle,
  runId: missingRunId,
  generation: 2,
  kernelId: missingKernelId,
  kernelName,
};
assert.ok(handle.length <= JUPYTER_ENTERPRISE_GATEWAY_MAX_RECOVERY_HANDLE_CHARACTERS);

const maxKernelName = `k${"a".repeat(99)}`;
const maxGenerationHandle = createJupyterEnterpriseGatewayRecoveryHandle({
  kernelId: "77777777-7777-4777-8777-777777777777",
  runId: "88888888-8888-4888-8888-888888888888",
  generation: Number.MAX_SAFE_INTEGER,
  idempotencyKey: "x".repeat(1_000),
  kernelName: maxKernelName,
});
assert.equal(
  maxGenerationHandle.length,
  JUPYTER_ENTERPRISE_GATEWAY_MAX_RECOVERY_HANDLE_CHARACTERS,
  "maximum-name compact handle must reach its documented bound exactly",
);
const worstCaseOuterHandle =
  `science-compute:jupyter_enterprise_gateway:${"i".repeat(100)}:${maxGenerationHandle}`;
assert.ok(
  worstCaseOuterHandle.length <= 500,
  `worst-case composed compute handle was ${worstCaseOuterHandle.length} characters`,
);
const maxRoundTripProvider = new JupyterEnterpriseGatewayPrerequisiteProvider({
  baseUrl: "https://gateway.invalid/jeg/",
  authToken: token,
  admission: "prerequisite-only",
  expectedInstanceId: instanceId,
  allowedKernelImages: {
    [maxKernelName]: `registry.invalid/science/max-kernel@sha256:${"d".repeat(64)}`,
  },
  timeoutMs: 5_000,
  fetchImpl: async (input, init) => {
    assertRequestBoundary(input, init);
    assert.match(String(input), /77777777-7777-4777-8777-777777777777$/);
    return json({
      id: "77777777-7777-4777-8777-777777777777",
      name: maxKernelName,
      execution_state: "idle",
    });
  },
});
assert.equal(
  (await maxRoundTripProvider.status(
    maxGenerationHandle,
    Number.MAX_SAFE_INTEGER,
    fence,
  )).state,
  "running",
  "maximum generation/name must round-trip through compact handle decoding",
);

const beforeBadFence = requestCount;
await assert.rejects(
  provider.status(handle, 1, { expectedInstanceId: "replacement-gateway" }),
  /instance fence/,
);
await assert.rejects(provider.status(handle, 2, fence), /generation mismatch/);
assert.equal(requestCount, beforeBadFence, "bad fence/generation must reject before fetch");

const running = await provider.status(handle, 1, fence);
assert.equal(running.state, "running");
assert.match(running.message, /not execution-completion evidence/);
mode = "status-dead";
assert.equal((await provider.status(handle, 1, fence)).state, "failed");
mode = "status-hostile";
await assert.rejects(provider.status(handle, 1, fence), (error) => {
  assert.match(error.message, /invalid kernel model|unsupported kernel execution state/);
  assert.equal(error.message.includes(token), false);
  assert.equal(/[\r\n]/.test(error.message), false);
  assert.ok(error.message.length < 200);
  return true;
});
mode = "probe";

const beforeInvalidDiscovery = requestCount;
await assert.rejects(
  provider.discover([{ ...expectedClaim, generation: 2 }], fence),
  /generation mismatch/,
);
await assert.rejects(
  provider.discover([{ ...expectedClaim, runId: missingRunId }], fence),
  /claim failed recovery-handle correlation/,
);
await assert.rejects(
  provider.discover([{ ...expectedClaim, kernelId: missingKernelId }], fence),
  /claim failed recovery-handle correlation/,
);
await assert.rejects(
  provider.discover([{ ...expectedClaim, kernelName: "other-tenant" }], fence),
  /claim failed recovery-handle correlation/,
);
await assert.rejects(
  provider.discover([expectedClaim, { ...expectedClaim }], fence),
  /duplicate recovery handle/,
);

const duplicateKernelHandle = createJupyterEnterpriseGatewayRecoveryHandle({
  kernelId,
  runId: missingRunId,
  generation: 2,
  idempotencyKey: "jeg-contract:duplicate-kernel",
  kernelName,
});
await assert.rejects(
  provider.discover([
    expectedClaim,
    {
      handle: duplicateKernelHandle,
      runId: missingRunId,
      generation: 2,
      kernelId,
      kernelName,
    },
  ], fence),
  /duplicate kernel identity/,
);

const duplicateRunHandle = createJupyterEnterpriseGatewayRecoveryHandle({
  kernelId: otherKernelId,
  runId,
  generation: 2,
  idempotencyKey: "jeg-contract:duplicate-run",
  kernelName,
});
await assert.rejects(
  provider.discover([
    expectedClaim,
    {
      handle: duplicateRunHandle,
      runId,
      generation: 2,
      kernelId: otherKernelId,
      kernelName,
    },
  ], fence),
  /duplicate run identity/,
);
assert.equal(
  requestCount,
  beforeInvalidDiscovery,
  "mismatched and duplicate discovery claims must reject before fetch",
);

const discovery = await provider.discover([expectedClaim, missingClaim], fence);
assert.equal(discovery.managed.length, 1);
assert.equal(discovery.managed[0].expected.runId, runId);
assert.equal(discovery.missing.length, 1);
assert.equal(discovery.missing[0].runId, missingRunId);
assert.equal(discovery.visibleButUnowned.length, 1);
assert.equal(discovery.visibleButUnowned[0].kernelId, otherKernelId);
mode = "discovery-hostile";
await assert.rejects(provider.discover([expectedClaim], fence), (error) => {
  assert.match(error.message, /invalid kernel model/);
  assert.equal(error.message.includes(token), false);
  assert.equal(/[\r\n]/.test(error.message), false);
  return true;
});
mode = "probe";

assert.equal((await provider.cancel(handle, 1, fence)).accepted, true);
assert.equal(mutationCount, 1, "only exact persisted-handle cancellation may mutate");

const beforeOutputs = requestCount;
await assert.rejects(provider.collectOutputs(handle, 1, fence), /NO-GO|no checksummed/);
await assert.rejects(provider.openOutput({
  reference: "https://untrusted.invalid/output",
  logicalName: "output.bin",
  kind: "result",
  format: "bin",
  mediaType: "application/octet-stream",
  sha256: "b".repeat(64),
  size: 1,
  metadata: {},
}, fence), /NO-GO|no scoped/);
assert.equal(requestCount, beforeOutputs, "output methods must reject before fetch");

const oldGateway = makeProvider(async () => apiInfo().status === 200
  ? json({ gateway_version: "3.2.2", version: "2.14.0" })
  : apiInfo());
await assert.rejects(oldGateway.probe(), /at least 3\.3\.0/);

for (const prereleaseVersion of [
  "3.3.0-alpha.1",
  "3.3.0.dev0",
  "v3.3.0-rc.1",
  "3.4.0-beta.1",
]) {
  const prereleaseGateway = makeProvider(async () => json({
    gateway_version: prereleaseVersion,
    version: "2.14.0",
  }));
  await assert.rejects(
    prereleaseGateway.probe(),
    /at least 3\.3\.0/,
    `${prereleaseVersion} must not satisfy the stable release floor`,
  );
}

const stableBuildGateway = makeProvider(async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/jeg/api") {
    return json({ gateway_version: "3.3.0+vendor.7", version: "2.14.0" });
  }
  if (url.pathname === "/jeg/api/kernelspecs") return kernelspecs();
  if (url.pathname === "/jeg/api/kernels") return json([]);
  throw new Error(`unexpected stable-build request ${url.pathname}`);
});
assert.equal(
  (await stableBuildGateway.probe()).gatewayVersion,
  "3.3.0+vendor.7",
  "build metadata must not lower a stable release",
);

const driftedInstance = makeProvider(async () => Response.json({
  gateway_version: "3.3.0",
  version: "2.14.0",
}, { headers: { "x-science-gateway-instance": "replacement-gateway" } }));
await assert.rejects(driftedInstance.probe(), /instance fence/);

const redirectingGateway = makeProvider(async () => new Response(null, {
  status: 302,
  headers: {
    location: "https://metadata.invalid/latest",
    "x-science-gateway-instance": instanceId,
  },
}));
await assert.rejects(redirectingGateway.probe(), /redirect|escaped/i);

const changedImageGateway = makeProvider(async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/jeg/api") return apiInfo();
  const response = kernelspecs();
  const body = await response.json();
  body.kernelspecs[kernelName].spec.metadata.process_proxy.config.image_name =
    `registry.invalid/science/kernel-python@sha256:${"c".repeat(64)}`;
  return json(body);
});
await assert.rejects(changedImageGateway.probe(), /image identity changed/);

const oversizedGateway = makeProvider(async () => new Response(
  JSON.stringify({ gateway_version: "3.3.0", padding: "x".repeat(70 * 1024) }),
  {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-science-gateway-instance": instanceId,
    },
  },
));
await assert.rejects(oversizedGateway.probe(), /control-response limit/);

const secretErrorGateway = makeProvider(async () => new Response(
  `Authorization: token ${token}; token=${token}`,
  {
    status: 500,
    headers: { "x-science-gateway-instance": instanceId },
  },
));
await assert.rejects(secretErrorGateway.probe(), (error) => {
  assert.equal(error.message.includes(token), false);
  assert.match(error.message, /\[REDACTED\]/);
  return true;
});

const jsonSecretErrorGateway = makeProvider(async () => new Response(
  JSON.stringify({ authorizationEcho: token }),
  {
    status: 500,
    headers: { "x-science-gateway-instance": instanceId },
  },
));
await assert.rejects(jsonSecretErrorGateway.probe(), (error) => {
  assert.equal(error.message.includes(token), false);
  assert.match(error.message, /\[REDACTED\]/);
  return true;
});

const lowerPercentToken = encodeURIComponent(token).replace(
  /%[0-9A-F]{2}/g,
  (triplet) => triplet.toLowerCase(),
);
const encodedSecretErrorGateway = makeProvider(async () => new Response(
  `echo=${lowerPercentToken}`,
  {
    status: 500,
    headers: { "x-science-gateway-instance": instanceId },
  },
));
await assert.rejects(encodedSecretErrorGateway.probe(), (error) => {
  assert.equal(error.message.includes(token), false);
  assert.equal(error.message.toLowerCase().includes(lowerPercentToken.toLowerCase()), false);
  assert.match(error.message, /\[REDACTED\]/);
  return true;
});

const longToken = `${"x".repeat(2_000)}+/==`;
const longTokenGateway = new JupyterEnterpriseGatewayPrerequisiteProvider({
  baseUrl: "https://gateway.invalid/jeg/",
  authToken: longToken,
  admission: "prerequisite-only",
  expectedInstanceId: instanceId,
  allowedKernelImages,
  timeoutMs: 5_000,
  fetchImpl: async () => new Response(`echo=${longToken}`, {
    status: 500,
    headers: { "x-science-gateway-instance": instanceId },
  }),
});
await assert.rejects(longTokenGateway.probe(), (error) => {
  assert.equal(error.message.includes(longToken.slice(0, 500)), false);
  assert.match(error.message, /\[REDACTED\]/);
  return true;
});

assert.equal(JUPYTER_ENTERPRISE_GATEWAY_CHANNEL_BOUNDS.maxLogLinesPerStatus, 32);
assert.equal(JUPYTER_ENTERPRISE_GATEWAY_CHANNEL_BOUNDS.maxLogLineCharacters, 2_000);
assert.ok(JUPYTER_ENTERPRISE_GATEWAY_CHANNEL_BOUNDS.maxMessageBytes <= 1024 * 1024);
assert.ok(JUPYTER_ENTERPRISE_GATEWAY_CHANNEL_BOUNDS.connectTimeoutMs <= 15_000);

console.log(
  "SCIENCE JEG PREREQUISITE PASS: authenticated HTTPS, >=3.3.0, exact instance fence, " +
  "immutable kernelspec/image allowlist, bounded control responses, recovery correlation, " +
  "read-only orphan inventory, exact-handle cancellation, and secret redaction",
);
console.log(
  "LIVE JEG EXECUTION: NOT PROVEN; submit/channels/output collection remain fail-closed and " +
  "the prerequisite is not registered as ComputeProvider",
);
