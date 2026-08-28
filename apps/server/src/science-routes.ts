import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { Readable } from "node:stream";
import {
  ScienceArtifactKind,
  ScienceDomainValidationSubmission,
  ScienceResourceBounds,
  ScienceRunState,
} from "@puppetmaster/shared";
import { ScienceConflictError } from "@puppetmaster/db";
import {
  ScienceDisabledError,
  ScienceNotFoundError,
  redactScienceDiagnostic,
  type ScienceService,
} from "@puppetmaster/kernel";
import { z } from "zod";
import {
  canonicalRequestPath,
  InvalidRequestPathError,
} from "./request-path.js";

const Uuid = z.string().uuid();
const Page = z.object({
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).passthrough();
const StrictPage = z.object({
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();
const ValidationPage = z.object({
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const ResourceRequest = ScienceResourceBounds;
const RunArtifactInput = z.object({
  artifactVersionId: Uuid,
  semanticRole: z.string().trim().min(1).max(128),
}).strict();

type Handler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

function route(handler: Handler): Handler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (reply.sent) return;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: "invalid science request",
          issues: error.issues.slice(0, 20).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      if (error instanceof ScienceNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof ScienceConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof ScienceDisabledError) {
        return reply.code(503).send({ error: error.message });
      }
      request.log.error(
        { scienceError: redactScienceDiagnostic(error, 1_000) },
        "science request failed",
      );
      return reply.code(500).send({ error: "science operation failed" });
    }
  };
}

export function resolveRenderGatewayUpstream(baseUrl: string, suffix: string): URL {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.hash) {
    throw new ScienceNotFoundError("render resource not found");
  }
  let decoded = suffix.replace(/^\/+/, "");
  try {
    // Decode twice so double-encoded dot segments or separators cannot be
    // interpreted differently by the upstream server after this check.
    for (let pass = 0; pass < 2; pass++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new ScienceNotFoundError("render resource not found");
  }
  if (decoded.includes("\\") || decoded.includes("\0") || /[?#]/.test(decoded)) {
    throw new ScienceNotFoundError("render resource not found");
  }
  const segments = decoded ? decoded.split("/") : [];
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ScienceNotFoundError("render resource not found");
  }
  if (segments.length === 0) return base;
  const basePrefix = `${base.pathname.replace(/\/+$/, "")}/`;
  const canonicalSuffix = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const upstream = new URL(canonicalSuffix, `${base.origin}${basePrefix}`);
  if (upstream.origin !== base.origin || !upstream.pathname.startsWith(basePrefix)) {
    throw new ScienceNotFoundError("render resource not found");
  }
  return upstream;
}

function actor(request: FastifyRequest): string {
  if (!request.authUser) throw new ScienceNotFoundError("authenticated science actor not found");
  return request.authUser.id;
}

export function redactScienceRequestPath(rawUrl: string): string {
  return rawUrl
    .split("?", 1)[0]
    .replace(
      /^(\/api\/science\/uploads\/)[^/]+(?=\/|$)/,
      "$1[REDACTED]",
    );
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /(^|[_-])(secret|token|password|passwd|api[_-]?key|credential|private[_-]?key|authorization|bearer|access[_-]?key(?:[_-]?id)?|session[_-]?key|key)([_-]|$)/i.test(key)
      ? "[REDACTED]"
      : redactSecrets(entry);
  }
  return output;
}

function publicVersion<T extends { storageKey: string }>(version: T) {
  const { storageKey: _storageKey, ...safe } = version;
  return safe;
}

const SAFE_INLINE_ARTIFACT_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function isSafeInlineArtifactMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SAFE_INLINE_ARTIFACT_MEDIA_TYPES.has(normalized);
}

function publicProfileConfig(config: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["dependencyLock", "network", "provisioningTimeoutSeconds"]) {
    if (config[key] !== undefined) output[key] = redactSecrets(config[key]);
  }
  return output;
}

