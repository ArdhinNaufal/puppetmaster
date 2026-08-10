import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { canonicalJson } from "./manifest.js";
import type { ArtifactReference } from "./artifact-store.js";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
  redactScienceDiagnostic,
  rejectRedirectOrOriginChange,
} from "./http-boundary.js";

export interface ScienceResourceRequest {
  cpuMillicores: number;
  memoryMb: number;
  gpuCount: number;
  wallTimeSeconds: number;
}

export interface ComputeQuote {
  available: boolean;
  provider: string;
  source: "declared" | "measured";
  queueSeconds: number | null;
  estimatedWallSeconds: number | null;
  cost: { amount: number; currency: string } | null;
  limits: ScienceResourceRequest;
  reason?: string;
}

export interface ComputeSubmission {
  runId: string;
  missionId: string;
  generation: number;
  idempotencyKey: string;
  submittedAt: string;
  imageDigest: string;
  kernel: string;
  parameters: Record<string, unknown>;
  resources: ScienceResourceRequest;
  inputs: Array<{
    artifactVersionId: string;
    role: string;
    mediaType: string;
    sha256: string;
    size: number;
    reference: ArtifactReference;
  }>;
}

export type ProviderExecutionState =
  | "queued"
  | "provisioning"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProviderMetric {
  name: string;
  value: number;
  unit: string;
  measuredAt: string;
}

export interface ComputeStatus {
  state: ProviderExecutionState;
  progress: number | null;
  message?: string;
  logs?: string[];
  metrics?: ProviderMetric[];
  error?: string;
}

export interface ProviderOutput {
  reference: string;
  logicalName: string;
  kind: "result" | "dataset" | "geometry" | "image" | "log" | "notebook";
  format: string;
  mediaType: string;
  sha256: string;
  size: number;
  metadata: Record<string, unknown>;
}

export interface ComputeProviderHealth {
  ok: boolean;
  provider: string;
  version: string;
  instanceId?: string;
  executionMode?: string;
  executesUserCode?: boolean;
  detail?: string;
}

export interface ProviderInstanceFence {
  /** Immutable provider instance admitted for this exact external operation. */
  expectedInstanceId: string;
}

function requireProviderInstanceFence(
  fence: ProviderInstanceFence | null | undefined,
): ProviderInstanceFence {
  if (
    !fence ||
    !/^[a-z0-9._-]{1,100}$/i.test(fence.expectedInstanceId)
  ) {
    throw new Error("science compute provider instance fence is required");
  }
  return fence;
}

export interface ComputeProvider {
  readonly kind: string;
  readonly version: string;
  quote(resources: ScienceResourceRequest): Promise<ComputeQuote>;
  submit(input: ComputeSubmission, fence: ProviderInstanceFence): Promise<{ handle: string }>;
  status(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ComputeStatus>;
  cancel(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<{ accepted: boolean }>;
  collectOutputs(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ProviderOutput[]>;
  openOutput(
    output: ProviderOutput,
    fence: ProviderInstanceFence,
  ): Promise<AsyncIterable<Uint8Array>>;
  health(): Promise<ComputeProviderHealth>;
}

function assertProviderInstanceFence(
  actualInstanceId: string,
  fence: ProviderInstanceFence | null | undefined,
): void {
  const requiredFence = requireProviderInstanceFence(fence);
  if (
    requiredFence.expectedInstanceId !== actualInstanceId
  ) {
    throw new Error("science compute provider instance fence rejected the operation");
  }
}

const ScienceResourceRequestSchema = z.object({
  cpuMillicores: z.number().int().positive().max(1_000_000),
  memoryMb: z.number().int().positive().max(16_777_216),
  gpuCount: z.number().int().nonnegative().max(64),
  wallTimeSeconds: z.number().int().positive().max(31_536_000),
}).strict();

const ComputeQuoteSchema = z.object({
  available: z.boolean(),
  provider: z.string().trim().min(1).max(200),
  source: z.enum(["declared", "measured"]),
  queueSeconds: z.number().nonnegative().finite().nullable(),
  estimatedWallSeconds: z.number().nonnegative().finite().nullable(),
  cost: z.object({
    amount: z.number().nonnegative().finite(),
    currency: z.string().trim().min(1).max(16),
  }).strict().nullable(),
  limits: ScienceResourceRequestSchema,
  reason: z.string().max(2_000).optional(),
}).strict();

const ComputeStatusSchema = z.object({
  state: z.enum(["queued", "provisioning", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().finite().min(0).max(1).nullable(),
  message: z.string().max(2_000).optional(),
  logs: z.array(z.string().max(2_000)).max(32).optional(),
  metrics: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    value: z.number().finite(),
    unit: z.string().max(100),
    measuredAt: z.string().datetime(),
  }).strict()).max(64).optional(),
  error: z.string().max(4_000).optional(),
}).strict();

const ProviderOutputSchema = z.object({
  reference: z.string().trim().min(1).max(4_096)
    .refine((value) => !/^data:/i.test(value), "inline data references are forbidden"),
  logicalName: z.string().trim().min(1).max(300),
  kind: z.enum(["result", "dataset", "geometry", "image", "log", "notebook"]),
  format: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative().safe(),
  metadata: z.record(z.unknown()).refine((value) => {
    try {
      return Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024;
    } catch {
      return false;
    }
  }, "provider output metadata exceeds 32 KiB or is not JSON"),
}).strict();

export function validateComputeQuote(value: unknown): ComputeQuote {
  return ComputeQuoteSchema.parse(value);
}

export function validateComputeStatus(value: unknown): ComputeStatus {
  return ComputeStatusSchema.parse(value);
}

export function validateProviderOutputs(value: unknown): ProviderOutput[] {
  return z.array(ProviderOutputSchema).max(200).parse(value);
}

export class ComputeProviderRegistry {
  private readonly providers = new Map<string, ComputeProvider>();

  register(provider: ComputeProvider): void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`compute provider ${provider.kind} is already registered`);
    }
    this.providers.set(provider.kind, provider);
  }

  get(kind: string): ComputeProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`compute provider ${kind} is not configured`);
    return provider;
  }

  list(): Array<{ kind: string; version: string }> {
    return [...this.providers.values()].map(({ kind, version }) => ({ kind, version }));
  }

  async health(): Promise<ComputeProviderHealth[]> {
    return Promise.all([...this.providers.values()].map((provider) => provider.health()));
  }
}

