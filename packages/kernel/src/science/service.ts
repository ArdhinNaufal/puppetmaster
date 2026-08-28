import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { ScienceAdminActionQueueItem } from "@puppetmaster/shared";
import type {
  ScienceAdminActionLink,
  ScienceArtifact,
  ScienceArtifactKind,
  ScienceArtifactVersion,
  ScienceDomainValidationSubmission,
  ScienceManifest,
  ScienceResourceBounds,
  ScienceRenderSession,
  ScienceRun,
  ScienceRunArtifact,
  ScienceRunEvent,
  ScienceStudy,
  ScienceWorkspaceAdmission,
} from "@puppetmaster/shared";
import {
  acquireScienceRunLease,
  assessScienceRunManifestForWorkspace,
  appendScienceRunEvent,
  archiveScienceStudy,
  beginScienceUpload,
  claimScienceUploadTransfer,
  claimScienceUploadFinalization,
  claimScienceArtifactVersionRetention,
  claimScienceRenderSessionLaunch,
  claimScienceRun,
  cleanupScienceArtifactVersionQuarantine,
  cleanupExpiredScienceRenderSessions,
  cleanupExpiredScienceUploads,
  commitScienceRunOutput,
  createScienceArtifact,
  createScienceArtifactVersion,
  createScienceComputeProfile,
  createScienceDomainValidation,
  createScienceRenderSession,
  createScienceRun,
  createScienceStudy,
  deleteScienceProviderOutputReservationAfterCommit,
  deleteExpiredScienceArtifactVersionAfterDiscard,
  deleteExpiredScienceRenderSessionTombstones,
  deleteTerminalScienceUploadAfterDiscard,
  deferScienceArtifactVersionCleanup,
  deferScienceRenderSessionCleanup,
  deferScienceUploadCleanup,
  finalizeScienceUpload,
  findApprovalForNode,
  getScienceArtifactByLogicalName,
  getScienceArtifactForWorkspace,
  getScienceArtifactVersionForWorkspace,
  getScienceComputeProfileForWorkspace,
  getScienceDomainValidationForRun,
  getLatestScienceLinkedNumericalEquivalenceRecord,
  getScienceWorkspaceAdmission,
  getLatestScienceRunEvent,
  getScienceRenderSessionForWorkspace,
  getScienceRenderSessionForRequest,
  getScienceRunByMissionForWorkspace,
  getScienceRunForWorkspace,
  getScienceRunSubmitAttempt,
  getScienceStudyForWorkspace,
  getScienceUploadByTokenHash,
  listScienceAdminActionQueue,
  listRecoverableScienceRuns,
  listScienceProtectedQuarantineKeys,
  listScienceArtifacts,
  listScienceArtifactVersions,
  listScienceComputeProfiles,
  listScienceDomainValidations,
  listScienceRenderSessions,
  listScienceRunArtifacts,
  listScienceRunEvents,
  listScienceRuns,
  listScienceStudies,
  listTerminalScienceRenderSessionsForCleanup,
  quarantineScienceUpload,
  probeScienceDatabase,
  recordScienceRunSubmitAttempt,
  recordScienceUploadProgress,
  releaseScienceRenderSessionLaunch,
  replaceScienceRenderSessionProviderHandle,
  releaseScienceUploadFinalization,
  releaseScienceRunLease,
  renewScienceUploadTransfer,
  renewScienceUploadFinalization,
  renewScienceRunLease,
  requestScienceRunApproval,
  resolveScienceRunApproval,
  setScienceRunProviderHandle,
  transitionScienceArtifactVersion,
  transitionScienceRenderSession,
  transitionScienceRun,
  tombstoneTerminalScienceRenderSessionAfterClose,
  setScienceWorkspaceAdmission,
  updateScienceComputeProfile,
  updateScienceStudy,
  verifyScienceDomainValidationRecordHash,
  withScienceAuditContext,
  heartbeatScienceRenderSession,
  type Db,
  type ScienceRunSubmitAttempt,
  ScienceConflictError,
} from "@puppetmaster/db";
import type { AuditSink } from "../audit-sink.js";
import type { EventBus, ScienceBusEvent, ScienceEventType } from "../bridge.js";
import type {
  ArtifactByteRange,
  ArtifactRead,
  ArtifactReference,
  ArtifactStore,
} from "./artifact-store.js";
import type { ScienceRuntimeConfig } from "./config.js";
import { redactScienceDiagnostic } from "./http-boundary.js";
import { assessManifest, canonicalJson, compareManifests } from "./manifest.js";
import type {
  ComputeProvider,
  ComputeProviderRegistry,
  ComputeQuote,
  ProviderOutput,
} from "./providers.js";
import {
  validateComputeQuote,
  validateComputeStatus,
  validateProviderOutputs,
} from "./providers.js";
import type {
  RenderProviderRegistry,
  RenderSessionProvider,
  RenderSource,
  RenderStatus,
} from "./render.js";
import type { ScienceScheduler, ScienceTickResult } from "./scheduler.js";

const ACTIVE_RUN_STATES = new Set([
  "queued",
  "provisioning",
  "running",
  "finalizing",
  "cancelling",
]);
const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const WORKER_LEASE_MS = 30_000;
const MAX_RECENT_EVENTS = 100;
const MAX_PROVIDER_ERRORS = 5;
const MAX_CONTROL_VALUE_BYTES = 64 * 1024;
const UPLOAD_TRANSFER_LEASE_MS = 5 * 60_000;
const UPLOAD_FINALIZATION_LEASE_MS = 5 * 60_000;
const MAX_PERSISTED_RUN_TELEMETRY_EVENTS = 1_000;
const RETENTION_OPERATION_TIMEOUT_MS = 5_000;
const RETENTION_UPLOAD_ATTEMPT_LIMIT = 8;
const RETENTION_VERSION_ATTEMPT_LIMIT = 8;
const RETENTION_RENDER_ATTEMPT_LIMIT = 4;
const STATIC_RENDER_MAX_BYTES = 8 * 1024 * 1024;
const RENDER_REPLAY_HORIZON_MS = 24 * 60 * 60_000;
const RENDER_LAUNCH_LEASE_MS = 30_000;

class ScienceExternalUploadStreamTimeoutError extends ScienceConflictError {
  readonly timeoutKind: "absolute" | "idle";

  constructor(timeoutKind: "absolute" | "idle", timeoutMs: number) {
    super(
      `Science external upload stream exceeded its ${timeoutKind} deadline of ` +
      `${timeoutMs} ms`,
    );
    this.name = "ScienceExternalUploadStreamTimeoutError";
    this.timeoutKind = timeoutKind;
  }
}

function externalUploadAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Science external upload stream was aborted");
}

function awaitExternalUploadOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // Keep observing a hostile operation that rejects after the deadline.
    void operation.catch(() => {});
    return Promise.reject(externalUploadAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(externalUploadAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function cancelExternalUploadTransport(
  body: AsyncIterable<Uint8Array>,
  error: unknown,
): void {
  const destroy = (body as { destroy?: (reason?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    try {
      destroy.call(body, error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Best-effort transport cancellation; the durable quarantine transition
      // remains the authoritative failure boundary.
    }
  }
}

interface ExternalUploadByteStreamOwner {
  readonly iterator: AsyncIterator<Uint8Array>;
  readonly completed: boolean;
  complete(): void;
  cancel(error: unknown): void;
}

function takeExternalUploadByteStream(
  body: AsyncIterable<Uint8Array>,
): ExternalUploadByteStreamOwner {
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = body[Symbol.asyncIterator]();
    if (!iterator || typeof iterator.next !== "function") {
      throw new TypeError("Science external upload body did not provide an async iterator");
    }
  } catch (error) {
    cancelExternalUploadTransport(body, error);
    throw error;
  }
  let completed = false;
  let cancelled = false;
  return {
    iterator,
    get completed() {
      return completed;
    },
    complete() {
      completed = true;
    },
    cancel(error) {
      if (completed || cancelled) return;
      cancelled = true;
      cancelExternalUploadTransport(body, error);
      try {
        const returned = iterator.return?.();
        if (returned) void Promise.resolve(returned).catch(() => {});
      } catch {
        // A hostile iterator cannot prevent the bounded caller from returning.
      }
    },
  };
}

interface ExternalUploadDeadline {
  readonly signal: AbortSignal;
  readonly expired: Promise<never>;
  readonly timeoutError: ScienceExternalUploadStreamTimeoutError | null;
  progress(): void;
  stop(): void;
}

function startExternalUploadDeadline(
  absoluteTimeoutMs: number,
  idleTimeoutMs: number,
): ExternalUploadDeadline {
  const controller = new AbortController();
  let rejectExpired!: (error: ScienceExternalUploadStreamTimeoutError) => void;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectExpired = reject;
  });
  let timeoutError: ScienceExternalUploadStreamTimeoutError | null = null;
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout>;
  const expire = (kind: "absolute" | "idle", timeoutMs: number) => {
    if (stopped || timeoutError) return;
    timeoutError = new ScienceExternalUploadStreamTimeoutError(kind, timeoutMs);
    rejectExpired(timeoutError);
    controller.abort(timeoutError);
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("idle", idleTimeoutMs), idleTimeoutMs);
  };
  const absoluteTimer = setTimeout(
    () => expire("absolute", absoluteTimeoutMs),
    absoluteTimeoutMs,
  );
  armIdle();
  return {
    signal: controller.signal,
    expired,
    get timeoutError() {
      return timeoutError;
    },
    progress: armIdle,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(absoluteTimer);
      clearTimeout(idleTimer);
    },
  };
}

const SCIENCE_ADMIN_ACTION_LINK = {
  study: (id: string) => `/api/science/studies/${id}`,
  run: (id: string) => `/api/science/runs/${id}`,
  artifact_versions: (id: string) => `/api/science/artifacts/${id}/versions`,
  artifact_version: (id: string) => `/api/science/artifact-versions/${id}`,
} satisfies Record<ScienceAdminActionLink["rel"], (id: string) => string>;

function cleanupRetryAt(attempts: number): Date {
  const exponent = Math.max(0, Math.min(10, attempts));
  return new Date(Date.now() + Math.min(60 * 60_000, 5_000 * (2 ** exponent)));
}