function publicProfile<T extends { config: Record<string, unknown> }>(profile: T) {
  return { ...profile, config: publicProfileConfig(profile.config) };
}

function publicRun<T extends {
  providerHandle: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  profileSnapshot: { config: Record<string, unknown> };
}>(run: T) {
  const {
    providerHandle: _providerHandle,
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    heartbeatAt: _heartbeatAt,
    profileSnapshot,
    ...safe
  } = run;
  return {
    ...safe,
    providerHandle: null,
    profileSnapshot: {
      ...profileSnapshot,
      config: publicProfileConfig(profileSnapshot.config),
    },
  };
}

function publicUpload<T extends { tokenHash: string; quarantineKey: string }>(upload: T) {
  const { tokenHash: _tokenHash, quarantineKey: _quarantineKey, ...safe } = upload;
  return safe;
}

function publicRender<T extends {
  tokenHash: string;
  providerHandle: string | null;
  audience: string;
  requestKeyHash: string;
  intentFingerprint: string;
  providerKind: string;
  sourceSha256: string;
  sourceMediaType: string;
  sourceSizeBytes: number;
  sourceLogicalName: string;
  launchLeaseId: string | null;
  launchLeaseExpiresAt: Date | null;
  artifactVersionId: string | null;
}>(session: T) {
  const {
    tokenHash: _tokenHash,
    providerHandle: _providerHandle,
    audience: _audience,
    requestKeyHash: _requestKeyHash,
    intentFingerprint: _intentFingerprint,
    providerKind,
    sourceSha256,
    sourceMediaType,
    sourceSizeBytes,
    sourceLogicalName,
    launchLeaseId: _launchLeaseId,
    launchLeaseExpiresAt: _launchLeaseExpiresAt,
    ...safe
  } = session;
  return {
    ...safe,
    provider: providerKind,
    source: {
      artifactVersionId: session.artifactVersionId,
      sha256: sourceSha256,
      mediaType: sourceMediaType,
      sizeBytes: sourceSizeBytes,
      logicalName: sourceLogicalName,
    },
  };
}

function publicAdmission<T extends {
  workspaceId: string;
  admitted: boolean;
  updatedAt: Date | null;
}>(admission: T) {
  const { workspaceId, admitted, updatedAt } = admission;
  return { workspaceId, admitted, updatedAt };
}

function publicDomainValidationSummary(item: Awaited<
  ReturnType<ScienceService["listDomainValidations"]>
>["items"][number]) {
  return {
    id: item.id,
    runId: item.runId,
    revision: item.revision,
    baselineRunId: item.baselineRunId,
    kind: item.kind,
    metric: item.metric,
    tolerance: item.tolerance,
    observedValue: item.observedValue,
    units: item.units,
    methodProtocolId: item.methodProtocolId,
    decision: item.decision,
    limitationsReason: item.limitationsReason,
    reviewerId: item.reviewerId,
    reviewerRole: item.reviewerRole,
    runManifestHash: item.runManifestHash,
    baselineManifestHash: item.baselineManifestHash,
    createdAt: item.createdAt,
    recordHash: item.recordHash,
  };
}

function publicDomainValidationDetail(item: Awaited<
  ReturnType<ScienceService["getDomainValidation"]>
>) {
  const outputs = (entries: typeof item.runOutputChecksums) => entries.map((entry) => ({
    artifactVersionId: entry.artifactVersionId,
    semanticRole: entry.semanticRole,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
  }));
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    runId: item.runId,
    revision: item.revision,
    baselineRunId: item.baselineRunId,
    kind: item.kind,
    metric: item.metric,
    tolerance: item.tolerance,
    observedValue: item.observedValue,
    units: item.units,
    methodProtocolId: item.methodProtocolId,
    decision: item.decision,
    limitationsReason: item.limitationsReason,
    reviewerId: item.reviewerId,
    reviewerRole: item.reviewerRole,
    runManifestHash: item.runManifestHash,
    runOutputChecksums: outputs(item.runOutputChecksums),
    baselineManifestHash: item.baselineManifestHash,
    baselineOutputChecksums: item.baselineOutputChecksums
      ? outputs(item.baselineOutputChecksums)
      : null,
    createdAt: item.createdAt,
    recordHash: item.recordHash,
  };
}

