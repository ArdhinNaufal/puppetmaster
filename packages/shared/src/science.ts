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

/** Canonical JSON serialization used as the input to the persisted manifest SHA-256. */
export function canonicalScienceJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      const source = input as Record<string, unknown>;
      const target: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) target[key] = normalize(source[key]);
      return target;
    }
    return input;
  };
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) throw new Error("science JSON value is not serializable");
  return encoded;
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
    tokenHash: ScienceSha256,
    audience: z.string().trim().min(1).max(300),
    state: ScienceRenderSessionState,
    cleanupAttempts: z.number().int().nonnegative().default(0),
    cleanupNotBefore: z.coerce.date().nullable().default(null),
    ownerId: z.string().uuid(),
    expiresAt: z.coerce.date(),
    heartbeatAt: z.coerce.date().nullable().default(null),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .refine((session) => session.runId !== null || session.artifactVersionId !== null, {
    message: "a render session must reference a run or artifact version",
    path: ["runId"],
  });
export type ScienceRenderSession = z.infer<typeof ScienceRenderSession>;
