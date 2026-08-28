#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertScienceProductionDeploymentEnv,
  createArtifactStoreFromEnv,
  createComputeProvidersFromEnv,
  createRenderProvidersFromEnv,
  createSingleFlightTtlCache,
  resolveScienceRuntimeConfig,
} from "../packages/kernel/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const productionReadOnly = {
  NODE_ENV: "production",
  SCIENCE_ENABLED: "1",
  SCIENCE_READ_ONLY: "1",
  SCIENCE_SIGNING_SECRET: "deployment-verifier-signing-secret",
  DATABASE_URL: "postgres://science:science@postgres.invalid:5432/science",
  REDIS_URL: "redis://redis.invalid:6379",
  SCIENCE_STORAGE_DRIVER: "s3",
  SCIENCE_S3_ENDPOINT: "https://objects.invalid",
  SCIENCE_S3_REGION: "us-east-1",
  SCIENCE_S3_BUCKET: "science-release-gate",
  SCIENCE_S3_ACCESS_KEY_ID: "deployment-verifier-access",
  SCIENCE_S3_SECRET_ACCESS_KEY: "deployment-verifier-secret",
};

function without(source, name) {
  const copy = { ...source };
  delete copy[name];
  return copy;
}

assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv({
    NODE_ENV: "production",
    SCIENCE_ENABLED: "0",
  }));
assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv({
    NODE_ENV: "test",
    SCIENCE_ENABLED: "1",
  }));
const developmentProviders = createComputeProvidersFromEnv({
  NODE_ENV: "test",
  SCIENCE_ENABLED: "1",
});
assert.deepEqual(developmentProviders.list(), [
  { kind: "local_container", version: "1.0.0" },
]);
console.log("ok - disabled and non-production Science retain local fallback behavior");

for (const [name, env] of [
  ["SCIENCE_ENABLED", { SCIENCE_ENABLED: "maybe" }],
  ["SCIENCE_READ_ONLY", { SCIENCE_ENABLED: "1", SCIENCE_READ_ONLY: "treu" }],
  ["SCIENCE_SUBMISSIONS_DISABLED", {
    SCIENCE_ENABLED: "1",
    SCIENCE_READ_ONLY: "0",
    SCIENCE_SUBMISSIONS_DISABLED: "flase",
  }],
]) {
  assert.throws(
    () => resolveScienceRuntimeConfig(env),
    new RegExp(name + ".*must be a boolean"),
  );
}
for (const falseValue of ["0", "false", "no", "off", "disabled"]) {
  assert.equal(resolveScienceRuntimeConfig({
    SCIENCE_ENABLED: "1",
    SCIENCE_READ_ONLY: falseValue,
  }).submissionsEnabled, true);
}
const configuredUploadStreamLimits = resolveScienceRuntimeConfig({
  SCIENCE_ENABLED: "1",
  SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS: "90000",
  SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS: "12000",
  SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS: "7",
});
assert.equal(configuredUploadStreamLimits.externalUploadAbsoluteTimeoutMs, 90_000);
assert.equal(configuredUploadStreamLimits.externalUploadIdleTimeoutMs, 12_000);
assert.equal(
  configuredUploadStreamLimits.maxConcurrentExternalUploadStreamsPerWorkspace,
  7,
);
for (const [name, value] of [
  ["SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS", "0"],
  ["SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS", "not-an-integer"],
  ["SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS", "129"],
]) {
  assert.throws(
    () => resolveScienceRuntimeConfig({ SCIENCE_ENABLED: "1", [name]: value }),
    new RegExp(name),
  );
}
assert.throws(
  () => resolveScienceRuntimeConfig({
    SCIENCE_ENABLED: "1",
    SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS: "1000",
    SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS: "1001",
  }),
  /SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS.*less than or equal/i,
);
const disabledWithStaleConfiguration = {
  NODE_ENV: "production",
  SCIENCE_ENABLED: "0",
  SCIENCE_READ_ONLY: "stale-not-a-boolean",
  SCIENCE_SUBMISSIONS_DISABLED: "also-stale",
  SCIENCE_MAX_UPLOAD_BYTES: "not-a-number",
  SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS: "not-a-number",
  SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS: "not-a-number",
  SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS: "not-a-number",
  SCIENCE_STORAGE_DRIVER: "stale-driver",
  SCIENCE_S3_ENDPOINT: "not-a-url",
  SCIENCE_PUBLIC_BASE_URL: "not-a-url",
  SCIENCE_RUNTIME_URL: "not-a-url",
  SCIENCE_RENDER_URL: "not-a-url",
};
assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv(disabledWithStaleConfiguration));
assert.equal(
  createArtifactStoreFromEnv(
    disabledWithStaleConfiguration,
    "disabled-science-verifier-secret",
  ).adapter,
  "filesystem",
);
assert.deepEqual(
  createComputeProvidersFromEnv(disabledWithStaleConfiguration).list(),
  [],
);
assert.deepEqual(
  createRenderProvidersFromEnv(disabledWithStaleConfiguration)
    .list()
    .map((provider) => provider.kind),
  ["static"],
);
console.log("ok - malformed active booleans fail closed while disabled settings stay inert");

assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv(productionReadOnly));
assert.equal(
  resolveScienceRuntimeConfig(productionReadOnly).submissionsEnabled,
  false,
);
assert.deepEqual(createComputeProvidersFromEnv(productionReadOnly).list(), []);
const submissionsDisabled = without(productionReadOnly, "SCIENCE_READ_ONLY");
submissionsDisabled.SCIENCE_SUBMISSIONS_DISABLED = "1";
assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv(submissionsDisabled));
console.log("ok - read-only production requires durable infrastructure but may omit compute");

function assertStopsBeforeDurableBoundary(env, expected) {
  let durableBoundaryCrossed = false;
  assert.throws(() => {
    assertScienceProductionDeploymentEnv(env);
    durableBoundaryCrossed = true;
  }, expected);
  assert.equal(
    durableBoundaryCrossed,
    false,
    "invalid production Science configuration crossed the durable-resource boundary",
  );
}

const mainSource = readFileSync(
  resolve(repositoryRoot, "apps/server/src/main.ts"),
  "utf8",
);
const preflightCall = mainSource.indexOf("assertScienceProductionDeploymentEnv(process.env);");
const databaseConstruction = mainSource.indexOf("await createDb()");
assert.ok(preflightCall >= 0 && databaseConstruction > preflightCall);

for (const env of [
  without(productionReadOnly, "SCIENCE_SIGNING_SECRET"),
  { ...productionReadOnly, SCIENCE_SIGNING_SECRET: "too-short" },
]) {
  assertStopsBeforeDurableBoundary(
    env,
    /SCIENCE_SIGNING_SECRET.*PUPPETMASTER_MASTER_KEY.*16 bytes/,
  );
}
assert.doesNotThrow(() => assertScienceProductionDeploymentEnv({
  ...without(productionReadOnly, "SCIENCE_SIGNING_SECRET"),
  PUPPETMASTER_MASTER_KEY: "deployment-master-key-fallback",
}));

for (const [name, value, expected] of [
  ["DATABASE_URL", "https://database.invalid/science", /DATABASE_URL.*postgres/],
  ["DATABASE_URL", "not a URL", /DATABASE_URL.*valid/],
  ["REDIS_URL", "https://redis.invalid/0", /REDIS_URL.*redis/],
  ["REDIS_URL", "redis://redis.invalid/not-a-database", /REDIS_URL database path/],
  ["SCIENCE_S3_ENDPOINT", "ftp://objects.invalid", /SCIENCE_S3_ENDPOINT.*http/],
  ["SCIENCE_S3_ENDPOINT", "https://user@objects.invalid", /S3 endpoint cannot contain/],
  ["SCIENCE_S3_REQUEST_TIMEOUT_MS", "0", /SCIENCE_S3_REQUEST_TIMEOUT_MS/],
]) {
  assertStopsBeforeDurableBoundary(
    { ...productionReadOnly, [name]: value },
    expected,
  );
}

