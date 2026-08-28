import { createHash } from "node:crypto";
import type {
  ComputeProvider,
  ComputeProviderHealth,
  ComputeQuote,
  ComputeStatus,
  ComputeSubmission,
  ProviderInstanceFence,
  ProviderOutput,
  ScienceResourceRequest,
} from "./providers.js";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
  redactScienceDiagnostic,
  rejectRedirectOrOriginChange,
} from "./http-boundary.js";

const MINIMUM_GATEWAY_VERSION = [3, 3, 0] as const;
const INSTANCE_ID_PATTERN = /^[a-z0-9._-]{1,100}$/i;
const KERNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const KERNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN68_PATTERN = /^[A-Za-z0-9._~+/-]+={0,}$/;
const IMMUTABLE_IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._:/-]{0,299}@sha256:[0-9a-f]{64}$/;
const MAX_VISIBLE_KERNELS = 256;
const RECOVERY_HANDLE_PREFIX = "jg1.";
const RECOVERY_HANDLE_FIXED_BYTES = 16 + 16 + 8 + 32 + 1;
const MAX_KERNEL_NAME_BYTES = 100;
const MAX_RECOVERY_PAYLOAD_BYTES = RECOVERY_HANDLE_FIXED_BYTES + MAX_KERNEL_NAME_BYTES;
/** Maximum inner handle; the worst-case service wrapper remains below 500. */
export const JUPYTER_ENTERPRISE_GATEWAY_MAX_RECOVERY_HANDLE_CHARACTERS =
  RECOVERY_HANDLE_PREFIX.length + Math.ceil(MAX_RECOVERY_PAYLOAD_BYTES * 4 / 3);

/**
 * Bounds reserved for the future Jupyter channels bridge. No WebSocket is
 * opened by the prerequisite provider: there is no durable channel ledger or
 * output-receipt bridge yet, so code execution remains fail-closed.
 */
export const JUPYTER_ENTERPRISE_GATEWAY_CHANNEL_BOUNDS = Object.freeze({
  connectTimeoutMs: 15_000,
  maxMessageBytes: 1024 * 1024,
  maxMessagesPerExecution: 10_000,
  maxLogLinesPerStatus: 32,
  maxLogLineCharacters: 2_000,
});

export const JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_BLOCKERS = Object.freeze([
  "ComputeSubmission has no immutable executable entrypoint or signed runner descriptor",
  "stock JEG has no durable idempotency/generation receipt for POST /api/kernels",
  "Jupyter channels have no Puppetmaster-owned restart-stable execution transcript",
  "stock JEG has no checksummed artifact receipt/open-output contract",
  "stock JEG has no immutable gateway-instance response fence",
]);

export interface JupyterEnterpriseGatewayPrerequisiteOptions {
  baseUrl: string;
  authToken: string;
  /** Must remain prerequisite-only until the blockers above have live proof. */
  admission: "prerequisite-only";
  /**
   * Operator-pinned deployment identity. A trusted gateway/proxy must return
   * this exact value in X-Science-Gateway-Instance on every response.
   */
  expectedInstanceId: string;
  /** Exact kernelspec name -> immutable OCI image reference. */
  allowedKernelImages: Readonly<Record<string, string>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface JupyterEnterpriseGatewayProbe {
  prerequisiteOk: true;
  admittedForExecution: false;
  gatewayVersion: string;
  instanceId: string;
  kernelImages: Readonly<Record<string, string>>;
  blockers: readonly string[];
}

const JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_STATES = [
  "starting",
  "restarting",
  "idle",
  "busy",
  "dead",
] as const;

export type JupyterEnterpriseGatewayExecutionState =
  (typeof JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_STATES)[number];

interface JupyterEnterpriseGatewayRecoveryHandle {
  kernelId: string;
  runId: string;
  generation: number;
  idempotencyKeyHash: string;
  kernelName: string;
}

export interface JupyterEnterpriseGatewayExpectedExecution {
  handle: string;
  runId: string;
  generation: number;
  kernelId: string;
  kernelName: string;
}

export interface JupyterEnterpriseGatewayDiscovery {
  managed: Array<{
    expected: JupyterEnterpriseGatewayExpectedExecution;
    executionState: JupyterEnterpriseGatewayExecutionState;
  }>;
  missing: JupyterEnterpriseGatewayExpectedExecution[];
  /**
   * Visible kernels without a persisted exact handle are never treated as
   * owned and are never automatically cancelled in a multi-tenant gateway.
   */
  visibleButUnowned: Array<{
    kernelId: string;
    kernelName: string;
    executionState: JupyterEnterpriseGatewayExecutionState;
  }>;
}

interface GatewayKernelModel {
  id: string;
  name: string;
  executionState: JupyterEnterpriseGatewayExecutionState;
}

function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  // Only a stable release (optionally carrying SemVer build metadata) can
  // satisfy the compatibility floor. Treating 3.3.0-alpha or 3.3.0.dev0 as
  // 3.3.0 would turn a pre-release into false prerequisite evidence.
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return tuple.every(Number.isSafeInteger) ? [...tuple] : null;
}