function publicAdminActionQueueItem(item: Awaited<
  ReturnType<ScienceService["listAdminActionQueue"]>
>["items"][number]) {
  return {
    id: item.id,
    kind: item.kind,
    state: item.state,
    ageSeconds: item.ageSeconds,
    attempts: item.attempts,
    nextRetryAt: item.nextRetryAt,
    reason: item.reason,
    links: item.links.map(({ rel, href }) => ({ rel, href })),
  };
}

function parseSingleRange(header: string | undefined, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw new ScienceConflictError("invalid byte range");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new ScienceConflictError("invalid byte range");
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new ScienceConflictError("requested byte range is unsatisfiable");
  }
  return { start, end: Math.min(end, size - 1) };
}

function flattenRunDossier(
  dossier: Awaited<ReturnType<ScienceService["getRunDossier"]>>,
) {
  const project = (entry: (typeof dossier.inputs)[number]) => ({
    id: entry.id,
    runId: entry.runId,
    artifactVersionId: entry.artifactVersionId,
    direction: entry.direction,
    semanticRole: entry.semanticRole,
    createdAt: entry.createdAt,
    sha256: entry.version?.sha256 ?? null,
    sizeBytes: entry.version?.sizeBytes ?? null,
    mediaType: entry.version?.mediaType ?? null,
    logicalName: entry.artifact?.logicalName ?? null,
    format: entry.artifact?.format ?? null,
  });
  return {
    ...publicRun(dossier.run),
    inputs: dossier.inputs.map(project),
    outputs: dossier.outputs.map(project),
    recentEvents: dossier.events.items,
  };
}