const readOnlyStaleAdapters = {
  ...productionReadOnly,
  SCIENCE_PUBLIC_BASE_URL: "not-a-url",
  SCIENCE_RUNTIME_URL: "file:///stale-runtime",
  SCIENCE_RUNTIME_TOKEN: "",
  SCIENCE_RUNTIME_ADMISSION: "stale",
  SCIENCE_RUNTIME_TIMEOUT_MS: "0",
  SCIENCE_RENDER_URL: "file:///stale-render",
  SCIENCE_RENDER_TOKEN: "",
  SCIENCE_RENDER_ADMISSION: "stale",
  SCIENCE_RENDER_TIMEOUT_MS: "0",
};
assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv(readOnlyStaleAdapters));
assert.equal(
  createArtifactStoreFromEnv(
    readOnlyStaleAdapters,
    readOnlyStaleAdapters.SCIENCE_SIGNING_SECRET,
  ).adapter,
  "s3-compatible",
);
const serverDockerfile = readFileSync(
  resolve(repositoryRoot, "docker/server.Dockerfile"),
  "utf8",
);
const webDockerfile = readFileSync(
  resolve(repositoryRoot, "docker/web.Dockerfile"),
  "utf8",
);
const webNginxSource = readFileSync(
  resolve(repositoryRoot, "docker/web-nginx.conf"),
  "utf8",
);
const webSecurityHeaders = readFileSync(
  resolve(repositoryRoot, "docker/web-security-headers.conf"),
  "utf8",
);
const webEventStreamSource = readFileSync(
  resolve(repositoryRoot, "apps/web/src/useEventStream.ts"),
  "utf8",
);
assert.deepEqual(createComputeProvidersFromEnv(readOnlyStaleAdapters).list(), []);
assert.deepEqual(
  createRenderProvidersFromEnv(readOnlyStaleAdapters)
    .list()
    .map((provider) => provider.kind),
  ["static"],
);
const readOnlyAdmittedAdapters = {
  ...productionReadOnly,
  SCIENCE_PUBLIC_BASE_URL: "https://control.invalid",
  SCIENCE_RUNTIME_URL: "https://runtime.invalid",
  SCIENCE_RUNTIME_TOKEN: "runtime-verifier-token",
  SCIENCE_RUNTIME_ADMISSION: "approved",
  SCIENCE_RENDER_URL: "https://render.invalid",
  SCIENCE_RENDER_TOKEN: "render-verifier-token",
  SCIENCE_RENDER_ADMISSION: "approved",
};
assert.deepEqual(
  createComputeProvidersFromEnv(readOnlyAdmittedAdapters)
    .list()
    .map((provider) => provider.kind),
  ["local_container"],
);
assert.deepEqual(
  createRenderProvidersFromEnv(readOnlyAdmittedAdapters)
    .list()
    .map((provider) => provider.kind),
  ["static", "trame"],
);
console.log("ok - read-only ignores stale adapters but retains admitted cancellation/close providers");

const writableAdapters = {
  ...without(productionReadOnly, "SCIENCE_READ_ONLY"),
  SCIENCE_PUBLIC_BASE_URL: "https://control.invalid",
  SCIENCE_RUNTIME_URL: "https://runtime.invalid",
  SCIENCE_RUNTIME_TOKEN: "runtime-verifier-token",
  SCIENCE_RUNTIME_ADMISSION: "approved",
  SCIENCE_RENDER_URL: "https://render.invalid",
  SCIENCE_RENDER_TOKEN: "render-verifier-token",
  SCIENCE_RENDER_ADMISSION: "approved",
};
assert.doesNotThrow(() => assertScienceProductionDeploymentEnv(writableAdapters));
for (const [name, value, expected] of [
  ["SCIENCE_RUNTIME_URL", "file:///runtime", /SCIENCE_RUNTIME_URL.*http/],
  ["SCIENCE_RUNTIME_TOKEN", "", /SCIENCE_RUNTIME_TOKEN/],
  ["SCIENCE_RUNTIME_ADMISSION", "pending", /SCIENCE_RUNTIME_ADMISSION=approved/],
  ["SCIENCE_RUNTIME_TIMEOUT_MS", "0", /SCIENCE_RUNTIME_TIMEOUT_MS/],
  ["SCIENCE_RENDER_URL", "file:///render", /SCIENCE_RENDER_URL.*http/],
  ["SCIENCE_RENDER_TOKEN", "", /SCIENCE_RENDER_TOKEN/],
  ["SCIENCE_RENDER_ADMISSION", "pending", /SCIENCE_RENDER_ADMISSION=approved/],
  ["SCIENCE_RENDER_TIMEOUT_MS", "0", /SCIENCE_RENDER_TIMEOUT_MS/],
]) {
  assertStopsBeforeDurableBoundary({ ...writableAdapters, [name]: value }, expected);
}
assertStopsBeforeDurableBoundary(
  without(writableAdapters, "SCIENCE_PUBLIC_BASE_URL"),
  /SCIENCE_PUBLIC_BASE_URL/,
);
console.log(
  "ok - pure preflight rejects every production constructor prerequisite before createDb",
);

