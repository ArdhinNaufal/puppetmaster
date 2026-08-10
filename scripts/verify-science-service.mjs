#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  acquireScienceRunLease,
  createScienceRun,
  createDb,
  createUser,
  getLatestScienceRunEvent,
  getScienceRenderSessionForWorkspace,
  getScienceUploadByTokenHash,
  listScienceRenderSessions,
  migrate,
  probeScienceDatabase,
  releaseScienceRunLease,
  setScienceWorkspaceAdmission,
  transitionScienceRenderSession,
  upsertMembership,
  workspaces,
} from "../packages/db/dist/index.js";
import {
  BuiltinToolRegistry,
  ComputeProviderRegistry,
  DeterministicComputeProvider,
  FilesystemArtifactStore,
  InMemoryEventBus,
  InlineScienceScheduler,
  RenderProviderRegistry,
  S3CompatibleArtifactStore,
  ScienceService,
  StaticRenderSessionProvider,
  registerScienceTools,
} from "../packages/kernel/dist/index.js";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const STORAGE_SECRET = "science-service-storage-secret";
const GATEWAY_SECRET = "science-service-gateway-secret";
const PROVIDER_SECRET_SENTINEL = "provider-secret-must-not-be-public";
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
const CONFIG = {
  enabled: true,
  submissionsEnabled: true,
  maxUploadBytes: 8 * 1024 * 1024,
  maxWorkspaceStorageBytes: 64 * 1024 * 1024,
  uploadTtlSeconds: 60,
  renderTtlSeconds: 60,
  maxConcurrentRunsPerWorkspace: 16,
  maxConcurrentRenderSessionsPerWorkspace: 16,
  pollIntervalMs: 5,
};

const failures = [];

async function acceptance(name, action) {
  try {
    await action();
    console.log(`ok - ${name}`);
    return true;
  } catch (error) {
    failures.push({ name, error });
    console.error(
      `not ok - ${name}: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function phase(name, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${name}: ${error.message}`;
    }
    throw error;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function bytesOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createComputeRegistry(options = {}) {
  const registry = new ComputeProviderRegistry();
  registry.register(new DeterministicComputeProvider({
    kind: "local_container",
    provisioningMs: options.provisioningMs ?? 0,
    runningMs: options.runningMs ?? 0,
  }));
  return registry;
}

function createRenderRegistry() {
  const registry = new RenderProviderRegistry();
  registry.register(new StaticRenderSessionProvider());
  return registry;
}

function trackQuarantine(base) {
  const created = [];
  const discarded = [];
  const store = new Proxy(base, {
    get(target, property) {
      if (property === "createQuarantine") {
        return async (...args) => {
          const key = await target.createQuarantine(...args);
          created.push(key);
          return key;
        };
      }
      if (property === "discardQuarantine") {
        return async (key) => {
          await target.discardQuarantine(key);
          discarded.push(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store, created, discarded };
}

function createService({
  db,
  workspaceId,
  store,
  computeProviders,
  renderProviders,
  config = CONFIG,
  workerId,
  audit,
  auditEntries,
  publishedEvents,
}) {
  const bus = new InMemoryEventBus();
  bus.subscribe((event) => publishedEvents?.push(event));
  return new ScienceService({
    db,
    workspaceId,
    store,
    computeProviders,
    renderProviders: renderProviders ?? createRenderRegistry(),
    bus,
    config,
    workerId,
    gatewaySecret: GATEWAY_SECRET,
    audit: audit ?? (auditEntries ? async (entry) => {
      auditEntries.push(entry);
    } : undefined),
  });
}

async function waitForRun(service, runId, expectedStates, timeoutMs = 5_000) {
  const states = new Set(expectedStates);
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await service.getRun(runId);
    if (states.has(last.state)) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `science run ${runId} did not reach ${[...states].join("|")}; last state ${last?.state}`,
  );
}

async function uploadArtifact(service, {
  studyId,
  actorId,
  logicalName,
  kind,
  format,
  mediaType,
  bytes,
}) {
  const artifact = await service.createArtifact({
    studyId,
    logicalName,
    kind,
    format,
    actorId,
  });
  const begun = await service.beginUpload({
    artifactId: artifact.id,
    expectedSizeBytes: bytes.length,
    expectedSha256: digest(bytes),
    actorId,
  });
  const written = await service.writeUpload(
    begun.uploadToken,
    Readable.from([bytes]),
    actorId,
  );
  assert.equal(written.state, "uploading");
  const completed = await service.completeUpload({
    uploadToken: begun.uploadToken,
    mediaType,
    metadata: { fixture: "science-service-v1" },
    actorId,
  });
  assert.equal(completed.upload.state, "completed");
  assert.equal(completed.version.status, "ready");
  assert.equal(completed.version.sha256, digest(bytes));
  return { artifact, version: completed.version };
}

async function verifyCommittedPromotionRetry(service, store, {
  studyId,
  actorId,
  logicalName,
  bytes,
}) {
  const artifact = await service.createArtifact({
    studyId,
    logicalName,
    kind: "dataset",
    format: "binary",
    actorId,
  });
  const begun = await service.beginUpload({
    artifactId: artifact.id,
    expectedSizeBytes: bytes.length,
    expectedSha256: digest(bytes),
    actorId,
  });
  await service.writeUpload(begun.uploadToken, Readable.from([bytes]), actorId);
  await assert.rejects(
    service.completeUpload({
      uploadToken: begun.uploadToken,
      mediaType: "application/octet-stream",
      actorId,
    }),
    /fixture crash after committed artifact promotion/,
  );
  const completed = await service.completeUpload({
    uploadToken: begun.uploadToken,
    mediaType: "application/octet-stream",
    actorId,
  });
  assert.equal(completed.upload.state, "completed");
  assert.equal(completed.version.status, "ready");
  const persisted = await store.open(completed.version.storageKey);
  assert.deepEqual(await bytesOf(persisted.body), bytes);
}

async function approve(service, submission, actorId) {
  return service.resolveApproval({
    runId: submission.run.id,
    approvalId: submission.approval.id,
    approved: true,
    actorId,
  });
}

function runIntent({ studyId, profileId, inputVersionId, actorId, key }) {
  return {
    studyId,
    computeProfileId: profileId,
    resourceRequest: RESOURCE_REQUEST,
    inputs: [{ artifactVersionId: inputVersionId, semanticRole: "notebook" }],
    parameters: {
      reynolds: 12_000,
      units: { length: "m", time: "s" },
      randomSeeds: { solver: 42 },
    },
    idempotencyKey: key,
    actorId,
  };
}

class GatedDeterministicProvider extends DeterministicComputeProvider {
  constructor() {
    super({
      kind: "local_container",
      provisioningMs: 0,
      runningMs: 0,
    });
    this.entered = new Promise((resolve) => {
      this.resolveEntered = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.resolveGate = resolve;
    });
  }

  async status(handle, generation, fence) {
    this.resolveEntered();
    await this.gate;
    return super.status(handle, generation, fence);
  }

  release() {
    this.resolveGate();
  }
}

class GatedHealthProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 60_000, runningMs: 60_000 });
    this.healthEntered = deferred();
    this.healthGate = deferred();
    this.submitCalls = 0;
  }

  async health() {
    this.healthEntered.resolve();
    await this.healthGate.promise;
    return super.health();
  }

  async submit(input, fence) {
    this.submitCalls++;
    return super.submit(input, fence);
  }

  releaseHealth() {
    this.healthGate.resolve();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class InFlightSubmitProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.submitEntered = deferred();
    this.submitGate = deferred();
    this.cancelCalls = 0;
    this.providerTerminal = false;
    this.lastHandle = null;
  }

  async submit(input, fence) {
    const result = await super.submit(input, fence);
    this.lastHandle = result.handle;
    this.submitEntered.resolve();
    await this.submitGate.promise;
    return result;
  }

  async status() {
    return this.providerTerminal
      ? { state: "cancelled", progress: null, message: "terminal confirmation" }
      : { state: "running", progress: 0.5, message: "submit completed; cancellation pending" };
  }

  async cancel() {
    this.cancelCalls++;
    return { accepted: true };
  }

  releaseSubmit() {
    this.submitGate.resolve();
  }

  confirmTerminal() {
    this.providerTerminal = true;
  }
}

class RefusingCancelProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.providerTerminal = false;
    this.cancelCalls = 0;
  }

  async status() {
    return this.providerTerminal
      ? { state: "cancelled", progress: null, message: "eventual terminal state" }
      : { state: "running", progress: 0.5, message: "provider still owns compute" };
  }

  async cancel() {
    this.cancelCalls++;
    return { accepted: false };
  }

  confirmTerminal() {
    this.providerTerminal = true;
  }
}

class SlowOutputProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.outputEntered = deferred();
    this.outputGate = deferred();
    this.gated = false;
  }

  async status() {
    return { state: "succeeded", progress: 1, message: "outputs ready" };
  }

  async openOutput(output, fence) {
    const source = await super.openOutput(output, fence);
    if (this.gated) return source;
    this.gated = true;
    const entered = this.outputEntered;
    const gate = this.outputGate;
    return (async function* gatedOutput() {
      entered.resolve();
      await gate.promise;
      for await (const chunk of source) yield chunk;
    })();
  }

  releaseOutput() {
    this.outputGate.resolve();
  }
}

class CountingOutputOpenProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.openCalls = 0;
  }

  async openOutput(output, fence) {
    this.openCalls++;
    return super.openOutput(output, fence);
  }
}

function decodeRestartMatrixHandle(handle) {
  assert.match(handle, /^det:/, "restart-matrix provider received a foreign handle");
  const value = JSON.parse(Buffer.from(handle.slice(4), "base64url").toString("utf8"));
  assert.equal(typeof value?.runId, "string");
  assert.ok(Number.isSafeInteger(value?.generation));
  return value;
}

class RestartMatrixProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.phases = new Map();
    this.failSecondOutput = new Set();
    this.submitCalls = [];
    this.statusCalls = [];
    this.cancelCalls = [];
    this.openCalls = [];
  }

  setPhase(runId, phase) {
    this.phases.set(runId, phase);
  }

  failSecondOutputFor(runId) {
    this.failSecondOutput.add(runId);
  }

  async submit(input, fence) {
    const result = await super.submit(input, fence);
    this.submitCalls.push({ runId: input.runId, generation: input.generation, handle: result.handle });
    return result;
  }

  async status(handle, generation, fence) {
    const base = await super.status(handle, generation, fence);
    const value = decodeRestartMatrixHandle(handle);
    this.statusCalls.push({ runId: value.runId, generation, handle });
    if (base.state === "cancelled") return base;
    const state = this.phases.get(value.runId) ?? "succeeded";
    return {
      state,
      progress: state === "succeeded" ? 1 : state === "running" ? 0.5 : 0,
      message: "restart matrix " + state,
    };
  }

  async cancel(handle, generation, fence) {
    const value = decodeRestartMatrixHandle(handle);
    const result = await super.cancel(handle, generation, fence);
    this.cancelCalls.push({
      runId: value.runId,
      generation,
      handle,
      accepted: result.accepted,
    });
    return result;
  }

  async openOutput(output, fence) {
    const separator = output.reference.lastIndexOf(":");
    const handle = output.reference.slice(0, separator);
    const value = decodeRestartMatrixHandle(handle);
    this.openCalls.push({ runId: value.runId, logicalName: output.logicalName });
    if (this.failSecondOutput.has(value.runId) && output.logicalName === "result.vtk") {
      throw new Error("fixture restart after first committed output");
    }
    return super.openOutput(output, fence);
  }
}

