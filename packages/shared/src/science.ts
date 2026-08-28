import { z } from "zod";

/** Science Operations v1 accepts non-regulated research data only. */
export const ScienceDataClassification = z.enum(["non_regulated"]);
export type ScienceDataClassification = z.infer<typeof ScienceDataClassification>;

export const ScienceStudyStatus = z.enum(["active", "archived"]);
export type ScienceStudyStatus = z.infer<typeof ScienceStudyStatus>;

export const ScienceArtifactKind = z.enum([
  "dataset",
  "notebook",
  "geometry",
  "result",
  "log",
  "manifest",
  "environment",
  "other",
]);
export type ScienceArtifactKind = z.infer<typeof ScienceArtifactKind>;

export const ScienceArtifactStatus = z.enum(["active", "archived"]);
export type ScienceArtifactStatus = z.infer<typeof ScienceArtifactStatus>;

export const ScienceArtifactVersionStatus = z.enum([
  "pending",
  "ready",
  "quarantined",
  "expired",
]);
export type ScienceArtifactVersionStatus = z.infer<typeof ScienceArtifactVersionStatus>;

export const ScienceUploadState = z.enum([
  "pending",
  "uploading",
  "finalizing",
  "completed",
  "quarantined",
  "expired",
]);
export type ScienceUploadState = z.infer<typeof ScienceUploadState>;

export const ScienceComputeProviderKind = z.enum([
  "local_container",
  "jupyter_enterprise_gateway",
]);
export type ScienceComputeProviderKind = z.infer<typeof ScienceComputeProviderKind>;