let readinessNow = 10_000;
let readinessCalls = 0;
let releaseReadiness;
const readinessGate = new Promise((resolveGate) => {
  releaseReadiness = resolveGate;
});
const cachedReadiness = createSingleFlightTtlCache(async () => {
  readinessCalls++;
  await readinessGate;
  return { ok: true, sequence: readinessCalls };
}, {
  ttlMs: 5_000,
  now: () => readinessNow,
});
const concurrentReadiness = Array.from({ length: 64 }, () => cachedReadiness());
await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
assert.equal(readinessCalls, 1, "concurrent public probes must share one dependency probe");
releaseReadiness();
const firstReadiness = await Promise.all(concurrentReadiness);
assert.equal(new Set(firstReadiness.map((value) => value.sequence)).size, 1);
assert.equal((await cachedReadiness()).sequence, 1);
assert.equal(readinessCalls, 1, "fresh readiness must come from the TTL cache");
readinessNow += 5_001;
assert.equal((await cachedReadiness()).sequence, 2);
assert.equal(readinessCalls, 2, "expired readiness must be refreshed");

let failedReadinessCalls = 0;
const failedReadiness = createSingleFlightTtlCache(async () => {
  failedReadinessCalls++;
  throw new Error("probe failed");
}, { ttlMs: 5_000 });
const failedWave = await Promise.allSettled(
  Array.from({ length: 32 }, () => failedReadiness()),
);
assert.ok(failedWave.every((result) => result.status === "rejected"));
assert.equal(failedReadinessCalls, 1, "concurrent failures must also be single-flight");
await assert.rejects(failedReadiness(), /probe failed/);
assert.equal(failedReadinessCalls, 2, "failed readiness must not be cached");
assert.match(mainSource, /const currentReadiness = createSingleFlightTtlCache/);
console.log("ok - public readiness probes are TTL-cached, single-flight, and retry failures");

for (const name of ["DATABASE_URL", "REDIS_URL"]) {
  assert.throws(
    () => assertScienceProductionDeploymentEnv(without(productionReadOnly, name)),
    new RegExp(name),
    name + " must be mandatory for production Science",
  );
}
for (const driver of [undefined, "filesystem"]) {
  const env = { ...productionReadOnly };
  if (driver === undefined) delete env.SCIENCE_STORAGE_DRIVER;
  else env.SCIENCE_STORAGE_DRIVER = driver;
  assert.throws(
    () => assertScienceProductionDeploymentEnv(env),
    /SCIENCE_STORAGE_DRIVER=s3/,
  );
}
for (const name of [
  "SCIENCE_S3_ENDPOINT",
  "SCIENCE_S3_BUCKET",
  "SCIENCE_S3_ACCESS_KEY_ID",
  "SCIENCE_S3_SECRET_ACCESS_KEY",
]) {
  assert.throws(
    () => assertScienceProductionDeploymentEnv(without(productionReadOnly, name)),
    new RegExp(name),
    name + " must be mandatory for production Science",
  );
}
console.log("ok - production Science refuses PGlite, inline Redis fallback, and filesystem storage");

const productionWritable = without(productionReadOnly, "SCIENCE_READ_ONLY");
assert.throws(
  () => assertScienceProductionDeploymentEnv(productionWritable),
  /SCIENCE_RUNTIME_URL/,
);
for (const name of [
  "SCIENCE_RUNTIME_URL",
  "SCIENCE_RUNTIME_TOKEN",
  "SCIENCE_PUBLIC_BASE_URL",
]) {
  const env = {
    ...productionWritable,
    SCIENCE_RUNTIME_URL: "https://runtime.invalid",
    SCIENCE_RUNTIME_TOKEN: "runtime-verifier-token",
    SCIENCE_PUBLIC_BASE_URL: "https://control.invalid",
    SCIENCE_RUNTIME_ADMISSION: "approved",
  };
  delete env[name];
  assert.throws(
    () => assertScienceProductionDeploymentEnv(env),
    new RegExp(name),
  );
}
const admittedWritable = {
  ...productionWritable,
  SCIENCE_RUNTIME_URL: "https://runtime.invalid",
  SCIENCE_RUNTIME_TOKEN: "runtime-verifier-token",
  SCIENCE_PUBLIC_BASE_URL: "https://control.invalid",
};
assert.throws(
  () => assertScienceProductionDeploymentEnv(admittedWritable),
  /SCIENCE_RUNTIME_ADMISSION=approved/,
);
admittedWritable.SCIENCE_RUNTIME_ADMISSION = "APPROVED";
assert.doesNotThrow(() =>
  assertScienceProductionDeploymentEnv(admittedWritable));