class RecordingInlineScienceScheduler extends InlineScienceScheduler {
  constructor(tick, onError) {
    super(tick, onError);
    this.enqueued = [];
  }

  async enqueue(runId, expectedGeneration = null, delayMs = 0) {
    this.enqueued.push({ runId, expectedGeneration, delayMs });
    return super.enqueue(runId, expectedGeneration, delayMs);
  }
}

class DeclaredSizeOverrunProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.chunksRead = 0;
  }

  async status() {
    return { state: "succeeded", progress: 1, message: "declared-size fixture ready" };
  }

  async collectOutputs() {
    const declared = Buffer.from("ABCD");
    return [{
      reference: "fixture://declared-size-overrun",
      logicalName: "declared-size.bin",
      kind: "result",
      format: "binary",
      mediaType: "application/octet-stream",
      sha256: digest(declared),
      size: declared.length,
      metadata: { fixture: "declared-size-overrun" },
    }];
  }

  async openOutput() {
    const provider = this;
    return (async function* overrun() {
      provider.chunksRead++;
      yield Buffer.from("ABCD");
      provider.chunksRead++;
      yield Buffer.from("X");
      provider.chunksRead++;
      yield Buffer.alloc(1024 * 1024, 0x7a);
    })();
  }
}

class TooManyOutputsProvider extends DeterministicComputeProvider {
  constructor() {
    super({ kind: "local_container", provisioningMs: 0, runningMs: 0 });
    this.openCalls = 0;
  }

  async status() {
    return { state: "succeeded", progress: 1, message: "oversized output index ready" };
  }

  async collectOutputs() {
    return Array.from({ length: 201 }, (_, index) => ({
      reference: `fixture://oversized-output/${index}`,
      logicalName: `output-${String(index).padStart(3, "0")}.bin`,
      kind: "result",
      format: "binary",
      mediaType: "application/octet-stream",
      sha256: digest(Buffer.alloc(0)),
      size: 0,
      metadata: { index },
    }));
  }

  async openOutput() {
    this.openCalls++;
    throw new Error("oversized output list must be rejected before opening bytes");
  }
}

class UnreachableProvider extends DeterministicComputeProvider {
  constructor(instanceId = "unreachable-provider-a") {
    super({ kind: "local_container", provisioningMs: 60_000, runningMs: 60_000 });
    // The deterministic base now enforces the same instance fence as a remote
    // provider. Keep the fixture's admitted health identity and operation
    // identity identical so transport failures, rather than a fixture lie,
    // drive these recovery tests.
    this.instanceId = instanceId;
    this.cancelCalls = 0;
    this.terminal = false;
  }

  async health() {
    return super.health();
  }

  async status() {
    if (this.terminal) {
      return { state: "cancelled", progress: null, message: "operator-confirmed terminal" };
    }
    throw new Error("provider transport unavailable");
  }

  async cancel() {
    this.cancelCalls++;
    return { accepted: true };
  }

  confirmTerminal() {
    this.terminal = true;
  }
}

class UnhealthyBeforeSubmitProvider extends DeterministicComputeProvider {
  constructor(instanceId = "unhealthy-before-submit") {
    super({ kind: "local_container", provisioningMs: 60_000, runningMs: 60_000 });
    this.runtimeInstanceId = instanceId;
    this.healthCalls = 0;
    this.submitCalls = 0;
    this.statusCalls = 0;
    this.cancelCalls = 0;
  }

  async health() {
    this.healthCalls++;
    return {
      ...(await super.health()),
      ok: false,
      instanceId: this.runtimeInstanceId,
      detail: "fixture provider unavailable before submit",
    };
  }

  async submit(input, fence) {
    this.submitCalls++;
    return super.submit(input, fence);
  }

  async status(handle, generation, fence) {
    this.statusCalls++;
    return super.status(handle, generation, fence);
  }

  async cancel(handle, generation, fence) {
    this.cancelCalls++;
    return super.cancel(handle, generation, fence);
  }
}

class LostSubmitResponseProvider extends DeterministicComputeProvider {
  constructor(instanceId) {
    super({ kind: "local_container", provisioningMs: 60_000, runningMs: 60_000 });
    this.instanceId = instanceId;
    this.submitCalls = 0;
    this.statusCalls = 0;
    this.cancelCalls = 0;
    this.loseNextResponse = true;
  }

  async health() {
    return super.health();
  }

  async submit(input, fence) {
    this.submitCalls++;
    const result = await super.submit(input, fence);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("fixture lost the accepted submit response");
    }
    return result;
  }

  async status(handle, generation, fence) {
    this.statusCalls++;
    return super.status(handle, generation, fence);
  }

  async cancel(handle, generation, fence) {
    this.cancelCalls++;
    return super.cancel(handle, generation, fence);
  }
}

class LongHandleRenderProvider {
  constructor(handleLength, {
    instanceId = "render-a",
    launchInstanceId = instanceId,
    launchState = "ready",
    closeFails = false,
  } = {}) {
    this.kind = "trame";
    this.version = "acceptance-long-handle.v1";
    this.handle = "r".repeat(handleLength);
    this.instanceId = instanceId;
    this.launchInstanceId = launchInstanceId;
    this.launchState = launchState;
    this.closeFails = closeFails;
    this.closed = [];
    this.closeFences = [];
    this.renewed = [];
    this.statusCalls = 0;
  }

  async start() {
    return {
      providerHandle: this.handle,
      instanceId: this.launchInstanceId,
      state: this.launchState,
      mode: "remote",
    };
  }

  async status() {
    this.statusCalls++;
    return {
      state: "ready",
      mode: "remote",
      upstreamUrl: "http://renderer.internal/session",
    };
  }

  async renew(handle, expiresAt) {
    assert.equal(handle, this.handle);
    this.renewed.push(expiresAt);
  }

  async close(handle, fence) {
    this.closed.push(handle);
    this.closeFences.push(fence.expectedInstanceId);
    if (this.closeFails) throw new Error("fixture render close failed");
  }

  async health() {
    return {
      ok: true,
      provider: this.kind,
      version: this.version,
      instanceId: this.instanceId,
    };
  }
}

function registryWith(provider) {
  const registry = new ComputeProviderRegistry();
  registry.register(provider);
  return registry;
}

function renderRegistryWith(provider) {
  const registry = new RenderProviderRegistry();
  registry.register(provider);
  return registry;
}

