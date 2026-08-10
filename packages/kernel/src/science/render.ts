import { createHash } from "node:crypto";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
  redactScienceDiagnostic,
  rejectRedirectOrOriginChange,
} from "./http-boundary.js";
import type { ArtifactReference } from "./artifact-store.js";
import type { ProviderInstanceFence } from "./providers.js";

export type RenderMode = "client" | "remote" | "static";
export type RenderProviderState = "starting" | "ready" | "failed" | "closed";

export interface RenderSource {
  runId: string;
  artifactVersionId: string;
  format: string;
  mediaType: string;
  size: number;
  sha256: string;
  reference: ArtifactReference;
}

export interface RenderLaunch {
  providerHandle: string;
  /** Immutable launcher identity for fencing durable provider handles. */
  instanceId: string;
  state: RenderProviderState;
  mode: RenderMode;
}

export interface RenderStatus {
  state: RenderProviderState;
  mode: RenderMode;
  /** Internal upstream URL. It is consumed by the same-origin gateway only. */
  upstreamUrl: string | null;
  message?: string;
}

export interface RenderProviderHealth {
  ok: boolean;
  provider: string;
  version: string;
  /** Immutable launcher identity; bounded even on adapter-reported failures. */
  instanceId: string;
  detail?: string;
}

export interface RenderSessionProvider {
  readonly kind: string;
  readonly version: string;
  start(input: {
    sessionId: string;
    workspaceId: string;
    ownerId: string;
    expiresAt: string;
    gatewayToken: string;
    source: RenderSource;
  }, fence: ProviderInstanceFence): Promise<RenderLaunch>;
  status(providerHandle: string, fence: ProviderInstanceFence): Promise<RenderStatus>;
  renew(
    providerHandle: string,
    expiresAt: string,
    fence: ProviderInstanceFence,
  ): Promise<void>;
  close(providerHandle: string, fence: ProviderInstanceFence): Promise<void>;
  health(): Promise<RenderProviderHealth>;
}

function boundedRenderInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9._-]{1,100}$/i.test(value)) {
    throw new Error("render provider returned an invalid immutable instance ID");
  }
  return value;
}

function requireRenderInstanceFence(
  fence: ProviderInstanceFence | null | undefined,
): ProviderInstanceFence {
  return {
    expectedInstanceId: boundedRenderInstanceId(fence?.expectedInstanceId),
  };
}

export class RenderProviderRegistry {
  private readonly providers = new Map<string, RenderSessionProvider>();

  register(provider: RenderSessionProvider): void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`render provider ${provider.kind} is already registered`);
    }
    this.providers.set(provider.kind, provider);
  }

  get(kind: string): RenderSessionProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`render provider ${kind} is not configured`);
    return provider;
  }

  list(): Array<{ kind: string; version: string }> {
    return [...this.providers.values()].map(({ kind, version }) => ({ kind, version }));
  }

  async health(): Promise<RenderProviderHealth[]> {
    return Promise.all([...this.providers.values()].map((provider) => provider.health()));
  }
}

interface StaticHandle {
  sessionId: string;
  artifactVersionId: string;
}