async function withOperationDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded the retention operation deadline`)),
      RETENTION_OPERATION_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ScienceDisabledError extends Error {
  constructor(message = "Science Operations is disabled") {
    super(message);
    this.name = "ScienceDisabledError";
  }
}

export class ScienceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScienceNotFoundError";
  }
}

export interface ScienceServiceDeps {
  db: Db;
  workspaceId: string;
  store: ArtifactStore;
  computeProviders: ComputeProviderRegistry;
  renderProviders: RenderProviderRegistry;
  bus: EventBus;
  config: ScienceRuntimeConfig;
  /** Explicit startup snapshot. Real-server construction passes persisted default-deny state. */
  audit?: AuditSink;
  workerId?: string;
  /** Server-only key used to derive renderer gateway credentials. */
  gatewaySecret: string | Buffer;
}

export interface ScienceRunInput {
  artifactVersionId: string;
  semanticRole: string;
}

export interface ScienceSubmitInput {
  studyId: string;
  computeProfileId: string;
  resourceRequest: ScienceResourceBounds;
  inputs: ScienceRunInput[];
  parameters?: Record<string, unknown>;
  idempotencyKey: string;
  actorId: string;
}

interface StoredRenderHandle {
  providerKind: string;
  instanceId: string;
  handle: string;
  attempt: false;
}

interface StoredRenderAttempt {
  providerKind: string;
  instanceId: string;
  sessionId: string;
  handle: null;
  attempt: true;
}

interface StoredComputeHandle {
  providerKind: string;
  instanceId: string;
  handle: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRecord(value: Record<string, unknown>, maxBytes = 8 * 1024): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= maxBytes) return value;
  return { truncated: true, originalBytes: Buffer.byteLength(encoded) };
}

function safeError(error: unknown): string {
  return redactScienceDiagnostic(error);
}

function normalizeLogicalName(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "-")
    .trim();
  return (cleaned || fallback).slice(0, 180);
}

function outputArtifactKind(kind: ProviderOutput["kind"]): ScienceArtifactKind {
  if (kind === "result" || kind === "dataset" || kind === "geometry" ||
      kind === "log" || kind === "notebook") {
    return kind;
  }
  return "result";
}

const FORMAT_SAMPLE_BYTES = 1024 * 1024;
const STRUCTURED_PARSE_LIMIT = 16 * 1024 * 1024;

async function readArtifactBytes(read: ArtifactRead, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of read.body as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit) {
      (read.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw new ScienceConflictError("science artifact format sample exceeds its validation bound");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function normalizedArtifactFormat(value: string): string {
  return value.trim().toLowerCase().replace(/^\./, "");
}

const VERIFIED_CODE_SEMANTIC_ROLES = new Set(["code", "notebook", "solver"]);

function isVerifiedCodeArtifact(
  artifact: Pick<ScienceArtifact, "kind" | "format">,
  version: Pick<ScienceArtifactVersion, "status" | "metadata">,
): boolean {
  // `ipynb` is the only current code-bearing format whose bytes are parsed at
  // upload time. Other text/opaque declarations remain useful inputs, but are
  // not sufficient to make a provenance-completeness claim.
  return version.status === "ready" &&
    artifact.kind === "notebook" &&
    normalizedArtifactFormat(artifact.format) === "ipynb" &&
    version.metadata.detectedFormat === "ipynb" &&
    version.metadata.formatValidation === "parsed";
}

function assertSafeArtifactMediaType(mediaType: string, format: string): void {
  const normalized = mediaType.trim().toLowerCase().split(";")[0] ?? "";
  if (
    !normalized ||
    /[\r\n]/.test(mediaType) ||
    ["text/html", "application/xhtml+xml", "application/javascript", "text/javascript"]
      .includes(normalized)
  ) {
    throw new ScienceConflictError("active or malformed artifact media types are not admitted");
  }
  if (normalized === "application/octet-stream") return;
  const compatible =
    (["ipynb", "json"].includes(format) && (normalized.endsWith("/json") || normalized.endsWith("+json"))) ||
    (format === "csv" && ["text/csv", "text/plain"].includes(normalized)) ||
    (format === "tsv" && ["text/tab-separated-values", "text/plain"].includes(normalized)) ||
    (["txt", "log", "py"].includes(format) && normalized.startsWith("text/")) ||
    (["vtk", "vti", "vtu", "vtp"].includes(format) &&
      ["model/vnd.vtk", "application/vnd.vtk", "application/xml", "text/xml", "text/plain"]
        .includes(normalized)) ||
    (["step", "stp"].includes(format) &&
      ["model/step", "application/step", "model/vnd.step"].includes(normalized)) ||
    (format === "stl" && ["model/stl", "application/sla"].includes(normalized)) ||
    (format === "png" && normalized === "image/png") ||
    (["jpg", "jpeg"].includes(format) && normalized === "image/jpeg") ||
    (format === "gif" && normalized === "image/gif") ||
    (format === "webp" && normalized === "image/webp") ||
    (["parquet", "npy", "npz", "h5", "hdf5", "bin"].includes(format) &&
      normalized.startsWith("application/"));
  if (!compatible) {
    throw new ScienceConflictError(
      `artifact media type ${normalized} is inconsistent with declared format ${format}`,
    );
  }
}

function encodeRenderHandle(value: Omit<StoredRenderHandle, "attempt">): string {
  if (
    !/^[a-z0-9_-]{1,80}$/i.test(value.providerKind) ||
    !/^[a-z0-9._-]{1,100}$/i.test(value.instanceId) ||
    !value.handle ||
    value.handle.includes("\0")
  ) {
    throw new Error("invalid render provider handle identity");
  }
  const encoded =
    `science-render:${value.providerKind}:${value.instanceId}:${value.handle}`;
  if (encoded.length > 500) {
    throw new Error("render provider handle exceeds the durable 500-character limit");
  }
  return encoded;
}

function encodeRenderAttempt(value: Omit<StoredRenderAttempt, "handle" | "attempt">): string {
  if (
    !/^[a-z0-9_-]{1,80}$/i.test(value.providerKind) ||
    !/^[a-z0-9._-]{1,100}$/i.test(value.instanceId) ||
    !/^[0-9a-f-]{36}$/i.test(value.sessionId)
  ) {
    throw new Error("invalid render provider launch-attempt identity");
  }
  return `science-render-attempt:${value.providerKind}:${value.instanceId}:${value.sessionId}`;
}

function encodeComputeHandle(value: StoredComputeHandle): string {
  if (
    !/^[a-z0-9_-]{1,80}$/i.test(value.providerKind) ||
    !/^[a-z0-9._-]{1,100}$/i.test(value.instanceId) ||
    !value.handle ||
    value.handle.includes("\0")
  ) {
    throw new Error("invalid compute provider handle identity");
  }
  const encoded =
    `science-compute:${value.providerKind}:${value.instanceId}:${value.handle}`;
  if (encoded.length > 500) {
    throw new Error("compute provider handle exceeds the durable 500-character limit");
  }
  return encoded;
}

function decodeComputeHandle(value: string): StoredComputeHandle {
  const match = /^science-compute:([a-z0-9_-]{1,80}):([a-z0-9._-]{1,100}):(.+)$/i.exec(value);
  if (!match || match[3].includes("\0")) {
    throw new Error("invalid or legacy compute provider handle identity");
  }
  return {
    providerKind: match[1],
    instanceId: match[2],
    handle: match[3],
  };
}

function decodeRenderHandle(value: string): StoredRenderHandle | StoredRenderAttempt {
  const attempt =
    /^science-render-attempt:([a-z0-9_-]{1,80}):([a-z0-9._-]{1,100}):([0-9a-f-]{36})$/i
      .exec(value);
  if (attempt) {
    return {
      providerKind: attempt[1],
      instanceId: attempt[2],
      sessionId: attempt[3],
      handle: null,
      attempt: true,
    };
  }
  const match =
    /^science-render:([a-z0-9_-]{1,80}):([a-z0-9._-]{1,100}):(.+)$/i.exec(value);
  if (!match || match[3].includes("\0")) {
    throw new Error("invalid or legacy science render provider handle identity");
  }
  return {
    providerKind: match[1],
    instanceId: match[2],
    handle: match[3],
    attempt: false,
  };
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function recordOfIntegers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isSafeInteger(entry[1])),
  );
}

function isSecretField(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  return /(^|_)(secret|token|password|passwd|api_key|credential|private_key|authorization|bearer|access_key|access_key_id|session_key|key)(_|$)/.test(
    normalized,
  );
}

function assertNoSecretFields(
  value: unknown,
  label: string,
  seen = new Set<object>(),
  root = true,
): void {
  if (root) {
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      throw new Error(`${label} must be JSON serializable`);
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_VALUE_BYTES) {
      throw new ScienceConflictError(
        `${label} exceeds the ${MAX_CONTROL_VALUE_BYTES}-byte control-plane limit`,
      );
    }
    if (/data:[^;,]+;base64,/i.test(encoded)) {
      throw new ScienceConflictError(
        `${label} cannot contain inline binary data; use an artifact reference`,
      );
    }
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecretFields(entry, label, seen, false);
  } else {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretField(key)) {
        throw new ScienceConflictError(
          `${label} cannot contain secret-bearing field "${key}"; use the credential boundary`,
        );
      }
      assertNoSecretFields(entry, label, seen, false);
    }
  }
  seen.delete(value);
}

function validatedComputeProfileConfig(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const config = value ?? {};
  assertNoSecretFields(config, "science compute profile config");
  const allowed = new Set([
    "dependencyLock",
    "network",
    "provisioningTimeoutSeconds",
  ]);
  const unexpected = Object.keys(config).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ScienceConflictError(
      `science compute profile config contains unsupported field "${unexpected[0]}"`,
    );
  }
  if (
    config.dependencyLock !== undefined &&
    (
      !config.dependencyLock ||
      typeof config.dependencyLock !== "object" ||
      Array.isArray(config.dependencyLock)
    )
  ) {
    throw new ScienceConflictError("science compute dependencyLock must be an object");
  }
  if (config.network !== undefined && config.network !== "none") {
    throw new ScienceConflictError("science compute profile network must be exactly none");
  }
  if (
    config.provisioningTimeoutSeconds !== undefined &&
    (
      !Number.isSafeInteger(config.provisioningTimeoutSeconds) ||
      Number(config.provisioningTimeoutSeconds) < 1 ||
      Number(config.provisioningTimeoutSeconds) > 86_400
    )
  ) {
    throw new ScienceConflictError(
      "science compute provisioningTimeoutSeconds must be an integer from 1 through 86400",
    );
  }
  return config;
}

/**
 * One service boundary for REST, tools, queue ticks, and recovery. Providers
 * never receive database credentials or host paths; callers never receive
 * provider credentials or raw binary through the control plane.
 */
export class ScienceService {
  readonly workspaceId: string;
  private readonly db: Db;
  private readonly store: ArtifactStore;
  private readonly computeProviders: ComputeProviderRegistry;
  private readonly renderProviders: RenderProviderRegistry;
  private readonly bus: EventBus;
  private readonly config: ScienceRuntimeConfig;
  private readonly audit?: AuditSink;
  private readonly workerId: string;
  private readonly gatewaySecret: Buffer;
  private scheduler: ScienceScheduler | null = null;
  private workflowWaitWaker: ((runId: string) => Promise<void>) | null = null;

  private admissionMutationQueue: Promise<void> = Promise.resolve();

  constructor(deps: ScienceServiceDeps) {
    this.db = deps.db;
    this.workspaceId = deps.workspaceId;
    this.store = deps.store;
    this.computeProviders = deps.computeProviders;
    this.renderProviders = deps.renderProviders;
    this.bus = deps.bus;
    this.config = deps.config;
    this.audit = deps.audit;
    this.workerId = deps.workerId?.trim() || `science-worker:${process.pid}:${randomUUID()}`;
    this.gatewaySecret = Buffer.isBuffer(deps.gatewaySecret)
      ? deps.gatewaySecret
      : Buffer.from(deps.gatewaySecret, "utf8");
    if (this.gatewaySecret.length < 16) {
      throw new Error("science render gateway secret must be at least 16 bytes");
    }
  }

  attachScheduler(scheduler: ScienceScheduler): void {
    if (this.scheduler && this.scheduler !== scheduler) {
      throw new Error("Science scheduler is already attached");
    }
    this.scheduler = scheduler;
  }

  /** Queue delivery is advisory; `workflow_waits.state=ready` remains the
   * authoritative after-commit wake source for startup/periodic recovery. */
  attachWorkflowWaitWaker(waker: (runId: string) => Promise<void>): void {
    if (this.workflowWaitWaker && this.workflowWaitWaker !== waker) {
      throw new Error("Science workflow wait waker is already attached");
    }
    this.workflowWaitWaker = waker;
  }

  private async readArtifactCandidate(
    quarantineKey: string,
    size: number,
    range: ArtifactByteRange | null,
    promotedStorageKey?: string,
  ): Promise<Buffer> {
    const boundedRange =
      size === 0
        ? null
        : range ?? { start: 0, end: size - 1 };
    let read: ArtifactRead;
    try {
      read = await this.store.openQuarantine(quarantineKey, boundedRange);
    } catch (quarantineError) {
      if (!promotedStorageKey) throw quarantineError;
      read = await this.store.open(promotedStorageKey, boundedRange).catch(() => {
        throw quarantineError;
      });
    }
    const expectedBytes = boundedRange
      ? boundedRange.end - boundedRange.start + 1
      : size;
    return readArtifactBytes(read, Math.max(1, expectedBytes));
  }

  private async validateArtifactFormat(input: {
    artifact: Pick<ScienceArtifact, "kind" | "format">;
    quarantineKey: string;
    size: number;
    mediaType?: string;
    promotedStorageKey?: string;
  }): Promise<{ detectedFormat: string; validation: "parsed" | "signature" | "text" | "opaque" }> {
    const format = normalizedArtifactFormat(input.artifact.format);
    if (input.mediaType) assertSafeArtifactMediaType(input.mediaType, format);
    const headSize = Math.min(input.size, FORMAT_SAMPLE_BYTES);
    const head = await this.readArtifactCandidate(
      input.quarantineKey,
      input.size,
      headSize > 0 ? { start: 0, end: headSize - 1 } : null,
      input.promotedStorageKey,
    );
    const ascii = head.toString("ascii");
    const starts = (...bytes: number[]) =>
      bytes.every((value, index) => head[index] === value);
    const text = () => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(head);
      } catch {
        throw new ScienceConflictError(`declared ${format} artifact is not valid UTF-8 text`);
      }
    };

    if (format === "ipynb" || format === "json") {
      if (input.size > STRUCTURED_PARSE_LIMIT) {
        throw new ScienceConflictError(
          `${format} artifacts exceed the ${STRUCTURED_PARSE_LIMIT}-byte structural-validation limit`,
        );
      }
      const full = await this.readArtifactCandidate(
        input.quarantineKey,
        input.size,
        null,
        input.promotedStorageKey,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(full));
      } catch {
        throw new ScienceConflictError(`declared ${format} artifact is not valid JSON`);
      }
      if (format === "ipynb") {
        const notebook = parsed as { cells?: unknown; nbformat?: unknown } | null;
        if (
          !notebook ||
          typeof notebook !== "object" ||
          !Array.isArray(notebook.cells) ||
          !Number.isInteger(notebook.nbformat)
        ) {
          throw new ScienceConflictError("declared ipynb artifact is not a Jupyter notebook");
        }
      }
      return { detectedFormat: format, validation: "parsed" };
    }
    if (["vtk", "vti", "vtu", "vtp"].includes(format)) {
      const legacy =
        ascii.startsWith("# vtk DataFile Version") &&
        /(?:^|\r?\n)(?:ASCII|BINARY)(?:\r?\n)/.test(ascii) &&
        /(?:^|\r?\n)DATASET\s+\w+/i.test(ascii);
      const xml = /<VTKFile\b/i.test(ascii) && /type\s*=\s*["'][A-Za-z]+["']/i.test(ascii);
      if (!legacy && !xml) throw new ScienceConflictError("declared VTK artifact has no VTK header");
      return { detectedFormat: legacy ? "vtk-legacy" : "vtk-xml", validation: "signature" };
    }
    if (format === "step" || format === "stp") {
      if (
        !/ISO-10303-21\s*;/i.test(ascii) ||
        !/\bHEADER\s*;/i.test(ascii) ||
        !/\bDATA\s*;/i.test(ascii)
      ) {
        throw new ScienceConflictError("declared STEP artifact has no ISO-10303-21 envelope");
      }
      return { detectedFormat: "step", validation: "signature" };
    }
    if (format === "stl") {
      const stlText = head.toString("utf8");
      const asciiStl =
        /^\s*solid\b/i.test(stlText) && /\bfacet\s+normal\b/i.test(stlText);
      let binaryStl = false;
      if (input.size >= 84 && head.length >= 84) {
        const triangles = head.readUInt32LE(80);
        binaryStl = Number.isSafeInteger(triangles) && 84 + triangles * 50 === input.size;
      }
      if (!asciiStl && !binaryStl) {
        throw new ScienceConflictError("declared STL artifact has no valid ASCII or binary envelope");
      }
      return {
        detectedFormat: asciiStl ? "stl-ascii" : "stl-binary",
        validation: "signature",
      };
    }
    if (format === "png") {
      if (!starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        throw new ScienceConflictError("declared PNG artifact has no PNG signature");
      }
      return { detectedFormat: "png", validation: "signature" };
    }
    if (format === "jpg" || format === "jpeg") {
      if (!starts(0xff, 0xd8, 0xff)) {
        throw new ScienceConflictError("declared JPEG artifact has no JPEG signature");
      }
      return { detectedFormat: "jpeg", validation: "signature" };
    }
    if (format === "gif") {
      if (!ascii.startsWith("GIF87a") && !ascii.startsWith("GIF89a")) {
        throw new ScienceConflictError("declared GIF artifact has no GIF signature");
      }
      return { detectedFormat: "gif", validation: "signature" };
    }
    if (format === "webp") {
      if (!(ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP")) {
        throw new ScienceConflictError("declared WebP artifact has no RIFF/WebP signature");
      }
      return { detectedFormat: "webp", validation: "signature" };
    }
    if (format === "parquet") {
      const tail = input.size >= 4
        ? await this.readArtifactCandidate(
            input.quarantineKey,
            input.size,
            { start: input.size - 4, end: input.size - 1 },
            input.promotedStorageKey,
          )
        : Buffer.alloc(0);
      if (ascii.slice(0, 4) !== "PAR1" || tail.toString("ascii") !== "PAR1") {
        throw new ScienceConflictError("declared Parquet artifact has no PAR1 envelope");
      }
      return { detectedFormat: "parquet", validation: "signature" };
    }
    if (format === "npy") {
      if (!starts(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59)) {
        throw new ScienceConflictError("declared NPY artifact has no NumPy signature");
      }
      return { detectedFormat: "npy", validation: "signature" };
    }
    if (format === "npz") {
      if (!starts(0x50, 0x4b, 0x03, 0x04)) {
        throw new ScienceConflictError("declared NPZ artifact has no ZIP signature");
      }
      return { detectedFormat: "npz", validation: "signature" };
    }
    if (format === "h5" || format === "hdf5") {
      if (!starts(0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a)) {
        throw new ScienceConflictError("declared HDF5 artifact has no HDF5 signature");
      }
      return { detectedFormat: "hdf5", validation: "signature" };
    }
    if (["csv", "tsv", "txt", "log", "py"].includes(format)) {
      const decoded = text();
      if (decoded.includes("\0")) {
        throw new ScienceConflictError(`declared ${format} artifact contains binary NUL bytes`);
      }
      const delimiter = format === "csv" ? "," : format === "tsv" ? "\t" : null;
      if (delimiter && input.size > 0 && !decoded.includes(delimiter)) {
        throw new ScienceConflictError(`declared ${format} artifact has no ${format} delimiter`);
      }
      return { detectedFormat: format, validation: "text" };
    }
    if (input.artifact.kind === "notebook" || input.artifact.kind === "geometry") {
      throw new ScienceConflictError(
        `unsupported ${input.artifact.kind} format ${format}; use an admitted pilot format`,
      );
    }
    return { detectedFormat: format || "opaque", validation: "opaque" };
  }

  private assertReadable(): void {
    if (!this.config.enabled) throw new ScienceDisabledError();
  }

  private async assertWritable(): Promise<void> {
    await this.admissionMutationQueue;
    this.assertReadable();
    if (!this.config.submissionsEnabled) {
      throw new ScienceDisabledError("Science Operations is in read-only mode");
    }
    // Admission is database-authoritative on every new-work boundary so a
    // decision committed by another server process is observed without a
    // restart. A revoke racing after this read defines the in-flight boundary:
    // already-admitted work may converge, while the next boundary observes it.
    const admission = await getScienceWorkspaceAdmission(this.db, this.workspaceId);
    if (!admission.admitted) {
      throw new ScienceDisabledError("Science Operations is not admitted for this workspace");
    }
  }

  /** Metadata review writes consume no provider/storage resource but remain disabled in read-only mode. */
  private assertMetadataWritable(): void {
    this.assertReadable();
    if (!this.config.submissionsEnabled) {
      throw new ScienceDisabledError("Science Operations is in read-only mode");
    }
  }

  private assertAcceptedWorkMayConverge(): void {
    this.assertReadable();
  }

  /**
   * Run exactly one database-local mutation with actor attribution installed
   * on the same transaction. External I/O must remain outside this callback.
   */
  private async mutateAs<T>(
    action: string,
    actorId: string | null,
    mutation: (scoped: Db) => Promise<T>,
    reason?: string,
  ): Promise<T> {
    return withScienceAuditContext(
      this.db,
      {
        actorKind: actorId ? "user" : "system",
        actorId,
        actorLabel: actorId ? null : "Science runtime",
        action,
        reason,
      },
      mutation,
    );
  }

  /** Read the persisted admission after all earlier local mutations settle. */
  async getWorkspaceAdmission(): Promise<ScienceWorkspaceAdmission> {
    this.assertReadable();
    await this.admissionMutationQueue;
    const admission = await getScienceWorkspaceAdmission(this.db, this.workspaceId);
    return admission;
  }

  /**
   * Serialize local writes so call order and database commit order cannot
   * diverge under concurrent admin PATCH requests.
   */
  async setWorkspaceAdmission(input: {
    admitted: boolean;
    actorId: string;
    reason: string;
  }): Promise<ScienceWorkspaceAdmission> {
    this.assertReadable();
    const previous = this.admissionMutationQueue;
    let release!: () => void;
    this.admissionMutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let admission: ScienceWorkspaceAdmission;
    try {
      admission = await this.mutateAs(
        "science.workspace.admission.update",
        input.actorId,
        (db) => setScienceWorkspaceAdmission(db, {
          workspaceId: this.workspaceId,
          admitted: input.admitted,
          updatedBy: input.actorId,
        }),
        input.reason,
      );
    } finally {
      release();
    }
    await this.auditEntry(
      "science.workspace.admission.update",
      input.actorId,
      admission.id ?? admission.workspaceId,
      { admitted: admission.admitted, reason: input.reason.slice(0, 1_000) },
    );
    return admission;
  }

  private async auditEntry(
    action: string,
    actorId: string | null,
    target: string,
    detail?: Record<string, unknown>,
    missionId?: string | null,
  ): Promise<void> {
    if (!this.audit) return;
    // AuditSink is best-effort by contract. Every Science domain mutation is
    // also covered by the database trigger in the same transaction, so a
    // secondary actor-rich audit failure must not turn an already-committed
    // mutation into a retryable API error.
    try {
      await this.audit({
        workspaceId: this.workspaceId,
        actorKind: actorId ? "user" : "system",
        actorId,
        actorLabel: actorId ? null : "science-runtime",
        missionId: missionId ?? null,
        action,
        target,
        detail: detail ? boundedRecord(detail) : undefined,
      });
    } catch {
      /* atomic database mutation audit remains authoritative */
    }
  }

  private async publish(event: ScienceBusEvent): Promise<void> {
    await this.bus.publish(event).catch(() => {});
  }

  private async publishRunEvent(run: ScienceRun, event?: ScienceRunEvent | null): Promise<void> {
    const current = event ??
      await getLatestScienceRunEvent(
        this.db,
        this.workspaceId,
        run.id,
      );
    if (current) {
      await this.publish({
        type: current.eventType,
        workspaceId: this.workspaceId,
        studyId: run.studyId,
        runId: run.id,
        missionId: run.missionId,
        sequence: current.sequence,
        at: current.createdAt.toISOString(),
        state: current.state,
        metadata: boundedRecord(current.payload),
      });
    }
    if (TERMINAL_RUN_STATES.has(run.state)) {
      await this.workflowWaitWaker?.(run.id).catch(() => {});
    }
  }

  async listStudies(input: {
    status?: "active" | "archived";
    page?: { offset?: number; limit?: number };
  } = {}) {
    this.assertReadable();
    return listScienceStudies(this.db, {
      workspaceId: this.workspaceId,
      status: input.status,
      page: input.page,
    });
  }

  async listAdminActionQueue(input: {
    page?: { offset?: number; limit?: number };
  } = {}) {
    this.assertReadable();
    const observedAt = new Date();
    const queue = await listScienceAdminActionQueue(this.db, {
      workspaceId: this.workspaceId,
      page: input.page,
      now: observedAt,
    });
    return {
      ...queue,
      items: queue.items.map((item) => {
        const links: ScienceAdminActionLink[] = [];
        if (item.studyId) {
          links.push({
            rel: "study",
            href: SCIENCE_ADMIN_ACTION_LINK.study(item.studyId),
          });
        }
        if (item.runId) {
          links.push({
            rel: "run",
            href: SCIENCE_ADMIN_ACTION_LINK.run(item.runId),
          });
        }
        if (item.artifactId) {
          links.push({
            rel: "artifact_versions",
            href: SCIENCE_ADMIN_ACTION_LINK.artifact_versions(item.artifactId),
          });
        }
        if (item.artifactVersionId) {
          links.push({
            rel: "artifact_version",
            href: SCIENCE_ADMIN_ACTION_LINK.artifact_version(item.artifactVersionId),
          });
        }
        return ScienceAdminActionQueueItem.parse({
          id: item.id,
          kind: item.kind,
          state: item.state,
          ageSeconds: Math.max(
            0,
            Math.floor((observedAt.getTime() - item.detectedAt.getTime()) / 1_000),
          ),
          attempts: item.attempts,
          nextRetryAt: item.nextRetryAt?.toISOString() ?? null,
          reason: redactScienceDiagnostic(item.reason, 200),
          links,
        });
      }),
    };
  }

  async createStudy(input: {
    name: string;
    description?: string;
    classification?: "non_regulated";
    workshopProjectId?: string | null;
    actorId: string;
  }) {
    await this.assertWritable();
    const study = await this.mutateAs("science.study.create", input.actorId, (db) =>
      createScienceStudy(db, {
      workspaceId: this.workspaceId,
      name: input.name,
      description: input.description,
      classification: input.classification,
      workshopProjectId: input.workshopProjectId,
      createdBy: input.actorId,
      }));
    await this.publish({
      type: "science.study.created",
      workspaceId: this.workspaceId,
      studyId: study.id,
      sequence: 1,
      at: study.createdAt.toISOString(),
      state: study.status,
    });
    await this.auditEntry("science.study.create", input.actorId, study.id, {
      classification: study.classification,
    });
    return study;
  }

  async getStudy(studyId: string): Promise<ScienceStudy> {
    this.assertReadable();
    const study = await getScienceStudyForWorkspace(this.db, this.workspaceId, studyId);
    if (!study) throw new ScienceNotFoundError("science study not found");
    return study;
  }

  async updateStudy(input: {
    studyId: string;
    name?: string;
    description?: string;
    workshopProjectId?: string | null;
    archive?: boolean;
    actorId: string;
  }) {
    await this.assertWritable();
    // Resolve ownership through the scoped getter before entering repository
    // mutations. Repository conflicts describe invariant failures and must not
    // become an existence oracle for foreign UUIDs at the API boundary.
    await this.getStudy(input.studyId);
    const action = input.archive ? "science.study.archive" : "science.study.update";
    const study = await this.mutateAs(action, input.actorId, (db) =>
      input.archive
        ? archiveScienceStudy(db, this.workspaceId, input.studyId)
        : updateScienceStudy(db, {
            workspaceId: this.workspaceId,
            studyId: input.studyId,
            name: input.name,
            description: input.description,
            workshopProjectId: input.workshopProjectId,
          }),
    );
    await this.auditEntry(
      input.archive ? "science.study.archive" : "science.study.update",
      input.actorId,
      study.id,
    );
    return study;
  }

  async listArtifacts(input: {
    studyId: string;
    status?: "active" | "archived";
    page?: { offset?: number; limit?: number };
  }) {
    this.assertReadable();
    await this.getStudy(input.studyId);
    const page = await listScienceArtifacts(this.db, {
      workspaceId: this.workspaceId,
      studyId: input.studyId,
      status: input.status,
      page: input.page,
    });
    return {
      ...page,
      items: await Promise.all(page.items.map(async (artifact) => {
        const versions = await listScienceArtifactVersions(this.db, {
          workspaceId: this.workspaceId,
          artifactId: artifact.id,
          page: { offset: 0, limit: 1 },
        });
        return {
          ...artifact,
          latestVersion: versions.items[0] ?? null,
        };
      })),
    };
  }

  async createArtifact(input: {
    studyId: string;
    logicalName: string;
    kind: ScienceArtifactKind;
    format: string;
    actorId: string;
  }) {
    await this.assertWritable();
    await this.getStudy(input.studyId);
    const artifact = await this.mutateAs("science.artifact.create", input.actorId, (db) =>
      createScienceArtifact(db, {
      workspaceId: this.workspaceId,
      studyId: input.studyId,
      logicalName: input.logicalName,
      kind: input.kind,
      format: input.format,
      createdBy: input.actorId,
      }));
    await this.auditEntry("science.artifact.create", input.actorId, artifact.id, {
      studyId: artifact.studyId,
      kind: artifact.kind,
      format: artifact.format,
    });
    return artifact;
  }

  async inspectArtifact(input: {
    artifactId: string;
    page?: { offset?: number; limit?: number };
    audience?: string;
  }) {
    this.assertReadable();
    const artifact = await getScienceArtifactForWorkspace(
      this.db,
      this.workspaceId,
      input.artifactId,
    );
    if (!artifact) throw new ScienceNotFoundError("science artifact not found");
    const versions = await listScienceArtifactVersions(this.db, {
      workspaceId: this.workspaceId,
      artifactId: artifact.id,
      page: input.page,
    });
    const items = await Promise.all(versions.items.map(async (version) => ({
      ...version,
      content:
        version.status === "ready" && input.audience
          ? await this.store.reference(version.storageKey, {
              versionId: version.id,
              sha256: version.sha256,
              size: version.sizeBytes,
              audience: input.audience,
              ttlSeconds: 300,
            })
          : null,
    })));
    return { artifact, versions: { ...versions, items } };
  }

  async beginUpload(input: {
    artifactId: string;
    expectedSizeBytes: number;
    expectedSha256: string;
    actorId: string;
  }) {
    await this.assertWritable();
    const artifact = await getScienceArtifactForWorkspace(
      this.db,
      this.workspaceId,
      input.artifactId,
    );
    if (!artifact) throw new ScienceNotFoundError("science artifact not found");
    if (input.expectedSizeBytes > this.config.maxUploadBytes) {
      throw new ScienceConflictError(
        `Science upload exceeds the ${this.config.maxUploadBytes} byte limit`,
      );
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const quarantineKey = await this.store.createQuarantine(
      `uploads/${this.workspaceId}/${randomUUID()}`,
    );
    const expiresAt = new Date(Date.now() + this.config.uploadTtlSeconds * 1_000);
    try {
      const result = await this.mutateAs("science.artifact.upload.begin", input.actorId, (db) =>
        beginScienceUpload(db, {
        workspaceId: this.workspaceId,
        artifactId: input.artifactId,
        tokenHash,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedSha256: input.expectedSha256,
        quarantineKey,
        expiresAt,
        maxWorkspaceStorageBytes: this.config.maxWorkspaceStorageBytes,
        }));
      await this.auditEntry("science.artifact.upload.begin", input.actorId, input.artifactId, {
        uploadId: result.upload.id,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedSha256: input.expectedSha256,
      });
      return {
        upload: result.upload,
        uploadToken: token,
        uploadUrl: `/api/science/uploads/${encodeURIComponent(token)}`,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      await this.store.discardQuarantine(quarantineKey).catch(() => {});
      throw error;
    }
  }

  private uploadTokenHash(token: string): string {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new ScienceNotFoundError("science upload not found");
    }
    return sha256(token);
  }

  private startUploadTransferHeartbeat(tokenHash: string, leaseId: string) {
    let stopped = false;
    let leaseError: unknown = null;
    let renewalTail = Promise.resolve();
    const renew = () => {
      renewalTail = renewalTail.then(async () => {
        if (stopped || leaseError) return;
        try {
          await renewScienceUploadTransfer(this.db, {
            workspaceId: this.workspaceId,
            tokenHash,
            leaseId,
            leaseExpiresAt: new Date(Date.now() + UPLOAD_TRANSFER_LEASE_MS),
          });
        } catch (error) {
          leaseError = error;
        }
      });
    };
    const timer = setInterval(
      renew,
      Math.max(1_000, Math.floor(UPLOAD_TRANSFER_LEASE_MS / 3)),
    );
    timer.unref?.();
    const ensure = async () => {
      await renewalTail;
      if (leaseError) {
        throw new ScienceConflictError(
          `science upload transfer lease was lost: ${safeError(leaseError)}`,
        );
      }
    };
    const stop = async (requireHealthy = true) => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await renewalTail.catch(() => {});
      if (requireHealthy) await ensure();
    };
    return { ensure, stop };
  }

  private guardUploadByteStream(
    owner: ExternalUploadByteStreamOwner,
    ensureLease: () => Promise<void>,
    deadline: ExternalUploadDeadline,
  ): AsyncIterable<Uint8Array> {
    return (async function* () {
      while (true) {
        await awaitExternalUploadOperation(
          Promise.resolve().then(ensureLease),
          deadline.signal,
        );
        const next = await awaitExternalUploadOperation(
          Promise.resolve().then(() => owner.iterator.next()),
          deadline.signal,
        );
        if (next.done) {
          owner.complete();
          break;
        }
        deadline.progress();
        await awaitExternalUploadOperation(
          Promise.resolve().then(ensureLease),
          deadline.signal,
        );
        yield next.value;
      }
      await awaitExternalUploadOperation(
        Promise.resolve().then(ensureLease),
        deadline.signal,
      );
    })();
  }

  async writeUpload(
    uploadToken: string,
    body: AsyncIterable<Uint8Array>,
    actorId: string,
  ) {
    const owner = takeExternalUploadByteStream(body);
    let exitError: unknown;
    try {
      this.assertAcceptedWorkMayConverge();
      return await this.writeAcceptedExternalUpload(uploadToken, owner, actorId);
    } catch (error) {
      exitError = error;
      throw error;
    } finally {
      owner.cancel(
        exitError ?? new Error("Science external upload request body was not consumed"),
      );
    }
  }

  private async writeAcceptedExternalUpload(
    uploadToken: string,
    owner: ExternalUploadByteStreamOwner,
    actorId: string,
  ) {
    const tokenHash = this.uploadTokenHash(uploadToken);
    const transferLeaseId = randomUUID();
    let claimed;
    try {
      claimed = await this.mutateAs("science.artifact.upload.transfer", actorId, (db) =>
        claimScienceUploadTransfer(db, {
        workspaceId: this.workspaceId,
        tokenHash,
        leaseId: transferLeaseId,
        leaseExpiresAt: new Date(Date.now() + UPLOAD_TRANSFER_LEASE_MS),
        external: true,
        maxConcurrentExternalStreamsPerWorkspace:
          this.config.maxConcurrentExternalUploadStreamsPerWorkspace,
        }));
    } catch (error) {
      if (
        error instanceof ScienceConflictError &&
        /does not exist in the workspace/i.test(error.message)
      ) {
        throw new ScienceNotFoundError("science upload not found");
      }
      throw error;
    }
    const upload = claimed.upload;
    if (!claimed.claimed) return upload;
    const transferHeartbeat = this.startUploadTransferHeartbeat(
      tokenHash,
      transferLeaseId,
    );
    try {
    let receipt;
    const deadline = startExternalUploadDeadline(
      this.config.externalUploadAbsoluteTimeoutMs,
      this.config.externalUploadIdleTimeoutMs,
    );
    const storeWrite = Promise.resolve().then(() => this.store.writeQuarantine(
      upload.quarantineKey,
      this.guardUploadByteStream(owner, transferHeartbeat.ensure, deadline),
      {
        maxBytes: Math.min(this.config.maxUploadBytes, upload.expectedSizeBytes),
        signal: deadline.signal,
      },
    ));
    try {
      receipt = await Promise.race([storeWrite, deadline.expired]);
      deadline.stop();
    } catch (error) {
      deadline.stop();
      const transferError = deadline.timeoutError ?? error;
      const streamTimedOut =
        transferError instanceof ScienceExternalUploadStreamTimeoutError;
      if (streamTimedOut) {
        // Stop extending the durable transfer lease before making the partial
        // object immediately eligible for retention cleanup.
        await transferHeartbeat.stop(false);
      }
      owner.cancel(transferError);
      // ArtifactStore implementations own their writer resources and must
      // settle after the abort signal. Durable quarantine cannot race a late
      // file open, buffered drain, or object-store write.
      await storeWrite.catch(() => {});
      await this.mutateAs("science.artifact.upload.quarantine", actorId, (db) =>
        quarantineScienceUpload(db, {
        workspaceId: this.workspaceId,
        tokenHash,
        error: safeError(transferError),
        cleanupEligible: streamTimedOut,
        })).catch((quarantineError) => {
          if (streamTimedOut) {
            throw new ScienceConflictError(
              `Science external upload stream timed out and durable quarantine failed: ` +
              safeError(quarantineError),
            );
          }
        });
      await this.publish({
        type: "science.artifact.quarantined",
        workspaceId: this.workspaceId,
        sequence: 1,
        at: new Date().toISOString(),
        state: "quarantined",
        metadata: { uploadId: upload.id, reason: safeError(transferError) },
      });
      throw transferError;
    }
    if (
      receipt.size !== upload.expectedSizeBytes ||
      receipt.sha256 !== upload.expectedSha256
    ) {
      const reason =
        receipt.size !== upload.expectedSizeBytes
          ? `Upload size mismatch: expected ${upload.expectedSizeBytes}, received ${receipt.size}`
          : "Upload checksum mismatch";
      await this.mutateAs("science.artifact.upload.quarantine", actorId, (db) =>
        quarantineScienceUpload(db, {
        workspaceId: this.workspaceId,
        tokenHash,
        error: reason,
        }));
      await this.publish({
        type: "science.artifact.quarantined",
        workspaceId: this.workspaceId,
        sequence: 1,
        at: new Date().toISOString(),
        state: "quarantined",
        metadata: { uploadId: upload.id, reason },
      });
      await this.auditEntry("science.artifact.upload.quarantine", actorId, upload.artifactId, {
        uploadId: upload.id,
        reason,
      });
      throw new ScienceConflictError(reason);
    }
    const artifact = await getScienceArtifactForWorkspace(
      this.db,
      this.workspaceId,
      upload.artifactId,
    );
    if (!artifact) throw new Error("science upload is missing its workspace artifact");
    try {
      await this.validateArtifactFormat({
        artifact,
        quarantineKey: upload.quarantineKey,
        size: receipt.size,
      });
    } catch (error) {
      const reason = safeError(error);
      await this.mutateAs("science.artifact.upload.quarantine", actorId, (db) =>
        quarantineScienceUpload(db, {
        workspaceId: this.workspaceId,
        tokenHash,
        error: reason,
        }));
      await this.publish({
        type: "science.artifact.quarantined",
        workspaceId: this.workspaceId,
        sequence: 1,
        at: new Date().toISOString(),
        state: "quarantined",
        metadata: { uploadId: upload.id, reason },
      });
      await this.auditEntry("science.artifact.upload.quarantine", actorId, upload.artifactId, {
        uploadId: upload.id,
        reason,
      });
      throw error;
    }
    await transferHeartbeat.stop(true);
    await this.mutateAs("science.artifact.upload.transfer", actorId, (db) =>
      recordScienceUploadProgress(db, {
      workspaceId: this.workspaceId,
      tokenHash,
      leaseId: transferLeaseId,
      receivedBytes: receipt.size,
      readyExpiresAt: new Date(Date.now() + this.config.uploadTtlSeconds * 1_000),
      }));
    await this.publish({
      type: "science.artifact.uploaded",
      workspaceId: this.workspaceId,
      sequence: 1,
      at: new Date().toISOString(),
      state: "uploading",
      metadata: { uploadId: upload.id, sizeBytes: receipt.size, sha256: receipt.sha256 },
    });
    return getScienceUploadByTokenHash(this.db, this.workspaceId, tokenHash);
    } finally {
      await transferHeartbeat.stop(false);
    }
  }

  async completeUpload(input: {
    uploadToken: string;
    mediaType: string;
    metadata?: Record<string, unknown>;
    parentVersionId?: string | null;
    actorId: string;
  }) {
    this.assertAcceptedWorkMayConverge();
    assertNoSecretFields(input.metadata ?? {}, "science artifact metadata");
    const tokenHash = this.uploadTokenHash(input.uploadToken);
    let upload = await getScienceUploadByTokenHash(this.db, this.workspaceId, tokenHash);
    if (!upload) throw new ScienceNotFoundError("science upload not found");
    if (upload.state === "completed" && upload.artifactVersionId) {
      const version = await getScienceArtifactVersionForWorkspace(
        this.db,
        this.workspaceId,
        upload.artifactVersionId,
      );
      if (!version) throw new Error("completed science upload is missing its version");
      return { upload, version };
    }
    if (
      !["uploading", "finalizing"].includes(upload.state) ||
      upload.receivedBytes !== upload.expectedSizeBytes
    ) {
      throw new ScienceConflictError("science upload bytes are incomplete or unavailable");
    }
    const finalizationLeaseId = randomUUID();
    upload = await this.mutateAs("science.artifact.upload.complete", input.actorId, (db) =>
      claimScienceUploadFinalization(db, {
      workspaceId: this.workspaceId,
      tokenHash,
      leaseId: finalizationLeaseId,
      leaseExpiresAt: new Date(Date.now() + UPLOAD_FINALIZATION_LEASE_MS),
      }));
    let finalizationCompleted = false;
    let finalizationLeaseError: unknown = null;
    let finalizationHeartbeatTail = Promise.resolve();
    const renewFinalizationLease = () => {
      finalizationHeartbeatTail = finalizationHeartbeatTail.then(async () => {
        if (finalizationLeaseError) return;
        try {
          await renewScienceUploadFinalization(this.db, {
            workspaceId: this.workspaceId,
            tokenHash,
            leaseId: finalizationLeaseId,
            leaseExpiresAt: new Date(Date.now() + UPLOAD_FINALIZATION_LEASE_MS),
          });
        } catch (error) {
          finalizationLeaseError = error;
        }
      });
    };
    const ensureFinalizationLease = async () => {
      await finalizationHeartbeatTail;
      if (finalizationLeaseError) {
        throw new ScienceConflictError(
          `science upload finalization lease was lost: ${safeError(finalizationLeaseError)}`,
        );
      }
    };
    const finalizationTimer = setInterval(
      renewFinalizationLease,
      Math.max(1_000, Math.floor(UPLOAD_FINALIZATION_LEASE_MS / 3)),
    );
    finalizationTimer.unref?.();
    try {
    const storageKey =
      `objects/${this.workspaceId}/${upload.artifactId}/${upload.expectedSha256}`;
    const artifact = await getScienceArtifactForWorkspace(
      this.db,
      this.workspaceId,
      upload.artifactId,
    );
    if (!artifact) throw new Error("science upload is missing its workspace artifact");
    const formatValidation = await this.validateArtifactFormat({
      artifact,
      quarantineKey: upload.quarantineKey,
      size: upload.expectedSizeBytes,
      mediaType: input.mediaType,
      promotedStorageKey: storageKey,
    });
    await ensureFinalizationLease();
    const created = await this.mutateAs("science.artifact.upload.complete", input.actorId, (db) =>
      createScienceArtifactVersion(db, {
      workspaceId: this.workspaceId,
      artifactId: upload.artifactId,
      storageKey,
      sha256: upload.expectedSha256,
      sizeBytes: upload.expectedSizeBytes,
      mediaType: input.mediaType,
      metadata: {
        ...(input.metadata ?? {}),
        detectedFormat: formatValidation.detectedFormat,
        formatValidation: formatValidation.validation,
      },
      parentVersionId: input.parentVersionId,
      uploadReservationId: upload.id,
      cleanupEligible: true,
      maxWorkspaceStorageBytes: this.config.maxWorkspaceStorageBytes,
      createdBy: input.actorId,
      }));
    let version = created.version;
    if (version.status === "pending") {
      await ensureFinalizationLease();
      await this.store.promote(upload.quarantineKey, storageKey, {
        sha256: upload.expectedSha256,
        size: upload.expectedSizeBytes,
      });
      version = await this.mutateAs("science.artifact.upload.complete", input.actorId, (db) =>
        transitionScienceArtifactVersion(db, {
        workspaceId: this.workspaceId,
        versionId: version.id,
        to: "ready",
        }));
    }
    await ensureFinalizationLease();
    const completed = await this.mutateAs("science.artifact.upload.complete", input.actorId, (db) =>
      finalizeScienceUpload(db, {
      workspaceId: this.workspaceId,
      tokenHash,
      leaseId: finalizationLeaseId,
      artifactVersionId: version.id,
      actualSha256: version.sha256,
      }));
    finalizationCompleted = true;
    await this.publish({
      type: "science.artifact.ready",
      workspaceId: this.workspaceId,
      artifactVersionId: version.id,
      sequence: version.version,
      at: (version.readyAt ?? version.createdAt).toISOString(),
      state: version.status,
      metadata: {
        artifactId: version.artifactId,
        sha256: version.sha256,
        sizeBytes: version.sizeBytes,
        mediaType: version.mediaType,
      },
    });
    await this.auditEntry("science.artifact.upload.complete", input.actorId, version.id, {
      uploadId: completed.id,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
    });
    return { upload: completed, version };
    } finally {
      clearInterval(finalizationTimer);
      await finalizationHeartbeatTail.catch(() => {});
      if (!finalizationCompleted) {
        await this.mutateAs("science.artifact.upload.complete", input.actorId, (db) =>
          releaseScienceUploadFinalization(db, {
          workspaceId: this.workspaceId,
          tokenHash,
          leaseId: finalizationLeaseId,
          retryExpiresAt: new Date(Date.now() + this.config.uploadTtlSeconds * 1_000),
          })).catch(() => {});
      }
    }
  }

  async getArtifactVersion(versionId: string) {
    this.assertReadable();
    const version = await getScienceArtifactVersionForWorkspace(
      this.db,
      this.workspaceId,
      versionId,
    );
    if (!version) throw new ScienceNotFoundError("science artifact version not found");
    return version;
  }

  async expireArtifactVersion(input: {
    versionId: string;
    confirmSha256: string;
    actorId: string;
  }): Promise<{
    id: string;
    artifactId: string;
    sha256: string;
    sizeBytes: number;
    status: "expired";
  }> {
    this.assertAcceptedWorkMayConverge();
    // Resolve workspace ownership without exposing whether a foreign UUID is
    // otherwise valid, then let the repository serialize every reference
    // check with run/render/lineage creation.
    await this.getArtifactVersion(input.versionId);
    const claimed = await this.mutateAs("science.artifact.version.expire", input.actorId, (db) =>
      claimScienceArtifactVersionRetention(db, {
      workspaceId: this.workspaceId,
      versionId: input.versionId,
      expectedSha256: input.confirmSha256,
      }));
    // Object deletion precedes quota release. Both removal and tombstone
    // finalization are idempotent, so a crash at either boundary is recovered
    // by the periodic retention pass or an identical administrator retry.
    await this.store.remove(claimed.storageKey);
    const released = await this.mutateAs("science.artifact.version.expire", input.actorId, (db) =>
      deleteExpiredScienceArtifactVersionAfterDiscard(db, {
      workspaceId: this.workspaceId,
      versionId: claimed.id,
      }));
    if (!released) {
      const retained = await getScienceArtifactVersionForWorkspace(
        this.db,
        this.workspaceId,
        claimed.id,
      );
      if (retained?.cleanupEligible) {
        throw new ScienceConflictError(
          "artifact version acquired a retained reference before quota release",
        );
      }
    }
    await this.auditEntry("science.artifact.version.expire", input.actorId, claimed.id, {
      artifactId: claimed.artifactId,
      sha256: claimed.sha256,
      sizeBytes: claimed.sizeBytes,
    });
    return {
      id: claimed.id,
      artifactId: claimed.artifactId,
      sha256: claimed.sha256,
      sizeBytes: claimed.sizeBytes,
      status: "expired",
    };
  }

  async openArtifactVersion(input: {
    versionId: string;
    range?: ArtifactByteRange | null;
    signed?: { audience: string; expires: string; signature: string };
  }): Promise<{ version: ScienceArtifactVersion; read: ArtifactRead }> {
    this.assertReadable();
    const version = await this.getArtifactVersion(input.versionId);
    if (version.status !== "ready") {
      throw new ScienceConflictError("only ready science artifact versions can be read");
    }
    if (input.signed && !this.store.verifyReference({
      versionId: version.id,
      audience: input.signed.audience,
      expires: input.signed.expires,
      signature: input.signed.signature,
      sha256: version.sha256,
      size: version.sizeBytes,
    })) {
      throw new ScienceNotFoundError("science artifact reference is invalid or expired");
    }
    return { version, read: await this.store.open(version.storageKey, input.range) };
  }

  async listComputeProfiles(input: {
    enabled?: boolean;
    page?: { offset?: number; limit?: number };
  } = {}) {
    this.assertReadable();
    return listScienceComputeProfiles(this.db, {
      workspaceId: this.workspaceId,
      enabled: input.enabled,
      page: input.page,
    });
  }

  async createComputeProfile(input: {
    name: string;
    providerKind: "local_container" | "jupyter_enterprise_gateway";
    imageDigest: string;
    kernelName: string;
    resourceBounds: ScienceResourceBounds;
    config?: Record<string, unknown>;
    enabled?: boolean;
    actorId: string;
  }) {
    await this.assertWritable();
    const config = validatedComputeProfileConfig(input.config);
    // A configured provider is a prerequisite for enabling a profile. Merely
    // accepting a provider-kind string would create a false-ready control plane.
    if (input.enabled !== false) this.computeProviders.get(input.providerKind);
    const profile = await this.mutateAs("science.compute-profile.create", input.actorId, (db) =>
      createScienceComputeProfile(db, {
      workspaceId: this.workspaceId,
      name: input.name,
      providerKind: input.providerKind,
      imageDigest: input.imageDigest,
      kernelName: input.kernelName,
      resourceBounds: input.resourceBounds,
      config,
      enabled: input.enabled,
      }));
    await this.auditEntry("science.compute-profile.create", input.actorId, profile.id, {
      providerKind: profile.providerKind,
      imageDigest: profile.imageDigest,
    });
    return profile;
  }

  async updateComputeProfile(input: {
    profileId: string;
    name?: string;
    providerKind?: "local_container" | "jupyter_enterprise_gateway";
    imageDigest?: string;
    kernelName?: string;
    resourceBounds?: ScienceResourceBounds;
    config?: Record<string, unknown>;
    enabled?: boolean;
    actorId: string;
  }) {
    await this.assertWritable();
    const current = await getScienceComputeProfileForWorkspace(
      this.db,
      this.workspaceId,
      input.profileId,
    );
    if (!current) throw new ScienceNotFoundError("science compute profile not found");
    const config =
      input.config === undefined ? undefined : validatedComputeProfileConfig(input.config);
    if (input.enabled === true || input.providerKind) {
      this.computeProviders.get(input.providerKind ?? current.providerKind);
    }
    const profile = await this.mutateAs("science.compute-profile.update", input.actorId, (db) =>
      updateScienceComputeProfile(db, {
      workspaceId: this.workspaceId,
      profileId: input.profileId,
      name: input.name,
      providerKind: input.providerKind,
      imageDigest: input.imageDigest,
      kernelName: input.kernelName,
      resourceBounds: input.resourceBounds,
      config,
      enabled: input.enabled,
      }));
    await this.auditEntry("science.compute-profile.update", input.actorId, profile.id, {
      enabled: profile.enabled,
    });
    return profile;
  }

  async quote(input: {
    computeProfileId: string;
    resourceRequest: ScienceResourceBounds;
  }): Promise<ComputeQuote> {
    await this.assertWritable();
    const profile = await getScienceComputeProfileForWorkspace(
      this.db,
      this.workspaceId,
      input.computeProfileId,
    );
    if (!profile) throw new ScienceNotFoundError("science compute profile not found");
    for (const key of ["cpuMillicores", "memoryMb", "gpuCount", "wallTimeSeconds"] as const) {
      if (input.resourceRequest[key] > profile.resourceBounds[key]) {
        throw new ScienceConflictError(
          `science ${key} request exceeds the selected profile ceiling`,
        );
      }
    }
    return validateComputeQuote(
      await this.computeProviders.get(profile.providerKind).quote(input.resourceRequest),
    );
  }

  async submitRun(input: ScienceSubmitInput) {
    await this.assertWritable();
    assertNoSecretFields(input.parameters ?? {}, "science run parameters");
    await this.getStudy(input.studyId);
    const profile = await getScienceComputeProfileForWorkspace(
      this.db,
      this.workspaceId,
      input.computeProfileId,
    );
    if (!profile) throw new ScienceNotFoundError("science compute profile not found");
    if (input.inputs.length === 0) {
      throw new ScienceConflictError("a science run requires at least one ready input");
    }
    if (input.inputs.length > 200) {
      throw new ScienceConflictError("a science run accepts at most 200 input links");
    }
    const unique = new Set<string>();
    const validatedInputs: Array<{ version: ScienceArtifactVersion; semanticRole: string }> = [];
    for (const entry of input.inputs) {
      const semanticRole = entry.semanticRole.trim();
      if (!semanticRole || semanticRole.length > 128) {
        throw new Error("science input semanticRole must contain 1-128 characters");
      }
      const key = `${entry.artifactVersionId}:${semanticRole}`;
      if (unique.has(key)) throw new ScienceConflictError("duplicate science run input");
      unique.add(key);
      const version = await getScienceArtifactVersionForWorkspace(
        this.db,
        this.workspaceId,
        entry.artifactVersionId,
      );
      if (!version) throw new ScienceNotFoundError("science artifact version not found");
      if (version.status !== "ready") {
        throw new ScienceConflictError("science run inputs must be ready workspace artifacts");
      }
      const artifact = await getScienceArtifactForWorkspace(
        this.db,
        this.workspaceId,
        version.artifactId,
      );
      if (!artifact || artifact.studyId !== input.studyId) {
        throw new ScienceConflictError("science run inputs must belong to the selected study");
      }
      if (
        VERIFIED_CODE_SEMANTIC_ROLES.has(semanticRole) &&
        !isVerifiedCodeArtifact(artifact, version)
      ) {
        throw new ScienceConflictError(
          "science code, notebook, or solver roles require a parsed ipynb notebook artifact",
        );
      }
      validatedInputs.push({ version, semanticRole });
    }
    const created = await this.mutateAs("science.run.submit", input.actorId, (db) =>
      createScienceRun(db, {
      workspaceId: this.workspaceId,
      studyId: input.studyId,
      computeProfileId: input.computeProfileId,
      resourceRequest: input.resourceRequest,
      idempotencyKey: input.idempotencyKey,
      inputs: validatedInputs.map((entry) => ({
        artifactVersionId: entry.version.id,
        semanticRole: entry.semanticRole,
      })),
      parameters: input.parameters,
      createdBy: input.actorId,
      }));
    const prompt =
      `Approve science run ${created.run.id} using immutable image ` +
      `${created.run.profileSnapshot.imageDigest} and the declared resource request.`;
    let run = created.run;
    let approval;
    let approvalCreated = false;
    if (run.state === "draft" || run.state === "awaiting_approval") {
      const requested = await this.mutateAs("science.run.submit", input.actorId, (db) =>
        requestScienceRunApproval(db, {
        workspaceId: this.workspaceId,
        runId: run.id,
        expectedGeneration: run.executionGeneration,
        prompt,
        tier: "write_approved",
        nodeId: "science.run",
        }));
      run = requested.run;
      approval = requested.approval;
      approvalCreated = requested.created;
      if (requested.created) {
        await this.publishRunEvent(run, requested.event);
        await this.bus.publish({
          type: "approval.requested",
          missionId: run.missionId,
          nodeId: "science.run",
          approvalId: approval.id,
          prompt: approval.prompt,
          at: approval.createdAt.toISOString(),
        }).catch(() => {});
      }
    } else {
      approval = await findApprovalForNode(this.db, run.missionId, "science.run");
      if (!approval) {
        throw new Error("progressed science run is missing its durable approval");
      }
    }
    await this.auditEntry("science.run.submit", input.actorId, run.id, {
      studyId: input.studyId,
      computeProfileId: input.computeProfileId,
      resourceRequest: input.resourceRequest,
      inputCount: input.inputs.length,
      approvalId: approval.id,
      idempotentReplay: !created.created,
      approvalCreated,
    }, run.missionId);
    return {
      run,
      mission: created.mission,
      approval,
      created: created.created,
    };
  }

  async resolveApproval(input: {
    runId: string;
    approvalId: string;
    approved: boolean;
    actorId: string;
    reason?: string;
    auditAction?: "science.run.approval" | "science.run.cancel";
  }) {
    if (input.approved) await this.assertWritable();
    else this.assertReadable();
    const run = await this.getRun(input.runId);
    const action = input.auditAction ?? "science.run.approval";
    const reason = input.reason?.trim()
      ? redactScienceDiagnostic(input.reason.trim(), 1_000)
      : undefined;
    const result = await this.mutateAs(action, input.actorId, (db) =>
      resolveScienceRunApproval(db, {
      workspaceId: this.workspaceId,
      runId: run.id,
      expectedGeneration: run.executionGeneration,
      approvalId: input.approvalId,
      decision: input.approved ? "approved" : "rejected",
      maxActiveRuns: this.config.maxConcurrentRunsPerWorkspace,
      }), reason);
    await this.publishRunEvent(result.run, result.event);
    await this.bus.publish({
      type: "approval.resolved",
      missionId: run.missionId,
      approvalId: input.approvalId,
      approved: input.approved,
      at: new Date().toISOString(),
    }).catch(() => {});
    // Approval state is durable before queue handoff. Re-enqueue every
    // idempotent approved replay (job IDs are deterministic and run claims are
    // fenced) so a prior Redis/audit failure cannot strand a quota-consuming
    // queued run until process restart.
    if (input.approved && result.run.state === "queued") {
      await this.scheduler?.enqueue(run.id, null);
    }
    await this.auditEntry(action, input.actorId, run.id, {
      approvalId: input.approvalId,
      approved: input.approved,
      ...(reason ? { reason } : {}),
    }, run.missionId);
    return result;
  }

  async listRuns(input: {
    studyId: string;
    state?: ScienceRun["state"];
    page?: { offset?: number; limit?: number };
  }) {
    this.assertReadable();
    await this.getStudy(input.studyId);
    return listScienceRuns(this.db, {
      workspaceId: this.workspaceId,
      studyId: input.studyId,
      state: input.state,
      page: input.page,
    });
  }

  async getRun(runId: string): Promise<ScienceRun> {
    this.assertReadable();
    const run = await getScienceRunForWorkspace(this.db, this.workspaceId, runId);
    if (!run) throw new ScienceNotFoundError("science run not found");
    return run;
  }

  async getRunByMission(missionId: string): Promise<ScienceRun | null> {
    this.assertReadable();
    return getScienceRunByMissionForWorkspace(
      this.db,
      this.workspaceId,
      missionId,
    );
  }

  private async allRunArtifacts(
    runId: string,
    direction?: "input" | "output",
  ): Promise<ScienceRunArtifact[]> {
    const items: ScienceRunArtifact[] = [];
    let offset = 0;
    for (;;) {
      const page = await listScienceRunArtifacts(this.db, {
        workspaceId: this.workspaceId,
        runId,
        direction,
        page: { offset, limit: 200 },
      });
      items.push(...page.items);
      if (page.nextOffset === null) return items;
      offset = page.nextOffset;
      if (items.length >= 1_000) {
        throw new ScienceConflictError("science run artifact link limit was exceeded");
      }
    }
  }

  private async allRunEvents(
    runId: string,
    maxItems = 5_000,
  ): Promise<{ items: ScienceRunEvent[]; truncated: boolean }> {
    const items: ScienceRunEvent[] = [];
    let offset = 0;
    for (;;) {
      const page = await listScienceRunEvents(this.db, {
        workspaceId: this.workspaceId,
        runId,
        page: { offset, limit: 200 },
      });
      const remaining = maxItems - items.length;
      items.push(...page.items.slice(0, Math.max(0, remaining)));
      if (page.nextOffset === null) return { items, truncated: false };
      if (items.length >= maxItems) return { items, truncated: true };
      offset = page.nextOffset;
    }
  }

  private async recentRunEvents(
    runId: string,
    limit: number,
  ): Promise<ScienceRunEvent[]> {
    const bounded = Math.max(1, Math.min(limit, 200));
    const latest = await getLatestScienceRunEvent(this.db, this.workspaceId, runId);
    if (!latest) return [];
    const page = await listScienceRunEvents(this.db, {
      workspaceId: this.workspaceId,
      runId,
      page: {
        offset: Math.max(0, latest.sequence - bounded),
        limit: bounded,
      },
    });
    return page.items;
  }

  private async allRenderSessions(
    state: ScienceRenderSession["state"],
    maxItems = 1_000,
  ): Promise<ScienceRenderSession[]> {
    const items: ScienceRenderSession[] = [];
    let offset = 0;
    for (;;) {
      const page = await listScienceRenderSessions(this.db, {
        workspaceId: this.workspaceId,
        state,
        page: { offset, limit: 200 },
      });
      items.push(...page.items);
      if (page.nextOffset === null || items.length >= maxItems) {
        return items.slice(0, maxItems);
      }
      offset = page.nextOffset;
    }
  }

  async getRunDossier(runId: string, eventLimit = 50) {
    const run = await this.getRun(runId);
    const boundedEventLimit = Math.max(1, Math.min(eventLimit, MAX_RECENT_EVENTS));
    const [events, links] = await Promise.all([
      this.recentRunEvents(runId, boundedEventLimit),
      this.allRunArtifacts(runId),
    ]);
    const artifacts = await Promise.all(links.map(async (link) => {
      const version = await getScienceArtifactVersionForWorkspace(
        this.db,
        this.workspaceId,
        link.artifactVersionId,
      );
      const artifact = version
        ? await getScienceArtifactForWorkspace(this.db, this.workspaceId, version.artifactId)
        : null;
      return { ...link, version, artifact };
    }));
    return {
      run,
      events: {
        items: events,
        nextOffset: null,
      },
      inputs: artifacts.filter((entry) => entry.direction === "input"),
      outputs: artifacts.filter((entry) => entry.direction === "output"),
    };
  }

  async cancelRun(input: {
    runId: string;
    expectedGeneration?: number;
    actorId: string;
    reason?: string;
  }) {
    // Read-only rollback stops new submissions but must retain authority to
    // terminate already-running external compute.
    this.assertReadable();
    let run = await this.getRun(input.runId);
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration !== run.executionGeneration
    ) {
      throw new ScienceConflictError("science run generation is stale");
    }
    if (TERMINAL_RUN_STATES.has(run.state)) {
      return { run, accepted: false };
    }
    const reason = input.reason?.trim()
      ? redactScienceDiagnostic(input.reason.trim(), 1_000)
      : undefined;
    if (run.state === "awaiting_approval") {
      const approval = await findApprovalForNode(this.db, run.missionId, "science.run");
      if (!approval) throw new Error("awaiting science run has no approval");
      const resolved = await this.resolveApproval({
        runId: run.id,
        approvalId: approval.id,
        approved: false,
        actorId: input.actorId,
        reason,
        auditAction: "science.run.cancel",
      });
      return { run: resolved.run, accepted: true };
    }
    const target = run.state === "draft" ? "cancelled" : "cancelling";
    run = await this.mutateAs("science.run.cancel", input.actorId, (db) =>
      transitionScienceRun(db, {
      workspaceId: this.workspaceId,
      runId: run.id,
      expectedGeneration: run.executionGeneration,
      to: target,
      eventPayload: {
        requestedBy: input.actorId,
        ...(reason ? { reason } : {}),
      },
      }), reason);
    await this.publishRunEvent(run);
    await this.auditEntry("science.run.cancel", input.actorId, run.id, {
      executionGeneration: run.executionGeneration,
      ...(reason ? { reason } : {}),
    }, run.missionId);
    if (run.state === "cancelling") await this.scheduler?.enqueue(run.id, null);
    return { run, accepted: true };
  }

  private async providerInputs(run: ScienceRun): Promise<Array<{
    artifactVersionId: string;
    role: string;
    mediaType: string;
    sha256: string;
    size: number;
    reference: ArtifactReference;
  }>> {
    const links = await this.allRunArtifacts(run.id, "input");
    return Promise.all(links.map(async (link) => {
      const version = await getScienceArtifactVersionForWorkspace(
        this.db,
        this.workspaceId,
        link.artifactVersionId,
      );
      if (!version || version.status !== "ready") {
        throw new Error(`science run input ${link.artifactVersionId} is not ready`);
      }
      return {
        artifactVersionId: version.id,
        role: link.semanticRole,
        mediaType: version.mediaType,
        sha256: version.sha256,
        size: version.sizeBytes,
        reference: await this.store.reference(version.storageKey, {
          versionId: version.id,
          sha256: version.sha256,
          size: version.sizeBytes,
          audience: `science-runtime:${run.id}:${run.executionGeneration}`,
          ttlSeconds: Math.min(3600, Math.max(60, run.resourceRequest.wallTimeSeconds + 60)),
        }),
      };
    }));
  }

  private async submissionTime(run: ScienceRun): Promise<string> {
    const events = await this.allRunEvents(run.id);
    return (
      events.items.find((event) =>
        event.eventType === "science.run.provisioning" &&
        event.executionGeneration === run.executionGeneration)?.createdAt ??
      run.createdAt
    ).toISOString();
  }

  private async appendTelemetry(
    run: ScienceRun,
    leaseOwner: string,
    input: { progress: number | null; message?: string; logs?: string[]; metrics?: unknown[] },
  ): Promise<void> {
    const latest = await getLatestScienceRunEvent(this.db, this.workspaceId, run.id);
    let remaining = Math.max(
      0,
      MAX_PERSISTED_RUN_TELEMETRY_EVENTS - (latest?.sequence ?? 0),
    );
    if (remaining === 0) return;

    const payload = boundedRecord({
      progress: input.progress,
      ...(input.message ? { message: safeError(input.message).slice(0, 1_000) } : {}),
      ...(input.metrics ? { metrics: input.metrics.slice(0, 32) } : {}),
    });
    const progress = await appendScienceRunEvent(this.db, {
      workspaceId: this.workspaceId,
      runId: run.id,
      expectedGeneration: run.executionGeneration,
      leaseOwner,
      eventType: "science.run.progress",
      payload,
    });
    await this.publishRunEvent(run, progress);
    remaining -= 1;
    for (const line of (input.logs ?? []).slice(-8).slice(0, remaining)) {
      const event = await appendScienceRunEvent(this.db, {
        workspaceId: this.workspaceId,
        runId: run.id,
        expectedGeneration: run.executionGeneration,
        leaseOwner,
        eventType: "science.run.log",
        payload: { line: safeError(String(line)).slice(0, 1_000) },
      });
      await this.publishRunEvent(run, event);
    }
  }

  private async ensureOutputArtifact(
    run: ScienceRun,
    output: ProviderOutput,
  ): Promise<ScienceArtifact> {
    const logicalName = `run-${run.id}-${normalizeLogicalName(output.logicalName, "output")}`.slice(
      0,
      300,
    );
    const existing = await getScienceArtifactByLogicalName(this.db, {
      workspaceId: this.workspaceId,
      studyId: run.studyId,
      logicalName,
    });
    if (existing) return existing;
    return createScienceArtifact(this.db, {
      workspaceId: this.workspaceId,
      studyId: run.studyId,
      logicalName,
      kind: outputArtifactKind(output.kind),
      format: normalizeLogicalName(output.format, "binary").slice(0, 100),
      createdBy: run.createdBy,
    });
  }

  private async ingestOutput(
    run: ScienceRun,
    provider: ComputeProvider,
    providerInstanceId: string,
    output: ProviderOutput,
    leaseOwner: string,
    leaseGuard: () => Promise<void>,
  ): Promise<ScienceArtifactVersion> {
    await leaseGuard();
    assertNoSecretFields(output.metadata, "science provider output metadata");
    if (output.size > this.config.maxUploadBytes) {
      throw new ScienceConflictError(
        `science provider output ${output.logicalName} exceeds the artifact-size limit`,
      );
    }
    const artifact = await this.ensureOutputArtifact(run, output);
    const quarantineKey = await this.store.createQuarantine(
      `outputs/${this.workspaceId}/${run.id}/${run.executionGeneration}/${randomUUID()}`,
    );
    const reservationTokenHash = sha256(randomBytes(32));
    const reservationLeaseId = randomUUID();
    const reservationTtlMs = Math.max(
      this.config.uploadTtlSeconds,
      run.resourceRequest.wallTimeSeconds + 60,
    ) * 1_000;
    let reservationId: string | null = null;
    try {
      const reserved = await beginScienceUpload(this.db, {
        workspaceId: this.workspaceId,
        artifactId: artifact.id,
        tokenHash: reservationTokenHash,
        expectedSizeBytes: output.size,
        expectedSha256: output.sha256,
        quarantineKey,
        expiresAt: new Date(Date.now() + reservationTtlMs),
        maxWorkspaceStorageBytes: this.config.maxWorkspaceStorageBytes,
      });
      reservationId = reserved.upload.id;
      await claimScienceUploadTransfer(this.db, {
        workspaceId: this.workspaceId,
        tokenHash: reservationTokenHash,
        leaseId: reservationLeaseId,
        leaseExpiresAt: new Date(Date.now() + UPLOAD_TRANSFER_LEASE_MS),
        external: false,
      });
    } catch (error) {
      // Aggregate admission happens before the provider stream is opened.
      await this.store.discardQuarantine(quarantineKey).catch(() => {});
      throw error;
    }
    const discardUnversionedOutput = async (error: unknown) => {
      if (reservationId) {
        await quarantineScienceUpload(this.db, {
          workspaceId: this.workspaceId,
          tokenHash: reservationTokenHash,
          error: safeError(error),
        }).catch(() => {});
      }
      try {
        await this.store.discardQuarantine(quarantineKey);
        if (reservationId) {
          await deleteTerminalScienceUploadAfterDiscard(this.db, {
            workspaceId: this.workspaceId,
            uploadId: reservationId,
          });
        }
      } catch {
        // The retained reservation remains quota-charged and periodic
        // reconciliation retries discard-before-delete.
      }
    };
    const transferHeartbeat = this.startUploadTransferHeartbeat(
      reservationTokenHash,
      reservationLeaseId,
    );
    const releaseCommittedReservation = async (version: ScienceArtifactVersion) => {
      await transferHeartbeat.stop(true);
      if (!reservationId) {
        throw new Error("science provider output reservation identity was lost");
      }
      await deleteScienceProviderOutputReservationAfterCommit(this.db, {
        workspaceId: this.workspaceId,
        uploadId: reservationId,
        artifactVersionId: version.id,
        leaseId: reservationLeaseId,
      });
    };
    try {
    let receipt;
    try {
      const source = await provider.openOutput(output, {
        expectedInstanceId: providerInstanceId,
      });
      await leaseGuard();
      const guardedSource = (async function* () {
        let observedBytes = 0;
        for await (const raw of source) {
          await leaseGuard();
          await transferHeartbeat.ensure();
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (chunk.byteLength > output.size - observedBytes) {
            throw new Error(
              `science provider output ${output.logicalName} exceeded its declared ` +
              `${output.size}-byte size`,
            );
          }
          observedBytes += chunk.byteLength;
          yield chunk;
        }
      })();
      receipt = await this.store.writeQuarantine(
        quarantineKey,
        guardedSource,
        { maxBytes: output.size },
      );
      await leaseGuard();
      await transferHeartbeat.ensure();
      await recordScienceUploadProgress(this.db, {
        workspaceId: this.workspaceId,
        tokenHash: reservationTokenHash,
        leaseId: reservationLeaseId,
        receivedBytes: receipt.size,
        readyExpiresAt: new Date(Date.now() + reservationTtlMs),
        retainTransferLease: true,
      });
    } catch (error) {
      await discardUnversionedOutput(error);
      throw error;
    }
    const exactReceipt = receipt.sha256 === output.sha256 && receipt.size === output.size;
    let formatValidation:
      | { detectedFormat: string; validation: "parsed" | "signature" | "text" | "opaque" }
      | null = null;
    let formatError: string | null = null;
    if (exactReceipt) {
      try {
        formatValidation = await this.validateArtifactFormat({
          artifact,
          quarantineKey,
          size: receipt.size,
          mediaType: output.mediaType,
        });
      } catch (error) {
        formatError = safeError(error);
      }
    }
    const exact = exactReceipt && !formatError;
    const storageKey = exact
      ? `objects/${this.workspaceId}/${artifact.id}/${receipt.sha256}`
      : `objects/${this.workspaceId}/${artifact.id}/quarantined/${receipt.sha256}`;
    await transferHeartbeat.ensure();
    const created = await createScienceArtifactVersion(this.db, {
      workspaceId: this.workspaceId,
      artifactId: artifact.id,
      storageKey,
      sha256: receipt.sha256,
      sizeBytes: receipt.size,
      mediaType: output.mediaType,
      metadata: {
        ...output.metadata,
        providerReferenceHash: sha256(output.reference),
        declaredSha256: output.sha256,
        declaredSizeBytes: output.size,
        executionGeneration: run.executionGeneration,
        ...(formatValidation
          ? {
              detectedFormat: formatValidation.detectedFormat,
              formatValidation: formatValidation.validation,
            }
          : {}),
        ...(formatError ? { formatValidationError: formatError } : {}),
      },
      uploadReservationId: reservationId,
      uploadReservationMode: "provider_output",
      cleanupEligible: true,
      maxWorkspaceStorageBytes: this.config.maxWorkspaceStorageBytes,
      createdBy: run.createdBy,
    }).catch(async (error) => {
      await discardUnversionedOutput(error);
      throw error;
    });
    let version = created.version;
    if (version.status === "pending") {
      await transferHeartbeat.ensure();
      await this.store.promote(quarantineKey, storageKey, {
        sha256: receipt.sha256,
        size: receipt.size,
      });
      await transferHeartbeat.ensure();
      if (exact) {
        try {
          await leaseGuard();
          const committed = await commitScienceRunOutput(this.db, {
            workspaceId: this.workspaceId,
            runId: run.id,
            expectedGeneration: run.executionGeneration,
            leaseOwner,
            artifactVersionId: version.id,
            semanticRole: normalizeLogicalName(output.logicalName, "output").slice(0, 128),
          });
          version = committed.version;
        } catch (error) {
          // Promotion completed, but cancellation/generation/lease fencing won
          // before the atomic ready+link commit. Make the version terminal and
          // remove the now-unreachable object so a losing worker cannot leave
          // pending metadata or consume immutable storage indefinitely.
          const quarantined = await transitionScienceArtifactVersion(this.db, {
            workspaceId: this.workspaceId,
            versionId: version.id,
            to: "quarantined",
          }).catch(() => null);
          if (quarantined?.status === "quarantined") {
            await this.store.remove(storageKey).catch(() => {});
            version = quarantined;
            await releaseCommittedReservation(version).catch(() => {});
          }
          throw error;
        }
      } else {
        await transferHeartbeat.ensure();
        version = await transitionScienceArtifactVersion(this.db, {
          workspaceId: this.workspaceId,
          versionId: version.id,
          to: "quarantined",
        });
      }
    } else {
      await this.store.discardQuarantine(quarantineKey).catch(() => {});
      if (exact) {
        await transferHeartbeat.ensure();
        await leaseGuard();
        const committed = await commitScienceRunOutput(this.db, {
          workspaceId: this.workspaceId,
          runId: run.id,
          expectedGeneration: run.executionGeneration,
          leaseOwner,
          artifactVersionId: version.id,
          semanticRole: normalizeLogicalName(output.logicalName, "output").slice(0, 128),
        });
        version = committed.version;
      }
    }
    await releaseCommittedReservation(version);
    if (!exact) {
      await this.publish({
        type: "science.artifact.quarantined",
        workspaceId: this.workspaceId,
        studyId: run.studyId,
        runId: run.id,
        missionId: run.missionId,
        artifactVersionId: version.id,
        sequence: version.version,
        at: version.createdAt.toISOString(),
        state: version.status,
        metadata: {
          declaredSha256: output.sha256,
          actualSha256: receipt.sha256,
          declaredSizeBytes: output.size,
          actualSizeBytes: receipt.size,
          ...(formatError ? { formatError } : {}),
        },
      });
      throw new Error(
        formatError
          ? `provider output ${output.logicalName} failed format verification: ${formatError}`
          : `provider output ${output.logicalName} failed checksum verification`,
      );
    }
    await this.publish({
      type: "science.artifact.ready",
      workspaceId: this.workspaceId,
      studyId: run.studyId,
      runId: run.id,
      missionId: run.missionId,
      artifactVersionId: version.id,
      sequence: version.version,
      at: (version.readyAt ?? version.createdAt).toISOString(),
      state: version.status,
      metadata: {
        artifactId: version.artifactId,
        sha256: version.sha256,
        sizeBytes: version.sizeBytes,
        mediaType: version.mediaType,
      },
    });
    return version;
    } finally {
      await transferHeartbeat.stop(false);
    }
  }

  private async buildManifest(
    run: ScienceRun,
    provider: ComputeProvider,
    adapterVersion: string,
    finishedAt: Date,
  ): Promise<ScienceManifest> {
    const [links, events, approval] = await Promise.all([
      this.allRunArtifacts(run.id),
      this.allRunEvents(run.id),
      findApprovalForNode(this.db, run.missionId, "science.run"),
    ]);
    assertNoSecretFields(run.profileSnapshot.config, "science compute profile config");
    assertNoSecretFields(run.parameters, "science run parameters");
    const refs = await Promise.all(links.map(async (link) => {
      const version = await getScienceArtifactVersionForWorkspace(
        this.db,
        this.workspaceId,
        link.artifactVersionId,
      );
      if (!version) throw new Error("science manifest link is missing its artifact version");
      const artifact = await getScienceArtifactForWorkspace(
        this.db,
        this.workspaceId,
        version.artifactId,
      );
      if (!artifact) throw new Error("science manifest link is missing its artifact");
      return {
        direction: link.direction,
        artifactVersionId: version.id,
        sha256: version.sha256,
        sizeBytes: version.sizeBytes,
        semanticRole: link.semanticRole,
        artifactKind: artifact.kind,
        artifactFormat: artifact.format,
        artifactVersionStatus: version.status,
        artifactVersionMetadata: version.metadata,
      };
    }));
    const sorted = (direction: "input" | "output") =>
      refs
        .filter((entry) => entry.direction === direction)
        .map(({
          direction: _direction,
          artifactKind: _artifactKind,
          artifactFormat: _artifactFormat,
          artifactVersionStatus: _artifactVersionStatus,
          artifactVersionMetadata: _artifactVersionMetadata,
          ...entry
        }) => entry)
        .sort((left, right) =>
          left.semanticRole.localeCompare(right.semanticRole) ||
          left.artifactVersionId.localeCompare(right.artifactVersionId));
    const config = run.profileSnapshot.config;
    const dependencyLock =
      config.dependencyLock &&
      typeof config.dependencyLock === "object" &&
      !Array.isArray(config.dependencyLock)
        ? config.dependencyLock as Record<string, unknown>
        : {};
    const inputs = sorted("input");
    const outputs = sorted("output");
    const codeArtifactVersionId =
      refs.find((entry) =>
        entry.direction === "input" &&
        VERIFIED_CODE_SEMANTIC_ROLES.has(entry.semanticRole) &&
        isVerifiedCodeArtifact(
          { kind: entry.artifactKind, format: entry.artifactFormat },
          {
            status: entry.artifactVersionStatus,
            metadata: entry.artifactVersionMetadata,
          },
        ))
        ?.artifactVersionId ?? null;
    const preliminary = {
      schemaVersion: 1 as const,
      studyId: run.studyId,
      runId: run.id,
      missionId: run.missionId,
      inputs,
      outputs,
      codeArtifactVersionId,
      // Run parameters are user-controlled. Until an independent repository
      // resolver records immutable evidence, a declared source revision must
      // remain informational inside `parameters` and cannot be promoted to
      // verified top-level provenance.
      sourceRevision: null,
      compute: {
        ...run.profileSnapshot,
        requestedResources: run.resourceRequest,
        adapterVersion,
        dependencyLock,
      },
      parameters: run.parameters,
      units: recordOfStrings(run.parameters.units),
      randomSeeds: recordOfIntegers(run.parameters.randomSeeds),
      environment: {
        nodeEnv: process.env.NODE_ENV ?? "unknown",
        artifactStore: this.store.adapter,
        computeProvider: provider.kind,
      },
      actorId: run.createdBy,
      approvalIds: approval?.status === "approved" ? [approval.id] : [],
      policyIds: [],
      toolCalls: [
        "science.run.submit",
        `${provider.kind}.submit`,
        `${provider.kind}.status`,
        `${provider.kind}.collectOutputs`,
      ],
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: finishedAt.toISOString(),
      history: events.items.map((event) => ({
        event: event.eventType,
        at: event.createdAt.toISOString(),
        generation: event.executionGeneration,
        detail: boundedRecord(event.payload, 2 * 1024),
      })),
      validations: [{
        kind: "artifact-checksum",
        passed: true,
        outputCount: outputs.length,
        algorithm: "sha256",
      }],
      limitations: provider.kind === "local_container"
        ? ["Execution completion and checksums are verified; domain-specific numerical validity is not inferred."]
        : ["Provider completion and checksums are verified; domain-specific numerical validity is not inferred."],
      complete: false,
      gaps: ["assessment-pending"],
    };
    const assessed = assessManifest(preliminary);
    const gaps = [...assessed.gaps];
    if (Object.keys(dependencyLock).length === 0) {
      gaps.push("manifest.compute.dependencyLock");
    }
    if (events.truncated) gaps.push("manifest.history.truncated");
    const uniqueGaps = [...new Set(gaps.filter((gap) => gap !== "manifest.gaps"))].sort();
    // "assessment-pending" is data in gaps, not a structural schema issue.
    const finalGaps = uniqueGaps.filter((gap) => gap !== "assessment-pending");
    return {
      ...preliminary,
      complete: finalGaps.length === 0,
      gaps: finalGaps,
    };
  }

  private async tickWithLease(run: ScienceRun): Promise<ScienceTickResult> {
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    let leased = false;
    let current = run;
    let leaseFailure: unknown = null;
    let providerTerminalObserved = false;
    let durableSubmitAttemptExists = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTail = Promise.resolve();
    const leaseExpiresAt = () => new Date(Date.now() + WORKER_LEASE_MS);
    const scheduleHeartbeat = () => {
      heartbeatTail = heartbeatTail.then(async () => {
        if (!leased || leaseFailure) return;
        try {
          await renewScienceRunLease(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            leaseExpiresAt: leaseExpiresAt(),
          });
        } catch (error) {
          leaseFailure = error;
        }
      });
      return heartbeatTail;
    };
    const ensureLease = async () => {
      await heartbeatTail;
      if (leaseFailure) {
        throw new ScienceConflictError(
          `science run worker lease was lost: ${safeError(leaseFailure)}`,
        );
      }
    };
    const finishCancelled = async (
      providerState: string,
      cancelAccepted: boolean | null,
    ): Promise<ScienceTickResult> => {
      await ensureLease();
      current = await transitionScienceRun(this.db, {
        workspaceId: this.workspaceId,
        runId: current.id,
        expectedGeneration: current.executionGeneration,
        leaseOwner,
        to: "cancelled",
        eventPayload: { providerState, cancelAccepted },
      });
      await this.publishRunEvent(current);
      await this.bus.publish({
        type: "mission.finished",
        missionId: current.missionId,
        status: "cancelled",
        at: current.finishedAt?.toISOString() ?? new Date().toISOString(),
      }).catch(() => {});
      await this.auditEntry("science.run.cancelled", null, current.id, {
        providerState,
        cancelAccepted,
      }, current.missionId);
      return { nextPollMs: null };
    };
    const handleCancellation = async (
      provider: ComputeProvider,
      providerHandle: string | null,
      submitAttempt: ScienceRunSubmitAttempt | null,
      providerInstanceId: string,
    ): Promise<ScienceTickResult> => {
      if (!providerHandle) {
        if (submitAttempt) {
          throw new Error(
            "science provider submission may exist but its durable handle has not been recovered",
          );
        }
        return finishCancelled("not-submitted", null);
      }
      const cancellation = await provider.cancel(
        providerHandle,
        current.executionGeneration,
        { expectedInstanceId: providerInstanceId },
      );
      if (typeof cancellation.accepted !== "boolean") {
        throw new Error("science provider returned an invalid cancellation acknowledgement");
      }
      await ensureLease();
      const status = validateComputeStatus(await provider.status(
        providerHandle,
        current.executionGeneration,
        { expectedInstanceId: providerInstanceId },
      ));
      await ensureLease();
      if (["cancelled", "failed", "succeeded"].includes(status.state)) {
        // A succeeded provider is still safe to cancel here: no output has
        // been collected or linked after the durable cancelling transition.
        return finishCancelled(status.state, cancellation.accepted);
      }
      await this.appendTelemetry(current, leaseOwner, {
        progress: status.progress,
        message:
          `Cancellation pending (${status.state}); provider accepted=${cancellation.accepted}`,
        logs: status.logs,
        metrics: status.metrics,
      });
      const cancellationEvents = await this.recentRunEvents(current.id, 100).catch(
        () => [] as ScienceRunEvent[],
      );
      const pendingAttempts = cancellationEvents.filter(
        (event) =>
          event.executionGeneration === current.executionGeneration &&
          event.eventType === "science.run.log" &&
          (event.payload as Record<string, unknown>).cancellationPending === true,
      ).length + 1;
      const adminActionRequired = pendingAttempts >= MAX_PROVIDER_ERRORS;
      const pendingEvent = await appendScienceRunEvent(this.db, {
        workspaceId: this.workspaceId,
        runId: current.id,
        expectedGeneration: current.executionGeneration,
        leaseOwner,
        eventType: "science.run.log",
        payload: {
          cancellationPending: true,
          attempt: pendingAttempts,
          providerState: status.state,
          cancelAccepted: cancellation.accepted,
          ...(adminActionRequired ? { orphaned: true, adminActionRequired: true } : {}),
        },
      });
      await this.publishRunEvent(current, pendingEvent);
      if (pendingAttempts === MAX_PROVIDER_ERRORS) {
        await this.auditEntry("science.run.orphaned", null, current.id, {
          executionGeneration: current.executionGeneration,
          providerState: status.state,
          reason: "provider did not reach a terminal state after repeated cancellation",
          adminActionRequired: true,
        }, current.missionId).catch(() => {});
      }
      return {
        nextPollMs: adminActionRequired
          ? Math.max(this.config.pollIntervalMs, 60_000)
          : this.config.pollIntervalMs,
      };
    };
    try {
      current = await acquireScienceRunLease(this.db, {
        workspaceId: this.workspaceId,
        runId: current.id,
        expectedGeneration: current.executionGeneration,
        leaseOwner,
        leaseExpiresAt: leaseExpiresAt(),
      });
      leased = true;
      heartbeatTimer = setInterval(() => {
        void scheduleHeartbeat();
      }, Math.max(1_000, Math.floor(WORKER_LEASE_MS / 3)));
      heartbeatTimer.unref?.();
      let submitAttempt = await getScienceRunSubmitAttempt(this.db, {
        workspaceId: this.workspaceId,
        runId: current.id,
        expectedGeneration: current.executionGeneration,
      });
      durableSubmitAttemptExists = submitAttempt !== null;
      let storedHandle: StoredComputeHandle | null = null;
      if (current.providerHandle) {
        storedHandle = decodeComputeHandle(current.providerHandle);
      }

      const submittedAt = Date.parse(await this.submissionTime(current));
      const elapsedSeconds = Math.max(0, (Date.now() - submittedAt) / 1_000);
      const configuredProvisioning =
        typeof current.profileSnapshot.config.provisioningTimeoutSeconds === "number" &&
        Number.isFinite(current.profileSnapshot.config.provisioningTimeoutSeconds)
          ? Math.max(1, current.profileSnapshot.config.provisioningTimeoutSeconds)
          : 300;
      const provisioningDeadline = Math.min(
        current.resourceRequest.wallTimeSeconds,
        configuredProvisioning,
      );
      if (
        current.state !== "cancelling" &&
        (
          elapsedSeconds > current.resourceRequest.wallTimeSeconds ||
          (current.state === "provisioning" && elapsedSeconds > provisioningDeadline)
        )
      ) {
        current = await transitionScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          to: "cancelling",
          eventPayload: {
            reason:
              elapsedSeconds > current.resourceRequest.wallTimeSeconds
                ? "wall-time limit exceeded"
                : "provisioning deadline exceeded",
          },
        });
        await this.publishRunEvent(current);
      }
      if (current.state === "cancelling" && !storedHandle && !submitAttempt) {
        // No external call can exist: a durable marker is always committed
        // before submit. Cancellation and local deadlines therefore do not
        // depend on an unhealthy or missing provider control plane.
        return await finishCancelled("not-submitted", null);
      }

      const provider = this.computeProviders.get(current.profileSnapshot.providerKind);
      const fenceProviderIdentity = async (
        recordedProviderKind: string,
        recordedProviderInstanceId: string,
        observedProviderInstanceId: string | null,
      ): Promise<ScienceTickResult> => {
        const payload = {
          providerIdentityFenced: true,
          adminActionRequired: true,
          recordedProviderKind,
          recordedProviderInstanceId,
          observedProviderKind: provider.kind,
          observedProviderInstanceId,
          reason: "compute provider identity changed while the run was active",
        };
        const prior = (await this.recentRunEvents(current.id, 100).catch(
          () => [] as ScienceRunEvent[],
        )).some(
          (event) =>
            event.executionGeneration === current.executionGeneration &&
            (event.payload as Record<string, unknown>).providerIdentityFenced === true,
        );
        if (current.state !== "cancelling") {
          current = await transitionScienceRun(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            to: "cancelling",
            eventPayload: payload,
          });
          await this.publishRunEvent(current);
        } else if (!prior) {
          const event = await appendScienceRunEvent(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            eventType: "science.run.log",
            payload,
          });
          await this.publishRunEvent(current, event);
        }
        if (!prior) {
          await this.auditEntry("science.run.orphaned", null, current.id, payload, current.missionId)
            .catch(() => {});
        }
        return { nextPollMs: Math.max(this.config.pollIntervalMs, 60_000) };
      };

      const recordedIdentity = storedHandle
        ? {
            providerKind: storedHandle.providerKind,
            providerInstanceId: storedHandle.instanceId,
          }
        : submitAttempt;
      if (recordedIdentity && recordedIdentity.providerKind !== provider.kind) {
        return await fenceProviderIdentity(
          recordedIdentity.providerKind,
          recordedIdentity.providerInstanceId,
          null,
        );
      }
      if (
        storedHandle &&
        submitAttempt &&
        (
          storedHandle.providerKind !== submitAttempt.providerKind ||
          storedHandle.instanceId !== submitAttempt.providerInstanceId
        )
      ) {
        return await fenceProviderIdentity(
          submitAttempt.providerKind,
          submitAttempt.providerInstanceId,
          storedHandle.instanceId,
        );
      }

      const providerHealth = await provider.health();
      if (!providerHealth.ok) {
        throw new Error(
          `science compute provider is unavailable: ${providerHealth.detail ?? provider.kind}`,
        );
      }
      const instanceId = providerHealth.instanceId;
      if (!instanceId || !/^[a-z0-9._-]{1,100}$/i.test(instanceId)) {
        throw new Error("science compute provider did not report a bounded immutable instance ID");
      }
      if (
        recordedIdentity &&
        recordedIdentity.providerInstanceId !== instanceId
      ) {
        return await fenceProviderIdentity(
          recordedIdentity.providerKind,
          recordedIdentity.providerInstanceId,
          instanceId,
        );
      }
      const adapterVersion =
        `${provider.version}/${providerHealth.version}@${instanceId}`.slice(0, 200);
      let providerHandle = storedHandle?.handle ?? null;

      if (current.state === "cancelling" && providerHandle) {
        // Await inside the lease-owning try/finally. Returning the promise
        // directly would run `finally` first, release the worker lease, and
        // then let cancellation telemetry race against that release.
        return await handleCancellation(
          provider,
          providerHandle,
          submitAttempt,
          instanceId,
        );
      }
      if (!providerHandle) {
        const idempotencyKey =
          submitAttempt?.idempotencyKey ?? `${current.id}:${current.executionGeneration}`;
        if (
          submitAttempt &&
          submitAttempt.idempotencyKey !== `${current.id}:${current.executionGeneration}`
        ) {
          return await fenceProviderIdentity(
            submitAttempt.providerKind,
            submitAttempt.providerInstanceId,
            instanceId,
          );
        }
        const submission = {
          runId: current.id,
          missionId: current.missionId,
          generation: current.executionGeneration,
          idempotencyKey,
          submittedAt: await this.submissionTime(current),
          imageDigest: current.profileSnapshot.imageDigest,
          kernel: current.profileSnapshot.kernelName,
          parameters: current.parameters,
          resources: current.resourceRequest,
          inputs: await this.providerInputs(current),
        };
        let marker;
        try {
          marker = await recordScienceRunSubmitAttempt(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            providerKind: provider.kind,
            providerInstanceId: instanceId,
            idempotencyKey,
          });
        } catch (error) {
          if (
            error instanceof ScienceConflictError &&
            /cancelled before provider submission/i.test(error.message)
          ) {
            current = await getScienceRunForWorkspace(
              this.db,
              this.workspaceId,
              current.id,
            ) ?? current;
            return await finishCancelled("not-submitted", null);
          }
          throw error;
        }
        submitAttempt = marker.attempt;
        durableSubmitAttemptExists = true;
        if (marker.event) await this.publishRunEvent(current, marker.event);
        const submitted = await provider.submit(submission, {
          expectedInstanceId: instanceId,
        });
        await ensureLease();
        if (
          typeof submitted.handle !== "string" ||
          !submitted.handle ||
          submitted.handle.length > 440 ||
          submitted.handle.includes("\0")
        ) {
          throw new Error("science provider returned an invalid durable handle");
        }
        const durableHandle = encodeComputeHandle({
          providerKind: provider.kind,
          instanceId,
          handle: submitted.handle,
        });
        current = await setScienceRunProviderHandle(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          providerHandle: durableHandle,
        });
        providerHandle = submitted.handle;
      }
      if (current.state === "cancelling") {
        return await handleCancellation(
          provider,
          providerHandle,
          submitAttempt,
          instanceId,
        );
      }
      const status = validateComputeStatus(await provider.status(
        providerHandle!,
        current.executionGeneration,
        { expectedInstanceId: instanceId },
      ));
      providerTerminalObserved = ["succeeded", "failed", "cancelled"].includes(status.state);
      await ensureLease();
      if (status.state === "failed") {
        current = await transitionScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          to: "failed",
          error: safeError(status.error ?? status.message ?? "science provider failed"),
        });
        await this.publishRunEvent(current);
        await this.bus.publish({
          type: "mission.finished",
          missionId: current.missionId,
          status: "failed",
          at: new Date().toISOString(),
        }).catch(() => {});
        await this.auditEntry("science.run.failed", null, current.id, {
          error: current.error,
          providerState: status.state,
        }, current.missionId);
        return { nextPollMs: null };
      }
      if (status.state === "cancelled") {
        current = await transitionScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          to: "cancelling",
        });
        current = await transitionScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          to: "cancelled",
        });
        await this.publishRunEvent(current);
        await this.bus.publish({
          type: "mission.finished",
          missionId: current.missionId,
          status: "cancelled",
          at: current.finishedAt?.toISOString() ?? new Date().toISOString(),
        }).catch(() => {});
        await this.auditEntry("science.run.cancelled", null, current.id, {
          providerState: status.state,
          cancelAccepted: null,
        }, current.missionId);
        return { nextPollMs: null };
      }
      if (status.state === "running" && current.state === "provisioning") {
        current = await transitionScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          to: "running",
          providerHandle: current.providerHandle,
        });
        await this.publishRunEvent(current);
        await this.bus.publish({
          type: "mission.started",
          missionId: current.missionId,
          at: new Date().toISOString(),
        }).catch(() => {});
      }
      if (status.state === "provisioning" || status.state === "queued" ||
          status.state === "running") {
        if (current.state === "finalizing") {
          throw new Error(
            `science provider regressed to ${status.state} after finalization began`,
          );
        }
        await this.appendTelemetry(current, leaseOwner, status);
        return { nextPollMs: this.config.pollIntervalMs };
      }
      if (status.state === "succeeded") {
        if (current.state === "provisioning") {
          current = await transitionScienceRun(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            to: "running",
            providerHandle: current.providerHandle,
          });
          await this.publishRunEvent(current);
          await this.bus.publish({
            type: "mission.started",
            missionId: current.missionId,
            at: current.startedAt?.toISOString() ?? new Date().toISOString(),
          }).catch(() => {});
        }
        if (current.state === "running") {
          current = await transitionScienceRun(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            to: "finalizing",
          });
          await this.publishRunEvent(current);
        }
        await scheduleHeartbeat();
        await ensureLease();
        const outputs = validateProviderOutputs(await provider.collectOutputs(
          providerHandle!,
          current.executionGeneration,
          { expectedInstanceId: instanceId },
        ));
        await ensureLease();
        if (outputs.length === 0) throw new Error("science provider returned no outputs");
        if (outputs.length > 200) {
          throw new Error("science provider returned more than 200 outputs");
        }
        const outputNames = new Set<string>();
        for (const output of outputs) {
          const normalizedName = normalizeLogicalName(output.logicalName, "output");
          if (outputNames.has(normalizedName)) {
            throw new Error(
              `science provider returned duplicate output logical name ${normalizedName}`,
            );
          }
          outputNames.add(normalizedName);
          await scheduleHeartbeat();
          await ensureLease();
          await this.ingestOutput(
            current,
            provider,
            instanceId,
            output,
            leaseOwner,
            ensureLease,
          );
        }
        const finishedAt = new Date();
        const manifest = await this.buildManifest(
          current,
          provider,
          adapterVersion,
          finishedAt,
        );
        await ensureLease();
        current = await transitionScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
          to: "succeeded",
          manifest,
          now: finishedAt,
          eventPayload: {
            manifestComplete: manifest.complete,
            manifestGaps: manifest.gaps,
          },
        });
        await this.publishRunEvent(current);
        await this.bus.publish({
          type: "mission.finished",
          missionId: current.missionId,
          status: "succeeded",
          at: current.finishedAt?.toISOString() ?? new Date().toISOString(),
        }).catch(() => {});
        await this.auditEntry("science.run.finish", null, current.id, {
          state: current.state,
          manifestHash: current.manifestHash,
          manifestComplete: current.manifest?.complete,
        }, current.missionId);
        return { nextPollMs: null };
      }
      throw new Error(`unsupported provider state ${status.state}`);
    } catch (error) {
      if (error instanceof ScienceConflictError && /lease|generation is stale/i.test(error.message)) {
        return { nextPollMs: this.config.pollIntervalMs };
      }
      const message = safeError(error);
      let consecutiveErrorCount = 0;
      if (leased) {
        const fresh = await getScienceRunForWorkspace(
          this.db,
          this.workspaceId,
          current.id,
        ).catch(() => null);
        if (fresh) current = fresh;
        const recent = await this.recentRunEvents(current.id, 100).catch(
          () => [] as ScienceRunEvent[],
        );
        let errorCount = 0;
        for (const event of [...recent].reverse()) {
          if (event.executionGeneration !== current.executionGeneration) continue;
          if (
            event.eventType === "science.run.log" &&
            (event.payload as Record<string, unknown>).tickError === true
          ) {
            errorCount++;
            continue;
          }
          // A successful progress/lifecycle event breaks the consecutive
          // provider-error streak.
          break;
        }
        consecutiveErrorCount = errorCount + 1;
        if (ACTIVE_RUN_STATES.has(current.state) && !leaseFailure) {
          await appendScienceRunEvent(this.db, {
            workspaceId: this.workspaceId,
            runId: current.id,
            expectedGeneration: current.executionGeneration,
            leaseOwner,
            eventType: "science.run.log",
            payload: { tickError: true, attempt: errorCount + 1, message },
          }).then((event) => this.publishRunEvent(current, event)).catch(() => {});
          if (errorCount + 1 >= MAX_PROVIDER_ERRORS && current.state !== "cancelling") {
            if (providerTerminalObserved) {
              current = await transitionScienceRun(this.db, {
                workspaceId: this.workspaceId,
                runId: current.id,
                expectedGeneration: current.executionGeneration,
                leaseOwner,
                to: "failed",
                error: message,
              }).catch(() => current);
              if (current.state === "failed") {
                await this.publishRunEvent(current);
                await this.bus.publish({
                  type: "mission.finished",
                  missionId: current.missionId,
                  status: "failed",
                  at: current.finishedAt?.toISOString() ?? new Date().toISOString(),
                }).catch(() => {});
                await this.auditEntry("science.run.failed", null, current.id, {
                  error: current.error,
                  providerErrorCount: errorCount + 1,
                  providerTerminalObserved: true,
                }, current.missionId).catch(() => {});
                return { nextPollMs: null };
              }
            } else if (current.providerHandle || durableSubmitAttemptExists) {
              current = await transitionScienceRun(this.db, {
                workspaceId: this.workspaceId,
                runId: current.id,
                expectedGeneration: current.executionGeneration,
                leaseOwner,
                to: "cancelling",
                eventPayload: {
                  reason: "provider control plane failed repeatedly",
                  attempt: errorCount + 1,
                  providerErrorCount: errorCount + 1,
                  orphaned: true,
                  adminActionRequired: true,
                  providerHandlePersisted: current.providerHandle !== null,
                  durableSubmitAttemptPersisted: durableSubmitAttemptExists,
                  diagnostic: redactScienceDiagnostic(error, 1_000),
                },
              }).catch(() => current);
              if (current.state === "cancelling") {
                await this.publishRunEvent(current);
              }
            }
          }
          if (errorCount + 1 === MAX_PROVIDER_ERRORS) {
            await this.auditEntry("science.run.orphaned", null, current.id, {
              error: message,
              providerErrorCount: errorCount + 1,
              providerHandlePersisted: current.providerHandle !== null,
              durableSubmitAttemptPersisted: durableSubmitAttemptExists,
              adminActionRequired: true,
            }, current.missionId).catch(() => {});
          }
        }
      }
      return {
        nextPollMs:
          consecutiveErrorCount >= MAX_PROVIDER_ERRORS
            ? Math.max(this.config.pollIntervalMs, 60_000)
            : this.config.pollIntervalMs,
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeatTail.catch(() => {});
      if (leased && !TERMINAL_RUN_STATES.has(current.state)) {
        await releaseScienceRunLease(this.db, {
          workspaceId: this.workspaceId,
          runId: current.id,
          expectedGeneration: current.executionGeneration,
          leaseOwner,
        }).catch(() => {});
      }
    }
  }

  async tick(runId: string, expectedGeneration: number | null): Promise<ScienceTickResult> {
    // Internal lifecycle ownership continues in read-only mode so accepted
    // runs and provider resources are never stranded during rollback.
    this.assertReadable();
    let run = await getScienceRunForWorkspace(this.db, this.workspaceId, runId);
    if (!run || TERMINAL_RUN_STATES.has(run.state) || run.state === "awaiting_approval" ||
        run.state === "draft") {
      return { nextPollMs: null };
    }
    if (expectedGeneration !== null && run.executionGeneration !== expectedGeneration) {
      return { nextPollMs: null };
    }
    if (run.state === "queued") {
      try {
        const claimed = await claimScienceRun(this.db, {
          workspaceId: this.workspaceId,
          runId: run.id,
          expectedGeneration: run.executionGeneration,
        });
        run = claimed.run;
        await this.publishRunEvent(run);
      } catch (error) {
        if (error instanceof ScienceConflictError) {
          return { nextPollMs: this.config.pollIntervalMs };
        }
        throw error;
      }
    }
    return this.tickWithLease(run);
  }

  private async assessPersistedManifest(
    runId: string,
  ) {
    return (await assessScienceRunManifestForWorkspace(
      this.db,
      this.workspaceId,
      runId,
    )) ?? { complete: false, gaps: ["manifest.relational-integrity"] };
  }

  async getManifest(runId: string) {
    const run = await this.getRun(runId);
    const assessed = await this.assessPersistedManifest(run.id);
    return {
      runId: run.id,
      state: run.state,
      manifest: run.manifest,
      manifestHash: run.manifestHash,
      // Stored manifest bytes and hash remain immutable. These top-level fields
      // are the current trust assessment, so pre-hardening manifests cannot
      // retain a stale completeness claim.
      complete: assessed.complete,
      gaps: assessed.gaps,
    };
  }

  async recordDomainValidation(
    input: ScienceDomainValidationSubmission & {
      runId: string;
      reviewerId: string;
      reviewerRole: "admin" | "owner";
    },
  ) {
    this.assertMetadataWritable();
    const runId = input.runId.toLowerCase();
    const baselineRunId = input.baselineRunId?.toLowerCase();
    const reviewerId = input.reviewerId.toLowerCase();
    const record = await this.mutateAs(
      "science.domain-validation.create",
      reviewerId,
      (db) => createScienceDomainValidation(db, {
        ...input,
        runId,
        baselineRunId,
        reviewerId,
        workspaceId: this.workspaceId,
      }),
    );
    await this.auditEntry(
      "science.domain-validation.create",
      reviewerId,
      record.id,
      {
        runId: record.runId,
        revision: record.revision,
        baselineRunId: record.baselineRunId,
        kind: record.kind,
        metric: record.metric,
        decision: record.decision,
        recordHash: record.recordHash,
      },
    );
    return record;
  }

  async listDomainValidations(runId: string, page?: { offset?: number; limit?: number }) {
    this.assertReadable();
    runId = runId.toLowerCase();
    await this.getRun(runId);
    return listScienceDomainValidations(this.db, {
      workspaceId: this.workspaceId,
      runId,
      page,
    });
  }

  async getDomainValidation(runId: string, validationId: string) {
    this.assertReadable();
    runId = runId.toLowerCase();
    validationId = validationId.toLowerCase();
    await this.getRun(runId);
    const record = await getScienceDomainValidationForRun(this.db, {
      workspaceId: this.workspaceId,
      runId,
      validationId,
    });
    if (!record) throw new ScienceNotFoundError("science domain validation not found");
    return record;
  }

  async reproduceRun(input: {
    runId: string;
    actorId: string;
    idempotencyKey: string;
  }) {
    await this.assertWritable();
    const source = await this.getRun(input.runId);
    const manifestAssessment = await this.assessPersistedManifest(source.id);
    if (!source.manifest || source.state !== "succeeded" || !manifestAssessment.complete) {
      throw new ScienceConflictError(
        "only a succeeded science run with a currently verified complete manifest can be reproduced",
      );
    }
    const profile = await getScienceComputeProfileForWorkspace(
      this.db,
      this.workspaceId,
      source.computeProfileId,
    );
    if (!profile) {
      throw new ScienceConflictError("captured science compute profile no longer exists");
    }
    const currentSnapshot = {
      profileId: profile.id,
      providerKind: profile.providerKind,
      imageDigest: profile.imageDigest,
      kernelName: profile.kernelName,
      resourceBounds: profile.resourceBounds,
      config: profile.config,
    };
    if (canonicalJson(currentSnapshot) !== canonicalJson(source.profileSnapshot)) {
      throw new ScienceConflictError(
        "compute profile changed since the source run; exact reproduction is refused",
      );
    }
    const provider = this.computeProviders.get(source.profileSnapshot.providerKind);
    const health = await provider.health();
    const currentAdapterVersion = health.ok && health.instanceId
      ? `${provider.version}/${health.version}@${health.instanceId}`.slice(0, 200)
      : null;
    if (currentAdapterVersion !== source.manifest.compute.adapterVersion) {
      throw new ScienceConflictError(
        "compute adapter version changed since the source run; exact reproduction is refused",
      );
    }
    const submitted = await this.submitRun({
      studyId: source.studyId,
      computeProfileId: source.computeProfileId,
      resourceRequest: source.resourceRequest,
      inputs: source.manifest.inputs.map((entry) => ({
        artifactVersionId: entry.artifactVersionId,
        semanticRole: entry.semanticRole,
      })),
      parameters: source.parameters,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
    });
    await this.auditEntry("science.run.reproduce", input.actorId, submitted.run.id, {
      sourceRunId: source.id,
    }, submitted.run.missionId);
    return { sourceRunId: source.id, ...submitted };
  }

  async compareRuns(leftRunId: string, rightRunId: string) {
    leftRunId = leftRunId.toLowerCase();
    rightRunId = rightRunId.toLowerCase();
    const [left, right] = await Promise.all([
      this.getRun(leftRunId),
      this.getRun(rightRunId),
    ]);
    if (!left.manifest || !right.manifest) {
      throw new ScienceConflictError("both science runs need manifests before comparison");
    }
    const newestLinkedRecord = await getLatestScienceLinkedNumericalEquivalenceRecord(this.db, {
      workspaceId: this.workspaceId,
      baselineRunId: leftRunId,
      candidateRunId: rightRunId,
    });
    const leftHash = createHash("sha256").update(canonicalJson(left.manifest)).digest("hex");
    const rightHash = createHash("sha256").update(canonicalJson(right.manifest)).digest("hex");
    let linked: typeof newestLinkedRecord = null;
    if (newestLinkedRecord) {
      try {
        if (
          verifyScienceDomainValidationRecordHash(newestLinkedRecord) &&
          left.manifestHash !== null &&
          right.manifestHash !== null &&
          leftHash === left.manifestHash &&
          rightHash === right.manifestHash &&
          newestLinkedRecord.baselineManifestHash === left.manifestHash &&
          newestLinkedRecord.runManifestHash === right.manifestHash &&
          canonicalJson(newestLinkedRecord.baselineOutputChecksums) ===
            canonicalJson(left.manifest.outputs) &&
          canonicalJson(newestLinkedRecord.runOutputChecksums) ===
            canonicalJson(right.manifest.outputs)
        ) {
          linked = newestLinkedRecord;
        }
      } catch {
        // The newest exact-pair record is authoritative. Any malformed hash or
        // lineage binding makes numerical review unavailable; older decisions
        // must never be used as a fallback.
      }
    }
    const numericalValidation = linked
      ? {
          passed: linked.decision,
          metric: linked.metric,
          tolerance: linked.tolerance,
          observed: linked.observedValue,
          units: linked.units,
          methodProtocolId: linked.methodProtocolId,
          limitationsReason: linked.limitationsReason,
          recordId: linked.id,
          revision: linked.revision,
          reviewerId: linked.reviewerId,
          createdAt: linked.createdAt.toISOString(),
          recordHash: linked.recordHash,
        }
      : null;
    return {
      leftRunId,
      rightRunId,
      comparison: compareManifests(left.manifest, right.manifest, numericalValidation),
    };
  }

  private async renderSource(run: ScienceRun, versionId: string): Promise<{
    version: ScienceArtifactVersion;
    artifact: ScienceArtifact;
  }> {
    const outputs = await this.allRunArtifacts(run.id, "output");
    if (!outputs.some((entry) => entry.artifactVersionId === versionId)) {
      throw new ScienceConflictError(
        "render source must be an output linked to the selected science run",
      );
    }
    const version = await getScienceArtifactVersionForWorkspace(
      this.db,
      this.workspaceId,
      versionId,
    );
    if (!version || version.status !== "ready") {
      throw new ScienceConflictError("render source must be a ready artifact version");
    }
    const artifact = await getScienceArtifactForWorkspace(
      this.db,
      this.workspaceId,
      version.artifactId,
    );
    if (!artifact || artifact.studyId !== run.studyId) {
      throw new ScienceConflictError("render source must belong to the run study");
    }
    if (
      artifact.format.toLowerCase() !== "png" ||
      version.mediaType.toLowerCase() !== "image/png" ||
      version.sizeBytes < 1 ||
      version.sizeBytes > STATIC_RENDER_MAX_BYTES
    ) {
      throw new ScienceConflictError(
        `static render accepts only ready inline PNG outputs up to ${STATIC_RENDER_MAX_BYTES} bytes`,
      );
    }
    return { version, artifact };
  }

  private chooseRenderProvider(mode: "client" | "remote" | "static"): RenderSessionProvider {
    if (mode !== "static") {
      throw new ScienceConflictError(
        `${mode} render mode is not released; no implicit static downgrade is permitted`,
      );
    }
    return this.renderProviders.get("static");
  }

  private async admitRenderProvider(
    provider: RenderSessionProvider,
    expectedInstanceId?: string,
  ): Promise<string> {
    const health = await provider.health();
    if (!health.ok) {
      throw new ScienceConflictError(
        `science render provider is unavailable: ${health.detail ?? provider.kind}`,
      );
    }
    if (health.provider !== provider.kind) {
      throw new ScienceConflictError("science render provider reported a mismatched kind");
    }
    const instanceId = health.instanceId;
    if (!/^[a-z0-9._-]{1,100}$/i.test(instanceId)) {
      throw new ScienceConflictError(
        "science render provider did not report a bounded immutable instance ID",
      );
    }
    if (expectedInstanceId !== undefined && instanceId !== expectedInstanceId) {
      throw new ScienceConflictError(
        "science render provider identity changed while the session was active; " +
        "admin action is required",
      );
    }
    return instanceId;
  }

  private renderGatewayToken(audience: string): string {
    return createHmac("sha256", this.gatewaySecret)
      .update(`science-render-gateway.v1\n${audience}`)
      .digest("base64url");
  }

  async createRender(input: {
    runId: string;
    artifactVersionId: string;
    mode: "client" | "remote" | "static";
    idempotencyKey: string;
    actorId: string;
  }) {
    this.assertReadable();
    const idempotencyKey = typeof input.idempotencyKey === "string"
      ? input.idempotencyKey.trim()
      : "";
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ScienceConflictError("render idempotency key must be between 1 and 200 characters");
    }
    const run = await this.getRun(input.runId);
    const provider = this.chooseRenderProvider(input.mode);
    const requestKeyHash = sha256(idempotencyKey);
    const fingerprint = (source: {
      artifactVersionId: string;
      sha256: string;
      mediaType: string;
      sizeBytes: number;
      logicalName: string;
    }) => sha256(canonicalJson({
        contract: "science-render-intent.v1",
        workspaceId: this.workspaceId,
        ownerId: input.actorId,
        runId: run.id,
        artifactVersionId: source.artifactVersionId,
        mode: input.mode,
        providerKind: provider.kind,
        sourceSha256: source.sha256,
        sourceMediaType: source.mediaType.toLowerCase(),
        sourceSizeBytes: source.sizeBytes,
        sourceLogicalName: source.logicalName,
      }));
    const response = (session: ScienceRenderSession, created: boolean) => ({
      session,
      created,
      mode: session.mode,
      provider: session.providerKind,
      source: {
        artifactVersionId: session.artifactVersionId!,
        sha256: session.sourceSha256,
        mediaType: session.sourceMediaType,
        sizeBytes: session.sourceSizeBytes,
        logicalName: session.sourceLogicalName,
      },
      url: session.state === "ready"
        ? `/api/science/render-sessions/${session.id}/gateway`
        : null,
      expiresAt: session.expiresAt.toISOString(),
    });
    const replay = await getScienceRenderSessionForRequest(this.db, {
      workspaceId: this.workspaceId,
      ownerId: input.actorId,
      requestKeyHash,
    });
    let version: ScienceArtifactVersion;
    let artifact: ScienceArtifact;
    let intentFingerprint: string;
    if (replay) {
      const replayFingerprint = fingerprint({
        artifactVersionId: replay.artifactVersionId ?? "",
        sha256: replay.sourceSha256,
        mediaType: replay.sourceMediaType,
        sizeBytes: replay.sourceSizeBytes,
        logicalName: replay.sourceLogicalName,
      });
      if (
        replay.intentFingerprint !== replayFingerprint ||
        replay.runId !== run.id ||
        replay.artifactVersionId !== input.artifactVersionId ||
        replay.mode !== input.mode ||
        replay.providerKind !== provider.kind
      ) {
        throw new ScienceConflictError(
          "Render idempotency key was already used for a different request intent",
        );
      }
      if (replay.state !== "starting") return response(replay, false);
      try {
        await this.assertWritable();
      } catch (error) {
        if (error instanceof ScienceDisabledError) return response(replay, false);
        throw error;
      }
      ({ version, artifact } = await this.renderSource(run, input.artifactVersionId));
      intentFingerprint = fingerprint({
        artifactVersionId: version.id,
        sha256: version.sha256,
        mediaType: version.mediaType,
        sizeBytes: version.sizeBytes,
        logicalName: artifact.logicalName,
      });
      if (intentFingerprint !== replay.intentFingerprint) {
        throw new ScienceConflictError(
          "Render idempotency key was already used for a different request intent",
        );
      }
    } else {
      await this.assertWritable();
      ({ version, artifact } = await this.renderSource(run, input.artifactVersionId));
      intentFingerprint = fingerprint({
        artifactVersionId: version.id,
        sha256: version.sha256,
        mediaType: version.mediaType,
        sizeBytes: version.sizeBytes,
        logicalName: artifact.logicalName,
      });
    }
    const providerInstanceId = await this.admitRenderProvider(provider);
    const audience = `science-render:${sha256(
      `${this.workspaceId}:${input.actorId}:${requestKeyHash}`,
    )}`;
    const gatewayToken = this.renderGatewayToken(audience);
    const now = Date.now();
    const expiresAt = new Date(now + this.config.renderTtlSeconds * 1_000);
    const replayExpiresAt = new Date(
      now + Math.max(RENDER_REPLAY_HORIZON_MS, this.config.renderTtlSeconds * 1_000),
    );
    const created = await this.mutateAs("science.render.open", input.actorId, (db) =>
      createScienceRenderSession(db, {
      workspaceId: this.workspaceId,
      runId: run.id,
      artifactVersionId: version.id,
      requestKeyHash,
      intentFingerprint,
      providerKind: provider.kind,
      mode: input.mode,
      sourceSha256: version.sha256,
      sourceMediaType: version.mediaType.toLowerCase(),
      sourceSizeBytes: version.sizeBytes,
      sourceLogicalName: artifact.logicalName,
      tokenHash: sha256(gatewayToken),
      audience,
      ownerId: input.actorId,
      expiresAt,
      replayExpiresAt,
      maxConcurrentSessions: this.config.maxConcurrentRenderSessionsPerWorkspace,
      }));
    const source: RenderSource = {
      runId: run.id,
      artifactVersionId: version.id,
      format: artifact.format,
      mediaType: version.mediaType,
      size: version.sizeBytes,
      sha256: version.sha256,
    };
    const launchAttemptHandle = encodeRenderAttempt({
      providerKind: provider.kind,
      instanceId: providerInstanceId,
      sessionId: created.session.id,
    });
    let launchedHandle: string | null = null;
    let launchLeaseId: string | null = null;
    let actualHandlePersisted = false;
    try {
      if (created.session.state !== "starting") return response(created.session, created.created);
      if (created.session.providerHandle) {
        const stored = decodeRenderHandle(created.session.providerHandle);
        if (!stored.attempt) {
          if (stored.providerKind !== provider.kind) {
            throw new ScienceConflictError("persisted render provider does not match request intent");
          }
          await this.admitRenderProvider(provider, stored.instanceId);
          const status = await provider.status(
            stored.handle,
            { expectedInstanceId: stored.instanceId },
          );
          const session = status.state === "ready"
            ? await this.mutateAs("science.render.open", input.actorId, (db) =>
                transitionScienceRenderSession(db, {
                  workspaceId: this.workspaceId,
                  sessionId: created.session.id,
                  ownerId: input.actorId,
                  to: "ready",
                }))
            : created.session;
          return response(session, created.created);
        }
      }
      if (created.created) {
        await this.publish({
          type: "science.render.starting",
          workspaceId: this.workspaceId,
          studyId: run.studyId,
          runId: run.id,
          missionId: run.missionId,
          artifactVersionId: version.id,
          renderSessionId: created.session.id,
          sequence: 1,
          at: created.session.createdAt.toISOString(),
          state: "starting",
          metadata: { mode: input.mode, provider: provider.kind },
        });
      }
      launchLeaseId = randomUUID();
      const claim = await this.mutateAs("science.render.open", input.actorId, (db) =>
        claimScienceRenderSessionLaunch(db, {
          workspaceId: this.workspaceId,
          sessionId: created.session.id,
          ownerId: input.actorId,
          providerHandle: launchAttemptHandle,
          leaseId: launchLeaseId!,
          leaseExpiresAt: new Date(Date.now() + RENDER_LAUNCH_LEASE_MS),
        }));
      if (!claim.claimed) return response(claim.session, created.created);
      const launch = await provider.start({
        sessionId: created.session.id,
        workspaceId: this.workspaceId,
        ownerId: input.actorId,
        expiresAt: created.session.expiresAt.toISOString(),
        gatewayToken,
        source,
      }, { expectedInstanceId: providerInstanceId });
      launchedHandle = launch.providerHandle;
      if (!/^[a-z0-9._-]{1,100}$/i.test(launch.instanceId)) {
        throw new Error(
          "render provider start did not return a bounded immutable instance ID",
        );
      }
      if (launch.instanceId !== providerInstanceId) {
        throw new Error(
          "render provider identity changed between health admission and session launch",
        );
      }
      if (launch.mode !== "static") {
        throw new Error("static render provider returned a non-static launch mode");
      }
      if (launch.state !== "ready" && launch.state !== "starting") {
        throw new Error("render provider failed to start");
      }
      const persistedHandle = encodeRenderHandle({
        providerKind: provider.kind,
        instanceId: providerInstanceId,
        handle: launch.providerHandle,
      });
      const sessionWithHandle = await this.mutateAs("science.render.open", input.actorId, (db) =>
        replaceScienceRenderSessionProviderHandle(db, {
          workspaceId: this.workspaceId,
          sessionId: created.session.id,
          ownerId: input.actorId,
          expectedProviderHandle: launchAttemptHandle,
          launchLeaseId: launchLeaseId!,
          providerHandle: persistedHandle,
        }));
      actualHandlePersisted = true;
      let session;
      if (launch.state === "ready") {
        session = await this.mutateAs("science.render.open", input.actorId, (db) =>
          transitionScienceRenderSession(db, {
          workspaceId: this.workspaceId,
          sessionId: created.session.id,
          ownerId: input.actorId,
          to: "ready",
          }));
      } else session = sessionWithHandle;
      const type: ScienceEventType =
        session.state === "ready" ? "science.render.ready" : "science.render.starting";
      await this.publish({
        type,
        workspaceId: this.workspaceId,
        studyId: run.studyId,
        runId: run.id,
        missionId: run.missionId,
        artifactVersionId: version.id,
        renderSessionId: session.id,
        sequence: 2,
        at: session.updatedAt.toISOString(),
        state: session.state,
        metadata: { mode: launch.mode, provider: provider.kind },
      });
      await this.auditEntry("science.render.open", input.actorId, session.id, {
        runId: run.id,
        artifactVersionId: version.id,
        provider: provider.kind,
        mode: launch.mode,
      }, run.missionId);
      return response(session, created.created);
    } catch (error) {
      if (launchedHandle && launchLeaseId && !actualHandlePersisted) {
        try {
          await provider.close(
            launchedHandle,
            { expectedInstanceId: providerInstanceId },
          );
          await this.mutateAs("science.render.open", input.actorId, (db) =>
            releaseScienceRenderSessionLaunch(db, {
              workspaceId: this.workspaceId,
              sessionId: created.session.id,
              ownerId: input.actorId,
              providerHandle: launchAttemptHandle,
              leaseId: launchLeaseId!,
            }));
        } catch {
          // Keep the durable launch marker/lease so no retry can start a
          // second provider until the bounded claim expires.
        }
      } else if (launchLeaseId) {
        await this.mutateAs("science.render.open", input.actorId, (db) =>
          releaseScienceRenderSessionLaunch(db, {
            workspaceId: this.workspaceId,
            sessionId: created.session.id,
            ownerId: input.actorId,
            providerHandle: launchAttemptHandle,
            leaseId: launchLeaseId!,
          })).catch(() => {});
      }
      await this.publish({
        type: "science.render.starting",
        workspaceId: this.workspaceId,
        studyId: run.studyId,
        runId: run.id,
        missionId: run.missionId,
        artifactVersionId: version.id,
        renderSessionId: created.session.id,
        sequence: 2,
        at: new Date().toISOString(),
        state: "starting",
        metadata: { error: safeError(error) },
      }).catch(() => {});
      throw error;
    }
  }

  private async ownedRender(sessionId: string, actorId: string) {
    const session = await getScienceRenderSessionForWorkspace(
      this.db,
      this.workspaceId,
      sessionId,
    );
    if (!session || session.ownerId !== actorId) {
      throw new ScienceNotFoundError("science render session not found");
    }
    return session;
  }

  private async renderStatus(sessionId: string, actorId: string): Promise<{
    session: Awaited<ReturnType<typeof getScienceRenderSessionForWorkspace>>;
    status: RenderStatus;
  }> {
    let session = await this.ownedRender(sessionId, actorId);
    if (!session.providerHandle) {
      throw new ScienceConflictError("science render session has no provider handle");
    }
    const stored = decodeRenderHandle(session.providerHandle);
    if (stored.attempt) {
      throw new ScienceConflictError(
        "science render launch outcome is ambiguous; administrator action is required",
      );
    }
    const provider = this.renderProviders.get(stored.providerKind);
    await this.admitRenderProvider(provider, stored.instanceId);
    const status = await provider.status(
      stored.handle,
      { expectedInstanceId: stored.instanceId },
    );
    if (session.state === "starting" && status.state === "ready") {
      session = await this.mutateAs("science.render.status", actorId, (db) =>
        transitionScienceRenderSession(db, {
        workspaceId: this.workspaceId,
        sessionId,
        ownerId: actorId,
        to: "ready",
        }));
    } else if (
      (session.state === "starting" || session.state === "ready") &&
      (status.state === "failed" || status.state === "closed")
    ) {
      session = await this.mutateAs("science.render.status", actorId, (db) =>
        transitionScienceRenderSession(db, {
        workspaceId: this.workspaceId,
        sessionId,
        ownerId: actorId,
        to: status.state === "closed" ? "expired" : "failed",
        }));
    }
    return { session, status };
  }

  async renderGateway(sessionId: string, actorId: string): Promise<{
    mode: RenderStatus["mode"];
    upstreamUrl: string;
    authorization: string | null;
    expiresAt: Date;
  }> {
    const result = await this.renderStatus(sessionId, actorId);
    if (
      result.session?.state !== "ready" ||
      !result.status.upstreamUrl ||
      result.session.expiresAt.getTime() <= Date.now()
    ) {
      throw new ScienceConflictError("science render session is not ready");
    }
    return {
      mode: result.status.mode,
      upstreamUrl: result.status.upstreamUrl,
      authorization:
        result.status.mode === "remote"
          ? `Bearer ${this.renderGatewayToken(result.session.audience)}`
          : null,
      expiresAt: result.session.expiresAt,
    };
  }

  async renewRender(input: { sessionId: string; actorId: string }) {
    await this.assertWritable();
    const current = await this.ownedRender(input.sessionId, input.actorId);
    if (!current.providerHandle) {
      throw new ScienceConflictError("science render session has no provider handle");
    }
    const expiresAt = new Date(Date.now() + this.config.renderTtlSeconds * 1_000);
    const stored = decodeRenderHandle(current.providerHandle);
    if (stored.attempt) {
      throw new ScienceConflictError(
        "science render launch outcome is ambiguous; administrator action is required",
      );
    }
    const provider = this.renderProviders.get(stored.providerKind);
    await this.admitRenderProvider(provider, stored.instanceId);
    // Renew the provider first. If the owner-locked local heartbeat then loses
    // a close/expiry race, the same-origin gateway remains locally denied; the
    // inverse order could leave a failed provider renewal with a live gateway.
    await provider.renew(
      stored.handle,
      expiresAt.toISOString(),
      { expectedInstanceId: stored.instanceId },
    );
    const session = await this.mutateAs("science.render.renew", input.actorId, (db) =>
      heartbeatScienceRenderSession(db, {
      workspaceId: this.workspaceId,
      sessionId: current.id,
      ownerId: input.actorId,
      extendExpiresAt: expiresAt,
      extendReplayExpiresAt: new Date(Date.now() + RENDER_REPLAY_HORIZON_MS),
      }));
    await this.publish({
      type: "science.render.heartbeat",
      workspaceId: this.workspaceId,
      runId: session.runId ?? undefined,
      artifactVersionId: session.artifactVersionId ?? undefined,
      renderSessionId: session.id,
      sequence: Math.max(1, Math.floor(session.updatedAt.getTime() / 1_000)),
      at: session.updatedAt.toISOString(),
      state: session.state,
    });
    return session;
  }

  async closeRender(input: { sessionId: string; actorId: string }) {
    this.assertReadable();
    const current = await this.ownedRender(input.sessionId, input.actorId);
    if (current.providerHandle) {
      const stored = decodeRenderHandle(current.providerHandle);
      if (stored.attempt) {
        throw new ScienceConflictError(
          "science render launch outcome is ambiguous; administrator action is required",
        );
      }
      const provider = this.renderProviders.get(stored.providerKind);
      await this.admitRenderProvider(provider, stored.instanceId);
      await provider.close(
        stored.handle,
        { expectedInstanceId: stored.instanceId },
      );
    }
    const session =
      current.state === "expired" || current.state === "failed" || current.state === "revoked"
        ? current
        : await this.mutateAs("science.render.close", input.actorId, (db) =>
            transitionScienceRenderSession(db, {
            workspaceId: this.workspaceId,
            sessionId: current.id,
            ownerId: input.actorId,
            to: "revoked",
            }));
    const tombstone = await this.mutateAs("science.render.close", input.actorId, (db) =>
      tombstoneTerminalScienceRenderSessionAfterClose(db, {
        workspaceId: this.workspaceId,
        sessionId: session.id,
        replayExpiresAt: new Date(Date.now() + RENDER_REPLAY_HORIZON_MS),
      }));
    await this.auditEntry("science.render.close", input.actorId, session.id);
    return tombstone ?? session;
  }

  async cleanupRetention(): Promise<{
    expiredUploads: number;
    expiredArtifactVersions: number;
    expiredRenderSessions: number;
    orphanQuarantineObjects: number;
  }> {
    if (!this.config.enabled) {
      return {
        expiredUploads: 0,
        expiredArtifactVersions: 0,
        expiredRenderSessions: 0,
        orphanQuarantineObjects: 0,
      };
    }
    const olderThan = new Date(Date.now() - this.config.uploadTtlSeconds * 1_000);
    const [expiredUploads, expiredVersions] = await Promise.all([
      cleanupExpiredScienceUploads(this.db, {
        workspaceId: this.workspaceId,
        limit: 500,
      }),
      cleanupScienceArtifactVersionQuarantine(this.db, {
        workspaceId: this.workspaceId,
        olderThan,
        limit: 500,
      }),
      cleanupExpiredScienceRenderSessions(this.db, {
        workspaceId: this.workspaceId,
        limit: 500,
      }),
    ]);
    const cleanupSessions = await listTerminalScienceRenderSessionsForCleanup(this.db, {
      workspaceId: this.workspaceId,
      limit: 500,
    });
    let deletedUploads = 0;
    let deletedVersions = 0;
    let deletedRenders = 0;
    await Promise.all([
      (async () => {
        for (const upload of expiredUploads.slice(0, RETENTION_UPLOAD_ATTEMPT_LIMIT)) {
          try {
            await withOperationDeadline(
              this.store.discardQuarantine(upload.quarantineKey),
              "science upload quarantine discard",
            );
            const deleted = await deleteTerminalScienceUploadAfterDiscard(this.db, {
              workspaceId: this.workspaceId,
              uploadId: upload.id,
            });
            if (deleted) deletedUploads++;
          } catch {
            await deferScienceUploadCleanup(this.db, {
              workspaceId: this.workspaceId,
              uploadId: upload.id,
              retryAt: cleanupRetryAt(upload.cleanupAttempts),
            }).catch(() => {});
            // The row stays quota-charged, but persisted backoff rotates it
            // behind later candidates instead of starving the fixed batch.
          }
        }
      })(),
      (async () => {
        for (const version of expiredVersions.slice(0, RETENTION_VERSION_ATTEMPT_LIMIT)) {
          try {
            await this.store.remove(version.storageKey, {
              signal: AbortSignal.timeout(RETENTION_OPERATION_TIMEOUT_MS),
            });
            const released = await deleteExpiredScienceArtifactVersionAfterDiscard(this.db, {
              workspaceId: this.workspaceId,
              versionId: version.id,
            });
            if (released) deletedVersions++;
          } catch {
            await deferScienceArtifactVersionCleanup(this.db, {
              workspaceId: this.workspaceId,
              versionId: version.id,
              retryAt: cleanupRetryAt(version.cleanupAttempts),
            }).catch(() => {});
            // Bytes and quota remain retained until a later delete proof; the
            // tombstone is never removed or allowed to reuse its ordinal.
          }
        }
      })(),
      (async () => {
        for (const session of cleanupSessions.slice(0, RETENTION_RENDER_ATTEMPT_LIMIT)) {
          try {
            if (session.providerHandle) {
              const stored = decodeRenderHandle(session.providerHandle);
              if (stored.attempt) {
                if (stored.providerKind !== "static") {
                  throw new Error("ambiguous render launch marker requires administrator action");
                }
                // A static launch marker has no external resource. Once the
                // session lease is terminal it can be safely tombstoned.
              } else {
                const provider = this.renderProviders.get(stored.providerKind);
                await withOperationDeadline((async () => {
                  await this.admitRenderProvider(provider, stored.instanceId);
                  await provider.close(
                    stored.handle,
                    { expectedInstanceId: stored.instanceId },
                  );
                })(), "science render close");
              }
            }
            const tombstone = await tombstoneTerminalScienceRenderSessionAfterClose(this.db, {
              workspaceId: this.workspaceId,
              sessionId: session.id,
              replayExpiresAt: new Date(Date.now() + RENDER_REPLAY_HORIZON_MS),
            });
            if (tombstone) deletedRenders++;
          } catch {
            await deferScienceRenderSessionCleanup(this.db, {
              workspaceId: this.workspaceId,
              sessionId: session.id,
              retryAt: cleanupRetryAt(session.cleanupAttempts),
            }).catch(() => {});
            // The handle/attempt marker remains visible and resource-charged.
          }
        }
      })(),
    ]);
    deletedRenders += await deleteExpiredScienceRenderSessionTombstones(this.db, {
      workspaceId: this.workspaceId,
      limit: 500,
    });
    // Sweep only old, unreferenced quarantine files. Protecting keys from all
    // workspaces prevents this workspace's maintenance pass from racing a
    // live transfer or lease-renewed finalizer elsewhere.
    let orphanQuarantineObjects = 0;
    try {
      const protectedKeys = new Set(await listScienceProtectedQuarantineKeys(this.db));
      orphanQuarantineObjects = await withOperationDeadline(
        this.store.cleanupQuarantine(olderThan, protectedKeys),
        "science orphan quarantine sweep",
      );
    } catch {
      // A failed orphan sweep never releases a durable quota reservation. Row
      // driven cleanup above remains retryable on the next bounded pass.
    }
    return {
      expiredUploads: deletedUploads,
      expiredArtifactVersions: deletedVersions,
      expiredRenderSessions: deletedRenders,
      orphanQuarantineObjects,
    };
  }

  async reconcile(): Promise<{
    enqueued: number;
    expiredUploads: number;
    expiredArtifactVersions: number;
    expiredRenderSessions: number;
    orphanQuarantineObjects: number;
  }> {
    if (!this.config.enabled) {
      return {
        enqueued: 0,
        expiredUploads: 0,
        expiredArtifactVersions: 0,
        expiredRenderSessions: 0,
        orphanQuarantineObjects: 0,
      };
    }
    const [retention, recoverable] = await Promise.all([
      this.cleanupRetention(),
      listRecoverableScienceRuns(this.db, {
        workspaceId: this.workspaceId,
        limit: 1_000,
      }),
    ]);
    let enqueued = 0;
    if (this.config.enabled && this.scheduler) {
      for (const run of recoverable) {
        await this.scheduler.enqueue(run.id, null);
        enqueued++;
      }
    }
    return {
      enqueued,
      ...retention,
    };
  }

  async health() {
    const [rawDatabase, rawStorage, rawCompute, rawRender, rawQueue] = await Promise.all([
      withOperationDeadline(
        probeScienceDatabase(this.db),
        "science database readiness probe",
      ).then(
        () => ({ ok: true, adapter: "database" }),
        (error) => ({
          ok: false,
          adapter: "database",
          detail: redactScienceDiagnostic(error, 1_000),
        }),
      ),
      this.store.health(),
      this.computeProviders.health(),
      this.renderProviders.health(),
      this.scheduler?.health() ?? Promise.resolve({
        ok: false,
        adapter: "inline" as const,
        state: "not_started" as const,
        pending: 0,
        active: 0,
        detail: "science scheduler is not attached",
      }),
    ]);
    const storage = {
      ...rawStorage,
      ...(rawStorage.detail
        ? { detail: redactScienceDiagnostic(rawStorage.detail, 1_000) }
        : {}),
    };
    const databaseDetail = "detail" in rawDatabase ? rawDatabase.detail : undefined;
    const database = {
      ...rawDatabase,
      ...(databaseDetail
        ? { detail: redactScienceDiagnostic(databaseDetail, 1_000) }
        : {}),
    };
    const queue = {
      ...rawQueue,
      ...(rawQueue.detail
        ? { detail: redactScienceDiagnostic(rawQueue.detail, 1_000) }
        : {}),
    };
    const compute = rawCompute.map((entry) => ({
      ...entry,
      ...(entry.detail
        ? { detail: redactScienceDiagnostic(entry.detail, 1_000) }
        : {}),
    }));
    const render = rawRender.map((entry) => ({
      ...entry,
      ...(entry.detail
        ? { detail: redactScienceDiagnostic(entry.detail, 1_000) }
        : {}),
    }));
    const computeReady = compute.some((entry) => entry.ok);
    return {
      enabled: this.config.enabled,
      submissionsEnabled: this.config.submissionsEnabled,
      ok:
        database.ok &&
        (
          !this.config.enabled ||
          (
            storage.ok &&
            queue.ok &&
            (!this.config.submissionsEnabled || computeReady)
          )
        ),
      storage,
      database,
      queue,
      compute,
      render,
      limits: {
        maxUploadBytes: this.config.maxUploadBytes,
        maxWorkspaceStorageBytes: this.config.maxWorkspaceStorageBytes,
        externalUploadAbsoluteTimeoutMs:
          this.config.externalUploadAbsoluteTimeoutMs,
        externalUploadIdleTimeoutMs: this.config.externalUploadIdleTimeoutMs,
        maxConcurrentExternalUploadStreamsPerWorkspace:
          this.config.maxConcurrentExternalUploadStreamsPerWorkspace,
        maxConcurrentRunsPerWorkspace: this.config.maxConcurrentRunsPerWorkspace,
        maxConcurrentRenderSessionsPerWorkspace:
          this.config.maxConcurrentRenderSessionsPerWorkspace,
      },
    };
  }
}