export const ScienceRunState = z.enum([
  "draft",
  "awaiting_approval",
  "queued",
  "provisioning",
  "running",
  "finalizing",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ScienceRunState = z.infer<typeof ScienceRunState>;

export const SCIENCE_TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled"] as const;

export const SCIENCE_RUN_TRANSITIONS = {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "cancelled"],
  queued: ["provisioning", "cancelling", "failed"],
  provisioning: ["running", "cancelling", "failed"],
  running: ["finalizing", "cancelling", "failed"],
  finalizing: ["succeeded", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<ScienceRunState, readonly ScienceRunState[]>;

export function canTransitionScienceRun(from: ScienceRunState, to: ScienceRunState): boolean {
  return (SCIENCE_RUN_TRANSITIONS[from] as readonly ScienceRunState[]).includes(to);
}

export const ScienceRunArtifactDirection = z.enum(["input", "output"]);
export type ScienceRunArtifactDirection = z.infer<typeof ScienceRunArtifactDirection>;

export const ScienceRenderSessionState = z.enum([
  "starting",
  "ready",
  "expired",
  "failed",
  "revoked",
]);
export type ScienceRenderSessionState = z.infer<typeof ScienceRenderSessionState>;

export const ScienceEventName = z.enum([
  "science.study.created",
  "science.artifact.uploaded",
  "science.artifact.ready",
  "science.artifact.quarantined",
  "science.run.awaiting_approval",
  "science.run.queued",
  "science.run.provisioning",
  "science.run.submit_attempted",
  "science.run.started",
  "science.run.progress",
  "science.run.log",
  "science.run.finalizing",
  "science.run.succeeded",
  "science.run.failed",
  "science.run.cancelling",
  "science.run.cancelled",
  "science.render.starting",
  "science.render.ready",
  "science.render.heartbeat",
  "science.render.expired",
  "science.render.failed",
]);
export type ScienceEventName = z.infer<typeof ScienceEventName>;

export const ScienceRunEventType = z.enum([
  "science.run.awaiting_approval",
  "science.run.queued",
  "science.run.provisioning",
  "science.run.submit_attempted",
  "science.run.started",
  "science.run.progress",
  "science.run.log",
  "science.run.finalizing",
  "science.run.succeeded",
  "science.run.failed",
  "science.run.cancelling",
  "science.run.cancelled",
]);
export type ScienceRunEventType = z.infer<typeof ScienceRunEventType>;

export const ScienceSha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 digest");
export type ScienceSha256 = z.infer<typeof ScienceSha256>;

export const ScienceOciDigest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected an immutable sha256 OCI digest");
export type ScienceOciDigest = z.infer<typeof ScienceOciDigest>;

export const SciencePageInput = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
});
export type SciencePageInput = z.input<typeof SciencePageInput>;

export interface SciencePage<T> {
  items: T[];
  nextOffset: number | null;
}

export const ScienceAdminActionKind = z.enum([
  "run",
  "upload_reservation",
  "artifact_version",
  "render_session",
]);
export type ScienceAdminActionKind = z.infer<typeof ScienceAdminActionKind>;

export const ScienceAdminActionReason = z.enum([
  "compute_reconciliation_required",
  "upload_quarantined",
  "upload_cleanup_retry_pending",
  "artifact_version_quarantined",
  "artifact_version_cleanup_retry_pending",
  "render_session_cleanup_pending",
]);
export type ScienceAdminActionReason = z.infer<typeof ScienceAdminActionReason>;

export const ScienceAdminActionLink = z.object({
  rel: z.enum(["study", "run", "artifact_versions", "artifact_version"]),
  href: z.string().trim().min(1).max(500).regex(/^\/api\/science\//),
}).strict();
export type ScienceAdminActionLink = z.infer<typeof ScienceAdminActionLink>;

/**
 * Deliberately redacted operator projection. Repository-only storage/provider
 * identities and raw failure text are not part of this public contract.
 */
export const ScienceAdminActionQueueItem = z.object({
  id: z.string().uuid(),
  kind: ScienceAdminActionKind,
  state: z.string().trim().min(1).max(64),
  ageSeconds: z.number().int().nonnegative().safe(),
  attempts: z.number().int().nonnegative().safe(),
  nextRetryAt: z.string().datetime().nullable(),
  reason: ScienceAdminActionReason,
  links: z.array(ScienceAdminActionLink).max(4),
}).strict();
export type ScienceAdminActionQueueItem = z.infer<typeof ScienceAdminActionQueueItem>;

/** Persisted, workspace-scoped admission for the opt-in Science pilot. */
export const ScienceWorkspaceAdmission = z.object({
  id: z.string().uuid().nullable().default(null),
  workspaceId: z.string().uuid(),
  admitted: z.boolean(),
  updatedBy: z.string().uuid().nullable().default(null),
  updatedAt: z.coerce.date().nullable().default(null),
});
export type ScienceWorkspaceAdmission = z.infer<typeof ScienceWorkspaceAdmission>;


export const ScienceResourceBounds = z.object({
  cpuMillicores: z.number().int().positive().max(1_000_000),
  memoryMb: z.number().int().positive().max(16_777_216),
  gpuCount: z.number().int().nonnegative().max(64).default(0),
  wallTimeSeconds: z.number().int().positive().max(31_536_000),
});
export type ScienceResourceBounds = z.infer<typeof ScienceResourceBounds>;

export const ScienceStudy = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(""),
  status: ScienceStudyStatus,
  classification: ScienceDataClassification,
  workshopProjectId: z.string().uuid().nullable().default(null),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ScienceStudy = z.infer<typeof ScienceStudy>;

export const ScienceArtifact = z.object({
  id: z.string().uuid(),
  studyId: z.string().uuid(),
  logicalName: z.string().trim().min(1).max(300),
  kind: ScienceArtifactKind,
  format: z.string().trim().min(1).max(100),
  status: ScienceArtifactStatus,
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ScienceArtifact = z.infer<typeof ScienceArtifact>;

export const ScienceArtifactVersion = z.object({
  id: z.string().uuid(),
  artifactId: z.string().uuid(),
  version: z.number().int().positive(),
  status: ScienceArtifactVersionStatus,
  storageKey: z.string().trim().min(1).max(2_000),
  sha256: ScienceSha256,
  sizeBytes: z.number().int().nonnegative().safe(),
  mediaType: z.string().trim().min(1).max(255),
  metadata: z.record(z.unknown()).default({}),
  cleanupEligible: z.boolean().default(false),
  cleanupAttempts: z.number().int().nonnegative().default(0),
  cleanupNotBefore: z.coerce.date().nullable().default(null),
  parentVersionId: z.string().uuid().nullable().default(null),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  readyAt: z.coerce.date().nullable().default(null),
});
export type ScienceArtifactVersion = z.infer<typeof ScienceArtifactVersion>;

export const ScienceUpload = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  artifactId: z.string().uuid(),
  artifactVersionId: z.string().uuid().nullable().default(null),
  tokenHash: ScienceSha256,
  expectedSizeBytes: z.number().int().nonnegative().safe(),
  expectedSha256: ScienceSha256,
  quarantineKey: z.string().trim().min(1).max(2_000),
  receivedBytes: z.number().int().nonnegative().safe(),
  state: ScienceUploadState,
  error: z.string().max(4_000).nullable().default(null),
  cleanupAttempts: z.number().int().nonnegative().default(0),
  cleanupNotBefore: z.coerce.date().nullable().default(null),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable().default(null),
});
export type ScienceUpload = z.infer<typeof ScienceUpload>;

export const ScienceComputeProfile = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  providerKind: ScienceComputeProviderKind,
  imageDigest: ScienceOciDigest,
  kernelName: z.string().trim().min(1).max(200),
  resourceBounds: ScienceResourceBounds,
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ScienceComputeProfile = z.infer<typeof ScienceComputeProfile>;

export const ScienceComputeSnapshot = z.object({
  profileId: z.string().uuid(),
  providerKind: ScienceComputeProviderKind,
  imageDigest: ScienceOciDigest,
  kernelName: z.string().trim().min(1).max(200),
  resourceBounds: ScienceResourceBounds,
  config: z.record(z.unknown()).default({}),
});
export type ScienceComputeSnapshot = z.infer<typeof ScienceComputeSnapshot>;

const ScienceManifestArtifactRef = z.object({
  artifactVersionId: z.string().uuid(),
  sha256: ScienceSha256,
  sizeBytes: z.number().int().nonnegative().safe(),
  semanticRole: z.string().trim().min(1).max(128),
});

const ScienceManifestHistoryEntry = z.object({
  event: z.string().trim().min(1).max(200),
  at: z.string().datetime(),
  generation: z.number().int().nonnegative(),
  detail: z.record(z.unknown()).default({}),
});

export const ScienceManifest = z
  .object({
    schemaVersion: z.literal(1),
    studyId: z.string().uuid(),
    runId: z.string().uuid(),
    missionId: z.string().uuid(),
    inputs: z.array(ScienceManifestArtifactRef),
    outputs: z.array(ScienceManifestArtifactRef),
    codeArtifactVersionId: z.string().uuid().nullable().default(null),
    sourceRevision: z.string().max(500).nullable().default(null),
    compute: ScienceComputeSnapshot.extend({
      requestedResources: ScienceResourceBounds,
      adapterVersion: z.string().trim().min(1).max(200),
      dependencyLock: z.record(z.unknown()).default({}),
    }),
    parameters: z.record(z.unknown()).default({}),
    units: z.record(z.string()).default({}),
    randomSeeds: z.record(z.number().int()).default({}),
    environment: z.record(z.string()).default({}),
    actorId: z.string().uuid(),
    approvalIds: z.array(z.string().uuid()).default([]),
    policyIds: z.array(z.string().uuid()).default([]),
    toolCalls: z.array(z.string().trim().min(1).max(300)).default([]),
    startedAt: z.string().datetime().nullable().default(null),
    finishedAt: z.string().datetime(),
    history: z.array(ScienceManifestHistoryEntry).default([]),
    validations: z.array(z.record(z.unknown())).default([]),
    limitations: z.array(z.string().trim().min(1).max(2_000)).default([]),
    complete: z.boolean(),
    gaps: z.array(z.string().trim().min(1).max(500)).default([]),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.complete && manifest.gaps.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gaps"], message: "a complete manifest cannot have gaps" });
    }
    if (!manifest.complete && manifest.gaps.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gaps"], message: "an incomplete manifest must name at least one gap" });
    }
  });
export type ScienceManifest = z.infer<typeof ScienceManifest>;

type CanonicalScienceJson =
  | null
  | boolean
  | number
  | string
  | CanonicalScienceJson[]
  | { [key: string]: CanonicalScienceJson };

function canonicalizeScienceJson(
  value: unknown,
  seen: Set<object>,
): CanonicalScienceJson {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("science JSON contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("science JSON contains a cycle");
    seen.add(value);
    const output = value.map((entry) => canonicalizeScienceJson(entry, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("science JSON contains a cycle");
    seen.add(value);
    const source = value as Record<string, unknown>;
    const output: Record<string, CanonicalScienceJson> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      // Match JSON object storage semantics while refusing values that JSON
      // would stringify inconsistently or cannot represent at all.
      if (entry === undefined) continue;
      if (typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol") {
        throw new Error(`science JSON field ${key} is not serializable`);
      }
      output[key] = canonicalizeScienceJson(entry, seen);
    }
    seen.delete(value);
    return output;
  }
  throw new Error("science JSON contains a value that is not serializable");
}

/**
 * Canonical JSON serialization used for immutable Science hashes and exact
 * comparisons. Keep hashing in the Node-owned boundary, but always hash these
 * bytes so repositories and the kernel cannot drift in their serialization.
 */
export function canonicalScienceJson(value: unknown): string {
  return JSON.stringify(canonicalizeScienceJson(value, new Set()));
}

export interface ScienceManifestAssessment {
  complete: boolean;
  gaps: string[];
}

function requiredManifestString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  gaps: string[],
): void {
  if (typeof object[key] !== "string" || !(object[key] as string).trim()) {
    gaps.push(`${path}.${key}`);
  }
}

function requiredManifestArray(
  object: Record<string, unknown>,
  key: string,
  path: string,
  gaps: string[],
): unknown[] {
  if (!Array.isArray(object[key])) {
    gaps.push(`${path}.${key}`);
    return [];
  }
  return object[key] as unknown[];
}

/**
 * Pure structural completeness assessment. Declared gaps are monotonic trust
 * evidence: a later read may discover more gaps, but it must never erase a
 * limitation that was recorded when the immutable manifest was created.
 */
export function assessScienceManifest(value: unknown): ScienceManifestAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { complete: false, gaps: ["manifest"] };
  }
  const manifest = value as Record<string, unknown>;
  const gaps = Array.isArray(manifest.gaps)
    ? manifest.gaps.filter(
      (gap): gap is string => typeof gap === "string" && gap.trim().length > 0,
    )
    : [];
  if (manifest.schemaVersion !== 1) gaps.push("manifest.schemaVersion");
  requiredManifestString(manifest, "studyId", "manifest", gaps);
  requiredManifestString(manifest, "runId", "manifest", gaps);
  requiredManifestString(manifest, "missionId", "manifest", gaps);
  requiredManifestString(manifest, "finishedAt", "manifest", gaps);
  requiredManifestString(manifest, "actorId", "manifest", gaps);
  if (!manifest.compute || typeof manifest.compute !== "object" || Array.isArray(manifest.compute)) {
    gaps.push("manifest.compute");
  } else {
    const compute = manifest.compute as Record<string, unknown>;
    requiredManifestString(compute, "profileId", "manifest.compute", gaps);
    requiredManifestString(compute, "providerKind", "manifest.compute", gaps);
    requiredManifestString(compute, "imageDigest", "manifest.compute", gaps);
    requiredManifestString(compute, "kernelName", "manifest.compute", gaps);
    requiredManifestString(compute, "adapterVersion", "manifest.compute", gaps);
    if (!compute.resourceBounds || typeof compute.resourceBounds !== "object") {
      gaps.push("manifest.compute.resourceBounds");
    }
    if (!compute.requestedResources || typeof compute.requestedResources !== "object") {
      gaps.push("manifest.compute.requestedResources");
    }
    if (!compute.dependencyLock || typeof compute.dependencyLock !== "object" ||
        Array.isArray(compute.dependencyLock)) {
      gaps.push("manifest.compute.dependencyLock");
    } else if (Object.keys(compute.dependencyLock as Record<string, unknown>).length === 0) {
      gaps.push("manifest.compute.dependencyLock");
    }
  }
  if (!manifest.parameters || typeof manifest.parameters !== "object" ||
      Array.isArray(manifest.parameters)) {
    gaps.push("manifest.parameters");
  }
  const approvals = Array.isArray(manifest.approvalIds) ? manifest.approvalIds : [];
  const policies = Array.isArray(manifest.policyIds) ? manifest.policyIds : [];
  if (approvals.length === 0 && policies.length === 0) {
    gaps.push("manifest.approvalIds|policyIds");
  }
  if (!Array.isArray(manifest.validations) || manifest.validations.length === 0) {
    gaps.push("manifest.validations");
  }
  if (!Array.isArray(manifest.limitations)) gaps.push("manifest.limitations");

  const inputs = requiredManifestArray(manifest, "inputs", "manifest", gaps);
  const outputs = requiredManifestArray(manifest, "outputs", "manifest", gaps);
  if (inputs.length === 0) gaps.push("manifest.inputs[0]");
  if (outputs.length === 0) gaps.push("manifest.outputs[0]");
  const codeArtifactVersionId =
    typeof manifest.codeArtifactVersionId === "string" && manifest.codeArtifactVersionId
      ? manifest.codeArtifactVersionId
      : null;
  const hasLinkedCodeInput = codeArtifactVersionId !== null && inputs.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const artifact = entry as Record<string, unknown>;
    return artifact.artifactVersionId === codeArtifactVersionId &&
      ["code", "notebook", "solver"].includes(String(artifact.semanticRole ?? ""));
  });
  if (!codeArtifactVersionId) {
    gaps.push("manifest.codeArtifactVersionId");
  } else if (!hasLinkedCodeInput) {
    gaps.push("manifest.codeArtifactVersionId.unlinked");
  }
  const parameters =
    manifest.parameters && typeof manifest.parameters === "object" &&
      !Array.isArray(manifest.parameters)
      ? manifest.parameters as Record<string, unknown>
      : null;
  const hasDeclaredSourceRevision =
    parameters !== null &&
    Object.prototype.hasOwnProperty.call(parameters, "sourceRevision") &&
    parameters.sourceRevision !== null &&
    parameters.sourceRevision !== undefined;
  if (
    (manifest.sourceRevision !== null && manifest.sourceRevision !== undefined) ||
    (!hasLinkedCodeInput && hasDeclaredSourceRevision)
  ) {
    gaps.push("manifest.sourceRevision.unverified");
  }
  for (const [collection, rows] of [["inputs", inputs], ["outputs", outputs]] as const) {
    rows.forEach((entry, index) => {
      const path = `manifest.${collection}[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        gaps.push(path);
        return;
      }
      const artifact = entry as Record<string, unknown>;
      requiredManifestString(artifact, "artifactVersionId", path, gaps);
      requiredManifestString(artifact, "sha256", path, gaps);
      requiredManifestString(artifact, "semanticRole", path, gaps);
      if (!Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0) {
        gaps.push(`${path}.sizeBytes`);
      }
    });
  }
  const parsed = ScienceManifest.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      gaps.push(`manifest.${issue.path.join(".")}`);
    }
  }
  const uniqueGaps = [...new Set(gaps)].sort();
  return { complete: uniqueGaps.length === 0, gaps: uniqueGaps };
}

export const ScienceRun = z
  .object({
    id: z.string().uuid(),
    studyId: z.string().uuid(),
    missionId: z.string().uuid(),
    computeProfileId: z.string().uuid(),
    profileSnapshot: ScienceComputeSnapshot,
    resourceRequest: ScienceResourceBounds,
    providerHandle: z.string().trim().min(1).max(500).nullable().default(null),
    leaseOwner: z.string().trim().min(1).max(300).nullable().default(null),
    leaseExpiresAt: z.coerce.date().nullable().default(null),
    heartbeatAt: z.coerce.date().nullable().default(null),
    state: ScienceRunState,
    executionGeneration: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(1).max(200),
    parameters: z.record(z.unknown()).default({}),
    manifest: ScienceManifest.nullable().default(null),
    manifestHash: ScienceSha256.nullable().default(null),
    error: z.string().max(8_000).nullable().default(null),
    createdBy: z.string().uuid(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    startedAt: z.coerce.date().nullable().default(null),
    finishedAt: z.coerce.date().nullable().default(null),
  })
  .superRefine((run, ctx) => {
    if ((run.leaseOwner === null) !== (run.leaseExpiresAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["leaseOwner"],
        message: "science run lease owner and expiry must be set or cleared together",
      });
    }
    if (run.leaseOwner === null && run.heartbeatAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["heartbeatAt"],
        message: "science run heartbeat requires a lease owner",
      });
    }
  });
export type ScienceRun = z.infer<typeof ScienceRun>;

/**
 * Human/domain review is retained outside the immutable run manifest. The
 * manifest hash and output snapshot bind the review to the exact bytes that
 * were inspected without rewriting historical provenance.
 */
export const ScienceDomainValidationKind = z.enum([
  "domain-validation",
  "numerical-equivalence",
]);
export type ScienceDomainValidationKind = z.infer<typeof ScienceDomainValidationKind>;

const ScienceCanonicalValidationUuid = z.string().uuid().transform((value) =>
  value.toLowerCase()
);

export const ScienceValidationOutputChecksum = z.object({
  artifactVersionId: ScienceCanonicalValidationUuid,
  semanticRole: z.string().trim().min(1).max(128),
  sha256: ScienceSha256,
  sizeBytes: z.number().int().nonnegative().safe(),
}).strict();
export type ScienceValidationOutputChecksum = z.infer<
  typeof ScienceValidationOutputChecksum
>;

export const ScienceDomainValidationSubmission = z.object({
  kind: ScienceDomainValidationKind,
  baselineRunId: ScienceCanonicalValidationUuid.nullable().optional(),
  metric: z.string().trim().min(1).max(200),
  tolerance: z.number().finite().nonnegative(),
  observedValue: z.number().finite(),
  units: z.string().trim().min(1).max(100),
  methodProtocolId: z.string().trim().min(1).max(300),
  decision: z.boolean(),
  limitationsReason: z.string().trim().min(1).max(2_000),
}).strict().superRefine((value, ctx) => {
  const hasBaseline = value.baselineRunId !== null && value.baselineRunId !== undefined;
  if (value.kind === "numerical-equivalence" && !hasBaseline) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baselineRunId"],
      message: "numerical-equivalence requires a baseline run",
    });
  }
  if (value.kind === "domain-validation" && hasBaseline) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baselineRunId"],
      message: "domain-validation cannot claim a baseline comparison",
    });
  }
});
export type ScienceDomainValidationSubmission = z.infer<
  typeof ScienceDomainValidationSubmission
>;

export const ScienceDomainValidationRecord = z.object({
  id: ScienceCanonicalValidationUuid,
  workspaceId: ScienceCanonicalValidationUuid,
  runId: ScienceCanonicalValidationUuid,
  revision: z.number().int().positive().safe(),
  baselineRunId: ScienceCanonicalValidationUuid.nullable(),
  kind: ScienceDomainValidationKind,
  metric: z.string().trim().min(1).max(200),
  tolerance: z.number().finite().nonnegative(),
  observedValue: z.number().finite(),
  units: z.string().trim().min(1).max(100),
  methodProtocolId: z.string().trim().min(1).max(300),
  decision: z.boolean(),
  limitationsReason: z.string().trim().min(1).max(2_000),
  reviewerId: ScienceCanonicalValidationUuid,
  reviewerRole: z.enum(["admin", "owner"]),
  runManifestHash: ScienceSha256,
  runOutputChecksums: z.array(ScienceValidationOutputChecksum).min(1).max(2_000),
  baselineManifestHash: ScienceSha256.nullable(),
  baselineOutputChecksums: z.array(ScienceValidationOutputChecksum).max(2_000).nullable(),
  createdAt: z.coerce.date(),
  recordHash: ScienceSha256,
}).strict().superRefine((value, ctx) => {
  const linked = value.baselineRunId !== null;
  if (value.kind === "numerical-equivalence" && !linked) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineRunId"], message: "baseline is required" });
  }
  if (value.kind === "domain-validation" && linked) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineRunId"], message: "baseline is not allowed" });
  }
  if (linked !== (value.baselineManifestHash !== null) ||
      linked !== (value.baselineOutputChecksums !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baselineManifestHash"],
      message: "baseline identity fields must be all present or all absent",
    });
  }
});
export type ScienceDomainValidationRecord = z.infer<
  typeof ScienceDomainValidationRecord
>;

/**
 * Bounded collection projection. Checksum snapshots stay available through
 * the one-record detail endpoint, but are deliberately excluded from pages so
 * one run with many outputs cannot multiply the list response size.
 */
export const ScienceDomainValidationSummary = z.object({
  id: ScienceCanonicalValidationUuid,
  runId: ScienceCanonicalValidationUuid,
  revision: z.number().int().positive().safe(),
  baselineRunId: ScienceCanonicalValidationUuid.nullable(),
  kind: ScienceDomainValidationKind,
  metric: z.string().trim().min(1).max(200),
  tolerance: z.number().finite().nonnegative(),
  observedValue: z.number().finite(),
  units: z.string().trim().min(1).max(100),
  methodProtocolId: z.string().trim().min(1).max(300),
  decision: z.boolean(),
  limitationsReason: z.string().trim().min(1).max(2_000),
  reviewerId: ScienceCanonicalValidationUuid,
  reviewerRole: z.enum(["admin", "owner"]),
  runManifestHash: ScienceSha256,
  baselineManifestHash: ScienceSha256.nullable(),
  createdAt: z.coerce.date(),
  recordHash: ScienceSha256,
}).strict();
export type ScienceDomainValidationSummary = z.infer<
  typeof ScienceDomainValidationSummary
>;

export const ScienceRunArtifact = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  artifactVersionId: z.string().uuid(),
  direction: ScienceRunArtifactDirection,
  semanticRole: z.string().trim().min(1).max(128),
  createdAt: z.coerce.date(),
});
export type ScienceRunArtifact = z.infer<typeof ScienceRunArtifact>;

export const SCIENCE_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;

export const ScienceRunEvent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  studyId: z.string().uuid(),
  runId: z.string().uuid(),
  missionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  eventType: ScienceRunEventType,
  executionGeneration: z.number().int().nonnegative(),
  state: ScienceRunState,
  payload: z.record(z.unknown()).default({}).refine(
    (payload) => {
      try {
        return new TextEncoder().encode(JSON.stringify(payload)).byteLength <= SCIENCE_EVENT_PAYLOAD_MAX_BYTES;
      } catch {
        return false;
      }
    },
    `science event payload exceeds ${SCIENCE_EVENT_PAYLOAD_MAX_BYTES} bytes or is not JSON serializable`,
  ),
  createdAt: z.coerce.date(),
});
export type ScienceRunEvent = z.infer<typeof ScienceRunEvent>;

export const ScienceRenderSession = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid().nullable().default(null),
    artifactVersionId: z.string().uuid().nullable().default(null),
    providerHandle: z.string().trim().min(1).max(500).nullable().default(null),
    requestKeyHash: ScienceSha256,
    intentFingerprint: ScienceSha256,
    providerKind: z.string().trim().regex(/^[a-z0-9_-]{1,80}$/i),
    mode: z.enum(["client", "remote", "static"]),
    sourceSha256: ScienceSha256,
    sourceMediaType: z.string().trim().min(1).max(200),
    sourceSizeBytes: z.number().int().nonnegative(),
    sourceLogicalName: z.string().trim().min(1).max(500),
    tokenHash: ScienceSha256,
    audience: z.string().trim().min(1).max(300),
    state: ScienceRenderSessionState,
    cleanupAttempts: z.number().int().nonnegative().default(0),
    cleanupNotBefore: z.coerce.date().nullable().default(null),
    launchLeaseId: z.string().uuid().nullable().default(null),
    launchLeaseExpiresAt: z.coerce.date().nullable().default(null),
    replayExpiresAt: z.coerce.date(),
    closedAt: z.coerce.date().nullable().default(null),
    ownerId: z.string().uuid(),
    expiresAt: z.coerce.date(),
    heartbeatAt: z.coerce.date().nullable().default(null),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .refine((session) => session.runId !== null || session.artifactVersionId !== null, {
    message: "a render session must reference a run or artifact version",
    path: ["runId"],
  })
  .refine(
    (session) =>
      (session.launchLeaseId === null && session.launchLeaseExpiresAt === null) ||
      (session.launchLeaseId !== null && session.launchLeaseExpiresAt !== null),
    { message: "render launch lease fields must be set or cleared together", path: ["launchLeaseId"] },
  );
export type ScienceRenderSession = z.infer<typeof ScienceRenderSession>;