assert.equal(
  resolveScienceRuntimeConfig(admittedWritable).submissionsEnabled,
  true,
);
assert.deepEqual(createComputeProvidersFromEnv(admittedWritable).list(), [
  { kind: "local_container", version: "http-contract.v1" },
]);
console.log("ok - writable production requires an explicitly admitted HTTP runtime");

const admittedProvider = createComputeProvidersFromEnv(admittedWritable).get(
  "local_container",
);
const originalFetch = globalThis.fetch;
let fixtureMutationRequests = 0;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/health") {
    return Response.json({
      ok: true,
      version: "0.2.0",
      instanceId: "science-runtime-fixture-a",
      executionMode: "contract_fixture",
      executesUserCode: false,
    });
  }
  fixtureMutationRequests++;
  throw new Error("the non-executing fixture reached a mutation request");
};
try {
  const health = await admittedProvider.health();
  assert.equal(health.ok, false);
  await assert.rejects(
    admittedProvider.submit({
      runId: "00000000-0000-4000-8000-000000000001",
      missionId: "00000000-0000-4000-8000-000000000002",
      generation: 1,
      idempotencyKey: "science-deployment-fixture-refusal",
      submittedAt: new Date(0).toISOString(),
      imageDigest: "sha256:" + "a".repeat(64),
      kernel: "python-fixture-v1",
      dependencyLock: {},
      resourceRequest: {
        cpuMillicores: 1000,
        memoryMb: 512,
        gpuCount: 0,
        wallTimeSeconds: 60,
      },
      parameters: {},
      inputs: [],
    }, { expectedInstanceId: "science-runtime-fixture-a" }),
    /not admitted|contract fixture/i,
  );
  assert.equal(fixtureMutationRequests, 0);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("ok - production admission still rejects the non-executing fixture before submit");

function renderCompose(overrides, options = {}) {
  const files = options.files ?? ["docker/docker-compose.yml"];
  const profile = options.profile ?? "science";
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("SCIENCE_")) delete env[name];
  }
  delete env.PUPPETMASTER_WEB_BIND_ADDRESS;
  delete env.PUPPETMASTER_WEB_PORT;
  delete env.POSTGRES_PASSWORD;
  Object.assign(env, overrides);
  const result = spawnSync(
    process.env.DOCKER_BIN || "docker",
    [
      "compose",
      ...files.flatMap((file) => ["-f", file]),
      "--profile",
      profile,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(
      "Docker Compose CLI is required for the deployment configuration verifier",
      { cause: result.error },
    );
  }
  assert.equal(
    result.status,
    0,
    "docker compose config failed with exit code " + String(result.status),
  );
  return JSON.parse(result.stdout);
}