interface DeterministicHandle {
  runId: string;
  generation: number;
  submittedAt: string;
  keyHash: string;
  parametersHash: string;
}

function encodeHandle(value: DeterministicHandle): string {
  return `det:${Buffer.from(canonicalJson(value)).toString("base64url")}`;
}

function decodeHandle(handle: string): DeterministicHandle {
  if (!handle.startsWith("det:")) throw new Error("invalid deterministic provider handle");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(handle.slice(4), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid deterministic provider handle");
  }
  if (!value || typeof value !== "object") throw new Error("invalid deterministic provider handle");
  const row = value as Record<string, unknown>;
  if (
    typeof row.runId !== "string" ||
    !Number.isSafeInteger(row.generation) ||
    typeof row.submittedAt !== "string" ||
    typeof row.keyHash !== "string" ||
    typeof row.parametersHash !== "string"
  ) {
    throw new Error("invalid deterministic provider handle");
  }
  return row as unknown as DeterministicHandle;
}

function deterministicOutput(handle: DeterministicHandle, reference: string): Buffer {
  if (reference.endsWith(":vtk")) {
    const amplitude = Number.parseInt(handle.parametersHash.slice(0, 8), 16) / 0xffffffff;
    return Buffer.from(
      [
        "# vtk DataFile Version 3.0",
        "Puppetmaster deterministic science fixture",
        "ASCII",
        "DATASET STRUCTURED_POINTS",
        "DIMENSIONS 2 2 2",
        "ORIGIN 0 0 0",
        "SPACING 1 1 1",
        "POINT_DATA 8",
        "SCALARS amplitude float 1",
        "LOOKUP_TABLE default",
        ...Array.from({ length: 8 }, (_, index) => (amplitude * (index + 1)).toFixed(8)),
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return Buffer.from(canonicalJson({
    schemaVersion: "science-result.v1",
    runId: handle.runId,
    generation: handle.generation,
    parametersHash: handle.parametersHash,
    values: Array.from({ length: 8 }, (_, index) => {
      const digest = createHash("sha256")
        .update(`${handle.runId}:${handle.parametersHash}:${index}`)
        .digest();
      return digest.readUInt32BE(0) / 0xffffffff;
    }),
  }), "utf8");
}

/**
 * Restart-stable provider used by deterministic tests and demo mode. Handles
 * encode the persisted submission timestamp, so duplicate submit and recovery
 * do not create a second external execution.
 */
export class DeterministicComputeProvider implements ComputeProvider {
  readonly kind: string;
  readonly version = "1.0.0";
  readonly instanceId: string;
  private readonly cancelled = new Set<string>();
  private readonly timings: {
    provisioningMs: number;
    runningMs: number;
  };

  constructor(opts?: { kind?: string; provisioningMs?: number; runningMs?: number }) {
    this.kind = opts?.kind?.trim() || "deterministic";
    this.timings = {
      provisioningMs: Math.max(0, opts?.provisioningMs ?? 100),
      runningMs: Math.max(0, opts?.runningMs ?? 300),
    };
    this.instanceId = createHash("sha256")
      .update(canonicalJson({
        kind: this.kind,
        version: this.version,
      }))
      .digest("hex")
      .slice(0, 32);
  }

  async quote(resources: ScienceResourceRequest): Promise<ComputeQuote> {
    return {
      available: resources.gpuCount === 0,
      provider: this.kind,
      source: "declared",
      queueSeconds: 0,
      estimatedWallSeconds: Math.ceil(
        (this.timings.provisioningMs + this.timings.runningMs) / 1000,
      ),
      cost: null,
      limits: {
        cpuMillicores: 4_000,
        memoryMb: 8192,
        gpuCount: 0,
        wallTimeSeconds: 3600,
      },
      ...(resources.gpuCount > 0 ? { reason: "deterministic provider has no GPU" } : {}),
    };
  }

  async submit(
    input: ComputeSubmission,
    fence: ProviderInstanceFence,
  ): Promise<{ handle: string }> {
    assertProviderInstanceFence(this.instanceId, fence);
    const handle = encodeHandle({
      runId: input.runId,
      generation: input.generation,
      submittedAt: input.submittedAt,
      keyHash: createHash("sha256").update(input.idempotencyKey).digest("hex"),
      parametersHash: createHash("sha256").update(canonicalJson(input.parameters)).digest("hex"),
    });
    return { handle };
  }

  async status(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ComputeStatus> {
    assertProviderInstanceFence(this.instanceId, fence);
    const value = decodeHandle(handle);
    if (value.generation !== generation) throw new Error("provider generation mismatch");
    if (this.cancelled.has(handle)) {
      return { state: "cancelled", progress: null, message: "cancelled by operator" };
    }
    const elapsed = Math.max(0, Date.now() - Date.parse(value.submittedAt));
    if (elapsed < this.timings.provisioningMs) {
      return { state: "provisioning", progress: 0, message: "allocating deterministic fixture" };
    }
    const runningFor = elapsed - this.timings.provisioningMs;
    if (runningFor < this.timings.runningMs) {
      const progress = this.timings.runningMs === 0
        ? 1
        : Math.max(0, Math.min(1, runningFor / this.timings.runningMs));
      return {
        state: "running",
        progress,
        message: "executing deterministic notebook fixture",
        logs: [`fixture progress ${Math.round(progress * 100)}%`],
        metrics: [{
          name: "wall_time",
          value: elapsed / 1000,
          unit: "s",
          measuredAt: new Date().toISOString(),
        }],
      };
    }
    return {
      state: "succeeded",
      progress: 1,
      message: "fixture complete",
      metrics: [{
        name: "wall_time",
        value: elapsed / 1000,
        unit: "s",
        measuredAt: new Date().toISOString(),
      }],
    };
  }

  async cancel(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<{ accepted: boolean }> {
    assertProviderInstanceFence(this.instanceId, fence);
    const value = decodeHandle(handle);
    if (value.generation !== generation) return { accepted: false };
    this.cancelled.add(handle);
    return { accepted: true };
  }

  async collectOutputs(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ProviderOutput[]> {
    assertProviderInstanceFence(this.instanceId, fence);
    const value = decodeHandle(handle);
    if (value.generation !== generation) throw new Error("provider generation mismatch");
    const refs = [`${handle}:result`, `${handle}:vtk`];
    return refs.map((reference, index) => {
      const bytes = deterministicOutput(value, reference);
      return {
        reference,
        logicalName: index === 0 ? "result.json" : "result.vtk",
        kind: index === 0 ? "result" : "geometry",
        format: index === 0 ? "json" : "vtk",
        mediaType: index === 0 ? "application/json" : "model/vnd.vtk",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        metadata: index === 0
          ? { schema: "science-result.v1", measured: true }
          : { dataset: "STRUCTURED_POINTS", dimensions: [2, 2, 2], preview: true },
      } satisfies ProviderOutput;
    });
  }

  async openOutput(
    output: ProviderOutput,
    fence: ProviderInstanceFence,
  ): Promise<AsyncIterable<Uint8Array>> {
    assertProviderInstanceFence(this.instanceId, fence);
    const separator = output.reference.lastIndexOf(":");
    const handle = output.reference.slice(0, separator);
    const value = decodeHandle(handle);
    const bytes = deterministicOutput(value, output.reference);
    if (
      bytes.length !== output.size ||
      createHash("sha256").update(bytes).digest("hex") !== output.sha256
    ) {
      throw new Error("deterministic output receipt mismatch");
    }
    return Readable.from([bytes]);
  }

  async health(): Promise<ComputeProviderHealth> {
    return {
      ok: true,
      provider: this.kind,
      version: this.version,
      instanceId: this.instanceId,
      executionMode: "deterministic_fixture",
      executesUserCode: false,
    };
  }
}

interface HttpProviderOptions {
  kind?: string;
  baseUrl: string;
  bearerToken?: string;
  timeoutMs?: number;
  requiredExecutionMode?: string;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

/**
 * Adapter for the isolated `services/science-runtime` container. Control
 * responses are JSON and bounded; output bytes are fetched only from the
 * configured runtime origin after collectOutputs returns checksummed refs.
 */
export class HttpComputeProvider implements ComputeProvider {
  readonly kind: string;
  readonly version = "http-contract.v1";
  readonly instanceId: string;
  private readonly baseUrl: URL;
  private readonly bearerToken: string | null;
  private readonly timeoutMs: number;
  private readonly requiredExecutionMode: string | null;

  constructor(opts: HttpProviderOptions) {
    this.kind = opts.kind?.trim() || "science-runtime";
    this.baseUrl = new URL(opts.baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("science runtime URL must use HTTP or HTTPS");
    }
    if (
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new Error("science runtime URL cannot contain credentials, query, or fragment");
    }
    this.bearerToken = opts.bearerToken?.trim() || null;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 15_000);
    this.requiredExecutionMode = opts.requiredExecutionMode?.trim() || null;
    this.instanceId = createHash("sha256")
      .update(`${this.kind}\n${this.version}\n${this.baseUrl.toString()}`)
      .digest("hex")
      .slice(0, 32);
  }

  private async request(
    path: string,
    init?: RequestInit,
    expected: readonly number[] = [200],
    fence?: ProviderInstanceFence,
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), `${this.baseUrl.toString().replace(/\/?$/, "/")}`);
    if (url.origin !== this.baseUrl.origin) throw new Error("runtime request escaped configured origin");
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (init?.body) headers.set("content-type", "application/json");
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    if (fence) {
      if (!/^[a-z0-9._-]{1,100}$/i.test(fence.expectedInstanceId)) {
        throw new Error("science runtime expected instance ID is invalid");
      }
      headers.set("x-science-provider-instance", fence.expectedInstanceId);
    }
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await rejectRedirectOrOriginChange(response, this.baseUrl.origin, "science runtime");
    if (!expected.includes(response.status)) {
      const detail = redactScienceDiagnostic(
        await readBoundedResponseText(response, "science runtime error response"),
        2_000,
      );
      throw new Error(`science runtime returned ${response.status}: ${detail}`);
    }
    return response;
  }

  async quote(resources: ScienceResourceRequest): Promise<ComputeQuote> {
    const response = await this.request("/v1/quote", {
      method: "POST",
      body: JSON.stringify({ resources }),
    });
    return validateComputeQuote(expectObject(
      await readBoundedResponseJson(response, "science runtime quote"),
      "quote",
    ));
  }

  async submit(
    input: ComputeSubmission,
    fence: ProviderInstanceFence,
  ): Promise<{ handle: string }> {
    const operationFence = requireProviderInstanceFence(fence);
    if (this.requiredExecutionMode) {
      const health = await this.readHealth();
      if (
        health.ok !== true ||
        health.executionMode !== this.requiredExecutionMode ||
        health.executesUserCode !== true ||
        typeof health.instanceId !== "string" ||
        !/^[a-z0-9._-]{1,100}$/i.test(health.instanceId)
      ) {
        throw new Error(
          `science runtime is not admitted as ${this.requiredExecutionMode}; ` +
          "a contract fixture cannot execute production runs",
        );
      }
      if (health.instanceId !== operationFence.expectedInstanceId) {
        throw new Error("science runtime instance changed before submit");
      }
    }
    const response = await this.request("/v1/runs", {
      method: "POST",
      headers: { "idempotency-key": input.idempotencyKey },
      body: JSON.stringify(input),
    }, [200, 201], operationFence);
    const row = expectObject(
      await readBoundedResponseJson(response, "science runtime submit"),
      "submit",
    );
    if (
      typeof row.handle !== "string" ||
      !row.handle ||
      row.handle.length > 450 ||
      row.handle.includes("\0")
    ) {
      throw new Error("science runtime submit response has no handle");
    }
    return { handle: row.handle };
  }

  async status(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ComputeStatus> {
    const operationFence = requireProviderInstanceFence(fence);
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(handle)}?generation=${generation}`,
      undefined,
      [200],
      operationFence,
    );
    return validateComputeStatus(expectObject(
      await readBoundedResponseJson(response, "science runtime status"),
      "status",
    ));
  }

  async cancel(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<{ accepted: boolean }> {
    const operationFence = requireProviderInstanceFence(fence);
    const response = await this.request(`/v1/runs/${encodeURIComponent(handle)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ generation }),
    }, [200, 202], operationFence);
    const row = expectObject(
      await readBoundedResponseJson(response, "science runtime cancel"),
      "cancel",
    );
    return { accepted: row.accepted === true };
  }

  async collectOutputs(
    handle: string,
    generation: number,
    fence: ProviderInstanceFence,
  ): Promise<ProviderOutput[]> {
    const operationFence = requireProviderInstanceFence(fence);
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(handle)}/outputs?generation=${generation}`,
      undefined,
      [200],
      operationFence,
    );
    const row = expectObject(
      await readBoundedResponseJson(response, "science runtime outputs"),
      "outputs",
    );
    if (!Array.isArray(row.outputs)) throw new Error("science runtime output list is invalid");
    const encoded = JSON.stringify(row.outputs);
    if (Buffer.byteLength(encoded) > 64 * 1024 || /data:[^;,]+;base64,/i.test(encoded)) {
      throw new Error("science runtime returned inline or oversized output metadata");
    }
    return validateProviderOutputs(row.outputs);
  }

  async openOutput(
    output: ProviderOutput,
    fence: ProviderInstanceFence,
  ): Promise<AsyncIterable<Uint8Array>> {
    const operationFence = requireProviderInstanceFence(fence);
    const url = new URL(output.reference, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith("/v1/outputs/")) {
      throw new Error("science runtime output reference escaped its configured origin");
    }
    const headers = new Headers();
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    headers.set("x-science-provider-instance", operationFence.expectedInstanceId);
    headers.set("accept-encoding", "identity");
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await rejectRedirectOrOriginChange(response, this.baseUrl.origin, "science runtime output");
    if (!response.ok || !response.body) {
      throw new Error(`science runtime output returned ${response.status}`);
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
      await response.body.cancel();
      throw new Error("science runtime output must use identity content encoding");
    }
    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader !== null) {
      const declared = Number(declaredHeader);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared !== output.size) {
        await response.body.cancel();
        throw new Error("science runtime output size differs from its receipt");
      }
    }
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }

  async health(): Promise<ComputeProviderHealth> {
    try {
      const row = await this.readHealth();
      if (
        typeof row.instanceId !== "string" ||
        !/^[a-z0-9._-]{1,100}$/i.test(row.instanceId)
      ) {
        throw new Error(
          "science runtime health did not report a bounded immutable instance ID",
        );
      }
      const executionMode =
        typeof row.executionMode === "string"
          ? row.executionMode.slice(0, 100)
          : undefined;
      const executesUserCode =
        typeof row.executesUserCode === "boolean"
          ? row.executesUserCode
          : undefined;
      const admissionMismatch =
        this.requiredExecutionMode !== null &&
        (
          executionMode !== this.requiredExecutionMode ||
          executesUserCode !== true
        );
      return {
        ok: row.ok === true && !admissionMismatch,
        provider: this.kind,
        version: typeof row.version === "string" ? row.version.slice(0, 100) : this.version,
        instanceId: row.instanceId,
        ...(executionMode !== undefined ? { executionMode } : {}),
        ...(executesUserCode !== undefined ? { executesUserCode } : {}),
        ...(admissionMismatch
          ? {
              detail:
                `science runtime is not admitted as ${this.requiredExecutionMode}; ` +
                "user-code execution is not enabled",
            }
          : typeof row.detail === "string"
            ? { detail: redactScienceDiagnostic(row.detail, 1_000) }
            : {}),
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.kind,
        version: this.version,
        detail: redactScienceDiagnostic(error, 1_000),
      };
    }
  }

  private async readHealth(): Promise<Record<string, unknown>> {
    const response = await this.request("/health");
    return expectObject(
      await readBoundedResponseJson(response, "science runtime health"),
      "health",
    );
  }
}