function isJupyterEnterpriseGatewayExecutionState(
  value: unknown,
): value is JupyterEnterpriseGatewayExecutionState {
  return (
    typeof value === "string" &&
    (JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_STATES as readonly string[]).includes(value)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactJupyterGatewayToken(value: unknown, authToken: string): string {
  let text = value instanceof Error ? value.message : String(value);
  const jsonEscaped = JSON.stringify(authToken).slice(1, -1);
  const urlEncoded = encodeURIComponent(authToken);
  const literalVariants = [...new Set([authToken, jsonEscaped])]
    .sort((left, right) => right.length - left.length);
  for (const variant of literalVariants) {
    text = text.split(variant).join("[REDACTED]");
  }
  if (urlEncoded !== authToken) {
    // Percent-triplet hex case is not canonical across gateways. A
    // case-insensitive literal expression catches both %2F and %2f forms.
    text = text.replace(new RegExp(escapeRegExp(urlEncoded), "gi"), "[REDACTED]");
  }
  return text;
}

function isMinimumGatewayVersion(value: unknown): value is string {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  for (let index = 0; index < 3; index++) {
    if (parsed[index]! > MINIMUM_GATEWAY_VERSION[index]!) return true;
    if (parsed[index]! < MINIMUM_GATEWAY_VERSION[index]!) return false;
  }
  return true;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function extractKernelImage(value: unknown, kernelName: string): string {
  const row = expectObject(value, `JEG kernelspec ${kernelName}`);
  if (row.name !== kernelName) {
    throw new Error(`JEG kernelspec ${kernelName} returned a mismatched name`);
  }
  const spec = expectObject(row.spec, `JEG kernelspec ${kernelName}.spec`);
  const metadata = expectObject(
    spec.metadata,
    `JEG kernelspec ${kernelName}.spec.metadata`,
  );
  const processProxy = expectObject(
    metadata.process_proxy,
    `JEG kernelspec ${kernelName}.metadata.process_proxy`,
  );
  const config = expectObject(
    processProxy.config,
    `JEG kernelspec ${kernelName}.metadata.process_proxy.config`,
  );
  if (typeof config.image_name !== "string") {
    throw new Error(`JEG kernelspec ${kernelName} has no pinned image_name`);
  }
  return config.image_name;
}

function parseKernelModel(value: unknown): GatewayKernelModel {
  const row = expectObject(value, "JEG kernel model");
  if (
    typeof row.id !== "string" ||
    !KERNEL_ID_PATTERN.test(row.id) ||
    typeof row.name !== "string" ||
    !KERNEL_NAME_PATTERN.test(row.name) ||
    !isJupyterEnterpriseGatewayExecutionState(row.execution_state)
  ) {
    throw new Error("JEG returned an invalid kernel model");
  }
  return {
    id: row.id.toLowerCase(),
    name: row.name,
    executionState: row.execution_state,
  };
}

function uuidToBytes(value: string, label: string): Buffer {
  if (!KERNEL_ID_PATTERN.test(value)) throw new Error(`${label} is not a UUID`);
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  if (bytes.length !== 16) throw new Error(`${label} is not a UUID`);
  return bytes;
}

function bytesToUuid(bytes: Buffer): string {
  if (bytes.length !== 16) throw new Error("invalid UUID byte length");
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function encodeRecoveryHandle(value: JupyterEnterpriseGatewayRecoveryHandle): string {
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw new Error("JEG recovery generation must be a positive safe integer");
  }
  if (!/^[0-9a-f]{64}$/.test(value.idempotencyKeyHash)) {
    throw new Error("JEG recovery idempotency hash is invalid");
  }
  if (!KERNEL_NAME_PATTERN.test(value.kernelName)) {
    throw new Error("JEG recovery kernel name is invalid");
  }
  const kernelName = Buffer.from(value.kernelName, "ascii");
  if (kernelName.length > MAX_KERNEL_NAME_BYTES) {
    throw new Error("JEG recovery kernel name exceeds 100 bytes");
  }
  const payload = Buffer.alloc(RECOVERY_HANDLE_FIXED_BYTES + kernelName.length);
  let offset = 0;
  uuidToBytes(value.kernelId, "JEG kernel ID").copy(payload, offset);
  offset += 16;
  uuidToBytes(value.runId, "JEG run ID").copy(payload, offset);
  offset += 16;
  payload.writeBigUInt64BE(BigInt(value.generation), offset);
  offset += 8;
  Buffer.from(value.idempotencyKeyHash, "hex").copy(payload, offset);
  offset += 32;
  payload.writeUInt8(kernelName.length, offset);
  kernelName.copy(payload, offset + 1);
  const encoded = `${RECOVERY_HANDLE_PREFIX}${payload.toString("base64url")}`;
  if (encoded.length > JUPYTER_ENTERPRISE_GATEWAY_MAX_RECOVERY_HANDLE_CHARACTERS) {
    throw new Error("JEG recovery handle exceeds its compact v1 limit");
  }
  return encoded;
}

function decodeRecoveryHandle(handle: string): JupyterEnterpriseGatewayRecoveryHandle {
  if (
    !handle.startsWith(RECOVERY_HANDLE_PREFIX) ||
    handle.length > JUPYTER_ENTERPRISE_GATEWAY_MAX_RECOVERY_HANDLE_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(handle.slice(RECOVERY_HANDLE_PREFIX.length))
  ) {
    throw new Error("invalid JEG recovery handle");
  }
  try {
    const payload = Buffer.from(handle.slice(RECOVERY_HANDLE_PREFIX.length), "base64url");
    if (payload.length < RECOVERY_HANDLE_FIXED_BYTES) {
      throw new Error("short payload");
    }
    const kernelNameLength = payload.readUInt8(RECOVERY_HANDLE_FIXED_BYTES - 1);
    if (
      kernelNameLength < 1 ||
      kernelNameLength > MAX_KERNEL_NAME_BYTES ||
      payload.length !== RECOVERY_HANDLE_FIXED_BYTES + kernelNameLength
    ) {
      throw new Error("invalid kernel name length");
    }
    const generation = Number(payload.readBigUInt64BE(32));
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("invalid generation");
    }
    const kernelName = payload.subarray(RECOVERY_HANDLE_FIXED_BYTES).toString("ascii");
    if (!KERNEL_NAME_PATTERN.test(kernelName)) throw new Error("invalid kernel name");
    const decoded = {
      kernelId: bytesToUuid(payload.subarray(0, 16)),
      runId: bytesToUuid(payload.subarray(16, 32)),
      generation,
      idempotencyKeyHash: payload.subarray(40, 72).toString("hex"),
      kernelName,
    };
    if (encodeRecoveryHandle(decoded) !== handle) {
      throw new Error("non-canonical handle encoding");
    }
    return decoded;
  } catch {
    throw new Error("invalid JEG recovery handle");
  }
}

/**
 * Creates a handle only for an execution whose exact JEG kernel identity was
 * already durably established by an external migration/recovery process. It
 * does not start a kernel or admit JEG execution.
 */
export function createJupyterEnterpriseGatewayRecoveryHandle(input: {
  kernelId: string;
  runId: string;
  generation: number;
  idempotencyKey: string;
  kernelName: string;
}): string {
  if (!input.idempotencyKey || Buffer.byteLength(input.idempotencyKey) > 1_000) {
    throw new Error("JEG recovery idempotency key is invalid");
  }
  return encodeRecoveryHandle({
    kernelId: input.kernelId.toLowerCase(),
    runId: input.runId,
    generation: input.generation,
    idempotencyKeyHash: createHash("sha256").update(input.idempotencyKey).digest("hex"),
    kernelName: input.kernelName,
  });
}

/**
 * Readiness/recovery prerequisite for the official JEG >=3.3 REST contract.
 *
 * This intentionally implements ComputeProvider only so the existing lifecycle
 * fence and recovery methods can be exercised. It is never registered by
 * createComputeProvidersFromEnv: quote is unavailable, submit rejects before a
 * request, channels are never opened, and outputs cannot be collected.
 */
export class JupyterEnterpriseGatewayPrerequisiteProvider implements ComputeProvider {
  readonly kind = "jupyter_enterprise_gateway";
  readonly version = "jeg-prerequisite.v1";
  readonly instanceId: string;
  private readonly baseUrl: URL;
  private readonly basePath: string;
  private readonly authToken: string;
  private readonly allowedKernelImages: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JupyterEnterpriseGatewayPrerequisiteOptions) {
    if (opts.admission !== "prerequisite-only") {
      throw new Error(
        "JEG admission must be prerequisite-only; executable JEG remains NO-GO",
      );
    }
    const baseUrl = new URL(opts.baseUrl);
    if (baseUrl.protocol !== "https:") {
      throw new Error("JEG URL must use HTTPS");
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error("JEG URL cannot contain credentials, query, or fragment");
    }
    if (!baseUrl.hostname) throw new Error("JEG URL must include a hostname");
    const token = opts.authToken.trim();
    if (token.length < 16 || token.length > 4096 || !TOKEN68_PATTERN.test(token)) {
      throw new Error("JEG auth token must be 16-4096 token68 characters");
    }
    if (!INSTANCE_ID_PATTERN.test(opts.expectedInstanceId)) {
      throw new Error("JEG expected instance ID is invalid");
    }
    const entries = Object.entries(opts.allowedKernelImages);
    if (entries.length < 1 || entries.length > 32) {
      throw new Error("JEG kernel/image allowlist must contain 1-32 entries");
    }
    const allowedKernelImages: Record<string, string> = Object.create(null);
    for (const [kernelName, image] of entries) {
      if (!KERNEL_NAME_PATTERN.test(kernelName)) {
        throw new Error(`JEG allowlist kernel name ${kernelName} is invalid`);
      }
      if (!IMMUTABLE_IMAGE_PATTERN.test(image)) {
        throw new Error(
          `JEG allowlist image for ${kernelName} must be an immutable OCI digest reference`,
        );
      }
      allowedKernelImages[kernelName] = image;
    }
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
      throw new Error("JEG timeout must be an integer between 1000 and 600000 milliseconds");
    }
    this.baseUrl = new URL(baseUrl.toString().replace(/\/?$/, "/"));
    this.basePath = this.baseUrl.pathname;
    this.authToken = token;
    this.instanceId = opts.expectedInstanceId;
    this.allowedKernelImages = Object.freeze(allowedKernelImages);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private assertFence(fence: ProviderInstanceFence | null | undefined): void {
    if (!fence || !INSTANCE_ID_PATTERN.test(fence.expectedInstanceId)) {
      throw new Error("science compute provider instance fence is required");
    }
    if (fence.expectedInstanceId !== this.instanceId) {
      throw new Error("JEG gateway instance fence rejected the operation");
    }
  }

  private diagnostic(value: unknown, maxLength = 1_000): string {
    // Remove full secret representations before the generic diagnostic helper
    // truncates the value; otherwise a reflected token longer than maxLength
    // could leak a large prefix that no longer equals the complete token.
    return redactScienceDiagnostic(
      redactJupyterGatewayToken(value, this.authToken),
      maxLength,
    );
  }

  private endpoint(relativePath: string): URL {
    if (relativePath.startsWith("/") || relativePath.includes("\\")) {
      throw new Error("JEG request path is invalid");
    }
    const url = new URL(relativePath, this.baseUrl);
    if (
      url.origin !== this.baseUrl.origin ||
      !url.pathname.startsWith(this.basePath) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("JEG request escaped its configured base URL");
    }
    return url;
  }

  private async request(
    relativePath: string,
    init: RequestInit | undefined,
    expectedStatuses: readonly number[],
    fence?: ProviderInstanceFence,
  ): Promise<Response> {
    if (fence) this.assertFence(fence);
    const url = this.endpoint(relativePath);
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `token ${this.authToken}`);
    headers.set("x-science-expected-gateway-instance", this.instanceId);
    if (init?.body) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`JEG request failed: ${this.diagnostic(error)}`);
    }
    await rejectRedirectOrOriginChange(response, this.baseUrl.origin, "JEG");
    const observedInstanceId = response.headers.get("x-science-gateway-instance");
    if (observedInstanceId !== this.instanceId) {
      await response.body?.cancel().catch(() => {});
      throw new Error("JEG response failed the immutable gateway-instance fence");
    }
    if (!expectedStatuses.includes(response.status)) {
      const detail = this.diagnostic(
        await readBoundedResponseText(response, "JEG error response"),
      );
      throw new Error(`JEG returned ${response.status}: ${detail}`);
    }
    return response;
  }

  private async readJson(response: Response, label: string): Promise<unknown> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${label} did not return application/json`);
    }
    return readBoundedResponseJson(response, label);
  }

  private validateAllowedKernel(kernelName: string, imageDigest?: string): void {
    const expectedImage = this.allowedKernelImages[kernelName];
    if (!expectedImage) throw new Error(`JEG kernel ${kernelName} is not allowlisted`);
    if (imageDigest !== undefined && !expectedImage.endsWith(`@${imageDigest}`)) {
      throw new Error(`JEG kernel ${kernelName} does not match the requested image digest`);
    }
  }

  private validateHandle(
    handle: string,
    generation: number,
  ): JupyterEnterpriseGatewayRecoveryHandle {
    const decoded = decodeRecoveryHandle(handle);
    if (decoded.generation !== generation) {
      throw new Error("JEG provider generation mismatch");
    }
    this.validateAllowedKernel(decoded.kernelName);
    return decoded;
  }

  private async listKernelModels(
    fence?: ProviderInstanceFence,
  ): Promise<GatewayKernelModel[]> {
    const response = await this.request("api/kernels", undefined, [200], fence);
    const document = await this.readJson(response, "JEG kernel list");
    if (!Array.isArray(document) || document.length > MAX_VISIBLE_KERNELS) {
      throw new Error(`JEG kernel list must contain at most ${MAX_VISIBLE_KERNELS} entries`);
    }
    const models = document.map(parseKernelModel);
    const ids = new Set<string>();
    for (const model of models) {
      if (ids.has(model.id)) throw new Error("JEG kernel list contains a duplicate ID");
      ids.add(model.id);
    }
    return models;
  }

  async probe(): Promise<JupyterEnterpriseGatewayProbe> {
    const apiResponse = await this.request("api", undefined, [200]);
    const api = expectObject(await this.readJson(apiResponse, "JEG API info"), "JEG API info");
    if (!isMinimumGatewayVersion(api.gateway_version)) {
      throw new Error("JEG gateway_version must be at least 3.3.0");
    }
    const kernelspecResponse = await this.request("api/kernelspecs", undefined, [200]);
    const kernelspecDocument = expectObject(
      await this.readJson(kernelspecResponse, "JEG kernelspec list"),
      "JEG kernelspec list",
    );
    const kernelspecs = expectObject(
      kernelspecDocument.kernelspecs,
      "JEG kernelspec list.kernelspecs",
    );
    if (Object.keys(kernelspecs).length > 256) {
      throw new Error("JEG kernelspec list exceeds 256 entries");
    }
    for (const [kernelName, expectedImage] of Object.entries(this.allowedKernelImages)) {
      const actualImage = extractKernelImage(kernelspecs[kernelName], kernelName);
      if (actualImage !== expectedImage) {
        throw new Error(`JEG kernelspec ${kernelName} image identity changed`);
      }
    }
    // Listing must be enabled for restart/orphan reconciliation. A JEG that
    // returns 403 here has not met even the read-only prerequisite.
    await this.listKernelModels();
    return {
      prerequisiteOk: true,
      admittedForExecution: false,
      gatewayVersion: api.gateway_version,
      instanceId: this.instanceId,
      kernelImages: this.allowedKernelImages,
      blockers: JUPYTER_ENTERPRISE_GATEWAY_EXECUTION_BLOCKERS,
    };
  }

  async quote(resources: ScienceResourceRequest): Promise<ComputeQuote> {
    return {
      available: false,
      provider: this.kind,
      source: "declared",
      queueSeconds: null,
      estimatedWallSeconds: null,
      cost: null,
      limits: { ...resources },
      reason:
        "JEG prerequisite only: durable execution and artifact output bridge is not implemented",
    };
  }

  async submit(
    input: ComputeSubmission,
    fence: ProviderInstanceFence,
  ): Promise<{ handle: string }> {
    this.assertFence(fence);
    this.validateAllowedKernel(input.kernel, input.imageDigest);
    throw new Error(
      "JEG execution remains NO-GO: the durable runner/idempotency/channel/output bridge is absent",
    );
  }

  async status(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ComputeStatus> {
    this.assertFence(fence);
    const decoded = this.validateHandle(handle, generation);
    const response = await this.request(
      `api/kernels/${encodeURIComponent(decoded.kernelId)}`,
      undefined,
      [200, 404],
      fence,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return {
        state: "failed",
        progress: null,
        error: "persisted JEG kernel is missing; operator reconciliation is required",
      };
    }
    const model = parseKernelModel(await this.readJson(response, "JEG kernel status"));
    if (model.id !== decoded.kernelId || model.name !== decoded.kernelName) {
      throw new Error("JEG kernel status failed recovery-handle correlation");
    }
    switch (model.executionState) {
      case "starting":
      case "restarting":
        return { state: "provisioning", progress: null, message: model.executionState };
      case "idle":
      case "busy":
        return {
          state: "running",
          progress: null,
          message:
            `${model.executionState}; JEG kernel state is not execution-completion evidence`,
        };
      case "dead":
        return { state: "failed", progress: null, error: "JEG kernel reported dead" };
      default:
        throw new Error("JEG returned an unsupported kernel execution state");
    }
  }

  async cancel(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<{ accepted: boolean }> {
    this.assertFence(fence);
    const decoded = this.validateHandle(handle, generation);
    const preflight = await this.request(
      `api/kernels/${encodeURIComponent(decoded.kernelId)}`,
      undefined,
      [200, 404],
      fence,
    );
    if (preflight.status === 404) {
      await preflight.body?.cancel().catch(() => {});
      return { accepted: true };
    }
    const model = parseKernelModel(await this.readJson(preflight, "JEG cancel preflight"));
    if (model.id !== decoded.kernelId || model.name !== decoded.kernelName) {
      throw new Error("JEG cancel preflight failed recovery-handle correlation");
    }
    const response = await this.request(
      `api/kernels/${encodeURIComponent(decoded.kernelId)}`,
      { method: "DELETE" },
      [204, 404],
      fence,
    );
    await response.body?.cancel().catch(() => {});
    return { accepted: true };
  }

  async collectOutputs(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ProviderOutput[]> {
    this.assertFence(fence);
    this.validateHandle(handle, generation);
    throw new Error(
      "JEG output collection remains NO-GO: no checksummed artifact receipt bridge exists",
    );
  }

  async openOutput(
    _output: ProviderOutput,
    fence: ProviderInstanceFence,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.assertFence(fence);
    throw new Error(
      "JEG output streaming remains NO-GO: no scoped same-origin output bridge exists",
    );
  }

  async discover(
    expectedClaims: readonly JupyterEnterpriseGatewayExpectedExecution[],
    fence: ProviderInstanceFence,
  ): Promise<JupyterEnterpriseGatewayDiscovery> {
    this.assertFence(fence);
    if (expectedClaims.length > MAX_VISIBLE_KERNELS) {
      throw new Error(`JEG discovery accepts at most ${MAX_VISIBLE_KERNELS} expected claims`);
    }
    const handles = new Set<string>();
    const kernelIds = new Set<string>();
    const runIds = new Set<string>();
    const expected = expectedClaims.map((claim) => {
      if (!claim || typeof claim !== "object") {
        throw new Error("JEG discovery expected claim is invalid");
      }
      const decoded = this.validateHandle(claim.handle, claim.generation);
      const claimedRunId = bytesToUuid(uuidToBytes(claim.runId, "JEG expected run ID"));
      const claimedKernelId = bytesToUuid(
        uuidToBytes(claim.kernelId, "JEG expected kernel ID"),
      );
      if (
        decoded.runId !== claimedRunId ||
        decoded.kernelId !== claimedKernelId ||
        decoded.kernelName !== claim.kernelName
      ) {
        throw new Error("JEG discovery claim failed recovery-handle correlation");
      }
      if (handles.has(claim.handle)) {
        throw new Error("JEG discovery contains a duplicate recovery handle");
      }
      if (kernelIds.has(claimedKernelId)) {
        throw new Error("JEG discovery contains a duplicate kernel identity");
      }
      if (runIds.has(claimedRunId)) {
        throw new Error("JEG discovery contains a duplicate run identity");
      }
      handles.add(claim.handle);
      kernelIds.add(claimedKernelId);
      runIds.add(claimedRunId);
      return {
        handle: claim.handle,
        runId: decoded.runId,
        generation: decoded.generation,
        kernelId: decoded.kernelId,
        kernelName: decoded.kernelName,
      } satisfies JupyterEnterpriseGatewayExpectedExecution;
    });
    const expectedByKernel = new Map(expected.map((item) => [item.kernelId, item]));
    const models = await this.listKernelModels(fence);
    const seen = new Set<string>();
    const managed: JupyterEnterpriseGatewayDiscovery["managed"] = [];
    const visibleButUnowned: JupyterEnterpriseGatewayDiscovery["visibleButUnowned"] = [];
    for (const model of models) {
      seen.add(model.id);
      const owned = expectedByKernel.get(model.id);
      if (!owned) {
        visibleButUnowned.push({
          kernelId: model.id,
          kernelName: model.name,
          executionState: model.executionState,
        });
        continue;
      }
      if (owned.kernelName !== model.name) {
        throw new Error("JEG discovered kernel failed persisted name correlation");
      }
      managed.push({ expected: owned, executionState: model.executionState });
    }
    return {
      managed,
      missing: expected.filter((item) => !seen.has(item.kernelId)),
      visibleButUnowned,
    };
  }

  async health(): Promise<ComputeProviderHealth> {
    try {
      const probe = await this.probe();
      return {
        ok: false,
        provider: this.kind,
        version: probe.gatewayVersion,
        instanceId: probe.instanceId,
        executionMode: "jupyter_enterprise_gateway_prerequisite",
        executesUserCode: false,
        detail:
          "JEG prerequisite passed, but execution is NO-GO until the durable " +
          "runner/idempotency/channel/output bridge and live isolation gate pass",
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.kind,
        version: this.version,
        instanceId: this.instanceId,
        executionMode: "jupyter_enterprise_gateway_prerequisite",
        executesUserCode: false,
        detail: this.diagnostic(error),
      };
    }
  }
}