const serverSentinels = {
  SCIENCE_ENABLED: "1",
  SCIENCE_READ_ONLY: "0",
  SCIENCE_SUBMISSIONS_DISABLED: "0",
  SCIENCE_SIGNING_SECRET: "compose-signing-sentinel",
  SCIENCE_MAX_UPLOAD_BYTES: "1234567",
  SCIENCE_MAX_WORKSPACE_STORAGE_BYTES: "2345678",
  SCIENCE_UPLOAD_TTL_SECONDS: "321",
  SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS: "91234",
  SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS: "8123",
  SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS: "5",
  SCIENCE_RENDER_TTL_SECONDS: "654",
  SCIENCE_MAX_CONCURRENT_RUNS: "3",
  SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS: "4",
  SCIENCE_POLL_INTERVAL_MS: "777",
  SCIENCE_RATE_LIMIT_READS_PER_MINUTE: "888",
  SCIENCE_RATE_LIMIT_WRITES_PER_MINUTE: "99",
  SCIENCE_AUTOMATION_USER_ID: "00000000-0000-4000-8000-000000000099",
  SCIENCE_STORAGE_DRIVER: "s3",
  SCIENCE_S3_ENDPOINT: "https://compose-objects.invalid",
  SCIENCE_S3_REGION: "test-region-1",
  SCIENCE_S3_BUCKET: "compose-science",
  SCIENCE_S3_ACCESS_KEY_ID: "compose-access-sentinel",
  SCIENCE_S3_SECRET_ACCESS_KEY: "compose-secret-sentinel",
  SCIENCE_S3_REQUEST_TIMEOUT_MS: "54321",
  SCIENCE_PUBLIC_BASE_URL: "https://compose-control.invalid",
  SCIENCE_RUNTIME_URL: "https://compose-runtime.invalid",
  SCIENCE_RUNTIME_TOKEN: "compose-runtime-token-sentinel",
  SCIENCE_RUNTIME_ADMISSION: "approved",
  SCIENCE_RUNTIME_TIMEOUT_MS: "13579",
  SCIENCE_FIXTURE_PROVISIONING_MS: "17",
  SCIENCE_FIXTURE_RUNNING_MS: "19",
  SCIENCE_RENDER_URL: "https://compose-render.invalid",
  SCIENCE_RENDER_TOKEN: "compose-render-token-sentinel",
  SCIENCE_RENDER_ADMISSION: "approved",
  SCIENCE_RENDER_TIMEOUT_MS: "24680",
};
const runtimeSentinels = {
  SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS: "https://compose-control.invalid",
  SCIENCE_RUNTIME_ALLOWED_IMAGE_DIGESTS: "sha256:" + "a".repeat(64),
  SCIENCE_RUNTIME_ALLOWED_KERNELS: "python-compose-v1",
  SCIENCE_RUNTIME_MAX_CONCURRENCY: "5",
  SCIENCE_RUNTIME_FIXTURE_DELAY_MS: "23",
  SCIENCE_RUNTIME_MAX_CPU_MILLICORES: "1500",
  SCIENCE_RUNTIME_MAX_MEMORY_MB: "768",
  SCIENCE_RUNTIME_MAX_GPU_COUNT: "1",
  SCIENCE_RUNTIME_MAX_WALL_SECONDS: "456",
};
const configuredCompose = renderCompose({
  POSTGRES_PASSWORD: "compose-postgres-sentinel",
  ...serverSentinels,
  ...runtimeSentinels,
});
const serverEnvironment = configuredCompose.services.server.environment;
const configuredServer = configuredCompose.services.server;
const configuredWeb = configuredCompose.services.web;
for (const [name, expected] of Object.entries(serverSentinels)) {
  assert.equal(
    serverEnvironment[name],
    expected,
    "Compose did not propagate server environment " + name,
  );
}
assert.equal(
  serverEnvironment.SCIENCE_ARTIFACT_ROOT,
  "/var/lib/puppetmaster-science/artifacts",
);
assert.equal(configuredServer.user, "1000:1000");
assert.equal(configuredServer.read_only, true);
assert.deepEqual(configuredServer.cap_drop, ["ALL"]);
assert.ok(configuredServer.security_opt.includes("no-new-privileges:true"));
assert.equal(
  configuredServer.depends_on["science-volume-init"].condition,
  "service_completed_successfully",
);
assert.match(serverDockerfile, /\nUSER node\r?\n/);
assert.equal(configuredServer.ports, undefined);
assert.ok(configuredServer.expose.includes("4000"));
assert.equal(configuredWeb.build.dockerfile, "docker/web.Dockerfile");
assert.equal(configuredWeb.user, "101:101");
assert.equal(configuredWeb.read_only, true);
assert.deepEqual(configuredWeb.cap_drop, ["ALL"]);
assert.ok(configuredWeb.security_opt.includes("no-new-privileges:true"));
assert.equal(configuredWeb.pids_limit, 64);
assert.equal(configuredWeb.mem_limit, String(128 * 1024 * 1024));
assert.equal(configuredWeb.depends_on.server.condition, "service_healthy");
assert.equal(configuredWeb.ports.length, 1);
assert.equal(configuredWeb.ports[0].host_ip, "127.0.0.1");
assert.equal(configuredWeb.ports[0].published, "4000");
assert.equal(configuredWeb.ports[0].target, 8080);
assert.ok(Object.hasOwn(configuredWeb.networks, "web_edge"));
assert.ok(Object.hasOwn(configuredWeb.networks, "web_gateway"));
assert.ok(Object.hasOwn(configuredServer.networks, "web_gateway"));
assert.equal(Object.hasOwn(configuredServer.networks, "web_edge"), false);
assert.equal(configuredCompose.networks.web_edge.internal ?? false, false);
assert.equal(configuredCompose.networks.web_gateway.internal, true);
assert.doesNotMatch(JSON.stringify(configuredWeb), /docker\.sock/i);
assert.match(JSON.stringify(configuredWeb.tmpfs), /\/tmp.*size=16m/);