export function registerScienceRoutes(
  app: FastifyInstance,
  deps: {
    service: ScienceService;
    rateLimit?: { readPerMinute?: number; writePerMinute?: number };
  },
): void {
  const { service } = deps;
  const positiveLimit = (value: number | undefined, fallback: number): number =>
    Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, 100_000) : fallback;
  const readPerMinute = positiveLimit(
    deps.rateLimit?.readPerMinute ??
      Number(process.env.SCIENCE_RATE_LIMIT_READS_PER_MINUTE),
    600,
  );
  const writePerMinute = positiveLimit(
    deps.rateLimit?.writePerMinute ??
      Number(process.env.SCIENCE_RATE_LIMIT_WRITES_PER_MINUTE),
    120,
  );
  const rateWindowMs = 60_000;
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();

  // Single-host pilot defense-in-depth. Reverse proxies may enforce a tighter
  // distributed policy, but the application still bounds authenticated and
  // signed-capability traffic when deployed without one.
  app.addHook("preHandler", async (request, reply) => {
    let path: string;
    try {
      path = canonicalRequestPath(request.url);
    } catch (error) {
      if (!(error instanceof InvalidRequestPathError)) throw error;
      return reply.code(400).send({ error: "invalid request path" });
    }
    if (path !== "/api/science" && !path.startsWith("/api/science/")) return;
    const now = Date.now();
    if (rateBuckets.size >= 10_000) {
      for (const [key, bucket] of rateBuckets) {
        if (bucket.resetAt <= now) rateBuckets.delete(key);
      }
    }
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const limit = mutating ? writePerMinute : readPerMinute;
    const principal = request.authUser?.id ?? `ip:${request.ip}`;
    const key = `${principal}:${mutating ? "write" : "read"}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && rateBuckets.size >= 10_000) {
        return reply
          .header("retry-after", "60")
          .code(429)
          .send({ error: "science request rate limit reached" });
      }
      bucket = { count: 0, resetAt: now + rateWindowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    reply.header("x-ratelimit-limit", String(limit));
    reply.header("x-ratelimit-remaining", String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      return reply
        .header("retry-after", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))))
        .code(429)
        .send({ error: "science request rate limit reached" });
    }
  });

  // Preserve streaming semantics; Fastify must not buffer multi-gigabyte
  // scientific uploads into process memory.
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser(
      "application/octet-stream",
      (request, payload, done) => done(null, payload),
    );
  }

  app.get("/api/science/workspace-admission", route(async () => ({
    admission: publicAdmission(await service.getWorkspaceAdmission()),
  })));

  app.patch("/api/science/workspace-admission", route(async (request) => {
    const body = z.object({
      admitted: z.boolean(),
      reason: z.string().trim().min(1).max(1_000),
    }).strict().parse(request.body);
    const admission = await service.setWorkspaceAdmission({
      admitted: body.admitted,
      reason: body.reason,
      actorId: actor(request),
    });
    return { admission: publicAdmission(admission) };
  }));

  app.get("/api/science/admin/action-queue", route(async (request) => {
    const query = StrictPage.parse(request.query);
    const actionQueue = await service.listAdminActionQueue({
      page: { offset: query.offset, limit: query.limit },
    });
    return {
      ...actionQueue,
      items: actionQueue.items.map(publicAdminActionQueueItem),
    };
  }));

  app.get("/api/science/studies", route(async (request) => {
    const query = Page.extend({
      status: z.enum(["active", "archived"]).optional(),
    }).parse(request.query);
    return service.listStudies({
      status: query.status,
      page: { offset: query.offset, limit: query.limit },
    });
  }));

  app.post("/api/science/studies", route(async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().max(20_000).optional(),
      classification: z.literal("non_regulated").optional(),
      workshopProjectId: Uuid.nullable().optional(),
    }).strict().parse(request.body);
    const study = await service.createStudy({ ...body, actorId: actor(request) });
    return reply.code(201).send({ study });
  }));

  app.get("/api/science/studies/:studyId", route(async (request) => {
    const { studyId } = z.object({ studyId: Uuid }).parse(request.params);
    return { study: await service.getStudy(studyId) };
  }));

  app.patch("/api/science/studies/:studyId", route(async (request) => {
    const { studyId } = z.object({ studyId: Uuid }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(20_000).optional(),
      workshopProjectId: Uuid.nullable().optional(),
      status: z.enum(["active", "archived"]).optional(),
      archive: z.boolean().optional(),
      classification: z.literal("non_regulated").optional(),
    }).strict().refine((value) => Object.keys(value).length > 0, {
      message: "at least one study field is required",
    }).parse(request.body);
    if (body.status === "active") {
      const current = await service.getStudy(studyId);
      if (current.status === "archived") {
        throw new ScienceConflictError("archived science studies cannot be reactivated");
      }
    }
    const study = await service.updateStudy({
      studyId,
      name: body.name,
      description: body.description,
      workshopProjectId: body.workshopProjectId,
      archive: body.archive === true || body.status === "archived",
      actorId: actor(request),
    });
    return { study };
  }));

  app.get("/api/science/studies/:studyId/artifacts", route(async (request) => {
    const { studyId } = z.object({ studyId: Uuid }).parse(request.params);
    const query = Page.extend({
      status: z.enum(["active", "archived"]).optional(),
    }).parse(request.query);
    const page = await service.listArtifacts({
      studyId,
      status: query.status,
      page: { offset: query.offset, limit: query.limit },
    });
    return {
      ...page,
      items: page.items.map((artifact) => ({
        ...artifact,
        latestVersion: artifact.latestVersion
          ? publicVersion(artifact.latestVersion)
          : null,
      })),
    };
  }));

  app.post("/api/science/studies/:studyId/artifacts", route(async (request, reply) => {
    const { studyId } = z.object({ studyId: Uuid }).parse(request.params);
    const body = z.object({
      logicalName: z.string().trim().min(1).max(300),
      kind: ScienceArtifactKind,
      format: z.string().trim().min(1).max(100),
    }).strict().parse(request.body);
    const artifact = await service.createArtifact({
      studyId,
      ...body,
      actorId: actor(request),
    });
    return reply.code(201).send({ artifact });
  }));

  app.get("/api/science/artifacts/:artifactId/versions", route(async (request) => {
    const { artifactId } = z.object({ artifactId: Uuid }).parse(request.params);
    const query = Page.parse(request.query);
    const inspected = await service.inspectArtifact({
      artifactId,
      page: { offset: query.offset, limit: query.limit },
    });
    return {
      ...inspected.versions,
      items: inspected.versions.items.map(publicVersion),
    };
  }));

  app.post("/api/science/artifacts/:artifactId/uploads", route(async (request, reply) => {
    const { artifactId } = z.object({ artifactId: Uuid }).parse(request.params);
    const body = z.object({
      expectedSizeBytes: z.number().int().nonnegative().safe(),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
      filename: z.string().trim().min(1).max(500).optional(),
      mediaType: z.string().trim().min(1).max(255).optional(),
    }).strict().parse(request.body);
    const result = await service.beginUpload({
      artifactId,
      expectedSizeBytes: body.expectedSizeBytes,
      expectedSha256: body.expectedSha256,
      actorId: actor(request),
    });
    return reply.code(201).send({
      uploadToken: result.uploadToken,
      uploadUrl: result.uploadUrl,
      expiresAt: result.expiresAt,
      upload: publicUpload(result.upload),
    });
  }));

  app.put("/api/science/uploads/:uploadToken", route(async (request) => {
    const { uploadToken } = z.object({
      uploadToken: z.string().min(32).max(256),
    }).parse(request.params);
    const body = request.body;
    if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
      throw new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "application/octet-stream body is required",
      }]);
    }
    const upload = await service.writeUpload(
      uploadToken,
      body as AsyncIterable<Uint8Array>,
      actor(request),
    );
    return { ok: true, upload: upload ? publicUpload(upload) : null };
  }));

  app.post("/api/science/uploads/:uploadToken/complete", route(async (request) => {
    const { uploadToken } = z.object({
      uploadToken: z.string().min(32).max(256),
    }).parse(request.params);
    const body = z.object({
      mediaType: z.string().trim().min(1).max(255).default("application/octet-stream"),
      metadata: z.record(z.unknown()).optional(),
      parentVersionId: Uuid.nullable().optional(),
    }).strict().parse(request.body ?? {});
    const result = await service.completeUpload({
      uploadToken,
      ...body,
      actorId: actor(request),
    });
    return publicVersion(result.version);
  }));

  app.get("/api/science/artifact-versions/:versionId", route(async (request) => {
    const { versionId } = z.object({ versionId: Uuid }).parse(request.params);
    return { artifactVersion: publicVersion(await service.getArtifactVersion(versionId)) };
  }));

  app.delete("/api/science/artifact-versions/:versionId", route(async (request) => {
    const { versionId } = z.object({ versionId: Uuid }).parse(request.params);
    const body = z.object({
      confirmSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict().parse(request.body);
    const expired = await service.expireArtifactVersion({
      versionId,
      confirmSha256: body.confirmSha256,
      actorId: actor(request),
    });
    return { ok: true, artifactVersion: expired };
  }));

  app.get("/api/science/artifact-versions/:versionId/content", route(async (request, reply) => {
    const { versionId } = z.object({ versionId: Uuid }).parse(request.params);
    const query = z.object({
      audience: z.string().min(1).max(300).optional(),
      expires: z.string().regex(/^\d+$/).optional(),
      sig: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    }).strict().parse(request.query);
    const hasSigned = Boolean(query.audience && query.expires && query.sig);
    if (!hasSigned && !request.authUser) {
      return reply.code(401).send({ error: "authentication required" });
    }
    const version = await service.getArtifactVersion(versionId);
    let range;
    try {
      range = parseSingleRange(request.headers.range, version.sizeBytes);
    } catch (error) {
      if (error instanceof ScienceConflictError) {
        reply.header("content-range", `bytes */${version.sizeBytes}`);
        return reply.code(416).send({ error: error.message });
      }
      throw error;
    }
    const opened = await service.openArtifactVersion({
      versionId,
      range,
      signed: hasSigned
        ? {
            audience: query.audience!,
            expires: query.expires!,
            signature: query.sig!,
          }
        : undefined,
    });
    const safeInline = isSafeInlineArtifactMediaType(opened.version.mediaType);
    reply
      .header("accept-ranges", "bytes")
      .header("content-type", opened.version.mediaType)
      .header("etag", `"sha256-${opened.version.sha256}"`)
      .header("cache-control", hasSigned ? "private, max-age=60" : "private, no-store")
      .header("x-content-type-options", "nosniff");
    if (!safeInline) {
      reply
        .header(
          "content-disposition",
          `attachment; filename="science-artifact-${opened.version.id}"`,
        )
        .header(
          "content-security-policy",
          "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
    }
    if (opened.read.range) {
      const length = opened.read.range.end - opened.read.range.start + 1;
      reply
        .code(206)
        .header("content-length", String(length))
        .header(
          "content-range",
          `bytes ${opened.read.range.start}-${opened.read.range.end}/${opened.read.size}`,
        );
    } else {
      reply.header("content-length", String(opened.read.size));
    }
    return reply.send(opened.read.body);
  }));

  app.get("/api/science/compute-profiles", route(async (request) => {
    const query = Page.extend({
      enabled: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    }).parse(request.query);
    const page = await service.listComputeProfiles({
      enabled: query.enabled,
      page: { offset: query.offset, limit: query.limit },
    });
    return { ...page, items: page.items.map(publicProfile) };
  }));

  app.post("/api/science/compute-profiles", route(async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(200),
      providerKind: z.enum(["local_container", "jupyter_enterprise_gateway"]),
      imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      kernelName: z.string().trim().min(1).max(200),
      resourceBounds: ResourceRequest,
      config: z.record(z.unknown()).optional(),
      enabled: z.boolean().optional(),
      availability: z.unknown().optional(),
      measuredEstimate: z.unknown().optional(),
    }).strict().parse(request.body);
    const { availability: _availability, measuredEstimate: _estimate, ...input } = body;
    const profile = await service.createComputeProfile({
      ...input,
      resourceBounds: ScienceResourceBounds.parse(input.resourceBounds),
      actorId: actor(request),
    });
    return reply.code(201).send({ profile: publicProfile(profile) });
  }));

  app.patch("/api/science/compute-profiles/:profileId", route(async (request) => {
    const { profileId } = z.object({ profileId: Uuid }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      providerKind: z.enum(["local_container", "jupyter_enterprise_gateway"]).optional(),
      imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
      kernelName: z.string().trim().min(1).max(200).optional(),
      resourceBounds: ResourceRequest.optional(),
      config: z.record(z.unknown()).optional(),
      enabled: z.boolean().optional(),
      availability: z.unknown().optional(),
      measuredEstimate: z.unknown().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0, {
      message: "at least one profile field is required",
    }).parse(request.body);
    const { availability: _availability, measuredEstimate: _estimate, ...input } = body;
    const profile = await service.updateComputeProfile({
      profileId,
      ...input,
      resourceBounds: input.resourceBounds
        ? ScienceResourceBounds.parse(input.resourceBounds)
        : undefined,
      actorId: actor(request),
    });
    return { profile: publicProfile(profile) };
  }));

  app.get("/api/science/studies/:studyId/runs", route(async (request) => {
    const { studyId } = z.object({ studyId: Uuid }).parse(request.params);
    const query = Page.extend({ state: ScienceRunState.optional() }).parse(request.query);
    const page = await service.listRuns({
      studyId,
      state: query.state,
      page: { offset: query.offset, limit: query.limit },
    });
    return { ...page, items: page.items.map(publicRun) };
  }));

  app.post("/api/science/studies/:studyId/runs", route(async (request, reply) => {
    const { studyId } = z.object({ studyId: Uuid }).parse(request.params);
    const body = z.object({
      computeProfileId: Uuid,
      resourceRequest: ResourceRequest,
      inputs: z.array(RunArtifactInput).min(1).max(200),
      parameters: z.record(z.unknown()).optional(),
      idempotencyKey: z.string().trim().min(1).max(200),
    }).strict().parse(request.body);
    const result = await service.submitRun({
      studyId,
      ...body,
      resourceRequest: ScienceResourceBounds.parse(body.resourceRequest),
      actorId: actor(request),
    });
    return reply.code(result.created ? 201 : 200).send({
      run: publicRun(result.run),
      missionId: result.mission.id,
      approvalId: result.approval.id,
      created: result.created,
    });
  }));

  app.get("/api/science/runs/:runId", route(async (request) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const query = z.object({
      eventLimit: z.coerce.number().int().min(1).max(100).optional(),
    }).passthrough().parse(request.query);
    return {
      run: flattenRunDossier(
        await service.getRunDossier(runId, query.eventLimit ?? 50),
      ),
    };
  }));

  app.post("/api/science/runs/:runId/cancel", route(async (request) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const body = z.object({
      generation: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(1_000).optional(),
    }).strict().parse(request.body);
    const result = await service.cancelRun({
      runId,
      expectedGeneration: body.generation,
      actorId: actor(request),
      reason: body.reason,
    });
    return { run: publicRun(result.run), accepted: result.accepted };
  }));

  app.get("/api/science/runs/:runId/manifest", route(async (request, reply) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const result = await service.getManifest(runId);
    if (!result.manifest) {
      return reply.code(404).send({
        error: "science manifest is not available",
        ...result,
      });
    }
    return {
      ...result,
      manifest: result.manifest
        ? {
            ...result.manifest,
            compute: {
              ...result.manifest.compute,
              config: publicProfileConfig(result.manifest.compute.config),
            },
          }
        : null,
    };
  }));

  app.get("/api/science/runs/:runId/validations", route(async (request) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const query = ValidationPage.parse(request.query);
    const validations = await service.listDomainValidations(runId, {
      offset: query.offset,
      limit: query.limit,
    });
    return {
      ...validations,
      items: validations.items.map(publicDomainValidationSummary),
    };
  }));

  app.get("/api/science/runs/:runId/validations/:validationId", route(async (request) => {
    const { runId, validationId } = z.object({
      runId: Uuid,
      validationId: Uuid,
    }).strict().parse(request.params);
    return {
      validation: publicDomainValidationDetail(
        await service.getDomainValidation(runId, validationId),
      ),
    };
  }));

  app.post("/api/science/runs/:runId/validations", route(async (request, reply) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const reviewer = request.authUser;
    if (!reviewer || (reviewer.role !== "admin" && reviewer.role !== "owner")) {
      return reply.code(403).send({ error: "requires admin role" });
    }
    const body = ScienceDomainValidationSubmission.parse(request.body);
    const validation = await service.recordDomainValidation({
      runId,
      ...body,
      reviewerId: reviewer.id,
      reviewerRole: reviewer.role,
    });
    return reply.code(201).send({
      validation: publicDomainValidationDetail(validation),
    });
  }));

  app.get("/api/science/runs/:runId/comparison", route(async (request) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const { candidateRunId } = z.object({
      candidateRunId: Uuid,
    }).strict().parse(request.query);
    return service.compareRuns(runId, candidateRunId);
  }));

  app.post("/api/science/runs/:runId/reproduce", route(async (request, reply) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const body = z.object({
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      candidateRunId: Uuid.optional(),
    }).strict().refine((value) => Boolean(value.candidateRunId || value.idempotencyKey), {
      message: "idempotencyKey is required when creating a reproduction",
    }).parse(request.body ?? {});
    if (body.candidateRunId) {
      return service.compareRuns(runId, body.candidateRunId);
    }
    const result = await service.reproduceRun({
      runId,
      idempotencyKey: body.idempotencyKey!,
      actorId: actor(request),
    });
    return reply.code(result.created ? 201 : 200).send({
      sourceRunId: result.sourceRunId,
      run: publicRun(result.run),
      missionId: result.mission.id,
      approvalId: result.approval.id,
      created: result.created,
    });
  }));

  app.post("/api/science/runs/:runId/render-sessions", route(async (request, reply) => {
    const { runId } = z.object({ runId: Uuid }).parse(request.params);
    const body = z.object({
      artifactVersionId: Uuid,
      mode: z.enum(["client", "remote", "static"]),
      idempotencyKey: z.string().trim().min(1).max(200),
    }).strict().parse(request.body ?? {});
    const result = await service.createRender({
      runId,
      artifactVersionId: body.artifactVersionId,
      mode: body.mode,
      idempotencyKey: body.idempotencyKey,
      actorId: actor(request),
    });
    return reply.code(result.created ? 201 : result.session.state === "starting" ? 202 : 200).send({
      session: publicRender(result.session),
      renderUrl: result.url,
      mode: result.mode,
      provider: result.provider,
      source: result.source,
      created: result.created,
      expiresAt: result.expiresAt,
    });
  }));

  app.post("/api/science/render-sessions/:id/renew", route(async (request) => {
    const { id } = z.object({ id: Uuid }).parse(request.params);
    const session = await service.renewRender({
      sessionId: id,
      actorId: actor(request),
    });
    return {
      session: publicRender(session),
      renderUrl: `/api/science/render-sessions/${session.id}/gateway`,
    };
  }));

  app.delete("/api/science/render-sessions/:id", route(async (request) => {
    const { id } = z.object({ id: Uuid }).parse(request.params);
    const session = await service.closeRender({
      sessionId: id,
      actorId: actor(request),
    });
    return { ok: true, session: publicRender(session) };
  }));

  const renderGateway: Handler = route(async (request, reply) => {
    const params = z.object({
      id: Uuid,
      "*": z.string().max(2_000).optional(),
    }).passthrough().parse(request.params);
    const gateway = await service.renderGateway(params.id, actor(request));
    const suffix = params["*"] ?? "";
    if (gateway.mode === "static") {
      if (suffix) throw new ScienceNotFoundError("static render resource not found");
      return reply
        .header("cache-control", "private, no-store")
        .redirect(gateway.upstreamUrl);
    }
    const upstream = resolveRenderGatewayUpstream(gateway.upstreamUrl, suffix);
    const headers = new Headers();
    headers.set("authorization", gateway.authorization!);
    headers.set("accept", request.headers.accept ?? "*/*");
    if (request.headers.range) headers.set("range", request.headers.range);
    const response = await fetch(upstream, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ScienceConflictError("remote renderer attempted an unsupported redirect");
    }
    reply
      .code(response.status)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header(
        "content-security-policy",
        "sandbox allow-scripts allow-pointer-lock; default-src 'self' data: blob:; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      )
      .header("referrer-policy", "no-referrer");
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }
    if (!response.body) return reply.send();
    return reply.send(Readable.fromWeb(response.body as never));
  });
  app.get("/api/science/render-sessions/:id/gateway", renderGateway);
  app.get("/api/science/render-sessions/:id/gateway/*", renderGateway);
}