function crashAfterCommittedPromotion(store) {
  let shouldCrash = true;
  return new Proxy(store, {
    get(target, property) {
      if (property === "promote") {
        return async (...args) => {
          await target.promote(...args);
          if (shouldCrash) {
            shouldCrash = false;
            throw new Error("fixture crash after committed artifact promotion");
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function startS3Mock() {
  const objects = new Map();
  const server = createServer(async (request, response) => {
    if (!/^AWS4-HMAC-SHA256 /.test(request.headers.authorization ?? "")) {
      response.writeHead(403).end();
      return;
    }
    const key = request.url.split("?")[0];
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] === "*" && objects.has(key)) {
        response.writeHead(412).end();
        return;
      }
      const body = await bytesOf(request);
      objects.set(key, {
        body,
        sha256: request.headers["x-amz-meta-sha256"],
      });
      response.writeHead(200).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "content-length": object.body.length,
        "x-amz-meta-sha256": object.sha256,
      }).end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const body = object.body.subarray(start, end + 1);
      response.writeHead(206, {
        "content-length": body.length,
        "content-range": `bytes ${start}-${end}/${object.body.length}`,
      }).end(body);
      return;
    }
    response.writeHead(200, { "content-length": object.body.length }).end(object.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function createPostgresBlackhole() {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // Accept TCP but intentionally never complete the PostgreSQL handshake.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    databaseUrl: `postgres://science:science@127.0.0.1:${address.port}/science`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

const artifactRoot = await mkdtemp(join(tmpdir(), "puppetmaster-science-service-"));
const dbHandle = await createDb({ ephemeral: true });
const schedulers = [];

try {
  await migrate(dbHandle);

  const [workspaceA] = await dbHandle.db
    .insert(workspaces)
    .values({ name: "Science service acceptance A" })
    .returning();
  const [workspaceB] = await dbHandle.db
    .insert(workspaces)
    .values({ name: "Science service acceptance B" })
    .returning();
  const owner = await createUser(dbHandle.db, {
    email: "science-service-owner@example.test",
    name: "Science Service Owner",
    passwordHash: "not-a-real-password-hash",
  });
  const otherMember = await createUser(dbHandle.db, {
    email: "science-service-other@example.test",
    name: "Other Science Member",
    passwordHash: "not-a-real-password-hash",
  });
  for (const [userId, workspaceId] of [
    [owner.id, workspaceA.id],
    [otherMember.id, workspaceA.id],
    [owner.id, workspaceB.id],
  ]) {
    await upsertMembership(dbHandle.db, {
      userId,
      workspaceId,
      role: "owner",
    });
  }

  for (const workspaceId of [workspaceA.id, workspaceB.id]) {
    await setScienceWorkspaceAdmission(dbHandle.db, {
      workspaceId,
      admitted: true,
      updatedBy: owner.id,
    });
  }

  const store = new FilesystemArtifactStore({
    root: artifactRoot,
    referenceSecret: STORAGE_SECRET,
  });
  const auditEntries = [];
  const publishedEvents = [];
  const mainService = createService({
    db: dbHandle.db,
    workspaceId: workspaceA.id,
    store,
    computeProviders: createComputeRegistry(),
    workerId: "acceptance-main",
    auditEntries,
    publishedEvents,
  });
  const schedulerErrors = [];
  const mainScheduler = new InlineScienceScheduler(
    (runId, generation) => mainService.tick(runId, generation),
    (message, error) => schedulerErrors.push({ message, error }),
  );
  mainService.attachScheduler(mainScheduler);
  schedulers.push(mainScheduler);
  await mainScheduler.start();

  await acceptance("postgres readiness is driver-bounded against a blackholed endpoint", async () => {
    const blackhole = await createPostgresBlackhole();
    let blackholeHandle;
    try {
      blackholeHandle = await createDb({ databaseUrl: blackhole.databaseUrl });
      const startedAt = Date.now();
      await assert.rejects(
        probeScienceDatabase(blackholeHandle.db),
        /timeout/i,
      );
      assert.ok(
        Date.now() - startedAt < 4_500,
        "PostgreSQL readiness must fail within its driver-enforced deadline",
      );
    } finally {
      await blackholeHandle?.close().catch(() => {});
      await blackhole.close();
    }
  });

  await acceptance("database readiness fails closed and recovers on the next probe", async () => {
    let unavailable = true;
    const probeDb = new Proxy(dbHandle.db, {
      get(target, property) {
        if (property === "execute") {
          return (...args) => unavailable
            ? Promise.reject(new Error("fixture database unavailable"))
            : target.execute(...args);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const readinessService = createService({
      db: probeDb,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry(),
      workerId: "acceptance-database-readiness",
    });
    const failed = await readinessService.health();
    assert.equal(failed.database.ok, false);
    assert.equal(failed.ok, false);
    unavailable = false;
    const recovered = await readinessService.health();
    assert.equal(recovered.database.ok, true);
  });

  const study = await mainService.createStudy({
    name: "Deterministic notebook study",
    description: "Service-level acceptance fixture",
    actorId: owner.id,
  });
  await acceptance(
    "semantic audit failure cannot turn a committed mutation into a retryable error",
    async () => {
      const service = createService({
        db: dbHandle.db,
        workspaceId: workspaceA.id,
        store,
        computeProviders: createComputeRegistry(),
        workerId: "acceptance-audit-degradation",
        audit: async () => {
          throw new Error("deliberate semantic audit sink outage");
        },
      });
      const created = await service.createStudy({
        name: "Audit degradation fixture",
        description: "The database trigger remains the atomic audit fallback",
        actorId: owner.id,
      });
      const persisted = await service.listStudies({
        page: { offset: 0, limit: 200 },
      });
      assert.equal(
        persisted.items.filter((entry) => entry.id === created.id).length,
        1,
        "a semantic audit outage must still return the single committed mutation",
      );
      const auditResult = await dbHandle.db.execute(sql`
        SELECT actor_kind, actor_id, action, target, detail
          FROM audit_log
         WHERE target = ${`science_studies:${created.id}`}
           AND action = 'science.study.create'
      `);
      const auditRows = auditResult.rows ?? auditResult;
      assert.deepEqual(auditRows, [{
        actor_kind: "user",
        actor_id: owner.id,
        action: "science.study.create",
        target: `science_studies:${created.id}`,
        detail: {
          operation: "insert",
          state: "active",
          table: "science_studies",
        },
      }], "the atomic trigger must retain initiating-user attribution when the semantic sink fails");
    },
  );
  const notebookBytes = Buffer.from(
    JSON.stringify({
      cells: [],
      metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
    "utf8",
  );
  const notebook = await uploadArtifact(mainService, {
    studyId: study.id,
    actorId: owner.id,
    logicalName: "solver.ipynb",
    kind: "notebook",
    format: "ipynb",
    mediaType: "application/x-ipynb+json",
    bytes: notebookBytes,
  });
  assert.equal(notebook.version.metadata.detectedFormat, "ipynb");
  assert.equal(notebook.version.metadata.formatValidation, "parsed");

  await acceptance("zero-byte manual upload remains checksummed and immutable", async () => {
    const empty = await uploadArtifact(mainService, {
      studyId: study.id,
      actorId: owner.id,
      logicalName: "empty-observation.txt",
      kind: "dataset",
      format: "txt",
      mediaType: "text/plain",
      bytes: Buffer.alloc(0),
    });
    assert.equal(empty.version.sizeBytes, 0);
    assert.equal(empty.version.sha256, digest(Buffer.alloc(0)));
    const opened = await store.open(empty.version.storageKey);
    assert.deepEqual(await bytesOf(opened.body), Buffer.alloc(0));
  });

  await acceptance("checksum-confirmed retention tombstones unreferenced ready bytes", async () => {
    const retained = await uploadArtifact(mainService, {
      studyId: study.id,
      actorId: owner.id,
      logicalName: "retention-expiry.bin",
      kind: "dataset",
      format: "binary",
      mediaType: "application/octet-stream",
      bytes: Buffer.from("retention expiry fixture", "utf8"),
    });
    await assert.rejects(
      mainService.expireArtifactVersion({
        versionId: retained.version.id,
        confirmSha256: "0".repeat(64),
        actorId: owner.id,
      }),
      /confirmation checksum/i,
    );
    const expired = await mainService.expireArtifactVersion({
      versionId: retained.version.id,
      confirmSha256: retained.version.sha256,
      actorId: owner.id,
    });
    assert.equal(expired.status, "expired");
    assert.equal(expired.sha256, retained.version.sha256);
    const tombstone = await mainService.getArtifactVersion(retained.version.id);
    assert.equal(tombstone.status, "expired");
    assert.equal(tombstone.cleanupEligible, false);
    assert.equal(tombstone.version, retained.version.version);
    await assert.rejects(
      store.open(retained.version.storageKey),
      /ENOENT|404|failed/i,
      "retention metadata must not release quota before immutable bytes are gone",
    );
  });

  await acceptance("filesystem promotion retry recovers after quarantine disappears", async () => {
    const baseStore = new FilesystemArtifactStore({
      root: join(artifactRoot, "promotion-filesystem"),
      referenceSecret: STORAGE_SECRET,
    });
    const crashStore = crashAfterCommittedPromotion(baseStore);
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store: crashStore,
      computeProviders: createComputeRegistry(),
      workerId: "acceptance-promotion-filesystem",
    });
    await verifyCommittedPromotionRetry(service, baseStore, {
      studyId: study.id,
      actorId: owner.id,
      logicalName: "promotion-retry-filesystem.bin",
      bytes: Buffer.from("filesystem promotion crash recovery", "utf8"),
    });
  });

  await acceptance("S3 promotion retry recovers after local quarantine disappears", async () => {
    const mock = await startS3Mock();
    try {
      const baseStore = new S3CompatibleArtifactStore({
        endpoint: mock.endpoint,
        bucket: "science-service",
        accessKeyId: "fixture-access",
        secretAccessKey: "fixture-secret",
        quarantineRoot: join(artifactRoot, "promotion-s3-quarantine"),
        referenceSecret: STORAGE_SECRET,
      });
      const crashStore = crashAfterCommittedPromotion(baseStore);
      const service = createService({
        db: dbHandle.db,
        workspaceId: workspaceA.id,
        store: crashStore,
        computeProviders: createComputeRegistry(),
        workerId: "acceptance-promotion-s3",
      });
      await verifyCommittedPromotionRetry(service, baseStore, {
        studyId: study.id,
        actorId: owner.id,
        logicalName: "promotion-retry-s3.bin",
        bytes: Buffer.from("S3 promotion crash recovery", "utf8"),
      });
      assert.equal(mock.objects.size, 1);
    } finally {
      await mock.close();
    }
  });

  await acceptance("checksum mismatch remains quarantined", async () => {
    const artifact = await mainService.createArtifact({
      studyId: study.id,
      logicalName: "bad-checksum.dat",
      kind: "dataset",
      format: "binary",
      actorId: owner.id,
    });
    const declared = Buffer.from("declared bytes", "utf8");
    const actual = Buffer.from("tampered bytes", "utf8");
    assert.equal(declared.length, actual.length);
    const begun = await mainService.beginUpload({
      artifactId: artifact.id,
      expectedSizeBytes: declared.length,
      expectedSha256: digest(declared),
      actorId: owner.id,
    });
    await assert.rejects(
      mainService.writeUpload(begun.uploadToken, Readable.from([actual]), owner.id),
      /checksum mismatch/i,
    );
    const persisted = await getScienceUploadByTokenHash(
      dbHandle.db,
      workspaceA.id,
      digest(begun.uploadToken),
    );
    assert.equal(persisted?.state, "quarantined");
    assert.equal(persisted?.artifactVersionId, null);
  });

  await acceptance("declared artifact format is validated before readiness", async () => {
    const artifact = await mainService.createArtifact({
      studyId: study.id,
      logicalName: "not-a-notebook.ipynb",
      kind: "notebook",
      format: "ipynb",
      actorId: owner.id,
    });
    const bytes = Buffer.from(JSON.stringify({ schema: "not-a-notebook" }), "utf8");
    const begun = await mainService.beginUpload({
      artifactId: artifact.id,
      expectedSizeBytes: bytes.length,
      expectedSha256: digest(bytes),
      actorId: owner.id,
    });
    await assert.rejects(
      mainService.writeUpload(begun.uploadToken, Readable.from([bytes]), owner.id),
      /Jupyter notebook/i,
    );
    const persisted = await getScienceUploadByTokenHash(
      dbHandle.db,
      workspaceA.id,
      digest(begun.uploadToken),
    );
    assert.equal(persisted?.state, "quarantined");
    assert.equal(persisted?.artifactVersionId, null);
  });

  await acceptance("signed scoped range read and workspace isolation", async () => {
    const reference = await store.reference(notebook.version.storageKey, {
      versionId: notebook.version.id,
      sha256: notebook.version.sha256,
      size: notebook.version.sizeBytes,
      audience: "acceptance-range-reader",
      ttlSeconds: 60,
    });
    const parsed = new URL(reference.url, "http://science.local");
    const start = 3;
    const end = 17;
    const opened = await mainService.openArtifactVersion({
      versionId: notebook.version.id,
      range: { start, end },
      signed: {
        audience: parsed.searchParams.get("audience"),
        expires: parsed.searchParams.get("expires"),
        signature: parsed.searchParams.get("sig"),
      },
    });
    assert.deepEqual(await bytesOf(opened.read.body), notebookBytes.subarray(start, end + 1));
    assert.equal(opened.read.size, notebookBytes.length);

    const otherWorkspace = createService({
      db: dbHandle.db,
      workspaceId: workspaceB.id,
      store,
      computeProviders: createComputeRegistry(),
      workerId: "acceptance-other-workspace",
    });
    assert.deepEqual((await otherWorkspace.listStudies()).items, []);
    await assert.rejects(
      otherWorkspace.openArtifactVersion({
        versionId: notebook.version.id,
        signed: {
          audience: parsed.searchParams.get("audience"),
          expires: parsed.searchParams.get("expires"),
          signature: parsed.searchParams.get("sig"),
        },
      }),
      /not found/i,
    );
  });

  await acceptance("secret-bearing compute configuration is rejected", async () => {
    for (const key of [
      "providerToken",
      "apiKey",
      "provider_token",
      "password",
      "authorization",
      "accessKeyId",
      "bearer",
      "key",
    ]) {
      let rejection;
      try {
        await mainService.createComputeProfile({
          name: `Unsafe provider configuration ${key}`,
          providerKind: "local_container",
          imageDigest: IMAGE_DIGEST,
          kernelName: "python3",
          resourceBounds: RESOURCE_BOUNDS,
          config: { [key]: PROVIDER_SECRET_SENTINEL },
          actorId: owner.id,
        });
      } catch (error) {
        rejection = error;
      }
      assert.match(
        rejection instanceof Error ? rejection.message : "",
        /secret-bearing field/i,
        `accepted secret-bearing configuration field ${key}`,
      );
    }
    await assert.rejects(
      mainService.createComputeProfile({
        name: "Unsafe inline provider payload",
        providerKind: "local_container",
        imageDigest: IMAGE_DIGEST,
        kernelName: "python3",
        resourceBounds: RESOURCE_BOUNDS,
        config: { documentation: "data:application/octet-stream;base64,AA==" },
        actorId: owner.id,
      }),
      /inline binary data/i,
    );
    await assert.rejects(
      mainService.createComputeProfile({
        name: "Oversized provider metadata",
        providerKind: "local_container",
        imageDigest: IMAGE_DIGEST,
        kernelName: "python3",
        resourceBounds: RESOURCE_BOUNDS,
        config: { documentation: "x".repeat(70 * 1024) },
        actorId: owner.id,
      }),
      /control-plane limit/i,
    );
  });

  const profile = await mainService.createComputeProfile({
    name: "Pinned deterministic Python",
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

  await acceptance("provider telemetry is capped at 1000 persisted run events", async () => {
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry({
        provisioningMs: 60_000,
        runningMs: 60_000,
      }),
      workerId: "acceptance-telemetry-cap",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-telemetry-cap",
    }));
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);

    const current = await service.getRun(submitted.run.id);
    assert.equal(current.state, "provisioning");
    const leaseOwner = "acceptance-telemetry-cap:manual";
    const leased = await acquireScienceRunLease(dbHandle.db, {
      workspaceId: workspaceA.id,
      runId: current.id,
      expectedGeneration: current.executionGeneration,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const before = await getLatestScienceRunEvent(
      dbHandle.db,
      workspaceA.id,
      current.id,
    );
    assert.ok(before && before.sequence < 999);
    await dbHandle.db.execute(sql`
      INSERT INTO science_run_events (
        workspace_id, study_id, run_id, mission_id, sequence, event_type,
        execution_generation, state, payload
      )
      SELECT
        ${workspaceA.id}, ${current.studyId}, ${current.id}, ${current.missionId},
        sequence, 'science.run.progress', ${current.executionGeneration},
        ${current.state}, '{"fixture":"telemetry-cap-preseed"}'::jsonb
        FROM generate_series(${before.sequence + 1}, 999) AS sequence
    `);

    await service.appendTelemetry(leased, leaseOwner, {
      progress: 0.99,
      message: "last admitted provider telemetry",
      logs: ["must not cross the cap", "must also be suppressed"],
    });
    await service.appendTelemetry(leased, leaseOwner, {
      progress: 1,
      message: "over-cap provider telemetry",
      logs: ["over-cap log"],
    });
    const after = await getLatestScienceRunEvent(
      dbHandle.db,
      workspaceA.id,
      current.id,
    );
    assert.equal(after?.sequence, 1_000);
    assert.equal(after?.eventType, "science.run.progress");
    assert.equal(after?.payload.message, "last admitted provider telemetry");

    await releaseScienceRunLease(dbHandle.db, {
      workspaceId: workspaceA.id,
      runId: current.id,
      expectedGeneration: current.executionGeneration,
      leaseOwner,
    });
    await service.cancelRun({
      runId: current.id,
      expectedGeneration: current.executionGeneration,
      actorId: owner.id,
    });
    await service.tick(current.id, current.executionGeneration);
    assert.equal((await service.getRun(current.id)).state, "cancelled");
  });

  await acceptance("unhealthy provider before submit cannot create an unmarked execution", async () => {
    const provider = new UnhealthyBeforeSubmitProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-unhealthy-before-submit",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-unhealthy-before-submit",
    }));
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);
    const pending = await service.getRun(submitted.run.id);
    assert.equal(pending.state, "provisioning");
    assert.equal(pending.providerHandle, null);
    assert.equal(provider.healthCalls, 1);
    assert.equal(provider.submitCalls, 0);
    assert.equal(
      (await service.getRunDossier(submitted.run.id, 100)).events.items.some(
        (event) => event.eventType === "science.run.submit_attempted",
      ),
      false,
    );

    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(provider.healthCalls, 1, "local cancellation must not probe provider health");
    assert.equal(provider.cancelCalls, 0);
  });

  await acceptance("explicit queued cancellation terminalizes without provider health", async () => {
    const provider = new UnhealthyBeforeSubmitProvider("explicit-cancel-provider");
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-explicit-local-cancel",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-explicit-local-cancel",
    }));
    await approve(service, submitted, owner.id);
    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 0,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 0);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(provider.healthCalls, 0);
    assert.equal(provider.submitCalls, 0);
    assert.equal(provider.cancelCalls, 0);
  });

  await acceptance("cancellation before the durable submit marker prevents external submit", async () => {
    const provider = new GatedHealthProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-cancel-before-submit-marker",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-cancel-before-submit-marker",
    }));
    await approve(service, submitted, owner.id);
    const tick = service.tick(submitted.run.id, 0);
    await provider.healthEntered.promise;
    try {
      const requested = await service.cancelRun({
        runId: submitted.run.id,
        expectedGeneration: 1,
        actorId: owner.id,
      });
      assert.equal(requested.run.state, "cancelling");
    } finally {
      provider.releaseHealth();
    }
    await tick;
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(provider.submitCalls, 0);
    assert.equal(
      (await service.getRunDossier(submitted.run.id, 100)).events.items.some(
        (event) => event.eventType === "science.run.submit_attempted",
      ),
      false,
    );
  });

  await acceptance("expired no-attempt provisioning terminalizes without another health probe", async () => {
    const provider = new UnhealthyBeforeSubmitProvider("deadline-provider");
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-local-provisioning-deadline",
    });
    const submitted = await service.submitRun({
      ...runIntent({
        studyId: study.id,
        profileId: profile.id,
        inputVersionId: notebook.version.id,
        actorId: owner.id,
        key: "acceptance-local-provisioning-deadline",
      }),
      resourceRequest: { ...RESOURCE_REQUEST, wallTimeSeconds: 1 },
    });
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);
    assert.equal((await service.getRun(submitted.run.id)).state, "provisioning");
    assert.equal(provider.healthCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(provider.healthCalls, 1);
    assert.equal(provider.submitCalls, 0);
    assert.equal(provider.cancelCalls, 0);
  });

  await acceptance("lost submit response recovers only through the same provider instance", async () => {
    const provider = new LostSubmitResponseProvider("lost-response-instance");
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-lost-submit-recovery",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-lost-submit-recovery",
    }));
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);
    const ambiguous = await service.getRun(submitted.run.id);
    assert.equal(ambiguous.state, "provisioning");
    assert.equal(ambiguous.providerHandle, null);
    const firstDossier = await service.getRunDossier(submitted.run.id, 100);
    assert.equal(
      firstDossier.events.items.filter(
        (event) => event.eventType === "science.run.submit_attempted",
      ).length,
      1,
    );
    assert.equal(provider.submitCalls, 1);

    await service.tick(submitted.run.id, 1);
    const recovered = await service.getRun(submitted.run.id);
    assert.equal(recovered.state, "provisioning");
    assert.ok(recovered.providerHandle);
    assert.equal(provider.submitCalls, 2);
    const recoveredDossier = await service.getRunDossier(submitted.run.id, 100);
    assert.equal(
      recoveredDossier.events.items.filter(
        (event) => event.eventType === "science.run.submit_attempted",
      ).length,
      1,
    );
    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
  });

  await acceptance("cancellation after an ambiguous submit recovers and cancels the same execution", async () => {
    const provider = new LostSubmitResponseProvider("lost-response-cancel-instance");
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-lost-submit-cancel",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-lost-submit-cancel",
    }));
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);
    assert.equal((await service.getRun(submitted.run.id)).providerHandle, null);

    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(provider.submitCalls, 2);
    assert.equal(provider.cancelCalls, 1);
    const dossier = await service.getRunDossier(submitted.run.id, 100);
    assert.equal(
      dossier.events.items.filter(
        (event) => event.eventType === "science.run.submit_attempted",
      ).length,
      1,
      "ambiguous cancellation must reuse one durable submission marker",
    );
  });

  await acceptance("ambiguous submit is admin-fenced across provider instance drift", async () => {
    const original = new LostSubmitResponseProvider("ambiguous-instance-original");
    const originalService = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(original),
      workerId: "acceptance-ambiguous-submit-original",
    });
    const submitted = await originalService.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-ambiguous-submit-instance-drift",
    }));
    await approve(originalService, submitted, owner.id);
    await originalService.tick(submitted.run.id, 0);
    assert.equal((await originalService.getRun(submitted.run.id)).providerHandle, null);
    assert.equal(original.submitCalls, 1);

    const replacement = new LostSubmitResponseProvider("ambiguous-instance-replacement");
    const localAudit = [];
    const replacementService = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(replacement),
      workerId: "acceptance-ambiguous-submit-replacement",
      auditEntries: localAudit,
    });
    const fencedTick = await replacementService.tick(submitted.run.id, 1);
    assert.equal(fencedTick.nextPollMs, 60_000);
    const fenced = await replacementService.getRun(submitted.run.id);
    assert.equal(fenced.state, "cancelling");
    assert.equal(fenced.finishedAt, null);
    assert.equal(fenced.providerHandle, null);
    assert.equal(replacement.submitCalls, 0);
    assert.equal(replacement.statusCalls, 0);
    assert.equal(replacement.cancelCalls, 0);
    assert.ok(
      (await replacementService.getRunDossier(submitted.run.id, 100)).events.items.some(
        (event) => event.payload.providerIdentityFenced === true &&
          event.payload.adminActionRequired === true,
      ),
    );
    assert.ok(
      localAudit.some(
        (entry) => entry.action === "science.run.orphaned" &&
          entry.detail?.adminActionRequired === true,
      ),
    );

    await originalService.tick(submitted.run.id, 1);
    assert.equal((await originalService.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(original.submitCalls, 2);
    assert.equal(original.cancelCalls, 1);
  });

  await acceptance("approved replay repairs a failed queue handoff", async () => {
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry(),
      workerId: "acceptance-approval-replay",
    });
    let enqueueAttempts = 0;
    service.attachScheduler({
      async start() {},
      async enqueue() {
        enqueueAttempts++;
        if (enqueueAttempts === 1) {
          throw new Error("fixture queue handoff unavailable");
        }
      },
      async health() {
        return {
          ok: true,
          adapter: "inline",
          state: "running",
          pending: 0,
          active: 0,
        };
      },
      async close() {},
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-approval-queue-replay",
    }));
    await assert.rejects(
      approve(service, submitted, owner.id),
      /fixture queue handoff unavailable/,
    );
    assert.equal((await service.getRun(submitted.run.id)).state, "queued");
    const replayed = await approve(service, submitted, owner.id);
    assert.equal(replayed.transitioned, false);
    assert.equal(replayed.run.state, "queued");
    assert.equal(enqueueAttempts, 2);
    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 0,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 0);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
  });

  let sourceRun;
  let sourceDossier;
  await acceptance("scheduler drives approved run to checksummed outputs and complete manifest", async () => {
    const quote = await mainService.quote({
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
    });
    assert.equal(quote.available, true);
    const submitted = await mainService.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-source-run",
    }));
    assert.equal(submitted.run.state, "awaiting_approval");
    await approve(mainService, submitted, owner.id);
    sourceRun = await waitForRun(mainService, submitted.run.id, ["succeeded"]);
    assert.equal(sourceRun.executionGeneration, 1);
    assert.match(sourceRun.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(sourceRun.manifest?.complete, true);
    assert.deepEqual(sourceRun.manifest?.gaps, []);
    assert.equal(sourceRun.manifest?.codeArtifactVersionId, notebook.version.id);

    sourceDossier = await mainService.getRunDossier(sourceRun.id, 50);
    assert.equal(sourceDossier.inputs.length, 1);
    assert.equal(sourceDossier.outputs.length, 2);
    for (const output of sourceDossier.outputs) {
      assert.equal(output.version?.status, "ready");
      const object = await store.open(output.version.storageKey);
      const bytes = await bytesOf(object.body);
      assert.equal(bytes.length, output.version.sizeBytes);
      assert.equal(digest(bytes), output.version.sha256);
    }
    assert.equal(schedulerErrors.length, 0);
    assert.ok(publishedEvents.some((event) => event.type === "science.run.succeeded"));
  });

  let reproducedRun;
  if (sourceRun) {
    await acceptance("reproduce and provenance comparison distinguish output identity", async () => {
      const reproduced = await mainService.reproduceRun({
        runId: sourceRun.id,
        actorId: owner.id,
        idempotencyKey: "acceptance-reproduce",
      });
      await approve(mainService, reproduced, owner.id);
      reproducedRun = await waitForRun(mainService, reproduced.run.id, ["succeeded"]);
      assert.equal(reproducedRun.manifest?.complete, true);
      const compared = await mainService.compareRuns(sourceRun.id, reproducedRun.id);
      assert.equal(compared.comparison.sameInputs, true);
      assert.equal(compared.comparison.sameParameters, true);
      assert.equal(compared.comparison.sameEnvironment, true);
      assert.equal(compared.comparison.sameOutputs, false);
      assert.equal(compared.comparison.numericallyEquivalent, null);
      assert.equal(compared.comparison.numericalValidation, null);
    });

    await acceptance("terminal reproduce retry is idempotent", async () => {
      const duplicate = await mainService.reproduceRun({
        runId: sourceRun.id,
        actorId: owner.id,
        idempotencyKey: "acceptance-reproduce",
      });
      assert.equal(duplicate.run.id, reproducedRun.id);
      assert.equal(duplicate.created, false);
    });
  }

  await acceptance("exact-generation queued cancellation reaches terminal state", async () => {
    const cancellationService = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry(),
      workerId: "acceptance-cancel",
    });
    const submitted = await cancellationService.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-cancel-run",
    }));
    await approve(cancellationService, submitted, owner.id);
    await assert.rejects(
      cancellationService.cancelRun({
        runId: submitted.run.id,
        expectedGeneration: 99,
        actorId: owner.id,
      }),
      /generation is stale/i,
    );
    const requested = await cancellationService.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 0,
      actorId: owner.id,
    });
    assert.equal(requested.run.state, "cancelling");
    await cancellationService.tick(submitted.run.id, 0);
    const cancelled = await cancellationService.getRun(submitted.run.id);
    assert.equal(cancelled.state, "cancelled");
  });

  await acceptance("cancellation racing in-flight submit persists handle and waits for terminal status", async () => {
    const provider = new InFlightSubmitProvider();
    const computeProviders = registryWith(provider);
    const submitWorker = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders,
      workerId: "acceptance-submit-race",
    });
    const cancelWorker = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders,
      workerId: "acceptance-submit-race-cancel",
    });
    const submitted = await submitWorker.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-submit-cancel-race",
    }));
    await approve(submitWorker, submitted, owner.id);
    const tick = submitWorker.tick(submitted.run.id, 0);
    await provider.submitEntered.promise;
    try {
      const provisioning = await submitWorker.getRun(submitted.run.id);
      assert.equal(provisioning.state, "provisioning");
      assert.equal(provisioning.executionGeneration, 1);
      const requested = await phase("request cancellation while submit is blocked", () =>
        cancelWorker.cancelRun({
        runId: submitted.run.id,
        expectedGeneration: 1,
        actorId: owner.id,
        }));
      assert.equal(requested.run.state, "cancelling");
      provider.releaseSubmit();
      const first = await phase("finish submit-owning tick", () => tick);
      assert.equal(first.nextPollMs, CONFIG.pollIntervalMs);
      const pending = await submitWorker.getRun(submitted.run.id);
      assert.equal(pending.state, "cancelling");
      assert.ok(pending.providerHandle?.endsWith(`:${provider.lastHandle}`));
      assert.equal(pending.finishedAt, null);
      assert.equal(pending.leaseOwner, null);
      assert.equal(provider.cancelCalls, 1);

      provider.confirmTerminal();
      const terminalTick = await phase("poll terminal cancellation", () =>
        cancelWorker.tick(submitted.run.id, 1));
      assert.equal(terminalTick.nextPollMs, null);
      const cancelled = await cancelWorker.getRun(submitted.run.id);
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.providerHandle, pending.providerHandle);
    } finally {
      provider.releaseSubmit();
      await tick.catch(() => {});
    }
  });

  await acceptance("provider cancel rejection remains cancelling until provider is terminal", async () => {
    const provider = new RefusingCancelProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-cancel-refused",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-cancel-refused",
    }));
    await approve(service, submitted, owner.id);
    const runningTick = await phase("submit and enter running", () =>
      service.tick(submitted.run.id, 0));
    assert.equal(runningTick.nextPollMs, CONFIG.pollIntervalMs);
    const running = await service.getRun(submitted.run.id);
    assert.equal(running.state, "running");
    assert.equal(running.leaseOwner, null);

    await phase("request provider-refused cancellation", () => service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    }));
    const pendingTick = await phase("poll rejected cancellation while running", () =>
      service.tick(submitted.run.id, 1));
    assert.equal(pendingTick.nextPollMs, CONFIG.pollIntervalMs);
    const pending = await service.getRun(submitted.run.id);
    assert.equal(pending.state, "cancelling");
    assert.equal(pending.finishedAt, null);
    assert.equal(pending.leaseOwner, null);
    assert.equal(provider.cancelCalls, 1);

    provider.confirmTerminal();
    const terminalTick = await phase("poll provider-refused cancellation after terminal", () =>
      service.tick(submitted.run.id, 1));
    assert.equal(terminalTick.nextPollMs, null);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
  });

  await acceptance("same-generation duplicate tick is fenced by a worker lease", async () => {
    const gatedProvider = new GatedDeterministicProvider();
    const gatedRegistry = new ComputeProviderRegistry();
    gatedRegistry.register(gatedProvider);
    const workerA = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: gatedRegistry,
      workerId: "acceptance-race-a",
    });
    const workerB = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: gatedRegistry,
      workerId: "acceptance-race-b",
    });
    const submitted = await workerA.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-race-run",
    }));
    await approve(workerA, submitted, owner.id);

    const firstTick = workerA.tick(submitted.run.id, 0);
    await gatedProvider.entered;
    const during = await workerA.getRun(submitted.run.id);
    assert.equal(during.executionGeneration, 1);
    assert.equal(during.state, "provisioning");
    assert.ok(during.leaseOwner);

    const duplicate = await workerB.tick(submitted.run.id, 1);
    assert.equal(duplicate.nextPollMs, CONFIG.pollIntervalMs);
    const stillOwned = await workerA.getRun(submitted.run.id);
    assert.equal(stillOwned.leaseOwner, during.leaseOwner);
    gatedProvider.release();
    await firstTick;

    const finishingWorker = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry(),
      workerId: "acceptance-race-finish",
    });
    await finishingWorker.tick(submitted.run.id, 1);
    const finished = await finishingWorker.getRun(submitted.run.id);
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.executionGeneration, 1);
    assert.equal((await finishingWorker.getRunDossier(finished.id)).outputs.length, 2);
  });

  await acceptance("lease heartbeat prevents takeover during a long output stream", async () => {
    const provider = new SlowOutputProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-output-heartbeat",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-output-heartbeat",
    }));
    await approve(service, submitted, owner.id);
    const tick = service.tick(submitted.run.id, 0);
    await provider.outputEntered.promise;
    try {
      const initiallyLeased = await service.getRun(submitted.run.id);
      assert.equal(initiallyLeased.state, "finalizing");
      assert.ok(initiallyLeased.leaseOwner);
      assert.ok(initiallyLeased.leaseExpiresAt);
      const initialExpiry = initiallyLeased.leaseExpiresAt;

      const heartbeatDeadline = Date.now() + 13_000;
      let renewed = initiallyLeased;
      while (
        Date.now() < heartbeatDeadline &&
        renewed.leaseExpiresAt.getTime() < initialExpiry.getTime() + 5_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        renewed = await service.getRun(submitted.run.id);
      }
      assert.ok(
        renewed.leaseExpiresAt.getTime() >= initialExpiry.getTime() + 5_000,
        "worker lease did not heartbeat while output bytes were blocked",
      );

      const logicalTimeAfterOriginalExpiry = new Date(initialExpiry.getTime() + 1);
      await assert.rejects(
        acquireScienceRunLease(dbHandle.db, {
          workspaceId: workspaceA.id,
          runId: submitted.run.id,
          expectedGeneration: 1,
          leaseOwner: "acceptance-logical-takeover",
          now: logicalTimeAfterOriginalExpiry,
          leaseExpiresAt: new Date(logicalTimeAfterOriginalExpiry.getTime() + 30_000),
        }),
        /live worker lease/i,
      );
    } finally {
      provider.releaseOutput();
      await tick;
    }
    const finished = await service.getRun(submitted.run.id);
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.executionGeneration, 1);
  });

  await acceptance("cancellation interleaving cannot publish an unlinked ready output", async () => {
    const provider = new SlowOutputProvider();
    const computeProviders = registryWith(provider);
    const ingestWorker = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders,
      workerId: "acceptance-output-cancel-ingest",
    });
    const cancelWorker = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders,
      workerId: "acceptance-output-cancel-request",
    });
    const submitted = await ingestWorker.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-output-cancel-interleave",
    }));
    await approve(ingestWorker, submitted, owner.id);

    const tick = ingestWorker.tick(submitted.run.id, 0);
    await provider.outputEntered.promise;
    try {
      const requested = await cancelWorker.cancelRun({
        runId: submitted.run.id,
        expectedGeneration: 1,
        actorId: owner.id,
      });
      assert.equal(requested.run.state, "cancelling");
    } finally {
      provider.releaseOutput();
      await tick;
    }

    const interrupted = await ingestWorker.getRun(submitted.run.id);
    assert.equal(interrupted.state, "cancelling");
    const interruptedDossier = await ingestWorker.getRunDossier(submitted.run.id, 100);
    assert.equal(interruptedDossier.outputs.length, 0);
    const artifacts = await ingestWorker.listArtifacts({
      studyId: study.id,
      page: { offset: 0, limit: 200 },
    });
    const produced = artifacts.items.filter((artifact) =>
      artifact.logicalName.startsWith(`run-${submitted.run.id}-`));
    assert.equal(produced.length, 1);
    assert.equal(produced[0].latestVersion?.status, "quarantined");
    await assert.rejects(
      store.open(produced[0].latestVersion.storageKey),
      /ENOENT|404|failed/i,
      "a fenced output commit must remove its promoted but unreachable object",
    );
    await dbHandle.db.execute(
      sql`update science_artifact_versions
            set created_at = now() - interval '2 minutes'
          where id = ${produced[0].latestVersion.id}`,
    );
    const retention = await ingestWorker.cleanupRetention();
    assert.ok(
      retention.expiredArtifactVersions >= 1,
      "periodic retention must retry and release abandoned provider-version quota",
    );
    const afterRetention = await ingestWorker.listArtifacts({
      studyId: study.id,
      page: { offset: 0, limit: 200 },
    });
    const discardedTombstone = afterRetention.items.find(
      (artifact) => artifact.id === produced[0].id,
    )?.latestVersion;
    assert.equal(discardedTombstone?.status, "expired");
    assert.equal(discardedTombstone?.cleanupEligible, false);
    assert.equal(
      discardedTombstone?.version,
      produced[0].latestVersion.version,
      "discarded internal bytes must retain a non-reusable immutable version ordinal",
    );

    await cancelWorker.tick(submitted.run.id, 1);
    assert.equal((await cancelWorker.getRun(submitted.run.id)).state, "cancelled");
    assert.equal(
      (await cancelWorker.getRunDossier(submitted.run.id, 100)).outputs.length,
      0,
    );
  });

  await acceptance("output streaming stops on the first byte beyond the declared size", async () => {
    const provider = new DeclaredSizeOverrunProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-output-declared-size",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-output-declared-size",
    }));
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);

    assert.equal(provider.chunksRead, 2);
    const run = await service.getRun(submitted.run.id);
    assert.equal(run.state, "finalizing");
    const dossier = await service.getRunDossier(submitted.run.id, 100);
    assert.equal(dossier.outputs.length, 0);
    assert.ok(
      dossier.events.items.some((event) =>
        event.eventType === "science.run.log" &&
        event.payload.tickError === true &&
        /declared 4-byte size/i.test(String(event.payload.message))),
    );
    const artifacts = await service.listArtifacts({
      studyId: study.id,
      page: { offset: 0, limit: 200 },
    });
    const produced = artifacts.items.filter((artifact) =>
      artifact.logicalName.startsWith(`run-${submitted.run.id}-`));
    assert.equal(produced.length, 1);
    assert.equal(produced[0].latestVersion, null);

    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
  });

  await acceptance("provider output quota is reserved before opening the stream", async () => {
    const tracked = trackQuarantine(store);
    const provider = new CountingOutputOpenProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store: tracked.store,
      computeProviders: registryWith(provider),
      config: {
        ...CONFIG,
        // Existing retained input bytes already exceed this deliberately low
        // cap, so the first provider output must fail immutable admission.
        maxWorkspaceStorageBytes: 1,
      },
      workerId: "acceptance-output-workspace-quota",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-output-workspace-quota",
    }));
    await approve(service, submitted, owner.id);
    await service.tick(submitted.run.id, 0);

    const run = await service.getRun(submitted.run.id);
    assert.equal(run.state, "finalizing");
    const dossier = await service.getRunDossier(submitted.run.id, 100);
    assert.equal(dossier.outputs.length, 0);
    assert.ok(
      dossier.events.items.some((event) =>
        event.eventType === "science.run.log" &&
        event.payload.tickError === true &&
        /storage quota/i.test(String(event.payload.message))),
    );
    assert.equal(tracked.created.length, 1);
    assert.equal(
      provider.openCalls,
      0,
      "workspace quota rejection must occur before a provider byte stream is opened",
    );
    assert.deepEqual(
      tracked.discarded,
      tracked.created,
      "quota-rejected provider quarantine must be discarded in the same failed tick",
    );
    await assert.rejects(
      store.openQuarantine(tracked.created[0]),
      /ENOENT|404|failed/i,
      "quota-rejected provider bytes must not remain on local quarantine storage",
    );

    await service.cancelRun({
      runId: submitted.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    });
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
  });

  await acceptance("provider output lists above 200 are rejected, never truncated", async () => {
    const provider = new TooManyOutputsProvider();
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-output-limit",
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-output-limit",
    }));
    await approve(service, submitted, owner.id);

    let run;
    for (let attempt = 0; attempt < 6; attempt++) {
      await service.tick(submitted.run.id, attempt === 0 ? 0 : 1);
      run = await service.getRun(submitted.run.id);
      if (run.state === "failed") break;
    }
    assert.equal(run.state, "failed");
    assert.match(run.error ?? "", /200|too big/i);
    const dossier = await service.getRunDossier(submitted.run.id, 100);
    assert.equal(dossier.outputs.length, 0);
    assert.equal(provider.openCalls, 0);
    assert.ok(
      dossier.events.items.some((event) =>
        event.eventType === "science.run.log" &&
        event.payload.tickError === true &&
        /200|too big/i.test(String(event.payload.message))),
    );
  });

  await acceptance("repeated provider transport errors enter orphan-safe cancellation", async () => {
    const provider = new UnreachableProvider();
    const localAudit = [];
    const service = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(provider),
      workerId: "acceptance-provider-unreachable",
      auditEntries: localAudit,
    });
    const submitted = await service.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-provider-unreachable",
    }));
    await approve(service, submitted, owner.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.tick(submitted.run.id, attempt === 0 ? 0 : 1);
    }
    const cancelling = await service.getRun(submitted.run.id);
    assert.equal(cancelling.state, "cancelling");
    assert.equal(cancelling.finishedAt, null);
    assert.ok(cancelling.providerHandle);
    assert.ok(
      localAudit.some((entry) =>
        entry.action === "science.run.orphaned" &&
        entry.detail?.adminActionRequired === true),
    );
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelling");
    assert.equal(provider.cancelCalls, 1);
    provider.confirmTerminal();
    await service.tick(submitted.run.id, 1);
    assert.equal((await service.getRun(submitted.run.id)).state, "cancelled");
  });

  await acceptance("provider instance drift never polls or cancels the replacement", async () => {
    const original = new UnreachableProvider("runtime-instance-original");
    const originalService = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(original),
      workerId: "acceptance-provider-identity-original",
    });
    const submitted = await originalService.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-provider-identity-drift",
    }));
    await approve(originalService, submitted, owner.id);
    await originalService.tick(submitted.run.id, 0);
    assert.ok((await originalService.getRun(submitted.run.id)).providerHandle);

    const replacement = new UnreachableProvider("runtime-instance-replacement");
    const replacementService = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(replacement),
      workerId: "acceptance-provider-identity-replacement",
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await replacementService.tick(submitted.run.id, 1);
    }
    const protectedRun = await replacementService.getRun(submitted.run.id);
    assert.equal(protectedRun.state, "cancelling");
    assert.equal(protectedRun.finishedAt, null);
    assert.equal(replacement.cancelCalls, 0);
    original.confirmTerminal();
    await originalService.tick(submitted.run.id, 1);
    assert.equal((await originalService.getRun(submitted.run.id)).state, "cancelled");
  });

  await mainScheduler.close();

  await acceptance("restart reconciliation covers every non-terminal run phase", async () => {
    const preparationProvider = new RestartMatrixProvider();
    const beforeRestart = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: registryWith(preparationProvider),
      workerId: "acceptance-restart-matrix-before",
    });
    const submit = (phase) => beforeRestart.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-restart-matrix-" + phase,
    }));

    const draft = (await createScienceRun(dbHandle.db, {
      workspaceId: workspaceA.id,
      studyId: study.id,
      computeProfileId: profile.id,
      resourceRequest: RESOURCE_REQUEST,
      idempotencyKey: "acceptance-restart-matrix-draft",
      inputs: [{ artifactVersionId: notebook.version.id, semanticRole: "notebook" }],
      parameters: { fixture: "restart-matrix-draft" },
      createdBy: owner.id,
    })).run;
    assert.equal(draft.state, "draft");

    const awaitingSubmission = await submit("awaiting-approval");
    const awaitingApproval = await beforeRestart.getRun(awaitingSubmission.run.id);
    assert.equal(awaitingApproval.state, "awaiting_approval");

    const queuedSubmission = await submit("queued");
    await approve(beforeRestart, queuedSubmission, owner.id);
    const queued = await beforeRestart.getRun(queuedSubmission.run.id);
    assert.equal(queued.state, "queued");

    const provisioningSubmission = await submit("provisioning");
    await approve(beforeRestart, provisioningSubmission, owner.id);
    preparationProvider.setPhase(provisioningSubmission.run.id, "provisioning");
    await beforeRestart.tick(provisioningSubmission.run.id, 0);
    const provisioning = await beforeRestart.getRun(provisioningSubmission.run.id);
    assert.equal(provisioning.state, "provisioning");

    const runningSubmission = await submit("running");
    await approve(beforeRestart, runningSubmission, owner.id);
    preparationProvider.setPhase(runningSubmission.run.id, "running");
    await beforeRestart.tick(runningSubmission.run.id, 0);
    const running = await beforeRestart.getRun(runningSubmission.run.id);
    assert.equal(running.state, "running");

    const finalizingSubmission = await submit("finalizing");
    await approve(beforeRestart, finalizingSubmission, owner.id);
    preparationProvider.setPhase(finalizingSubmission.run.id, "succeeded");
    preparationProvider.failSecondOutputFor(finalizingSubmission.run.id);
    await beforeRestart.tick(finalizingSubmission.run.id, 0);
    const finalizing = await beforeRestart.getRun(finalizingSubmission.run.id);
    assert.equal(finalizing.state, "finalizing");
    const partialFinalizingDossier = await beforeRestart.getRunDossier(finalizing.id, 100);
    assert.equal(partialFinalizingDossier.outputs.length, 1);
    const retainedOutputLink = partialFinalizingDossier.outputs[0].artifactVersionId;

    const cancellingSubmission = await submit("cancelling");
    await approve(beforeRestart, cancellingSubmission, owner.id);
    preparationProvider.setPhase(cancellingSubmission.run.id, "running");
    await beforeRestart.tick(cancellingSubmission.run.id, 0);
    const runningBeforeCancel = await beforeRestart.getRun(cancellingSubmission.run.id);
    assert.equal(runningBeforeCancel.state, "running");
    const cancellingResult = await beforeRestart.cancelRun({
      runId: cancellingSubmission.run.id,
      expectedGeneration: runningBeforeCancel.executionGeneration,
      actorId: owner.id,
    });
    const cancelling = cancellingResult.run;
    assert.equal(cancelling.state, "cancelling");

    const phaseRows = [
      { phase: "draft", run: draft, recoverable: false },
      { phase: "awaiting_approval", run: awaitingApproval, recoverable: false },
      { phase: "queued", run: queued, recoverable: true },
      { phase: "provisioning", run: provisioning, recoverable: true },
      { phase: "running", run: running, recoverable: true },
      { phase: "finalizing", run: finalizing, recoverable: true },
      { phase: "cancelling", run: cancelling, recoverable: true },
    ];
    for (const { phase, run, recoverable } of phaseRows) {
      assert.equal(run.state, phase);
      assert.equal(run.leaseOwner, null);
      if (recoverable && phase !== "queued") {
        assert.equal(run.executionGeneration, 1);
        assert.ok(run.providerHandle);
      } else {
        assert.equal(run.executionGeneration, 0);
        assert.equal(run.providerHandle, null);
      }
    }

    const cancellingSubmissionCall = preparationProvider.submitCalls.find(
      (call) => call.runId === cancelling.id,
    );
    assert.ok(cancellingSubmissionCall);

    const restartedStore = new FilesystemArtifactStore({
      root: artifactRoot,
      referenceSecret: STORAGE_SECRET,
    });
    const restartProvider = new RestartMatrixProvider();
    const restarted = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store: restartedStore,
      computeProviders: registryWith(restartProvider),
      workerId: "acceptance-restart-matrix-after",
    });
    const restartErrors = [];
    const restartScheduler = new RecordingInlineScienceScheduler(
      (runId, generation) => restarted.tick(runId, generation),
      (message, error) => restartErrors.push({ message, error }),
    );
    restarted.attachScheduler(restartScheduler);
    schedulers.push(restartScheduler);

    const reconciliation = await restarted.reconcile();
    const initiallyEnqueued = restartScheduler.enqueued.map((entry) => entry.runId).sort();
    const expectedRecoverable = phaseRows
      .filter((entry) => entry.recoverable)
      .map((entry) => entry.run.id)
      .sort();
    assert.equal(reconciliation.enqueued, expectedRecoverable.length);
    assert.deepEqual(initiallyEnqueued, expectedRecoverable);
    assert.equal(initiallyEnqueued.includes(draft.id), false);
    assert.equal(initiallyEnqueued.includes(awaitingApproval.id), false);
    assert.equal((await restarted.getRun(draft.id)).state, "draft");
    assert.equal((await restarted.getRun(awaitingApproval.id)).state, "awaiting_approval");

    const staleCancellation = await restarted.tick(cancelling.id, 0);
    assert.equal(staleCancellation.nextPollMs, null);
    assert.equal(restartProvider.cancelCalls.length, 0);
    const stillCancelling = await restarted.getRun(cancelling.id);
    assert.equal(stillCancelling.state, "cancelling");
    assert.equal(stillCancelling.executionGeneration, cancelling.executionGeneration);
    assert.equal(stillCancelling.providerHandle, cancelling.providerHandle);

    await restartScheduler.start();
    const [queuedRecovered, provisioningRecovered, runningRecovered, finalizingRecovered, cancelled] =
      await Promise.all([
        waitForRun(restarted, queued.id, ["succeeded"]),
        waitForRun(restarted, provisioning.id, ["succeeded"]),
        waitForRun(restarted, running.id, ["succeeded"]),
        waitForRun(restarted, finalizing.id, ["succeeded"]),
        waitForRun(restarted, cancelling.id, ["cancelled"]),
      ]);
    for (const recovered of [
      queuedRecovered,
      provisioningRecovered,
      runningRecovered,
      finalizingRecovered,
    ]) {
      assert.equal(recovered.manifest?.complete, true);
    }
    assert.equal((await restarted.getRun(draft.id)).state, "draft");
    assert.equal((await restarted.getRun(awaitingApproval.id)).state, "awaiting_approval");

    assert.equal(queuedRecovered.executionGeneration, 1);
    assert.ok(queuedRecovered.providerHandle);
    for (const [before, after] of [
      [provisioning, provisioningRecovered],
      [running, runningRecovered],
      [finalizing, finalizingRecovered],
      [cancelling, cancelled],
    ]) {
      assert.equal(after.executionGeneration, before.executionGeneration);
      assert.equal(after.providerHandle, before.providerHandle);
    }
    assert.deepEqual(
      restartProvider.submitCalls.map((call) => call.runId),
      [queued.id],
      "persisted handles must be resumed rather than submitted again",
    );
    assert.deepEqual(restartProvider.cancelCalls, [{
      runId: cancelling.id,
      generation: cancelling.executionGeneration,
      handle: cancellingSubmissionCall.handle,
      accepted: true,
    }]);

    const completedFinalizingDossier = await restarted.getRunDossier(finalizing.id, 100);
    assert.equal(completedFinalizingDossier.outputs.length, 2);
    assert.equal(
      completedFinalizingDossier.outputs.some(
        (entry) => entry.artifactVersionId === retainedOutputLink,
      ),
      true,
    );
    assert.equal(
      new Set(completedFinalizingDossier.outputs.map((entry) => entry.artifactVersionId)).size,
      2,
    );
    assert.equal(
      new Set(completedFinalizingDossier.outputs.map((entry) => entry.semanticRole)).size,
      2,
    );
    assert.equal(restartErrors.length, 0);
    await restartScheduler.close();
  });

  await acceptance("read-only mode reconciles and cancels existing runs but rejects new work", async () => {
    const writable = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry({
        provisioningMs: 60_000,
        runningMs: 60_000,
      }),
      workerId: "acceptance-read-only-prepare",
    });
    const activeSubmission = await writable.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-read-only-active",
    }));
    await approve(writable, activeSubmission, owner.id);
    await writable.tick(activeSubmission.run.id, 0);
    const active = await writable.getRun(activeSubmission.run.id);
    assert.equal(active.state, "provisioning");
    assert.ok(active.providerHandle);

    const cancelSubmission = await writable.submitRun(runIntent({
      studyId: study.id,
      profileId: profile.id,
      inputVersionId: notebook.version.id,
      actorId: owner.id,
      key: "acceptance-read-only-cancel",
    }));
    await approve(writable, cancelSubmission, owner.id);
    await writable.tick(cancelSubmission.run.id, 0);
    const cancellable = await writable.getRun(cancelSubmission.run.id);
    assert.equal(cancellable.state, "provisioning");
    assert.ok(cancellable.providerHandle);

    const readOnly = createService({
      db: dbHandle.db,
      workspaceId: workspaceA.id,
      store,
      computeProviders: createComputeRegistry(),
      config: { ...CONFIG, submissionsEnabled: false },
      workerId: "acceptance-read-only-runtime",
    });
    const cancellation = await readOnly.cancelRun({
      runId: cancelSubmission.run.id,
      expectedGeneration: 1,
      actorId: owner.id,
    });
    assert.equal(cancellation.run.state, "cancelling");
    assert.equal(cancellation.run.providerHandle, cancellable.providerHandle);
    await assert.rejects(
      readOnly.submitRun(runIntent({
        studyId: study.id,
        profileId: profile.id,
        inputVersionId: notebook.version.id,
        actorId: owner.id,
        key: "acceptance-read-only-rejected",
      })),
      /read-only/i,
    );
    await assert.rejects(
      readOnly.createStudy({
        name: "Must not be created in read-only mode",
        actorId: owner.id,
      }),
      /read-only/i,
    );

    const readOnlyErrors = [];
    const readOnlyScheduler = new InlineScienceScheduler(
      (runId, generation) => readOnly.tick(runId, generation),
      (message, error) => readOnlyErrors.push({ message, error }),
    );
    readOnly.attachScheduler(readOnlyScheduler);
    schedulers.push(readOnlyScheduler);
    const reconciliation = await readOnly.reconcile();
    assert.ok(reconciliation.enqueued >= 2);
    await readOnlyScheduler.start();
    const [recovered, cancelled] = await Promise.all([
      waitForRun(readOnly, activeSubmission.run.id, ["succeeded"]),
      waitForRun(readOnly, cancelSubmission.run.id, ["cancelled"]),
    ]);
    assert.equal(recovered.executionGeneration, 1);
    assert.equal(cancelled.executionGeneration, 1);
    assert.equal(cancelled.providerHandle, cancellable.providerHandle);
    assert.equal(
      readOnlyErrors.length,
      0,
      readOnlyErrors.map(({ message, error }) =>
        `${message}: ${error instanceof Error ? error.message : String(error)}`).join("\n"),
    );
    await readOnlyScheduler.close();
  });

  if (sourceRun && sourceDossier) {
    await acceptance("static render session opens, isolates owner, renews, and closes", async () => {
      const output = sourceDossier.outputs.find((entry) => entry.version)?.version;
      assert.ok(output);
      const rendered = await mainService.createRender({
        runId: sourceRun.id,
        artifactVersionId: output.id,
        mode: "static",
        actorId: owner.id,
      });
      assert.equal(rendered.session.state, "ready");
      assert.equal(rendered.mode, "static");
      assert.match(rendered.url, /^\/api\/science\/render-sessions\/[0-9a-f-]+\/gateway$/);
      await assert.rejects(
        mainService.renderStatus(rendered.session.id, otherMember.id),
        /not found/i,
      );
      const status = await mainService.renderStatus(rendered.session.id, owner.id);
      assert.equal(status.status.state, "ready");
      const renewed = await mainService.renewRender({
        sessionId: rendered.session.id,
        actorId: owner.id,
      });
      assert.equal(renewed.state, "ready");
      const closed = await mainService.closeRender({
        sessionId: rendered.session.id,
        actorId: owner.id,
      });
      assert.equal(closed.state, "revoked");
    });

    await acceptance("local render rejection never renews remote state", async () => {
      const output = sourceDossier.outputs.find((entry) => entry.version)?.version;
      assert.ok(output);
      for (const targetState of ["starting", "expired", "revoked"]) {
        const provider = new LongHandleRenderProvider(32, {
          instanceId: `render-local-${targetState}`,
          launchState: targetState === "starting" ? "starting" : "ready",
        });
        const service = createService({
          db: dbHandle.db,
          workspaceId: workspaceA.id,
          store,
          computeProviders: createComputeRegistry(),
          renderProviders: renderRegistryWith(provider),
          workerId: `acceptance-render-local-${targetState}`,
        });
        const rendered = await service.createRender({
          runId: sourceRun.id,
          artifactVersionId: output.id,
          mode: "remote",
          actorId: owner.id,
        });
        if (targetState !== "starting") {
          await transitionScienceRenderSession(dbHandle.db, {
            workspaceId: workspaceA.id,
            sessionId: rendered.session.id,
            ownerId: owner.id,
            to: targetState,
          });
        }
        await assert.rejects(
          service.renewRender({
            sessionId: rendered.session.id,
            actorId: owner.id,
          }),
          /live ready render session/i,
        );
        assert.deepEqual(
          provider.renewed,
          [],
          `remote renew was called for local state ${targetState}`,
        );
      }
    });

    await acceptance("render provider instance drift fences every remote operation", async () => {
      const provider = new LongHandleRenderProvider(32, {
        instanceId: "render-drift-a",
      });
      const service = createService({
        db: dbHandle.db,
        workspaceId: workspaceA.id,
        store,
        computeProviders: createComputeRegistry(),
        renderProviders: renderRegistryWith(provider),
        workerId: "acceptance-render-drift",
      });
      const output = sourceDossier.outputs.find((entry) => entry.version)?.version;
      assert.ok(output);
      const rendered = await service.createRender({
        runId: sourceRun.id,
        artifactVersionId: output.id,
        mode: "remote",
        actorId: owner.id,
      });
      assert.match(rendered.session.providerHandle, /:render-drift-a:/);
      provider.instanceId = "render-drift-b";

      await assert.rejects(
        service.renderGateway(rendered.session.id, owner.id),
        /identity changed.*admin action/i,
      );
      assert.equal(provider.statusCalls, 0);
      await assert.rejects(
        service.renewRender({
          sessionId: rendered.session.id,
          actorId: owner.id,
        }),
        /identity changed.*admin action/i,
      );
      assert.deepEqual(provider.renewed, []);
      await assert.rejects(
        service.closeRender({
          sessionId: rendered.session.id,
          actorId: owner.id,
        }),
        /identity changed.*admin action/i,
      );
      assert.deepEqual(provider.closed, []);

      await transitionScienceRenderSession(dbHandle.db, {
        workspaceId: workspaceA.id,
        sessionId: rendered.session.id,
        ownerId: owner.id,
        to: "expired",
      });
      await service.reconcile();
      assert.deepEqual(provider.closed, []);
    });

    await acceptance("near-limit remote render handle persists at exactly 500 characters", async () => {
      const durablePrefix = "science-render:trame:render-a:";
      const provider = new LongHandleRenderProvider(500 - durablePrefix.length);
      const service = createService({
        db: dbHandle.db,
        workspaceId: workspaceA.id,
        store,
        computeProviders: createComputeRegistry(),
        renderProviders: renderRegistryWith(provider),
        workerId: "acceptance-render-handle-limit",
      });
      const output = sourceDossier.outputs.find((entry) => entry.version)?.version;
      assert.ok(output);
      const rendered = await service.createRender({
        runId: sourceRun.id,
        artifactVersionId: output.id,
        mode: "remote",
        actorId: owner.id,
      });
      assert.equal(rendered.session.state, "ready");
      assert.equal(rendered.session.providerHandle.length, 500);
      await service.closeRender({
        sessionId: rendered.session.id,
        actorId: owner.id,
      });
      assert.deepEqual(provider.closed, [provider.handle]);
    });

    await acceptance("oversized remote render handle fails and cleans up launched provider", async () => {
      const durablePrefix = "science-render:trame:render-a:";
      const provider = new LongHandleRenderProvider(501 - durablePrefix.length);
      const service = createService({
        db: dbHandle.db,
        workspaceId: workspaceA.id,
        store,
        computeProviders: createComputeRegistry(),
        renderProviders: renderRegistryWith(provider),
        workerId: "acceptance-render-handle-overflow",
      });
      const before = await listScienceRenderSessions(dbHandle.db, {
        workspaceId: workspaceA.id,
        state: "failed",
        page: { offset: 0, limit: 200 },
      });
      const output = sourceDossier.outputs.find((entry) => entry.version)?.version;
      assert.ok(output);
      await assert.rejects(
        service.createRender({
          runId: sourceRun.id,
          artifactVersionId: output.id,
          mode: "remote",
          actorId: owner.id,
        }),
        /500-character limit/i,
      );
      assert.deepEqual(provider.closed, [provider.handle]);
      const after = await listScienceRenderSessions(dbHandle.db, {
        workspaceId: workspaceA.id,
        state: "failed",
        page: { offset: 0, limit: 200 },
      });
      assert.equal(
        after.items.length,
        before.items.length,
        "confirmed compensation close must remove the terminal render metadata",
      );
    });

    await acceptance("failed render compensation retains the admitted fenced handle", async () => {
      const provider = new LongHandleRenderProvider(32, {
        instanceId: "render-admitted-a",
        launchInstanceId: "invalid instance id",
        closeFails: true,
      });
      const service = createService({
        db: dbHandle.db,
        workspaceId: workspaceA.id,
        store,
        computeProviders: createComputeRegistry(),
        renderProviders: renderRegistryWith(provider),
        workerId: "acceptance-render-compensation-hold",
      });
      const output = sourceDossier.outputs.find((entry) => entry.version)?.version;
      assert.ok(output);
      await assert.rejects(
        service.createRender({
          runId: sourceRun.id,
          artifactVersionId: output.id,
          mode: "remote",
          actorId: owner.id,
        }),
        /bounded immutable instance ID/i,
      );
      assert.deepEqual(provider.closed, [provider.handle]);
      assert.deepEqual(provider.closeFences, ["render-admitted-a"]);
      const failed = await listScienceRenderSessions(dbHandle.db, {
        workspaceId: workspaceA.id,
        state: "failed",
        page: { offset: 0, limit: 200 },
      });
      const retained = failed.items.find((session) =>
        session.providerHandle?.includes(":render-admitted-a:"));
      assert.ok(retained, "failed compensation must retain the exact durable handle");
      await service.cleanupRetention();
      assert.ok(
        await getScienceRenderSessionForWorkspace(
          dbHandle.db,
          workspaceA.id,
          retained.id,
        ),
        "cleanup must retain a handle until provider close is proven",
      );
    });

    await acceptance("public science tool results contain no internal paths, handles, or secrets", async () => {
      const registry = new BuiltinToolRegistry();
      registerScienceTools(registry, {
        service: mainService,
        resolveActorId: async () => owner.id,
      });
      const context = { input: null, missionId: sourceRun.missionId };
      const expectedTiers = new Map([
        ["study.list", "read_auto"],
        ["artifact.inspect", "read_auto"],
        ["run.quote", "read_auto"],
        ["run.submit", "write_approved"],
        ["run.status", "read_auto"],
        ["run.cancel", "destructive_confirmed"],
        ["manifest.read", "read_auto"],
        ["render.open", "write_approved"],
      ]);
      for (const [tool, tier] of expectedTiers) {
        assert.equal(registry.info("science", tool)?.tier, tier);
      }
      const results = await Promise.all([
        registry.callTool(
          "science",
          "study.list",
          { limit: 10 },
          context,
        ),
        registry.callTool(
          "science",
          "artifact.inspect",
          { artifactId: notebook.artifact.id, limit: 10 },
          context,
        ),
        registry.callTool(
          "science",
          "run.status",
          { runId: sourceRun.id, eventLimit: 20 },
          context,
        ),
        registry.callTool(
          "science",
          "manifest.read",
          { runId: sourceRun.id },
          context,
        ),
        registry.callTool(
          "science",
          "run.quote",
          {
            computeProfileId: profile.id,
            resourceRequest: RESOURCE_REQUEST,
          },
          context,
        ),
      ]);
      const toolSubmission = await registry.callTool(
        "science",
        "run.submit",
        {
          studyId: study.id,
          computeProfileId: profile.id,
          resourceRequest: RESOURCE_REQUEST,
          inputs: [{
            artifactVersionId: notebook.version.id,
            semanticRole: "notebook",
          }],
          parameters: {
            sourceRevision: "89abcdef0123456789abcdef0123456789abcdef",
          },
          idempotencyKey: "acceptance-science-tool-submit",
        },
        context,
      );
      results.push(toolSubmission);
      assert.equal(toolSubmission.run.state, "awaiting_approval");
      const serialized = JSON.stringify(results);
      for (const forbidden of [
        STORAGE_SECRET,
        GATEWAY_SECRET,
        PROVIDER_SECRET_SENTINEL,
        artifactRoot,
      ]) {
        assert.equal(
          serialized.includes(forbidden),
          false,
          `public tool result leaked ${forbidden}`,
        );
      }
      assert.doesNotMatch(
        serialized,
        /"(storageKey|providerHandle|leaseOwner|leaseExpiresAt|heartbeatAt)":/,
      );
      assert.doesNotMatch(serialized, /data:[^;,]+;base64,/i);
    });
  }

  assert.ok(auditEntries.length > 0);
} catch (error) {
  failures.push({ name: "service verifier setup/core flow", error });
  console.error(
    `not ok - service verifier setup/core flow: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`,
  );
} finally {
  for (const scheduler of schedulers) {
    await scheduler.close().catch(() => {});
  }
  await dbHandle.close();
  await rm(artifactRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nSCIENCE SERVICE FAIL: ${failures.length} acceptance check(s) failed`);
  for (const { name, error } of failures) {
    console.error(`- ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "SCIENCE SERVICE PASS: upload, quarantine, signed ranges, execution, provenance, " +
    "reproduction, cancellation, fencing, restart recovery, isolation, render, and tool redaction",
  );
}