assert.match(webDockerfile, /pnpm install .*--frozen-lockfile/);
assert.match(webDockerfile, /pnpm --filter @puppetmaster\/web\.\.\. build/);
assert.match(webDockerfile, /FROM node:22-alpine@sha256:[a-f0-9]{64} AS build/);
assert.match(webDockerfile, /FROM nginx:1\.27\.5-alpine@sha256:[a-f0-9]{64}/);
assert.match(webDockerfile, /COPY --from=build --chown=101:101 .*apps\/web\/dist/);
assert.match(webDockerfile, /\nUSER 101:101\r?\n/);
assert.doesNotMatch(webDockerfile, /vite preview|docker\.sock/i);

const apiProxyBlock = webNginxSource.match(
  /location \^~ \/api\/ \{([\s\S]*?)\n    \}/,
)?.[1];
assert.ok(apiProxyBlock, "Nginx must own a non-SPA /api/ proxy boundary");
assert.match(apiProxyBlock, /proxy_pass http:\/\/puppetmaster_api/);
assert.match(apiProxyBlock, /proxy_http_version 1\.1/);
assert.match(apiProxyBlock, /proxy_set_header Upgrade \$http_upgrade/);
assert.match(apiProxyBlock, /proxy_set_header Connection \$connection_upgrade/);
assert.match(apiProxyBlock, /proxy_request_buffering off/);
assert.match(apiProxyBlock, /proxy_buffering off/);
assert.doesNotMatch(
  apiProxyBlock,
  /web-security-headers/,
  "the top-level frame-deny CSP must not override the render gateway response CSP",
);
assert.match(webNginxSource, /location \^~ \/assets\/[^]*?max-age=31536000, immutable/);
assert.match(webNginxSource, /location = \/index\.html[^]*?Cache-Control "no-store"/);
assert.match(webNginxSource, /location \/ \{[^]*?try_files \$uri \$uri\/ \/index\.html/);
assert.match(webNginxSource, /client_max_body_size 16g/);
assert.match(webNginxSource, /worker_processes 1/);
assert.match(webNginxSource, /resolver 127\.0\.0\.11 valid=30s ipv6=off/);
assert.match(webNginxSource, /server server:4000 resolve/);
assert.doesNotMatch(webNginxSource, /"\$request"/);
assert.doesNotMatch(webNginxSource, /\$args|\$query_string/);
for (const temporaryPath of ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]) {
  assert.match(
    webNginxSource,
    new RegExp(temporaryPath + "_temp_path /tmp/"),
    temporaryPath + " temporary files must stay on the bounded tmpfs",
  );
}
assert.match(webSecurityHeaders, /frame-ancestors 'none'/);
assert.match(webSecurityHeaders, /frame-src 'self'/);
assert.match(webSecurityHeaders, /worker-src 'self' blob:/);
assert.match(webSecurityHeaders, /connect-src 'self';/);
assert.doesNotMatch(webSecurityHeaders, /connect-src[^;]*(?:ws:|wss:)/);
assert.match(webSecurityHeaders, /style-src 'self' 'unsafe-inline'/);
assert.doesNotMatch(webSecurityHeaders, /script-src[^;]*'unsafe-eval'/);
assert.match(webEventStreamSource, /location\.host\}\/api\/events/);
console.log(
  "ok - unprivileged same-origin web gateway serves the SPA, streams /api, and preserves WebSocket/render paths",
);
assert.equal(
  serverEnvironment.SCIENCE_QUARANTINE_ROOT,
  "/var/lib/puppetmaster-science/quarantine",
);
const runtimeEnvironment =
  configuredCompose.services["science-runtime"].environment;