function encodeStaticHandle(value: StaticHandle): string {
  return `static:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function decodeStaticHandle(value: string): StaticHandle {
  if (!value.startsWith("static:")) throw new Error("invalid static render handle");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid static render handle");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("invalid static render handle");
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.sessionId !== "string" ||
    typeof row.artifactVersionId !== "string"
  ) {
    throw new Error("invalid static render handle");
  }
  return row as unknown as StaticHandle;
}

/** Always-available non-WebGL/static fallback. */
export class StaticRenderSessionProvider implements RenderSessionProvider {
  readonly kind = "static";
  readonly version = "1.0.0";
  readonly instanceId = "static-render-v1";

  async start(input: {
    sessionId: string;
    source: RenderSource;
  }, fence: ProviderInstanceFence): Promise<RenderLaunch> {
    boundedRenderInstanceId(fence.expectedInstanceId);
    if (fence.expectedInstanceId !== this.instanceId) {
      throw new Error("static render provider instance fence rejected start");
    }
    return {
      providerHandle: encodeStaticHandle({
        sessionId: input.sessionId,
        artifactVersionId: input.source.artifactVersionId,
      }),
      instanceId: this.instanceId,
      state: "ready",
      mode: "static",
    };
  }

  async status(
    providerHandle: string,
    fence: ProviderInstanceFence,
  ): Promise<RenderStatus> {
    if (boundedRenderInstanceId(fence.expectedInstanceId) !== this.instanceId) {
      throw new Error("static render provider instance fence rejected status");
    }
    const handle = decodeStaticHandle(providerHandle);
    return {
      state: "ready",
      mode: "static",
      // The gateway performs the session/owner check, then redirects to the
      // normal authenticated content route. No expiring URL is embedded in a
      // durable provider handle, so renewal remains valid.
      upstreamUrl:
        `/api/science/artifact-versions/${encodeURIComponent(handle.artifactVersionId)}/content`,
    };
  }

  async renew(
    providerHandle: string,
    _expiresAt: string,
    fence: ProviderInstanceFence,
  ): Promise<void> {
    if (boundedRenderInstanceId(fence.expectedInstanceId) !== this.instanceId) {
      throw new Error("static render provider instance fence rejected renew");
    }
    decodeStaticHandle(providerHandle);
  }

  async close(
    providerHandle: string,
    fence: ProviderInstanceFence,
  ): Promise<void> {
    if (boundedRenderInstanceId(fence.expectedInstanceId) !== this.instanceId) {
      throw new Error("static render provider instance fence rejected close");
    }
    decodeStaticHandle(providerHandle);
  }

  async health(): Promise<RenderProviderHealth> {
    return {
      ok: true,
      provider: this.kind,
      version: this.version,
      instanceId: this.instanceId,
    };
  }
}

export class HttpRenderSessionProvider implements RenderSessionProvider {
  readonly kind: string;
  readonly version = "render-contract.v1";
  private readonly baseUrl: URL;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly adapterInstanceId: string;

  constructor(opts: {
    kind?: string;
    baseUrl: string;
    bearerToken?: string;
    timeoutMs?: number;
  }) {
    this.kind = opts.kind?.trim() || "trame";
    this.baseUrl = new URL(opts.baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("render launcher URL must use HTTP or HTTPS");
    }
    if (
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new Error("render launcher URL cannot contain credentials, query, or fragment");
    }
    this.token = opts.bearerToken?.trim() || null;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 15_000);
    this.adapterInstanceId =
      `http-render-${createHash("sha256").update(this.baseUrl.origin).digest("hex").slice(0, 16)}`;
  }

  private async request(
    path: string,
    init?: RequestInit,
    expected: readonly number[] = [200],
    fence?: ProviderInstanceFence,
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), `${this.baseUrl.toString().replace(/\/?$/, "/")}`);
    if (url.origin !== this.baseUrl.origin) throw new Error("render request escaped configured origin");
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (init?.body) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (fence) {
      headers.set(
        "x-science-provider-instance",
        boundedRenderInstanceId(fence.expectedInstanceId),
      );
    }
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await rejectRedirectOrOriginChange(response, this.baseUrl.origin, "render launcher");
    if (!expected.includes(response.status)) {
      const detail = redactScienceDiagnostic(
        await readBoundedResponseText(response, "render launcher error response"),
        2_000,
      );
      throw new Error(`render launcher returned ${response.status}: ${detail}`);
    }
    return response;
  }

  private parseStatus(
    value: unknown,
  ): RenderStatus & { handle?: string; instanceId?: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("render launcher returned invalid JSON");
    }
    const row = value as Record<string, unknown>;
    if (
      !["starting", "ready", "failed", "closed"].includes(String(row.state)) ||
      row.mode !== "remote"
    ) {
      throw new Error("render launcher returned an invalid state");
    }
    let upstreamUrl: string | null = null;
    if (typeof row.upstreamUrl === "string" && row.upstreamUrl) {
      const upstream = new URL(row.upstreamUrl, this.baseUrl);
      if (upstream.origin !== this.baseUrl.origin) {
        throw new Error("render upstream escaped configured launcher origin");
      }
      upstreamUrl = upstream.toString();
    }
    return {
      state: row.state as RenderProviderState,
      mode: "remote",
      upstreamUrl,
      ...(typeof row.message === "string" ? { message: row.message.slice(0, 1_000) } : {}),
      ...(typeof row.handle === "string" ? { handle: row.handle } : {}),
      ...(typeof row.instanceId === "string" ? { instanceId: row.instanceId } : {}),
    };
  }

  async start(input: {
    sessionId: string;
    workspaceId: string;
    ownerId: string;
    expiresAt: string;
    gatewayToken: string;
    source: RenderSource;
  }, fence: ProviderInstanceFence): Promise<RenderLaunch> {
    const operationFence = requireRenderInstanceFence(fence);
    const response = await this.request("/v1/render-sessions", {
      method: "POST",
      headers: {
        "idempotency-key": createHash("sha256")
          .update(`${input.workspaceId}:${input.sessionId}`)
          .digest("hex"),
      },
      body: JSON.stringify(input),
    }, [200, 201, 202], operationFence);
    const status = this.parseStatus(
      await readBoundedResponseJson(response, "render launcher start"),
    );
    if (!status.handle) throw new Error("render launcher response has no handle");
    const instanceId = boundedRenderInstanceId(status.instanceId);
    return {
      providerHandle: status.handle,
      instanceId,
      state: status.state,
      mode: "remote",
    };
  }

  async status(
    providerHandle: string,
    fence: ProviderInstanceFence,
  ): Promise<RenderStatus> {
    const operationFence = requireRenderInstanceFence(fence);
    const response = await this.request(
      `/v1/render-sessions/${encodeURIComponent(providerHandle)}`,
      undefined,
      [200],
      operationFence,
    );
    return this.parseStatus(
      await readBoundedResponseJson(response, "render launcher status"),
    );
  }

  async renew(
    providerHandle: string,
    expiresAt: string,
    fence: ProviderInstanceFence,
  ): Promise<void> {
    const operationFence = requireRenderInstanceFence(fence);
    await this.request(`/v1/render-sessions/${encodeURIComponent(providerHandle)}/renew`, {
      method: "POST",
      body: JSON.stringify({ expiresAt }),
    }, [200, 204], operationFence);
  }

  async close(
    providerHandle: string,
    fence: ProviderInstanceFence,
  ): Promise<void> {
    const operationFence = requireRenderInstanceFence(fence);
    await this.request(`/v1/render-sessions/${encodeURIComponent(providerHandle)}`, {
      method: "DELETE",
    }, [200, 204, 404], operationFence);
  }

  async health(): Promise<RenderProviderHealth> {
    try {
      const response = await this.request("/health");
      const row = await readBoundedResponseJson(
        response,
        "render launcher health",
      ) as Record<string, unknown>;
      return {
        ok: row.ok === true,
        provider: this.kind,
        version: typeof row.version === "string" ? row.version : this.version,
        instanceId: boundedRenderInstanceId(row.instanceId),
        ...(typeof row.detail === "string"
          ? { detail: redactScienceDiagnostic(row.detail, 1_000) }
          : {}),
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.kind,
        version: this.version,
        instanceId: this.adapterInstanceId,
        detail: redactScienceDiagnostic(error, 1_000),
      };
    }
  }
}