assert.equal(
  runtimeEnvironment.SCIENCE_RUNTIME_TOKEN,
  serverSentinels.SCIENCE_RUNTIME_TOKEN,
);
for (const [name, expected] of Object.entries(runtimeSentinels)) {
  assert.equal(
    runtimeEnvironment[name],
    expected,
    "Compose did not propagate runtime environment " + name,
  );
}
assert.equal(runtimeEnvironment.SCIENCE_RUNTIME_ALLOW_ANONYMOUS, undefined);
console.log("ok - Compose forwards documented control-plane and fixture-runtime settings");

const defaultCompose = renderCompose({
  POSTGRES_PASSWORD: "compose-postgres-default-check",
});
const defaultServerEnvironment = defaultCompose.services.server.environment;
assert.equal(defaultServerEnvironment.SCIENCE_ENABLED, "0");
assert.equal(defaultServerEnvironment.SCIENCE_READ_ONLY, "1");
assert.equal(defaultServerEnvironment.SCIENCE_STORAGE_DRIVER, "filesystem");
assert.equal(defaultServerEnvironment.SCIENCE_S3_REGION, "us-east-1");
assert.equal(defaultServerEnvironment.SCIENCE_RUNTIME_URL, "");
assert.equal(defaultServerEnvironment.SCIENCE_RENDER_URL, "");
for (const name of [
  "SCIENCE_SIGNING_SECRET",
  "SCIENCE_S3_ACCESS_KEY_ID",
  "SCIENCE_S3_SECRET_ACCESS_KEY",
  "SCIENCE_RUNTIME_TOKEN",
  "SCIENCE_RENDER_TOKEN",
]) {
  assert.equal(
    defaultServerEnvironment[name],
    "",
    "Compose must not provide a credential default for " + name,
  );
}
assert.equal(
  defaultCompose.services["science-runtime"].environment.SCIENCE_RUNTIME_TOKEN,
  "",
);
assert.throws(
  () => assertScienceProductionDeploymentEnv({
    ...defaultServerEnvironment,
    SCIENCE_ENABLED: "1",
  }),
  /SCIENCE_STORAGE_DRIVER=s3/,
  "enabling the production Compose profile must require explicit external S3 configuration",
);

const minioCompose = renderCompose({
  POSTGRES_PASSWORD: "compose-minio-postgres-sentinel",
  SCIENCE_S3_ACCESS_KEY_ID: "compose-minio-access",
  SCIENCE_S3_SECRET_ACCESS_KEY: "compose-minio-secret-sentinel",
  SCIENCE_S3_BUCKET: "compose-minio-bucket",
}, {
  files: [
    "docker/docker-compose.yml",
    "docker/docker-compose.science-minio.yml",
  ],
  profile: "science-minio",
});
const minioService = minioCompose.services["science-minio"];
const minioBootstrap = minioCompose.services["science-minio-bootstrap"];
assert.equal(
  minioService.image,
  "quay.io/minio/minio@sha256:064117214caceaa8d8a90ef7caa58f2b2aeb316b5156afe9ee8da5b4d83e12c8",
);
assert.equal(minioService.user, "1000:1000");
assert.deepEqual(minioService.cap_drop, ["ALL"]);
assert.equal(minioService.read_only, true);
assert.equal(minioService.ports[0].host_ip, "127.0.0.1");
assert.equal(
  minioCompose.services.server.environment.SCIENCE_S3_ENDPOINT,
  "http://science-minio:9000",
);
assert.equal(minioCompose.services.server.environment.SCIENCE_STORAGE_DRIVER, "s3");
assert.match(minioBootstrap.command.join("\n"), /version info --json/);
assert.match(minioBootstrap.command.join("\n"), /"status":""/);
console.log(
  "ok - Compose defaults disabled/read-only and the opt-in pinned MinIO profile enforces an unversioned private bucket",
);

console.log(
  "SCIENCE DEPLOYMENT PASS: production preflight, read-only rollback, runtime admission, same-origin web delivery, and Compose environment parity",
);
