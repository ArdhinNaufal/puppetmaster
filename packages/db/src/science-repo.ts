import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  SCIENCE_TERMINAL_RUN_STATES,
  ScienceAdminActionKind,
  ScienceAdminActionReason,
  ScienceArtifact,
  ScienceArtifactKind,
  ScienceArtifactStatus,
  ScienceArtifactVersion,
  ScienceArtifactVersionStatus,
  ScienceComputeProfile,
  ScienceComputeProviderKind,
  ScienceComputeSnapshot,
  ScienceDomainValidationRecord,
  ScienceDomainValidationSummary,
  ScienceDomainValidationSubmission,
  ScienceManifest,
  ScienceOciDigest,
  SciencePageInput,
  ScienceRenderSession,
  ScienceRenderSessionState,
  ScienceResourceBounds,
  ScienceRun,
  ScienceRunArtifact,
  ScienceRunArtifactDirection,
  ScienceRunEvent,
  ScienceRunEventType,
  ScienceRunState,
  ScienceSha256,
  ScienceStudy,
  ScienceUpload,
  ScienceValidationOutputChecksum,
  ScienceWorkspaceAdmission,
  ScienceUploadState,
  assessScienceManifest,
  canTransitionScienceRun,
  canonicalScienceJson,
  type SciencePage,
} from "@puppetmaster/shared";
import type { Db } from "./client.js";
import { markWorkflowWaitsReadyForScienceRun } from "./durability-repo.js";
import {
  approvals,
  memberships,
  missionSteps,
  missions,
  projects,
  scienceArtifacts,
  scienceArtifactVersions,
  scienceComputeProfiles,
  scienceDomainValidationHeads,
  scienceDomainValidations,
  scienceRenderSessions,
  scienceRunArtifacts,
  scienceRunEvents,
  scienceRuns,
  scienceStudies,
  scienceUploads,
  scienceWorkspaceAdmissions,
  workspaces,
} from "./schema.js";

export type ScienceStudyRow = typeof scienceStudies.$inferSelect;
export type ScienceArtifactRow = typeof scienceArtifacts.$inferSelect;
export type ScienceArtifactVersionRow = typeof scienceArtifactVersions.$inferSelect;
export type ScienceUploadRow = typeof scienceUploads.$inferSelect;
export type ScienceComputeProfileRow = typeof scienceComputeProfiles.$inferSelect;
export type ScienceDomainValidationRow = typeof scienceDomainValidations.$inferSelect;
export type ScienceDomainValidationHeadRow = typeof scienceDomainValidationHeads.$inferSelect;
export type ScienceRunRow = typeof scienceRuns.$inferSelect;
export type ScienceRunArtifactRow = typeof scienceRunArtifacts.$inferSelect;
export type ScienceRunEventRow = typeof scienceRunEvents.$inferSelect;
export type ScienceRenderSessionRow = typeof scienceRenderSessions.$inferSelect;
export type ScienceWorkspaceAdmissionRow = typeof scienceWorkspaceAdmissions.$inferSelect;

export interface ScienceRunSubmitAttempt {
  providerKind: string;
  providerInstanceId: string;
  idempotencyKey: string;
  createdAt: Date;
  sequence: number;
}

export interface ScienceAdminActionQueueRecord {
  id: string;
  kind: ScienceAdminActionKind;
  state: string;
  detectedAt: Date;
  attempts: number;
  nextRetryAt: Date | null;
  reason: ScienceAdminActionReason;
  studyId: string | null;
  runId: string | null;
  artifactId: string | null;
  artifactVersionId: string | null;
}

export class ScienceConflictError extends Error {
  readonly code = "SCIENCE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ScienceConflictError";
  }
}

export type ScienceAuditActorKind = "user" | "agent" | "system";

export interface ScienceAuditContext {
  actorKind: ScienceAuditActorKind;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  reason?: string | null;
}

function conflict(message: string): never {
  throw new ScienceConflictError(message);
}

function normalizeJson(value: unknown, label: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined");
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalScienceJson(left) === canonicalScienceJson(right);
}

function isParsedIpynbArtifactVersion(
  version: Pick<ScienceArtifactVersionRow, "status" | "metadata">,
  artifact: Pick<ScienceArtifactRow, "kind" | "format">,
): boolean {
  const metadata = version.metadata;
  return version.status === "ready" &&
    artifact.kind === "notebook" &&
    artifact.format.trim().toLowerCase().replace(/^\./, "") === "ipynb" &&
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).detectedFormat === "ipynb" &&
    (metadata as Record<string, unknown>).formatValidation === "parsed";
}

function canonicalText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${label} must be between 1 and ${max} characters`);
  }
  return normalized;
}

function optionalCanonicalText(
  value: string | null | undefined,
  label: string,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  return canonicalText(value, label, max);
}

/**
 * Attach actor-rich audit metadata to one database-local mutation. The custom
 * settings are transaction-local and the mutation receives the exact same
 * connection, so the domain trigger records attribution atomically. Callers
 * must not include object-store, provider, scheduler, bus, or audit-sink I/O
 * inside this boundary.
 */
export async function withScienceAuditContext<T>(
  db: Db,
  input: ScienceAuditContext,
  mutation: (scoped: Db) => Promise<T>,
): Promise<T> {
  if (!(["user", "agent", "system"] as const).includes(input.actorKind)) {
    throw new Error("science audit actorKind is invalid");
  }
  const actorId = optionalCanonicalText(input.actorId, "science audit actorId", 300);
  if (input.actorKind !== "system" && !actorId) {
    throw new Error("science audit user and agent actors require an actorId");
  }
  const actorLabel = optionalCanonicalText(
    input.actorLabel,
    "science audit actorLabel",
    200,
  );
  const action = canonicalText(input.action, "science audit action", 200);
  const reason = optionalCanonicalText(input.reason, "science audit reason", 1_000);

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(sql`
      SELECT
        set_config('puppetmaster.science_actor_kind', ${input.actorKind}, true),
        set_config('puppetmaster.science_actor_id', ${actorId ?? ""}, true),
        set_config('puppetmaster.science_actor_label', ${actorLabel ?? ""}, true),
        set_config('puppetmaster.science_action', ${action}, true),
        set_config('puppetmaster.science_reason', ${reason ?? ""}, true)
    `);
    return mutation(scoped);
  });
}

function page(input?: SciencePageInput): { offset: number; limit: number } {
  return SciencePageInput.parse(input ?? {});
}

function paged<T>(rows: T[], offset: number, limit: number): SciencePage<T> {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    nextOffset: hasMore ? offset + limit : null,
  };
}

function parseStudy(row: ScienceStudyRow) {
  return ScienceStudy.parse(row);
}

function parseWorkspaceAdmission(row: ScienceWorkspaceAdmissionRow) {
  return ScienceWorkspaceAdmission.parse(row);
}

/**
 * Missing state is deliberately denied. This lets migration 11 upgrade an
 * existing deployment without silently admitting any workspace.
 */
export async function getScienceWorkspaceAdmission(
  db: Db,
  workspaceId: string,
) {
  const candidate = ScienceWorkspaceAdmission.shape.workspaceId.parse(workspaceId);
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, candidate))
    .limit(1);
  if (!workspace) conflict("Science workspace admission workspace does not exist");
  const [row] = await db
    .select()
    .from(scienceWorkspaceAdmissions)
    .where(eq(scienceWorkspaceAdmissions.workspaceId, candidate))
    .limit(1);
  return row
    ? parseWorkspaceAdmission(row)
    : ScienceWorkspaceAdmission.parse({
        id: null,
        workspaceId: candidate,
        admitted: false,
        updatedBy: null,
        updatedAt: null,
      });
}

/** One row per workspace; callers attach actor/reason context transactionally. */
export async function setScienceWorkspaceAdmission(
  db: Db,
  input: { workspaceId: string; admitted: boolean; updatedBy: string },
) {
  const workspaceId = ScienceWorkspaceAdmission.shape.workspaceId.parse(input.workspaceId);
  const updatedBy = ScienceWorkspaceAdmission.shape.workspaceId.parse(input.updatedBy);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await lockScienceWorkspaceForUpdate(scoped, workspaceId);
    const [existing] = await scoped
      .select({ id: scienceWorkspaceAdmissions.id })
      .from(scienceWorkspaceAdmissions)
      .where(eq(scienceWorkspaceAdmissions.workspaceId, workspaceId))
      .limit(1);
    const now = new Date();
    const [row] = existing
      ? await scoped
          .update(scienceWorkspaceAdmissions)
          .set({ admitted: input.admitted, updatedBy, updatedAt: now })
          .where(eq(scienceWorkspaceAdmissions.id, existing.id))
          .returning()
      : await scoped
          .insert(scienceWorkspaceAdmissions)
          .values({ workspaceId, admitted: input.admitted, updatedBy, updatedAt: now })
          .returning();
    if (!row) throw new Error("Science workspace admission update returned no row");
    return parseWorkspaceAdmission(row);
  });
}

function parseArtifact(row: ScienceArtifactRow) {
  return ScienceArtifact.parse(row);
}

function parseVersion(row: ScienceArtifactVersionRow) {
  return ScienceArtifactVersion.parse(row);
}

function parseUpload(row: ScienceUploadRow) {
  return ScienceUpload.parse(row);
}

function parseProfile(row: ScienceComputeProfileRow) {
  return ScienceComputeProfile.parse(row);
}

function parseDomainValidation(row: ScienceDomainValidationRow) {
  return ScienceDomainValidationRecord.parse(row);
}

function parseDomainValidationSummary(value: unknown) {
  return ScienceDomainValidationSummary.parse(value);
}

function parseRun(row: ScienceRunRow) {
  return ScienceRun.parse(row);
}

function parseRunArtifact(row: ScienceRunArtifactRow) {
  return ScienceRunArtifact.parse(row);
}

function parseRunEvent(row: ScienceRunEventRow) {
  return ScienceRunEvent.parse(row);
}

function parseRenderSession(row: ScienceRenderSessionRow) {
  return ScienceRenderSession.parse(row);
}

interface RawScienceAdminActionQueueRecord {
  id: string;
  kind: string;
  state: string;
  detected_at: Date | string;
  attempts: number | string;
  next_retry_at: Date | string | null;
  reason: string;
  study_id: string | null;
  run_id: string | null;
  artifact_id: string | null;
  artifact_version_id: string | null;
}

function parseAdminActionQueueRecord(
  row: RawScienceAdminActionQueueRecord,
): ScienceAdminActionQueueRecord {
  const detectedAt = row.detected_at instanceof Date
    ? row.detected_at
    : new Date(row.detected_at);
  const nextRetryAt = row.next_retry_at === null
    ? null
    : row.next_retry_at instanceof Date
      ? row.next_retry_at
      : new Date(row.next_retry_at);
  if (Number.isNaN(detectedAt.getTime()) || (nextRetryAt && Number.isNaN(nextRetryAt.getTime()))) {
    throw new Error("Science admin action queue returned an invalid timestamp");
  }
  const attempts = Number(row.attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("Science admin action queue returned an invalid attempt count");
  }
  return {
    id: ScienceWorkspaceAdmission.shape.workspaceId.parse(row.id),
    kind: ScienceAdminActionKind.parse(row.kind),
    state: canonicalText(row.state, "Science admin action state", 64),
    detectedAt,
    attempts,
    nextRetryAt,
    reason: ScienceAdminActionReason.parse(row.reason),
    studyId: row.study_id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
  };
}

/**
 * Workspace-scoped union of durable resources that currently require an
 * administrator's attention. The selected columns are intentionally narrow:
 * provider handles, capability hashes, storage keys, raw errors, and event
 * payloads never cross this repository boundary.
 */
export async function listScienceAdminActionQueue(
  db: Db,
  input: { workspaceId: string; page?: SciencePageInput; now?: Date },
): Promise<SciencePage<ScienceAdminActionQueueRecord>> {
  const workspaceId = ScienceWorkspaceAdmission.shape.workspaceId.parse(input.workspaceId);
  const pagination = page(input.page);
  const observedAt = input.now ?? new Date();
  const retainedRenderCutoff = new Date(observedAt.getTime() - 60_000);
  const result = await db.execute(sql<RawScienceAdminActionQueueRecord>`
    with action_items as (
      select
        r.id as id,
        'run'::text as kind,
        r.state as state,
        evidence.detected_at as detected_at,
        evidence.attempts as attempts,
        null::timestamptz as next_retry_at,
        'compute_reconciliation_required'::text as reason,
        r.study_id as study_id,
        r.id as run_id,
        null::uuid as artifact_id,
        null::uuid as artifact_version_id
      from science_runs r
      inner join science_studies s on s.id = r.study_id
      cross join lateral (
        select
          min(e.created_at) as detected_at,
          coalesce(max(
            case
              when coalesce(e.payload ->> 'attempt', '') ~ '^[0-9]{1,9}$'
                then (e.payload ->> 'attempt')::integer
              else 1
            end
          ), 0)::integer as attempts
        from science_run_events e
        where e.run_id = r.id
          and e.execution_generation = r.execution_generation
          and (
            e.payload ->> 'adminActionRequired' = 'true'
            or e.payload ->> 'orphaned' = 'true'
          )
      ) evidence
      where s.workspace_id = ${workspaceId}
        and r.state = 'cancelling'
        and evidence.detected_at is not null

      union all

      select
        u.id as id,
        'upload_reservation'::text as kind,
        u.state as state,
        u.updated_at as detected_at,
        u.cleanup_attempts as attempts,
        u.cleanup_not_before as next_retry_at,
        case
          when u.state = 'quarantined' then 'upload_quarantined'
          else 'upload_cleanup_retry_pending'
        end::text as reason,
        a.study_id as study_id,
        null::uuid as run_id,
        u.artifact_id as artifact_id,
        u.artifact_version_id as artifact_version_id
      from science_uploads u
      inner join science_artifacts a on a.id = u.artifact_id
      where u.workspace_id = ${workspaceId}
        and (
          u.state = 'quarantined'
          or (u.state = 'expired' and u.cleanup_attempts > 0)
        )

      union all

      select
        v.id as id,
        'artifact_version'::text as kind,
        v.status as state,
        v.created_at as detected_at,
        v.cleanup_attempts as attempts,
        v.cleanup_not_before as next_retry_at,
        case
          when v.status = 'quarantined' then 'artifact_version_quarantined'
          else 'artifact_version_cleanup_retry_pending'
        end::text as reason,
        a.study_id as study_id,
        null::uuid as run_id,
        v.artifact_id as artifact_id,
        v.id as artifact_version_id
      from science_artifact_versions v
      inner join science_artifacts a on a.id = v.artifact_id
      inner join science_studies s on s.id = a.study_id
      where s.workspace_id = ${workspaceId}
        and (
          v.status = 'quarantined'
          or (v.cleanup_eligible = true and v.cleanup_attempts > 0)
        )

      union all

      select
        rs.id as id,
        'render_session'::text as kind,
        rs.state as state,
        rs.updated_at as detected_at,
        rs.cleanup_attempts as attempts,
        rs.cleanup_not_before as next_retry_at,
        'render_session_cleanup_pending'::text as reason,
        coalesce(rr.study_id, ra.study_id) as study_id,
        rs.run_id as run_id,
        ra.id as artifact_id,
        rs.artifact_version_id as artifact_version_id
      from science_render_sessions rs
      left join science_runs rr on rr.id = rs.run_id
      left join science_artifact_versions rv on rv.id = rs.artifact_version_id
      left join science_artifacts ra on ra.id = rv.artifact_id
      where rs.workspace_id = ${workspaceId}
        and rs.state in ('expired', 'failed', 'revoked')
        and (
          rs.cleanup_attempts > 0
          or rs.updated_at <= ${retainedRenderCutoff}
        )
    )
    select
      id,
      kind,
      state,
      detected_at,
      attempts,
      next_retry_at,
      reason,
      study_id,
      run_id,
      artifact_id,
      artifact_version_id
    from action_items
    order by detected_at asc, kind asc, id asc
    offset ${pagination.offset}
    limit ${pagination.limit + 1}
  `);
  const rows =
    (result as unknown as { rows?: RawScienceAdminActionQueueRecord[] }).rows ??
    (result as unknown as RawScienceAdminActionQueueRecord[]);
  return paged(
    rows.map(parseAdminActionQueueRecord),
    pagination.offset,
    pagination.limit,
  );
}

function isTerminalRunState(value: string): boolean {
  return (SCIENCE_TERMINAL_RUN_STATES as readonly string[]).includes(value);
}

const ACTIVE_SCIENCE_UPLOAD_RESERVATION_STATES = [
  "pending",
  "uploading",
  "finalizing",
] as const;
const RETAINED_SCIENCE_UPLOAD_RESERVATION_STATES = [
  ...ACTIVE_SCIENCE_UPLOAD_RESERVATION_STATES,
  "quarantined",
  "expired",
] as const;

function workspaceStorageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Science workspace storage limit must be a positive safe integer");
  }
  return value;
}

function storageByteTotal(value: unknown, label: string): number {
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total < 0) {
    conflict(`${label} cannot be represented safely`);
  }
  return total;
}

async function lockScienceWorkspaceForUpdate(
  db: Db,
  workspaceId: string,
): Promise<void> {
  await db.execute(sql`select id from workspaces where id = ${workspaceId} for update`);
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) conflict(`Science workspace ${workspaceId} does not exist`);
}

async function workspaceStorageBytes(
  db: Db,
  workspaceId: string,
  excludeUploadReservationId?: string | null,
): Promise<number> {
  const [versionUsage] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${scienceArtifactVersions.sizeBytes}), 0)::text`,
    })
    .from(scienceArtifactVersions)
    .innerJoin(
      scienceArtifacts,
      eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
    )
    .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
    .where(
      and(
        eq(scienceStudies.workspaceId, workspaceId),
        sql`(${scienceArtifactVersions.status} <> 'expired' OR ${scienceArtifactVersions.cleanupEligible} = true)`,
      ),
    );

  const uploadFilter = excludeUploadReservationId
    ? and(
        eq(scienceUploads.workspaceId, workspaceId),
        inArray(
          scienceUploads.state,
          [...RETAINED_SCIENCE_UPLOAD_RESERVATION_STATES],
        ),
        sql`${scienceUploads.id} <> ${excludeUploadReservationId}`,
      )
    : and(
        eq(scienceUploads.workspaceId, workspaceId),
        inArray(
          scienceUploads.state,
          [...RETAINED_SCIENCE_UPLOAD_RESERVATION_STATES],
        ),
      );
  const [uploadUsage] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${scienceUploads.expectedSizeBytes}), 0)::text`,
    })
    .from(scienceUploads)
    .where(uploadFilter);

  const versions = storageByteTotal(
    versionUsage?.bytes ?? 0,
    "Science artifact storage usage",
  );
  const reservations = storageByteTotal(
    uploadUsage?.bytes ?? 0,
    "Science upload reservation usage",
  );
  if (versions > Number.MAX_SAFE_INTEGER - reservations) {
    conflict("Science workspace storage usage cannot be represented safely");
  }
  return versions + reservations;
}

async function assertWorkspaceStorageAdmission(
  db: Db,
  input: {
    workspaceId: string;
    requestedBytes: number;
    maxWorkspaceStorageBytes: number;
    excludeUploadReservationId?: string | null;
  },
): Promise<void> {
  const limit = workspaceStorageLimit(input.maxWorkspaceStorageBytes);
  await lockScienceWorkspaceForUpdate(db, input.workspaceId);
  const used = await workspaceStorageBytes(
    db,
    input.workspaceId,
    input.excludeUploadReservationId,
  );
  if (used > limit || input.requestedBytes > limit - used) {
    conflict(
      `Science workspace storage quota of ${limit} bytes would be exceeded ` +
      `(${used} bytes retained or reserved, ${input.requestedBytes} bytes requested)`,
    );
  }
}

async function lockStudy(db: Db, studyId: string): Promise<ScienceStudyRow> {
  await db.execute(sql`select id from science_studies where id = ${studyId} for update`);
  const [row] = await db.select().from(scienceStudies).where(eq(scienceStudies.id, studyId)).limit(1);
  if (!row) conflict(`Science study ${studyId} does not exist`);
  return row;
}

async function lockArtifact(db: Db, artifactId: string): Promise<ScienceArtifactRow> {
  await db.execute(sql`select id from science_artifacts where id = ${artifactId} for update`);
  const [row] = await db
    .select()
    .from(scienceArtifacts)
    .where(eq(scienceArtifacts.id, artifactId))
    .limit(1);
  if (!row) conflict(`Science artifact ${artifactId} does not exist`);
  return row;
}

async function lockRunForWorkspace(
  db: Db,
  workspaceId: string,
  runId: string,
): Promise<ScienceRunRow> {
  await db.execute(sql`select id from science_runs where id = ${runId} for update`);
  const [owned] = await db
    .select({ run: scienceRuns })
    .from(scienceRuns)
    .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
    .where(and(eq(scienceRuns.id, runId), eq(scienceStudies.workspaceId, workspaceId)))
    .limit(1);
  if (!owned) conflict(`Science run ${runId} does not exist in workspace ${workspaceId}`);
  return owned.run;
}

// --- Studies ---------------------------------------------------------------------

export async function createScienceStudy(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    description?: string;
    classification?: "non_regulated";
    workshopProjectId?: string | null;
    createdBy: string;
  },
) {
  const name = canonicalText(input.name, "Science study name", 200);
  const description = input.description ?? "";
  if (description.length > 20_000) throw new Error("Science study description is too long");
  const classification = ScienceStudy.shape.classification.parse(
    input.classification ?? "non_regulated",
  );

  if (input.workshopProjectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, input.workshopProjectId),
          eq(projects.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (!project) conflict("Workshop project does not belong to the study workspace");
  }

  const [row] = await db
    .insert(scienceStudies)
    .values({
      workspaceId: input.workspaceId,
      name,
      description,
      status: "active",
      classification,
      workshopProjectId: input.workshopProjectId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return parseStudy(row!);
}

export async function listScienceStudies(
  db: Db,
  input: { workspaceId: string; status?: "active" | "archived"; page?: SciencePageInput },
) {
  const pagination = page(input.page);
  const status = input.status === undefined ? undefined : ScienceStudy.shape.status.parse(input.status);
  const rows = await db
    .select()
    .from(scienceStudies)
    .where(
      status
        ? and(eq(scienceStudies.workspaceId, input.workspaceId), eq(scienceStudies.status, status))
        : eq(scienceStudies.workspaceId, input.workspaceId),
    )
    .orderBy(desc(scienceStudies.createdAt), desc(scienceStudies.id))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseStudy), pagination.offset, pagination.limit);
}

export async function getScienceStudyForWorkspace(
  db: Db,
  workspaceId: string,
  studyId: string,
) {
  const [row] = await db
    .select()
    .from(scienceStudies)
    .where(and(eq(scienceStudies.id, studyId), eq(scienceStudies.workspaceId, workspaceId)))
    .limit(1);
  return row ? parseStudy(row) : null;
}

export async function updateScienceStudy(
  db: Db,
  input: {
    workspaceId: string;
    studyId: string;
    name?: string;
    description?: string;
    workshopProjectId?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const study = await lockStudy(scoped, input.studyId);
    if (study.workspaceId !== input.workspaceId) {
      conflict(`Science study ${input.studyId} does not exist in workspace ${input.workspaceId}`);
    }
    if (study.status === "archived") conflict("Archived science studies are read-only");
    if (input.workshopProjectId) {
      const [project] = await scoped
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.workshopProjectId),
            eq(projects.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      if (!project) conflict("Workshop project does not belong to the study workspace");
    }
    const patch: Partial<typeof scienceStudies.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = canonicalText(input.name, "Science study name", 200);
    if (input.description !== undefined) {
      if (input.description.length > 20_000) throw new Error("Science study description is too long");
      patch.description = input.description;
    }
    if (input.workshopProjectId !== undefined) {
      patch.workshopProjectId = input.workshopProjectId;
    }
    const [row] = await scoped
      .update(scienceStudies)
      .set(patch)
      .where(eq(scienceStudies.id, study.id))
      .returning();
    return parseStudy(row!);
  });
}

export async function archiveScienceStudy(db: Db, workspaceId: string, studyId: string) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const study = await lockStudy(scoped, studyId);
    if (study.workspaceId !== workspaceId) {
      conflict(`Science study ${studyId} does not exist in workspace ${workspaceId}`);
    }
    if (study.status === "archived") return parseStudy(study);
    const activeRuns = await scoped
      .select({ id: scienceRuns.id })
      .from(scienceRuns)
      .where(
        and(
          eq(scienceRuns.studyId, studyId),
          inArray(scienceRuns.state, [
            "draft",
            "awaiting_approval",
            "queued",
            "provisioning",
            "running",
            "finalizing",
            "cancelling",
          ]),
        ),
      )
      .limit(1);
    if (activeRuns.length > 0) conflict("A study with a non-terminal run cannot be archived");
    const [row] = await scoped
      .update(scienceStudies)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(scienceStudies.id, study.id))
      .returning();
    return parseStudy(row!);
  });
}

// --- Artifacts and immutable versions -------------------------------------------

export async function createScienceArtifact(
  db: Db,
  input: {
    workspaceId: string;
    studyId: string;
    logicalName: string;
    kind: typeof ScienceArtifactKind._type;
    format: string;
    createdBy: string;
  },
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const study = await lockStudy(scoped, input.studyId);
    if (study.workspaceId !== input.workspaceId) conflict("Science study is outside the workspace");
    if (study.status !== "active") conflict("Archived science studies are read-only");
    const [row] = await scoped
      .insert(scienceArtifacts)
      .values({
        studyId: study.id,
        logicalName: canonicalText(input.logicalName, "Artifact logical name", 300),
        kind: ScienceArtifactKind.parse(input.kind),
        format: canonicalText(input.format, "Artifact format", 100),
        status: "active",
        createdBy: input.createdBy,
      })
      .returning();
    return parseArtifact(row!);
  });
}

export async function listScienceArtifacts(
  db: Db,
  input: {
    workspaceId: string;
    studyId: string;
    status?: "active" | "archived";
    page?: SciencePageInput;
  },
) {
  const study = await getScienceStudyForWorkspace(db, input.workspaceId, input.studyId);
  if (!study) return { items: [], nextOffset: null } satisfies SciencePage<ScienceArtifact>;
  const pagination = page(input.page);
  const status =
    input.status === undefined ? undefined : ScienceArtifactStatus.parse(input.status);
  const rows = await db
    .select()
    .from(scienceArtifacts)
    .where(
      status
        ? and(eq(scienceArtifacts.studyId, study.id), eq(scienceArtifacts.status, status))
        : eq(scienceArtifacts.studyId, study.id),
    )
    .orderBy(desc(scienceArtifacts.createdAt), desc(scienceArtifacts.id))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseArtifact), pagination.offset, pagination.limit);
}

export async function getScienceArtifactForWorkspace(
  db: Db,
  workspaceId: string,
  artifactId: string,
) {
  const [owned] = await db
    .select({ artifact: scienceArtifacts })
    .from(scienceArtifacts)
    .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
    .where(
      and(eq(scienceArtifacts.id, artifactId), eq(scienceStudies.workspaceId, workspaceId)),
    )
    .limit(1);
  return owned ? parseArtifact(owned.artifact) : null;
}

export async function getScienceArtifactByLogicalName(
  db: Db,
  input: { workspaceId: string; studyId: string; logicalName: string },
) {
  const logicalName = canonicalText(input.logicalName, "Artifact logical name", 300);
  const [owned] = await db
    .select({ artifact: scienceArtifacts })
    .from(scienceArtifacts)
    .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
    .where(
      and(
        eq(scienceArtifacts.studyId, input.studyId),
        eq(scienceArtifacts.logicalName, logicalName),
        eq(scienceStudies.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return owned ? parseArtifact(owned.artifact) : null;
}

export async function archiveScienceArtifact(
  db: Db,
  workspaceId: string,
  artifactId: string,
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const artifact = await lockArtifact(scoped, artifactId);
    const study = await lockStudy(scoped, artifact.studyId);
    if (study.workspaceId !== workspaceId) conflict("Science artifact is outside the workspace");
    if (study.status !== "active") conflict("Archived science studies are read-only");
    if (artifact.status === "archived") return parseArtifact(artifact);
    const [row] = await scoped
      .update(scienceArtifacts)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(scienceArtifacts.id, artifact.id))
      .returning();
    return parseArtifact(row!);
  });
}

export async function createScienceArtifactVersion(
  db: Db,
  input: {
    workspaceId: string;
    artifactId: string;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    metadata?: Record<string, unknown>;
    parentVersionId?: string | null;
    uploadReservationId?: string | null;
    uploadReservationMode?: "exact" | "provider_output";
    cleanupEligible?: boolean;
    maxWorkspaceStorageBytes: number;
    createdBy: string;
  },
): Promise<{ version: ScienceArtifactVersion; created: boolean }> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const artifact = await lockArtifact(scoped, input.artifactId);
    const study = await lockStudy(scoped, artifact.studyId);
    if (study.workspaceId !== input.workspaceId) conflict("Science artifact is outside the workspace");
    if (study.status !== "active" || artifact.status !== "active") {
      conflict("Archived science records are read-only");
    }
    const sha256 = ScienceSha256.parse(input.sha256);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("Artifact size must be a nonnegative safe integer");
    }
    const storageKey = canonicalText(input.storageKey, "Artifact storage key", 2_000);
    const mediaType = canonicalText(input.mediaType, "Artifact media type", 255);
    const metadata = normalizeJson(input.metadata ?? {}, "Artifact metadata") as Record<
      string,
      unknown
    >;

    const [duplicate] = await scoped
      .select()
      .from(scienceArtifactVersions)
      .where(
        and(
          eq(scienceArtifactVersions.artifactId, artifact.id),
          eq(scienceArtifactVersions.sha256, sha256),
        ),
      )
      .limit(1);
    if (duplicate) {
      if (
        duplicate.storageKey !== storageKey ||
        Number(duplicate.sizeBytes) !== input.sizeBytes ||
        duplicate.mediaType !== mediaType ||
        duplicate.parentVersionId !== (input.parentVersionId ?? null) ||
        !sameJson(duplicate.metadata, metadata)
      ) {
        conflict("Artifact checksum already exists with different immutable metadata");
      }
    }

    if (input.parentVersionId && !duplicate) {
      await scoped.execute(
        sql`select id from science_artifact_versions
             where id = ${input.parentVersionId}
             for update`,
      );
      const [parent] = await scoped
        .select()
        .from(scienceArtifactVersions)
        .where(eq(scienceArtifactVersions.id, input.parentVersionId))
        .limit(1);
      if (!parent || parent.artifactId !== artifact.id) {
        conflict("Artifact version parent must belong to the same logical artifact");
      }
      if (parent.status !== "ready") {
        conflict("Artifact version parent must be ready");
      }
    }

    let uploadReservationId: string | null = null;
    let uploadReservationMode: "exact" | "provider_output" = "exact";
    if (input.uploadReservationId) {
      const reservationMode = input.uploadReservationMode ?? "exact";
      if (!["exact", "provider_output"].includes(reservationMode)) {
        throw new Error("Artifact version upload reservation mode is invalid");
      }
      // Serialize the reservation-to-version handoff with expiry cleanup. A
      // cleanup worker must not be able to return this row and discard its
      // quarantine object after the version transaction has admitted it.
      await scoped.execute(
        sql`select id from science_uploads where id = ${input.uploadReservationId} for update`,
      );
      const [reservation] = await scoped
        .select()
        .from(scienceUploads)
        .where(eq(scienceUploads.id, input.uploadReservationId))
        .limit(1);
      const commonReservationMismatch =
        !reservation ||
        reservation.workspaceId !== input.workspaceId ||
        reservation.artifactId !== artifact.id ||
        Number(reservation.receivedBytes) !== input.sizeBytes ||
        reservation.expiresAt.getTime() <= Date.now() ||
        !ACTIVE_SCIENCE_UPLOAD_RESERVATION_STATES.includes(
          reservation.state as (typeof ACTIVE_SCIENCE_UPLOAD_RESERVATION_STATES)[number],
        );
      const receiptMismatch =
        reservationMode === "exact"
          ? reservation?.expectedSha256 !== sha256 ||
            Number(reservation?.expectedSizeBytes) !== input.sizeBytes
          : Number(reservation?.expectedSizeBytes) < input.sizeBytes;
      if (commonReservationMismatch || receiptMismatch) {
        conflict("Artifact version upload reservation does not match the completed bytes");
      }
      uploadReservationId = reservation.id;
      uploadReservationMode = reservationMode;
    }
    if (duplicate) {
      return { version: parseVersion(duplicate), created: false };
    }
    await assertWorkspaceStorageAdmission(scoped, {
      workspaceId: input.workspaceId,
      requestedBytes: input.sizeBytes,
      maxWorkspaceStorageBytes: input.maxWorkspaceStorageBytes,
      excludeUploadReservationId: uploadReservationId,
    });

    const [maxVersion] = await scoped
      .select({ value: sql<number>`coalesce(max(${scienceArtifactVersions.version}), 0)` })
      .from(scienceArtifactVersions)
      .where(eq(scienceArtifactVersions.artifactId, artifact.id));
    const [row] = await scoped
      .insert(scienceArtifactVersions)
      .values({
        artifactId: artifact.id,
        version: Number(maxVersion?.value ?? 0) + 1,
        status: "pending",
        storageKey,
        sha256,
        sizeBytes: input.sizeBytes,
        mediaType,
        metadata,
        cleanupEligible: input.cleanupEligible ?? false,
        parentVersionId: input.parentVersionId ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    return { version: parseVersion(row!), created: true };
  });
}

export async function listScienceArtifactVersions(
  db: Db,
  input: { workspaceId: string; artifactId: string; page?: SciencePageInput },
) {
  const artifact = await getScienceArtifactForWorkspace(db, input.workspaceId, input.artifactId);
  if (!artifact) return { items: [], nextOffset: null } satisfies SciencePage<ScienceArtifactVersion>;
  const pagination = page(input.page);
  const rows = await db
    .select()
    .from(scienceArtifactVersions)
    .where(eq(scienceArtifactVersions.artifactId, artifact.id))
    .orderBy(desc(scienceArtifactVersions.version))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseVersion), pagination.offset, pagination.limit);
}

export async function getScienceArtifactVersionForWorkspace(
  db: Db,
  workspaceId: string,
  versionId: string,
) {
  const [owned] = await db
    .select({ version: scienceArtifactVersions })
    .from(scienceArtifactVersions)
    .innerJoin(
      scienceArtifacts,
      eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
    )
    .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
    .where(
      and(
        eq(scienceArtifactVersions.id, versionId),
        eq(scienceStudies.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return owned ? parseVersion(owned.version) : null;
}

export async function transitionScienceArtifactVersion(
  db: Db,
  input: {
    workspaceId: string;
    versionId: string;
    to: "ready" | "quarantined" | "expired";
  },
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_artifact_versions where id = ${input.versionId} for update`,
    );
    const version = await getScienceArtifactVersionForWorkspace(
      scoped,
      input.workspaceId,
      input.versionId,
    );
    if (!version) conflict("Science artifact version does not exist in the workspace");
    const target = ScienceArtifactVersionStatus.parse(input.to);
    if (version.status === target) return version;
    const allowed =
      version.status === "pending"
        ? target === "ready" || target === "quarantined"
        : (version.status === "ready" || version.status === "quarantined") &&
          target === "expired";
    if (!allowed) {
      conflict(`Illegal artifact version transition ${version.status} -> ${target}`);
    }
    const [row] = await scoped
      .update(scienceArtifactVersions)
      .set({
        status: target,
        readyAt: target === "ready" ? new Date() : version.readyAt,
        ...(target === "ready"
          ? { cleanupEligible: false, cleanupAttempts: 0, cleanupNotBefore: null }
          : target === "expired"
            ? { cleanupEligible: true, cleanupAttempts: 0, cleanupNotBefore: null }
            : {}),
      })
      .where(eq(scienceArtifactVersions.id, version.id))
      .returning();
    return parseVersion(row!);
  });
}

/**
 * Mark abandoned provider-output versions terminal and return every prior
 * terminal candidate that still needs object deletion. Ready or linked
 * versions are never selected.
 */
export async function cleanupScienceArtifactVersionQuarantine(
  db: Db,
  input: {
    workspaceId: string;
    olderThan: Date;
    limit?: number;
    now?: Date;
  },
): Promise<ScienceArtifactVersion[]> {
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const now = input.now ?? new Date();
  const hasNoLiveMatchingUpload = () => sql`not exists (
    select 1 from ${scienceUploads}
     where ${scienceUploads.artifactId} = ${scienceArtifactVersions.artifactId}
       and ${scienceUploads.expectedSha256} = ${scienceArtifactVersions.sha256}
       and ${scienceUploads.state} in ('pending', 'uploading', 'finalizing')
       and ${scienceUploads.expiresAt} > ${now}
  )`;
  const candidates = db
    .select({ id: scienceArtifactVersions.id })
    .from(scienceArtifactVersions)
    .innerJoin(
      scienceArtifacts,
      eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
    )
    .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
    .leftJoin(
      scienceRunArtifacts,
      eq(scienceRunArtifacts.artifactVersionId, scienceArtifactVersions.id),
    )
    .where(
      and(
        eq(scienceStudies.workspaceId, input.workspaceId),
        eq(scienceArtifactVersions.cleanupEligible, true),
        inArray(scienceArtifactVersions.status, ["pending", "quarantined"]),
        lt(scienceArtifactVersions.createdAt, input.olderThan),
        or(
          isNull(scienceArtifactVersions.cleanupNotBefore),
          lte(scienceArtifactVersions.cleanupNotBefore, now),
        ),
        sql`${scienceRunArtifacts.id} is null`,
        hasNoLiveMatchingUpload(),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${scienceArtifactVersions.cleanupNotBefore}, ${scienceArtifactVersions.createdAt})`),
      asc(scienceArtifactVersions.id),
    )
    .limit(limit);
  await db
    .update(scienceArtifactVersions)
    .set({ status: "expired", cleanupAttempts: 0, cleanupNotBefore: null })
    .where(
      and(
        inArray(scienceArtifactVersions.id, candidates),
        eq(scienceArtifactVersions.cleanupEligible, true),
        inArray(scienceArtifactVersions.status, ["pending", "quarantined"]),
        lt(scienceArtifactVersions.createdAt, input.olderThan),
        sql`not exists (
          select 1 from science_run_artifacts
           where science_run_artifacts.artifact_version_id = ${scienceArtifactVersions.id}
        )`,
        hasNoLiveMatchingUpload(),
      ),
    );

  const rows = await db
    .select({ version: scienceArtifactVersions })
    .from(scienceArtifactVersions)
    .innerJoin(
      scienceArtifacts,
      eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
    )
    .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
    .leftJoin(
      scienceRunArtifacts,
      eq(scienceRunArtifacts.artifactVersionId, scienceArtifactVersions.id),
    )
    .where(
      and(
        eq(scienceStudies.workspaceId, input.workspaceId),
        eq(scienceArtifactVersions.cleanupEligible, true),
        eq(scienceArtifactVersions.status, "expired"),
        or(
          isNull(scienceArtifactVersions.cleanupNotBefore),
          lte(scienceArtifactVersions.cleanupNotBefore, now),
        ),
        sql`${scienceRunArtifacts.id} is null`,
        hasNoLiveMatchingUpload(),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${scienceArtifactVersions.cleanupNotBefore}, ${scienceArtifactVersions.createdAt})`),
      asc(scienceArtifactVersions.id),
    )
    .limit(limit);
  return rows.map(({ version }) => parseVersion(version));
}

/**
 * Claim an unreferenced ready version for administrator-requested retention
 * deletion. The checksum is the destructive confirmation token. Marking the
 * row expired before object deletion makes a partial failure retry-safe while
 * keeping the bytes quota-charged until delete proof succeeds.
 */
export async function claimScienceArtifactVersionRetention(
  db: Db,
  input: {
    workspaceId: string;
    versionId: string;
    expectedSha256: string;
  },
): Promise<ScienceArtifactVersion> {
  const expectedSha256 = ScienceSha256.parse(input.expectedSha256);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const [snapshot] = await scoped
      .select({ artifactId: scienceArtifactVersions.artifactId })
      .from(scienceArtifactVersions)
      .where(eq(scienceArtifactVersions.id, input.versionId))
      .limit(1);
    if (!snapshot) conflict("Science artifact version does not exist in the workspace");
    const artifact = await lockArtifact(scoped, snapshot.artifactId);
    const study = await lockStudy(scoped, artifact.studyId);
    if (study.workspaceId !== input.workspaceId) {
      conflict("Science artifact version does not exist in the workspace");
    }
    await scoped.execute(
      sql`select id from science_artifact_versions where id = ${input.versionId} for update`,
    );
    const [version] = await scoped
      .select()
      .from(scienceArtifactVersions)
      .where(eq(scienceArtifactVersions.id, input.versionId))
      .limit(1);
    if (!version || version.artifactId !== artifact.id) {
      conflict("Science artifact version does not exist in the workspace");
    }
    if (version.sha256 !== expectedSha256) {
      conflict("Artifact retention confirmation checksum does not match");
    }
    if (version.status === "expired" && version.cleanupEligible) {
      return parseVersion(version);
    }
    if (version.status !== "ready") {
      conflict(`Science artifact version in ${version.status} cannot be retention-expired`);
    }
    // A Drizzle transaction owns one PostgreSQL client. Keep these checks
    // sequential: pg 8 warns on concurrent queries on one client and pg 9 will
    // reject them. The artifact/version locks above preserve the same fence.
    const [runReference] = await scoped
      .select({ id: scienceRunArtifacts.id })
      .from(scienceRunArtifacts)
      .where(eq(scienceRunArtifacts.artifactVersionId, version.id))
      .limit(1);
    const [childVersion] = await scoped
      .select({ id: scienceArtifactVersions.id })
      .from(scienceArtifactVersions)
      .where(eq(scienceArtifactVersions.parentVersionId, version.id))
      .limit(1);
    const [renderReference] = await scoped
      .select({ id: scienceRenderSessions.id })
      .from(scienceRenderSessions)
      .where(
        and(
          eq(scienceRenderSessions.artifactVersionId, version.id),
          or(
            inArray(scienceRenderSessions.state, ["starting", "ready"]),
            isNotNull(scienceRenderSessions.providerHandle),
          ),
        ),
      )
      .limit(1);
    const [activeUpload] = await scoped
      .select({ id: scienceUploads.id })
      .from(scienceUploads)
      .where(
        and(
          eq(scienceUploads.artifactId, version.artifactId),
          eq(scienceUploads.expectedSha256, version.sha256),
          inArray(scienceUploads.state, ["pending", "uploading", "finalizing"]),
        ),
      )
      .limit(1);
    if (runReference) conflict("Run-linked artifact versions cannot be retention-expired");
    if (childVersion) conflict("Artifact versions with retained descendants cannot be expired");
    if (renderReference) conflict("Render-referenced artifact versions cannot be expired");
    if (activeUpload) conflict("Artifact version finalization is still active");
    const [claimed] = await scoped
      .update(scienceArtifactVersions)
      .set({
        status: "expired",
        cleanupEligible: true,
        cleanupAttempts: 0,
        cleanupNotBefore: null,
      })
      .where(
        and(
          eq(scienceArtifactVersions.id, version.id),
          eq(scienceArtifactVersions.status, "ready"),
        ),
      )
      .returning();
    if (!claimed) conflict("Artifact retention claim lost its version fence");
    return parseVersion(claimed);
  });
}

/**
 * Release version quota only after its storage object has been removed. The
 * immutable metadata row remains as a tombstone so version ordinals, checksum
 * identity, and completed-upload evidence can never be reused or rewritten.
 * The row must remain internal-cleanup eligible, expired, workspace-owned, and
 * unlinked at the exact release.
 */
export async function deleteExpiredScienceArtifactVersionAfterDiscard(
  db: Db,
  input: { workspaceId: string; versionId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_artifact_versions where id = ${input.versionId} for update`,
    );
    const [candidate] = await scoped
      .select({
        version: scienceArtifactVersions,
        workspaceId: scienceStudies.workspaceId,
      })
      .from(scienceArtifactVersions)
      .innerJoin(
        scienceArtifacts,
        eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
      )
      .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
      .where(eq(scienceArtifactVersions.id, input.versionId))
      .limit(1);
    if (
      !candidate ||
      candidate.workspaceId !== input.workspaceId ||
      candidate.version.status !== "expired" ||
      !candidate.version.cleanupEligible
    ) {
      return false;
    }
    const [runReference] = await scoped
      .select({ id: scienceRunArtifacts.id })
      .from(scienceRunArtifacts)
      .where(eq(scienceRunArtifacts.artifactVersionId, candidate.version.id))
      .limit(1);
    const [childVersion] = await scoped
      .select({ id: scienceArtifactVersions.id })
      .from(scienceArtifactVersions)
      .where(eq(scienceArtifactVersions.parentVersionId, candidate.version.id))
      .limit(1);
    const [renderReference] = await scoped
      .select({ id: scienceRenderSessions.id })
      .from(scienceRenderSessions)
      .where(
        and(
          eq(scienceRenderSessions.artifactVersionId, candidate.version.id),
          or(
            inArray(scienceRenderSessions.state, ["starting", "ready"]),
            isNotNull(scienceRenderSessions.providerHandle),
          ),
        ),
      )
      .limit(1);
    if (runReference || childVersion || renderReference) return false;
    const [released] = await scoped
      .update(scienceArtifactVersions)
      .set({ cleanupEligible: false, cleanupNotBefore: null })
      .where(
        and(
          eq(scienceArtifactVersions.id, candidate.version.id),
          eq(scienceArtifactVersions.status, "expired"),
          eq(scienceArtifactVersions.cleanupEligible, true),
        ),
      )
      .returning({ id: scienceArtifactVersions.id });
    return Boolean(released);
  });
}

export async function deferScienceArtifactVersionCleanup(
  db: Db,
  input: { workspaceId: string; versionId: string; retryAt: Date },
): Promise<boolean> {
  const [deferred] = await db
    .update(scienceArtifactVersions)
    .set({
      cleanupAttempts: sql`${scienceArtifactVersions.cleanupAttempts} + 1`,
      cleanupNotBefore: input.retryAt,
    })
    .where(
      and(
        eq(scienceArtifactVersions.id, input.versionId),
        eq(scienceArtifactVersions.status, "expired"),
        eq(scienceArtifactVersions.cleanupEligible, true),
        sql`exists (
          select 1
            from science_artifacts
            join science_studies on science_studies.id = science_artifacts.study_id
           where science_artifacts.id = ${scienceArtifactVersions.artifactId}
             and science_studies.workspace_id = ${input.workspaceId}
        )`,
      ),
    )
    .returning({ id: scienceArtifactVersions.id });
  return Boolean(deferred);
}

// --- Durable upload intents and leases ------------------------------------------

export async function beginScienceUpload(
  db: Db,
  input: {
    workspaceId: string;
    artifactId: string;
    tokenHash: string;
    expectedSizeBytes: number;
    expectedSha256: string;
    quarantineKey: string;
    expiresAt: Date;
    maxWorkspaceStorageBytes: number;
  },
): Promise<{ upload: ScienceUpload; created: boolean }> {
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const expectedSha256 = ScienceSha256.parse(input.expectedSha256);
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 0) {
    throw new Error("Expected upload size must be a nonnegative safe integer");
  }
  if (!(input.expiresAt instanceof Date) || input.expiresAt.getTime() <= Date.now()) {
    throw new Error("Upload expiry must be in the future");
  }
  const quarantineKey = canonicalText(input.quarantineKey, "Upload quarantine key", 2_000);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const artifact = await lockArtifact(scoped, input.artifactId);
    const study = await lockStudy(scoped, artifact.studyId);
    if (study.workspaceId !== input.workspaceId) conflict("Science artifact is outside the workspace");
    if (study.status !== "active" || artifact.status !== "active") {
      conflict("Archived science records cannot accept uploads");
    }
    const [existing] = await scoped
      .select()
      .from(scienceUploads)
      .where(eq(scienceUploads.tokenHash, tokenHash))
      .limit(1);
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.artifactId !== input.artifactId ||
        Number(existing.expectedSizeBytes) !== input.expectedSizeBytes ||
        existing.expectedSha256 !== expectedSha256 ||
        existing.quarantineKey !== quarantineKey ||
        existing.expiresAt.getTime() !== input.expiresAt.getTime()
      ) {
        conflict("Upload token hash was already used for a different intent");
      }
      return { upload: parseUpload(existing), created: false };
    }
    await assertWorkspaceStorageAdmission(scoped, {
      workspaceId: input.workspaceId,
      requestedBytes: input.expectedSizeBytes,
      maxWorkspaceStorageBytes: input.maxWorkspaceStorageBytes,
    });
    const [row] = await scoped
      .insert(scienceUploads)
      .values({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        tokenHash,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedSha256,
        quarantineKey,
        receivedBytes: 0,
        state: "pending",
        expiresAt: input.expiresAt,
      })
      .returning();
    return { upload: parseUpload(row!), created: true };
  });
}

export async function getScienceUploadByTokenHash(
  db: Db,
  workspaceId: string,
  tokenHash: string,
) {
  const canonicalHash = ScienceSha256.parse(tokenHash);
  const [row] = await db
    .select()
    .from(scienceUploads)
    .where(
      and(
        eq(scienceUploads.workspaceId, workspaceId),
        eq(scienceUploads.tokenHash, canonicalHash),
      ),
    )
    .limit(1);
  return row ? parseUpload(row) : null;
}

/**
 * Atomically claim the one permitted byte-transfer attempt. The object-store
 * writer must never be opened before this succeeds: otherwise two requests
 * can share a quarantine inode and mutate a hard-linked immutable object
 * after one request has verified it.
 */
export async function claimScienceUploadTransfer(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    leaseExpiresAt: Date;
    external?: boolean;
    maxConcurrentExternalStreamsPerWorkspace?: number;
    now?: Date;
  },
): Promise<{ upload: ScienceUpload; claimed: boolean }> {
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const now = input.now ?? new Date();
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    input.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science upload transfer lease must expire in the future");
  }
  const external = input.external === true;
  if (
    external &&
    (!Number.isSafeInteger(input.maxConcurrentExternalStreamsPerWorkspace) ||
      input.maxConcurrentExternalStreamsPerWorkspace! <= 0 ||
      input.maxConcurrentExternalStreamsPerWorkspace! > 128)
  ) {
    throw new Error(
      "Science external upload stream limit must be an integer between 1 and 128",
    );
  }

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    if (external) {
      // Every server instance serializes the count-and-claim decision on the
      // same workspace row. A process-local counter alone cannot protect a
      // horizontally scaled deployment.
      await lockScienceWorkspaceForUpdate(scoped, input.workspaceId);
      const existing = await getScienceUploadByTokenHash(
        scoped,
        input.workspaceId,
        tokenHash,
      );
      if (!existing) conflict("Science upload intent does not exist in the workspace");
      if (existing.state === "completed") {
        return { upload: existing, claimed: false };
      }
      if (existing.expiresAt.getTime() <= now.getTime()) {
        conflict("Science upload lease has expired");
      }
      if (existing.state !== "pending" || existing.receivedBytes !== 0) {
        conflict("Science upload byte transfer was already claimed");
      }
      const [usage] = await scoped
        .select({ value: sql<number>`count(*)` })
        .from(scienceUploads)
        .where(
          and(
            eq(scienceUploads.workspaceId, input.workspaceId),
            eq(scienceUploads.externalTransfer, true),
            eq(scienceUploads.state, "uploading"),
            isNotNull(scienceUploads.transferLeaseId),
            gt(scienceUploads.transferLeaseExpiresAt, now),
          ),
        );
      if (
        Number(usage?.value ?? 0) >=
        input.maxConcurrentExternalStreamsPerWorkspace!
      ) {
        conflict(
          `Science workspace external upload stream concurrency limit of ` +
            `${input.maxConcurrentExternalStreamsPerWorkspace} was reached`,
        );
      }
    }

    const [claimed] = await scoped
      .update(scienceUploads)
      .set({
        state: "uploading",
        transferLeaseId: input.leaseId,
        transferLeaseExpiresAt: input.leaseExpiresAt,
        externalTransfer: external,
        expiresAt: sql`greatest(${scienceUploads.expiresAt}, ${input.leaseExpiresAt})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scienceUploads.workspaceId, input.workspaceId),
          eq(scienceUploads.tokenHash, tokenHash),
          eq(scienceUploads.state, "pending"),
          eq(scienceUploads.receivedBytes, 0),
          gt(scienceUploads.expiresAt, now),
        ),
      )
      .returning();
    if (claimed) return { upload: parseUpload(claimed), claimed: true };

    const existing = await getScienceUploadByTokenHash(
      scoped,
      input.workspaceId,
      tokenHash,
    );
    if (!existing) conflict("Science upload intent does not exist in the workspace");
    if (existing.state === "completed") {
      return { upload: existing, claimed: false };
    }
    if (existing.expiresAt.getTime() <= now.getTime()) {
      conflict("Science upload lease has expired");
    }
    conflict("Science upload byte transfer was already claimed");
  });
}

export async function renewScienceUploadTransfer(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
): Promise<ScienceUpload> {
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const now = input.now ?? new Date();
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    input.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science upload transfer lease must expire in the future");
  }
  const [renewed] = await db
    .update(scienceUploads)
    .set({
      transferLeaseExpiresAt: input.leaseExpiresAt,
      expiresAt: sql`greatest(${scienceUploads.expiresAt}, ${input.leaseExpiresAt})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(scienceUploads.workspaceId, input.workspaceId),
        eq(scienceUploads.tokenHash, tokenHash),
        eq(scienceUploads.state, "uploading"),
        eq(scienceUploads.transferLeaseId, input.leaseId),
        gt(scienceUploads.transferLeaseExpiresAt, now),
        gt(scienceUploads.expiresAt, now),
      ),
    )
    .returning();
  if (!renewed) conflict("Science upload transfer lease was lost");
  return parseUpload(renewed);
}

async function lockUploadByToken(
  db: Db,
  workspaceId: string,
  tokenHash: string,
): Promise<ScienceUploadRow> {
  const canonicalHash = ScienceSha256.parse(tokenHash);
  await db.execute(sql`select id from science_uploads where token_hash = ${canonicalHash} for update`);
  const [row] = await db
    .select()
    .from(scienceUploads)
    .where(
      and(
        eq(scienceUploads.workspaceId, workspaceId),
        eq(scienceUploads.tokenHash, canonicalHash),
      ),
    )
    .limit(1);
  if (!row) conflict("Science upload intent does not exist in the workspace");
  return row;
}

export async function recordScienceUploadProgress(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    receivedBytes: number;
    readyExpiresAt: Date;
    retainTransferLease?: boolean;
    now?: Date;
  },
) {
  if (!Number.isSafeInteger(input.receivedBytes) || input.receivedBytes < 0) {
    throw new Error("Received upload bytes must be a nonnegative safe integer");
  }
  const now = input.now ?? new Date();
  if (
    !(input.readyExpiresAt instanceof Date) ||
    input.readyExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Completed upload bytes must retain a future expiry");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const upload = await lockUploadByToken(scoped, input.workspaceId, input.tokenHash);
    if (upload.state === "completed" && Number(upload.receivedBytes) === input.receivedBytes) {
      return parseUpload(upload);
    }
    if (upload.state !== "uploading") {
      conflict(`Science upload in ${upload.state} cannot record progress`);
    }
    if (
      upload.transferLeaseId !== input.leaseId ||
      !upload.transferLeaseExpiresAt ||
      upload.transferLeaseExpiresAt.getTime() <= now.getTime() ||
      upload.expiresAt.getTime() <= now.getTime()
    ) {
      conflict("Science upload transfer lease was lost");
    }
    if (input.receivedBytes < Number(upload.receivedBytes)) {
      conflict("Science upload progress cannot move backwards");
    }
    if (input.receivedBytes > Number(upload.expectedSizeBytes)) {
      conflict("Science upload progress exceeds the expected size");
    }
    if (input.receivedBytes !== Number(upload.expectedSizeBytes)) {
      conflict("Science upload byte transfer is incomplete");
    }
    const [row] = await scoped
      .update(scienceUploads)
      .set({
        receivedBytes: input.receivedBytes,
        transferLeaseId: input.retainTransferLease ? input.leaseId : null,
        transferLeaseExpiresAt: input.retainTransferLease
          ? upload.transferLeaseExpiresAt
          : null,
        externalTransfer: input.retainTransferLease ? upload.externalTransfer : false,
        expiresAt: sql`greatest(${scienceUploads.expiresAt}, ${input.readyExpiresAt})`,
        updatedAt: now,
      })
      .where(eq(scienceUploads.id, upload.id))
      .returning();
    return parseUpload(row!);
  });
}

export async function claimScienceUploadFinalization(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
): Promise<ScienceUpload> {
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const now = input.now ?? new Date();
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    input.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science upload finalization lease must expire in the future");
  }
  const [claimed] = await db
    .update(scienceUploads)
    .set({
      state: "finalizing",
      finalizationLeaseId: input.leaseId,
      expiresAt: input.leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(scienceUploads.workspaceId, input.workspaceId),
        eq(scienceUploads.tokenHash, tokenHash),
        sql`${scienceUploads.receivedBytes} = ${scienceUploads.expectedSizeBytes}`,
        or(
          and(
            eq(scienceUploads.state, "uploading"),
            isNull(scienceUploads.transferLeaseId),
            isNull(scienceUploads.finalizationLeaseId),
            gt(scienceUploads.expiresAt, now),
          ),
          and(
            eq(scienceUploads.state, "finalizing"),
            lte(scienceUploads.expiresAt, now),
          ),
          and(
            eq(scienceUploads.state, "finalizing"),
            eq(scienceUploads.finalizationLeaseId, input.leaseId),
            gt(scienceUploads.expiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  if (claimed) return parseUpload(claimed);
  const existing = await getScienceUploadByTokenHash(
    db,
    input.workspaceId,
    tokenHash,
  );
  if (!existing) conflict("Science upload intent does not exist in the workspace");
  if (existing.state === "completed") return existing;
  conflict(`Science upload in ${existing.state} cannot claim finalization`);
}

export async function renewScienceUploadFinalization(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
): Promise<ScienceUpload> {
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const now = input.now ?? new Date();
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    input.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science upload finalization lease must expire in the future");
  }
  const [renewed] = await db
    .update(scienceUploads)
    .set({ expiresAt: input.leaseExpiresAt, updatedAt: now })
    .where(
      and(
        eq(scienceUploads.workspaceId, input.workspaceId),
        eq(scienceUploads.tokenHash, tokenHash),
        eq(scienceUploads.state, "finalizing"),
        eq(scienceUploads.finalizationLeaseId, input.leaseId),
        gt(scienceUploads.expiresAt, now),
      ),
    )
    .returning();
  if (!renewed) conflict("Science upload finalization lease was lost");
  return parseUpload(renewed);
}

/**
 * Relinquish one failed finalization attempt without opening a concurrent
 * writer window. Only the holder of the exact persisted lease can return the
 * fully received upload to its retryable state.
 */
export async function releaseScienceUploadFinalization(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    retryExpiresAt: Date;
    now?: Date;
  },
): Promise<boolean> {
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const now = input.now ?? new Date();
  if (
    !(input.retryExpiresAt instanceof Date) ||
    input.retryExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science upload retry lease must expire in the future");
  }
  const [released] = await db
    .update(scienceUploads)
    .set({
      state: "uploading",
      transferLeaseId: null,
      transferLeaseExpiresAt: null,
      externalTransfer: false,
      finalizationLeaseId: null,
      expiresAt: input.retryExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(scienceUploads.workspaceId, input.workspaceId),
        eq(scienceUploads.tokenHash, tokenHash),
        eq(scienceUploads.state, "finalizing"),
        eq(scienceUploads.finalizationLeaseId, input.leaseId),
      ),
    )
    .returning({ id: scienceUploads.id });
  return Boolean(released);
}

export async function finalizeScienceUpload(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    leaseId: string;
    artifactVersionId: string;
    actualSha256: string;
    now?: Date;
  },
) {
  const actualSha256 = ScienceSha256.parse(input.actualSha256);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const upload = await lockUploadByToken(scoped, input.workspaceId, input.tokenHash);
    const now = input.now ?? new Date();
    if (upload.state === "completed") {
      if (
        upload.artifactVersionId === input.artifactVersionId &&
        upload.expectedSha256 === actualSha256
      ) {
        return parseUpload(upload);
      }
      conflict("Completed science upload cannot be finalized with different content");
    }
    if (upload.state !== "finalizing") {
      conflict(`Science upload in ${upload.state} cannot be finalized`);
    }
    if (upload.finalizationLeaseId !== input.leaseId) {
      conflict("Science upload finalization lease is owned by another attempt");
    }
    if (upload.expiresAt.getTime() <= now.getTime()) conflict("Science upload lease has expired");
    if (Number(upload.receivedBytes) !== Number(upload.expectedSizeBytes)) {
      conflict("Science upload is incomplete");
    }
    if (upload.expectedSha256 !== actualSha256) conflict("Science upload checksum mismatch");
    const version = await getScienceArtifactVersionForWorkspace(
      scoped,
      input.workspaceId,
      input.artifactVersionId,
    );
    if (
      !version ||
      version.artifactId !== upload.artifactId ||
      version.sha256 !== actualSha256 ||
      version.sizeBytes !== Number(upload.expectedSizeBytes) ||
      version.status !== "ready"
    ) {
      conflict("Final upload must reference its matching ready artifact version");
    }
    const [row] = await scoped
      .update(scienceUploads)
      .set({
        artifactVersionId: version.id,
        state: "completed",
        transferLeaseId: null,
        transferLeaseExpiresAt: null,
        externalTransfer: false,
        finalizationLeaseId: null,
        completedAt: now,
        updatedAt: now,
        error: null,
      })
      .where(eq(scienceUploads.id, upload.id))
      .returning();
    return parseUpload(row!);
  });
}

/**
 * Release the temporary provider-output reservation only after its immutable
 * version reached a durable ready/quarantined state. Keeping the exact
 * transfer lease until this transaction prevents cleanup from deleting a
 * pending version while object promotion or run-link commit is in flight.
 */
export async function deleteScienceProviderOutputReservationAfterCommit(
  db: Db,
  input: {
    workspaceId: string;
    uploadId: string;
    artifactVersionId: string;
    leaseId: string;
    now?: Date;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_uploads where id = ${input.uploadId} for update`,
    );
    const [upload] = await scoped
      .select()
      .from(scienceUploads)
      .where(
        and(
          eq(scienceUploads.id, input.uploadId),
          eq(scienceUploads.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (!upload) return false;
    const now = input.now ?? new Date();
    if (
      upload.state !== "uploading" ||
      upload.transferLeaseId !== input.leaseId ||
      !upload.transferLeaseExpiresAt ||
      upload.transferLeaseExpiresAt.getTime() <= now.getTime() ||
      upload.expiresAt.getTime() <= now.getTime() ||
      Number(upload.receivedBytes) !== Number(upload.expectedSizeBytes)
    ) {
      conflict("Science provider output reservation lease was lost");
    }
    const version = await getScienceArtifactVersionForWorkspace(
      scoped,
      input.workspaceId,
      input.artifactVersionId,
    );
    if (
      !version ||
      version.artifactId !== upload.artifactId ||
      version.sha256 !== upload.expectedSha256 ||
      version.sizeBytes !== Number(upload.expectedSizeBytes) ||
      !["ready", "quarantined"].includes(version.status)
    ) {
      conflict("Science provider output reservation lacks a terminal immutable version");
    }
    const [deleted] = await scoped
      .delete(scienceUploads)
      .where(eq(scienceUploads.id, upload.id))
      .returning({ id: scienceUploads.id });
    return Boolean(deleted);
  });
}

/**
 * Transfer an internal provider-output reservation to an already-created
 * immutable version. The version remains quota-charged; deleting the matching
 * reservation prevents double charging without creating an admission gap.
 */
export async function quarantineScienceUpload(
  db: Db,
  input: {
    workspaceId: string;
    tokenHash: string;
    error: string;
    /** Partial external streams can be discarded immediately after timeout. */
    cleanupEligible?: boolean;
    now?: Date;
  },
) {
  const error = canonicalText(input.error, "Upload quarantine error", 4_000);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const upload = await lockUploadByToken(scoped, input.workspaceId, input.tokenHash);
    if (upload.state === "quarantined" && upload.error === error) return parseUpload(upload);
    if (["completed", "expired"].includes(upload.state)) {
      conflict(`Science upload in ${upload.state} cannot be quarantined`);
    }
    const now = input.now ?? new Date();
    const [row] = await scoped
      .update(scienceUploads)
      .set({
        state: "quarantined",
        transferLeaseId: null,
        transferLeaseExpiresAt: null,
        externalTransfer: false,
        finalizationLeaseId: null,
        cleanupAttempts: 0,
        cleanupNotBefore: null,
        expiresAt: input.cleanupEligible ? now : upload.expiresAt,
        error,
        updatedAt: now,
      })
      .where(eq(scienceUploads.id, upload.id))
      .returning();
    return parseUpload(row!);
  });
}

export async function cleanupExpiredScienceUploads(
  db: Db,
  input: { workspaceId?: string; now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const eligible = input.workspaceId
    ? and(
        eq(scienceUploads.workspaceId, input.workspaceId),
        lt(scienceUploads.expiresAt, now),
        inArray(scienceUploads.state, ["pending", "uploading", "finalizing"]),
      )
    : and(
        lt(scienceUploads.expiresAt, now),
        inArray(scienceUploads.state, ["pending", "uploading", "finalizing"]),
      );
  const candidates = db
    .select({ id: scienceUploads.id })
    .from(scienceUploads)
    .where(eligible)
    .orderBy(asc(scienceUploads.expiresAt), asc(scienceUploads.id))
    .limit(limit);
  await db
    .update(scienceUploads)
    .set({
      state: "expired",
      transferLeaseId: null,
      transferLeaseExpiresAt: null,
      externalTransfer: false,
      finalizationLeaseId: null,
      cleanupAttempts: 0,
      cleanupNotBefore: null,
      updatedAt: now,
    })
    // Keep the eligibility predicate on the UPDATE itself. PostgreSQL
    // re-checks it after waiting on a concurrently changed row, so a finalizer
    // or another cleanup cannot be overwritten by a stale candidate snapshot.
    .where(and(eligible, inArray(scienceUploads.id, candidates)))
    .returning();

  // Include rows expired by an earlier reconcile and quarantined transfers
  // whose evidence-retention TTL has elapsed. A crash or object-store failure
  // after the state transition must not make the quota reservation permanent.
  const cleanupEligible = input.workspaceId
    ? and(
        eq(scienceUploads.workspaceId, input.workspaceId),
        lt(scienceUploads.expiresAt, now),
        inArray(scienceUploads.state, ["expired", "quarantined"]),
        or(
          isNull(scienceUploads.cleanupNotBefore),
          lte(scienceUploads.cleanupNotBefore, now),
        ),
      )
    : and(
        lt(scienceUploads.expiresAt, now),
        inArray(scienceUploads.state, ["expired", "quarantined"]),
        or(
          isNull(scienceUploads.cleanupNotBefore),
          lte(scienceUploads.cleanupNotBefore, now),
        ),
      );
  const rows = await db
    .select()
    .from(scienceUploads)
    .where(cleanupEligible)
    .orderBy(
      asc(sql`coalesce(${scienceUploads.cleanupNotBefore}, ${scienceUploads.updatedAt})`),
      asc(scienceUploads.id),
    )
    .limit(limit);
  return rows.map(parseUpload);
}

/**
 * Release an expired/quarantined upload reservation only after the caller has
 * successfully removed its quarantine object. A failed discard therefore
 * leaves the row (and its conservative expected-size charge) intact.
 */
export async function deleteTerminalScienceUploadAfterDiscard(
  db: Db,
  input: { workspaceId: string; uploadId: string },
): Promise<boolean> {
  const [deleted] = await db
    .delete(scienceUploads)
    .where(
      and(
        eq(scienceUploads.id, input.uploadId),
        eq(scienceUploads.workspaceId, input.workspaceId),
        inArray(scienceUploads.state, ["expired", "quarantined"]),
      ),
    )
    .returning({ id: scienceUploads.id });
  if (deleted) return true;
  const [existing] = await db
    .select({ state: scienceUploads.state })
    .from(scienceUploads)
    .where(
      and(
        eq(scienceUploads.id, input.uploadId),
        eq(scienceUploads.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!existing) return false;
  conflict(`Science upload in ${existing.state} cannot release its storage reservation`);
}

export async function deferScienceUploadCleanup(
  db: Db,
  input: { workspaceId: string; uploadId: string; retryAt: Date; now?: Date },
): Promise<boolean> {
  const [deferred] = await db
    .update(scienceUploads)
    .set({
      cleanupAttempts: sql`${scienceUploads.cleanupAttempts} + 1`,
      cleanupNotBefore: input.retryAt,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(scienceUploads.id, input.uploadId),
        eq(scienceUploads.workspaceId, input.workspaceId),
        inArray(scienceUploads.state, ["expired", "quarantined"]),
      ),
    )
    .returning({ id: scienceUploads.id });
  return Boolean(deferred);
}

/** Backward-compatible explicit-expiry spelling used by existing callers. */
export async function deleteExpiredScienceUploadAfterDiscard(
  db: Db,
  input: { workspaceId: string; uploadId: string },
): Promise<boolean> {
  return deleteTerminalScienceUploadAfterDiscard(db, input);
}

/**
 * Quarantine keys still named by durable upload rows. Store-level orphan
 * cleanup must exclude every one of these keys across all workspaces; a
 * per-workspace exclusion set could delete another workspace's live upload.
 */
export async function listScienceProtectedQuarantineKeys(db: Db): Promise<string[]> {
  const rows = await db
    .select({ quarantineKey: scienceUploads.quarantineKey })
    .from(scienceUploads)
    .where(
      inArray(scienceUploads.state, [
        "pending",
        "uploading",
        "finalizing",
        "quarantined",
        "expired",
      ]),
    );
  return rows.map((row) => row.quarantineKey);
}

// --- Compute profiles ------------------------------------------------------------

export async function createScienceComputeProfile(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    providerKind: "local_container" | "jupyter_enterprise_gateway";
    imageDigest: string;
    kernelName: string;
    resourceBounds: unknown;
    config?: Record<string, unknown>;
    enabled?: boolean;
  },
) {
  const [row] = await db
    .insert(scienceComputeProfiles)
    .values({
      workspaceId: input.workspaceId,
      name: canonicalText(input.name, "Compute profile name", 200),
      providerKind: ScienceComputeProviderKind.parse(input.providerKind),
      imageDigest: ScienceOciDigest.parse(input.imageDigest),
      kernelName: canonicalText(input.kernelName, "Compute kernel name", 200),
      resourceBounds: ScienceResourceBounds.parse(input.resourceBounds),
      config: normalizeJson(input.config ?? {}, "Compute profile config") as Record<
        string,
        unknown
      >,
      enabled: input.enabled ?? true,
    })
    .returning();
  return parseProfile(row!);
}

export async function listScienceComputeProfiles(
  db: Db,
  input: { workspaceId: string; enabled?: boolean; page?: SciencePageInput },
) {
  const pagination = page(input.page);
  const rows = await db
    .select()
    .from(scienceComputeProfiles)
    .where(
      input.enabled === undefined
        ? eq(scienceComputeProfiles.workspaceId, input.workspaceId)
        : and(
            eq(scienceComputeProfiles.workspaceId, input.workspaceId),
            eq(scienceComputeProfiles.enabled, input.enabled),
          ),
    )
    .orderBy(desc(scienceComputeProfiles.createdAt), desc(scienceComputeProfiles.id))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseProfile), pagination.offset, pagination.limit);
}

export async function getScienceComputeProfileForWorkspace(
  db: Db,
  workspaceId: string,
  profileId: string,
) {
  const [row] = await db
    .select()
    .from(scienceComputeProfiles)
    .where(
      and(
        eq(scienceComputeProfiles.id, profileId),
        eq(scienceComputeProfiles.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ? parseProfile(row) : null;
}

export async function updateScienceComputeProfile(
  db: Db,
  input: {
    workspaceId: string;
    profileId: string;
    name?: string;
    providerKind?: "local_container" | "jupyter_enterprise_gateway";
    imageDigest?: string;
    kernelName?: string;
    resourceBounds?: unknown;
    config?: Record<string, unknown>;
    enabled?: boolean;
  },
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_compute_profiles where id = ${input.profileId} for update`,
    );
    const current = await getScienceComputeProfileForWorkspace(
      scoped,
      input.workspaceId,
      input.profileId,
    );
    if (!current) conflict("Science compute profile does not exist in the workspace");
    const patch: Partial<typeof scienceComputeProfiles.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      patch.name = canonicalText(input.name, "Compute profile name", 200);
    }
    if (input.providerKind !== undefined) {
      patch.providerKind = ScienceComputeProviderKind.parse(input.providerKind);
    }
    if (input.imageDigest !== undefined) {
      patch.imageDigest = ScienceOciDigest.parse(input.imageDigest);
    }
    if (input.kernelName !== undefined) {
      patch.kernelName = canonicalText(input.kernelName, "Compute kernel name", 200);
    }
    if (input.resourceBounds !== undefined) {
      patch.resourceBounds = ScienceResourceBounds.parse(input.resourceBounds);
    }
    if (input.config !== undefined) {
      patch.config = normalizeJson(input.config, "Compute profile config") as Record<
        string,
        unknown
      >;
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [row] = await scoped
      .update(scienceComputeProfiles)
      .set(patch)
      .where(eq(scienceComputeProfiles.id, current.id))
      .returning();
    return parseProfile(row!);
  });
}

// --- Runs, mission linkage, generation fencing, and lifecycle -------------------

function profileSnapshot(profile: ScienceComputeProfile): ScienceComputeSnapshot {
  return ScienceComputeSnapshot.parse({
    profileId: profile.id,
    providerKind: profile.providerKind,
    imageDigest: profile.imageDigest,
    kernelName: profile.kernelName,
    resourceBounds: profile.resourceBounds,
    config: profile.config,
  });
}

function validatedResourceRequest(
  value: unknown,
  ceiling: ScienceComputeProfile["resourceBounds"],
) {
  const request = ScienceResourceBounds.parse(value);
  const dimensions = [
    ["cpuMillicores", request.cpuMillicores, ceiling.cpuMillicores],
    ["memoryMb", request.memoryMb, ceiling.memoryMb],
    ["gpuCount", request.gpuCount, ceiling.gpuCount],
    ["wallTimeSeconds", request.wallTimeSeconds, ceiling.wallTimeSeconds],
  ] as const;
  for (const [name, requested, maximum] of dimensions) {
    if (requested > maximum) {
      conflict(`Science ${name} request ${requested} exceeds profile ceiling ${maximum}`);
    }
  }
  return request;
}

function missionStatusForScienceRun(state: typeof ScienceRunState._type): string {
  if (state === "awaiting_approval") return "awaiting_approval";
  if (state === "succeeded" || state === "failed" || state === "cancelled") return state;
  if (["provisioning", "running", "finalizing", "cancelling"].includes(state)) return "running";
  return "queued";
}

function missionStepStatusForScienceRun(state: typeof ScienceRunState._type): string {
  if (state === "awaiting_approval") return "awaiting_approval";
  if (state === "succeeded" || state === "failed") return state;
  if (state === "cancelled") return "skipped";
  if (["provisioning", "running", "finalizing", "cancelling"].includes(state)) return "running";
  return "pending";
}

function lifecycleEventForState(
  state: typeof ScienceRunState._type,
): typeof ScienceRunEventType._type | null {
  switch (state) {
    case "awaiting_approval":
      return "science.run.awaiting_approval";
    case "queued":
      return "science.run.queued";
    case "provisioning":
      return "science.run.provisioning";
    case "running":
      return "science.run.started";
    case "finalizing":
      return "science.run.finalizing";
    case "cancelling":
      return "science.run.cancelling";
    case "succeeded":
      return "science.run.succeeded";
    case "failed":
      return "science.run.failed";
    case "cancelled":
      return "science.run.cancelled";
    case "draft":
      return null;
  }
}

async function appendScienceRunEventLocked(
  db: Db,
  input: {
    run: ScienceRunRow;
    eventType: typeof ScienceRunEventType._type;
    payload?: Record<string, unknown>;
    createdAt?: Date;
  },
) {
  const [scope] = await db
    .select({ workspaceId: scienceStudies.workspaceId })
    .from(scienceStudies)
    .where(eq(scienceStudies.id, input.run.studyId))
    .limit(1);
  if (!scope) throw new Error(`Science run ${input.run.id} is missing its study`);
  const validated = ScienceRunEvent.pick({
    workspaceId: true,
    studyId: true,
    runId: true,
    missionId: true,
    eventType: true,
    executionGeneration: true,
    state: true,
    payload: true,
  }).parse({
    workspaceId: scope.workspaceId,
    studyId: input.run.studyId,
    runId: input.run.id,
    missionId: input.run.missionId,
    eventType: input.eventType,
    executionGeneration: input.run.executionGeneration,
    state: input.run.state,
    payload: normalizeJson(input.payload ?? {}, "Science run event payload"),
  });
  const [last] = await db
    .select({ value: sql<number>`coalesce(max(${scienceRunEvents.sequence}), 0)` })
    .from(scienceRunEvents)
    .where(eq(scienceRunEvents.runId, input.run.id));
  const [row] = await db
    .insert(scienceRunEvents)
    .values({
      workspaceId: validated.workspaceId,
      studyId: validated.studyId,
      runId: input.run.id,
      missionId: validated.missionId,
      sequence: Number(last?.value ?? 0) + 1,
      eventType: validated.eventType,
      executionGeneration: validated.executionGeneration,
      state: validated.state,
      payload: validated.payload,
      createdAt: input.createdAt,
    })
    .returning();
  return parseRunEvent(row!);
}

export async function createScienceRun(
  db: Db,
  input: {
    workspaceId: string;
    studyId: string;
    computeProfileId: string;
    resourceRequest: unknown;
    idempotencyKey: string;
    inputs: Array<{
      artifactVersionId: string;
      semanticRole: string;
    }>;
    parameters?: Record<string, unknown>;
    createdBy: string;
  },
): Promise<{
  run: ScienceRun;
  mission: typeof missions.$inferSelect;
  created: boolean;
}> {
  const idempotencyKey = canonicalText(input.idempotencyKey, "Run idempotency key", 200);
  const parameters = normalizeJson(input.parameters ?? {}, "Science run parameters") as Record<
    string,
    unknown
  >;
  if (input.inputs.length === 0) {
    conflict("A science run requires at least one ready input");
  }
  if (input.inputs.length > 200) {
    conflict("A science run accepts at most 200 input links");
  }
  const canonicalInputs = input.inputs
    .map((entry) => ({
      artifactVersionId: entry.artifactVersionId,
      semanticRole: canonicalText(entry.semanticRole, "Artifact semantic role", 128),
    }))
    .sort(
      (left, right) =>
        left.artifactVersionId.localeCompare(right.artifactVersionId) ||
        left.semanticRole.localeCompare(right.semanticRole),
    );
  const inputKeys = canonicalInputs.map(
    (entry) => `${entry.artifactVersionId}:${entry.semanticRole}`,
  );
  if (new Set(inputKeys).size !== inputKeys.length) {
    conflict("Duplicate science run input");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const study = await lockStudy(scoped, input.studyId);
    if (study.workspaceId !== input.workspaceId) conflict("Science study is outside the workspace");
    if (study.status !== "active") conflict("Archived science studies are read-only");

    const [existing] = await scoped
      .select()
      .from(scienceRuns)
      .where(
        and(
          eq(scienceRuns.studyId, study.id),
          eq(scienceRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.computeProfileId !== input.computeProfileId ||
        existing.createdBy !== input.createdBy ||
        !sameJson(existing.resourceRequest, ScienceResourceBounds.parse(input.resourceRequest)) ||
        !sameJson(existing.parameters, parameters)
      ) {
        conflict("Run idempotency key was already used for a different intent");
      }
      const existingInputs = await scoped
        .select({
          artifactVersionId: scienceRunArtifacts.artifactVersionId,
          semanticRole: scienceRunArtifacts.semanticRole,
        })
        .from(scienceRunArtifacts)
        .where(
          and(
            eq(scienceRunArtifacts.runId, existing.id),
            eq(scienceRunArtifacts.direction, "input"),
          ),
        );
      const existingInputKeys = existingInputs
        .map((entry) => `${entry.artifactVersionId}:${entry.semanticRole}`)
        .sort();
      if (!sameJson(existingInputKeys, inputKeys)) {
        conflict("Run idempotency key was already used with different inputs");
      }
      const [mission] = await scoped
        .select()
        .from(missions)
        .where(eq(missions.id, existing.missionId))
        .limit(1);
      if (!mission) throw new Error(`Science run ${existing.id} is missing its required mission`);
      return { run: parseRun(existing), mission, created: false };
    }

    const profile = await getScienceComputeProfileForWorkspace(
      scoped,
      input.workspaceId,
      input.computeProfileId,
    );
    if (!profile) conflict("Science compute profile is outside the workspace");
    if (!profile.enabled) conflict("Disabled science compute profiles cannot start new runs");
    const snapshot = profileSnapshot(profile);
    const resourceRequest = validatedResourceRequest(input.resourceRequest, profile.resourceBounds);
    // Serialize run-input admission with administrator retention claims. The
    // study lock above gives both operations a stable ordering; the version
    // locks make a ready check and subsequent links one atomic decision.
    await scoped.execute(
      sql`select id from science_artifact_versions
           where id in (${sql.join(
             canonicalInputs.map((entry) => sql`${entry.artifactVersionId}`),
             sql`, `,
           )})
           order by id
           for update`,
    );
    const ownedInputs = await scoped
      .select({
        version: scienceArtifactVersions,
        studyId: scienceArtifacts.studyId,
        artifactKind: scienceArtifacts.kind,
        artifactFormat: scienceArtifacts.format,
        workspaceId: scienceStudies.workspaceId,
      })
      .from(scienceArtifactVersions)
      .innerJoin(
        scienceArtifacts,
        eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
      )
      .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
      .where(
        inArray(
          scienceArtifactVersions.id,
          canonicalInputs.map((entry) => entry.artifactVersionId),
        ),
      );
    const ownedById = new Map(ownedInputs.map((entry) => [entry.version.id, entry]));
    for (const entry of canonicalInputs) {
      const owned = ownedById.get(entry.artifactVersionId);
      if (
        !owned ||
        owned.workspaceId !== input.workspaceId ||
        owned.studyId !== study.id
      ) {
        conflict("Science run inputs must belong to the same workspace and study");
      }
      if (owned.version.status !== "ready") {
        conflict("Pending, quarantined, or expired artifacts cannot be run inputs");
      }
      if (
        ["code", "notebook", "solver"].includes(entry.semanticRole) &&
        !isParsedIpynbArtifactVersion(owned.version, {
          kind: owned.artifactKind,
          format: owned.artifactFormat,
        })
      ) {
        conflict(
          "Science code, notebook, or solver roles require a parsed ipynb notebook artifact",
        );
      }
    }
    const runId = randomUUID();
    const missionId = randomUUID();
    const [mission] = await scoped
      .insert(missions)
      .values({
        id: missionId,
        workspaceId: input.workspaceId,
        kind: "science",
        subjectId: runId,
        workflowVersionId: null,
        parentMissionId: null,
        status: "queued",
        trigger: {
          mode: "science",
          studyId: study.id,
          idempotencyKey,
        },
        input: {
          runId,
          studyId: study.id,
          compute: snapshot,
          resourceRequest,
          parameters,
          inputs: canonicalInputs,
        },
        cursor: {},
      })
      .returning();
    const [row] = await scoped
      .insert(scienceRuns)
      .values({
        id: runId,
        studyId: study.id,
        missionId,
        computeProfileId: profile.id,
        profileSnapshot: snapshot,
        resourceRequest,
        state: "draft",
        executionGeneration: 0,
        idempotencyKey,
        parameters,
        createdBy: input.createdBy,
      })
      .returning();
    await scoped.insert(missionSteps).values({
      missionId,
      nodeId: "science.run",
      kind: "science",
      status: "pending",
      attempt: 0,
      input: { runId, studyId: study.id },
    });
    await scoped.insert(scienceRunArtifacts).values(
      canonicalInputs.map((entry) => ({
        runId,
        artifactVersionId: entry.artifactVersionId,
        direction: "input",
        semanticRole: entry.semanticRole,
      })),
    );
    return { run: parseRun(row!), mission: mission!, created: true };
  });
}

export async function listScienceRuns(
  db: Db,
  input: {
    workspaceId: string;
    studyId: string;
    state?: typeof ScienceRunState._type;
    page?: SciencePageInput;
  },
) {
  const study = await getScienceStudyForWorkspace(db, input.workspaceId, input.studyId);
  if (!study) return { items: [], nextOffset: null } satisfies SciencePage<ScienceRun>;
  const pagination = page(input.page);
  const state = input.state === undefined ? undefined : ScienceRunState.parse(input.state);
  const rows = await db
    .select()
    .from(scienceRuns)
    .where(
      state
        ? and(eq(scienceRuns.studyId, study.id), eq(scienceRuns.state, state))
        : eq(scienceRuns.studyId, study.id),
    )
    .orderBy(desc(scienceRuns.createdAt), desc(scienceRuns.id))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseRun), pagination.offset, pagination.limit);
}

export async function getScienceRunForWorkspace(db: Db, workspaceId: string, runId: string) {
  const [owned] = await db
    .select({ run: scienceRuns })
    .from(scienceRuns)
    .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
    .where(and(eq(scienceRuns.id, runId), eq(scienceStudies.workspaceId, workspaceId)))
    .limit(1);
  return owned ? parseRun(owned.run) : null;
}

type ScienceDomainValidationHashInput = Omit<
  ScienceDomainValidationRecord,
  "recordHash" | "createdAt"
>;

function domainValidationHashPayload(input: ScienceDomainValidationHashInput) {
  const canonicalChecksums = (entries: ScienceValidationOutputChecksum[] | null) =>
    entries?.map((entry) => ({
      ...entry,
      artifactVersionId: entry.artifactVersionId.toLowerCase(),
    })) ?? null;
  return {
    schemaVersion: 2,
    id: input.id.toLowerCase(),
    workspaceId: input.workspaceId.toLowerCase(),
    runId: input.runId.toLowerCase(),
    revision: input.revision,
    baselineRunId: input.baselineRunId?.toLowerCase() ?? null,
    kind: input.kind,
    metric: input.metric,
    tolerance: input.tolerance,
    observedValue: input.observedValue,
    units: input.units,
    methodProtocolId: input.methodProtocolId,
    decision: input.decision,
    limitationsReason: input.limitationsReason,
    reviewerId: input.reviewerId.toLowerCase(),
    reviewerRole: input.reviewerRole,
    runManifestHash: input.runManifestHash,
    runOutputChecksums: canonicalChecksums(input.runOutputChecksums),
    baselineManifestHash: input.baselineManifestHash,
    baselineOutputChecksums: canonicalChecksums(input.baselineOutputChecksums),
  };
}

interface ScienceDomainValidationHeadHashInput {
  id: string;
  workspaceId: string;
  runId: string;
  kind: ScienceDomainValidationRecord["kind"];
  scopeBaselineRunId: string;
  validationId: string;
  revision: number;
  recordHash: string;
}

interface ScienceDomainValidationHeadScope {
  workspaceId: string;
  runId: string;
  kind: ScienceDomainValidationRecord["kind"];
  scopeBaselineRunId: string;
}

/** Deterministic UUIDv8 identity for one immutable validation-head scope. */
export function scienceDomainValidationHeadId(
  input: ScienceDomainValidationHeadScope,
): string {
  const digest = createHash("sha256").update([
    "science-domain-validation-head-id-v1",
    input.workspaceId.toLowerCase(),
    input.runId.toLowerCase(),
    input.kind,
    input.scopeBaselineRunId.toLowerCase(),
  ].join("|"), "utf8").digest("hex");
  return ScienceStudy.shape.id.parse([
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-"));
}

/** Stable anchor binding one exact canonical scope to one immutable record. */
export function scienceDomainValidationHeadHash(
  input: ScienceDomainValidationHeadHashInput,
): string {
  const payload = [
    "science-domain-validation-head-v1",
    input.id.toLowerCase(),
    input.workspaceId.toLowerCase(),
    input.runId.toLowerCase(),
    input.kind,
    input.scopeBaselineRunId.toLowerCase(),
    input.validationId.toLowerCase(),
    String(input.revision),
    input.recordHash,
  ].join("|");
  return ScienceSha256.parse(createHash("sha256").update(payload, "utf8").digest("hex"));
}

/** Stable SHA-256 envelope for independently checking one immutable review. */
export function scienceDomainValidationRecordHash(
  input: ScienceDomainValidationHashInput,
): string {
  return ScienceSha256.parse(
    createHash("sha256")
      .update(canonicalScienceJson(domainValidationHashPayload(input)))
      .digest("hex"),
  );
}

export function verifyScienceDomainValidationRecordHash(
  value: ScienceDomainValidationRecord,
): boolean {
  const parsed = ScienceDomainValidationRecord.parse(value);
  const { recordHash, createdAt: _createdAt, ...hashable } = parsed;
  return scienceDomainValidationRecordHash(hashable) === recordHash;
}

function succeededRunValidationSnapshot(runRow: ScienceRunRow): {
  manifestHash: string;
  outputs: ScienceValidationOutputChecksum[];
} {
  const run = parseRun(runRow);
  if (run.state !== "succeeded" || !run.manifest || !run.manifestHash) {
    conflict("Science domain validation requires a succeeded run with a manifest");
  }
  const calculated = createHash("sha256")
    .update(canonicalScienceJson(run.manifest))
    .digest("hex");
  if (calculated !== run.manifestHash) {
    conflict("Science run manifest hash does not match its immutable manifest");
  }
  const outputs = run.manifest.outputs.map((entry) =>
    ScienceValidationOutputChecksum.parse(entry)
  );
  if (outputs.length === 0) {
    conflict("Science domain validation requires at least one manifested output");
  }
  return { manifestHash: run.manifestHash, outputs };
}

/** Canonical total order used before taking any candidate/baseline run locks. */
export function scienceDomainValidationRunLockOrder(
  runId: string,
  baselineRunId?: string | null,
): string[] {
  const candidate = ScienceStudy.shape.id.parse(runId).toLowerCase();
  const baseline = baselineRunId === null || baselineRunId === undefined
    ? null
    : ScienceStudy.shape.id.parse(baselineRunId).toLowerCase();
  return [...new Set([candidate, ...(baseline ? [baseline] : [])])].sort();
}

/**
 * Append one actor-attributed review. The reviewer identity/role is supplied by
 * the authenticated service boundary and is rechecked against membership by
 * the database guard in the same transaction.
 */
export async function createScienceDomainValidation(
  db: Db,
  input: ScienceDomainValidationSubmission & {
    workspaceId: string;
    runId: string;
    reviewerId: string;
    reviewerRole: "admin" | "owner";
  },
) {
  const untrustedInput = input as unknown as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(untrustedInput, "createdAt") ||
    Object.prototype.hasOwnProperty.call(untrustedInput, "revision")
  ) {
    throw new Error(
      "Science domain validation revision and createdAt are database-assigned",
    );
  }
  const submission = ScienceDomainValidationSubmission.parse({
    kind: input.kind,
    baselineRunId: input.baselineRunId,
    metric: input.metric,
    tolerance: input.tolerance,
    observedValue: input.observedValue,
    units: input.units,
    methodProtocolId: input.methodProtocolId,
    decision: input.decision,
    limitationsReason: input.limitationsReason,
  });
  const workspaceId = ScienceStudy.shape.workspaceId.parse(input.workspaceId).toLowerCase();
  const runId = ScienceStudy.shape.id.parse(input.runId).toLowerCase();
  const reviewerId = ScienceStudy.shape.createdBy.parse(input.reviewerId).toLowerCase();
  const reviewerRole = input.reviewerRole;
  if (reviewerRole !== "admin" && reviewerRole !== "owner") {
    throw new Error("Science domain validation reviewer role must be admin or owner");
  }
  const baselineRunId = submission.baselineRunId?.toLowerCase() ?? null;
  if (baselineRunId === runId) {
    conflict("A numerical-equivalence baseline must be a different run");
  }

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const locked = new Map<string, ScienceRunRow>();
    for (const id of scienceDomainValidationRunLockOrder(runId, baselineRunId)) {
      locked.set(id, await lockRunForWorkspace(scoped, workspaceId, id));
    }
    const runSnapshot = succeededRunValidationSnapshot(locked.get(runId)!);
    const baselineSnapshot = baselineRunId
      ? succeededRunValidationSnapshot(locked.get(baselineRunId)!)
      : null;
    const [revisionRow] = await scoped
      .select({
        nextRevision: sql<number>`coalesce(max(${scienceDomainValidations.revision}), 0) + 1`,
      })
      .from(scienceDomainValidations)
      .where(eq(scienceDomainValidations.runId, runId));
    const revision = Number(revisionRow?.nextRevision);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error("Science domain validation revision is invalid");
    }
    const hashable: ScienceDomainValidationHashInput = {
      id: randomUUID(),
      workspaceId,
      runId,
      revision,
      baselineRunId,
      kind: submission.kind,
      metric: submission.metric,
      tolerance: submission.tolerance,
      observedValue: submission.observedValue,
      units: submission.units,
      methodProtocolId: submission.methodProtocolId,
      decision: submission.decision,
      limitationsReason: submission.limitationsReason,
      reviewerId,
      reviewerRole,
      runManifestHash: runSnapshot.manifestHash,
      runOutputChecksums: runSnapshot.outputs,
      baselineManifestHash: baselineSnapshot?.manifestHash ?? null,
      baselineOutputChecksums: baselineSnapshot?.outputs ?? null,
    };
    const recordHash = scienceDomainValidationRecordHash(hashable);
    const [row] = await scoped
      .insert(scienceDomainValidations)
      .values({ ...hashable, recordHash })
      .returning();
    if (!row) throw new Error("Science domain validation insert returned no row");
    const scopeBaselineRunId = baselineRunId ?? runId;
    const [existingHead] = await scoped
      .select({ id: scienceDomainValidationHeads.id })
      .from(scienceDomainValidationHeads)
      .where(and(
        eq(scienceDomainValidationHeads.workspaceId, workspaceId),
        eq(scienceDomainValidationHeads.runId, runId),
        eq(scienceDomainValidationHeads.kind, submission.kind),
        eq(scienceDomainValidationHeads.scopeBaselineRunId, scopeBaselineRunId),
      ))
      .limit(1);
    const headId = existingHead?.id ?? scienceDomainValidationHeadId({
      workspaceId,
      runId,
      kind: submission.kind,
      scopeBaselineRunId,
    });
    const headHash = scienceDomainValidationHeadHash({
      id: headId,
      workspaceId,
      runId,
      kind: submission.kind,
      scopeBaselineRunId,
      validationId: hashable.id,
      revision,
      recordHash,
    });
    const headValues = {
      validationId: hashable.id,
      revision,
      recordHash,
      headHash,
    };
    if (existingHead) {
      const [advanced] = await scoped
        .update(scienceDomainValidationHeads)
        .set(headValues)
        .where(eq(scienceDomainValidationHeads.id, headId))
        .returning({ id: scienceDomainValidationHeads.id });
      if (!advanced) throw new Error("Science domain validation head advance returned no row");
    } else {
      const [created] = await scoped
        .insert(scienceDomainValidationHeads)
        .values({
          id: headId,
          workspaceId,
          runId,
          kind: submission.kind,
          scopeBaselineRunId,
          ...headValues,
        })
        .returning({ id: scienceDomainValidationHeads.id });
      if (!created) throw new Error("Science domain validation head insert returned no row");
    }
    return parseDomainValidation(row);
  });
}

export async function listScienceDomainValidations(
  db: Db,
  input: { workspaceId: string; runId: string; page?: SciencePageInput },
) {
  const workspaceId = ScienceStudy.shape.workspaceId.parse(input.workspaceId).toLowerCase();
  const runId = ScienceStudy.shape.id.parse(input.runId).toLowerCase();
  const run = await getScienceRunForWorkspace(db, workspaceId, runId);
  if (!run) {
    return { items: [], nextOffset: null } satisfies SciencePage<ScienceDomainValidationSummary>;
  }
  const pagination = page(input.page);
  const rows = await db
    .select({
      id: scienceDomainValidations.id,
      runId: scienceDomainValidations.runId,
      revision: scienceDomainValidations.revision,
      baselineRunId: scienceDomainValidations.baselineRunId,
      kind: scienceDomainValidations.kind,
      metric: scienceDomainValidations.metric,
      tolerance: scienceDomainValidations.tolerance,
      observedValue: scienceDomainValidations.observedValue,
      units: scienceDomainValidations.units,
      methodProtocolId: scienceDomainValidations.methodProtocolId,
      decision: scienceDomainValidations.decision,
      limitationsReason: scienceDomainValidations.limitationsReason,
      reviewerId: scienceDomainValidations.reviewerId,
      reviewerRole: scienceDomainValidations.reviewerRole,
      runManifestHash: scienceDomainValidations.runManifestHash,
      baselineManifestHash: scienceDomainValidations.baselineManifestHash,
      createdAt: scienceDomainValidations.createdAt,
      recordHash: scienceDomainValidations.recordHash,
    })
    .from(scienceDomainValidations)
    .where(and(
      eq(scienceDomainValidations.workspaceId, workspaceId),
      eq(scienceDomainValidations.runId, runId),
    ))
    .orderBy(desc(scienceDomainValidations.revision))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseDomainValidationSummary), pagination.offset, pagination.limit);
}

export async function getScienceDomainValidationForRun(
  db: Db,
  input: { workspaceId: string; runId: string; validationId: string },
) {
  const workspaceId = ScienceStudy.shape.workspaceId.parse(input.workspaceId).toLowerCase();
  const runId = ScienceStudy.shape.id.parse(input.runId).toLowerCase();
  const validationId = ScienceStudy.shape.id.parse(input.validationId).toLowerCase();
  const [row] = await db
    .select()
    .from(scienceDomainValidations)
    .where(and(
      eq(scienceDomainValidations.id, validationId),
      eq(scienceDomainValidations.workspaceId, workspaceId),
      eq(scienceDomainValidations.runId, runId),
    ))
    .limit(1);
  if (!row) return null;
  const parsed = ScienceDomainValidationRecord.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export async function getLatestScienceLinkedNumericalEquivalenceRecord(
  db: Db,
  input: { workspaceId: string; baselineRunId: string; candidateRunId: string },
) {
  const workspaceId = ScienceStudy.shape.workspaceId.parse(input.workspaceId).toLowerCase();
  const baselineRunId = ScienceStudy.shape.id.parse(input.baselineRunId).toLowerCase();
  const candidateRunId = ScienceStudy.shape.id.parse(input.candidateRunId).toLowerCase();
  const [row] = await db
    .select({
      head: scienceDomainValidationHeads,
      validation: scienceDomainValidations,
    })
    .from(scienceDomainValidationHeads)
    .innerJoin(
      scienceDomainValidations,
      eq(scienceDomainValidations.id, scienceDomainValidationHeads.validationId),
    )
    .where(and(
      eq(scienceDomainValidationHeads.workspaceId, workspaceId),
      eq(scienceDomainValidationHeads.runId, candidateRunId),
      eq(scienceDomainValidationHeads.kind, "numerical-equivalence"),
      eq(scienceDomainValidationHeads.scopeBaselineRunId, baselineRunId),
    ))
    .limit(1);
  if (!row) return null;
  const parsed = ScienceDomainValidationRecord.safeParse(row.validation);
  if (!parsed.success) return null;
  const record = parsed.data;
  try {
    const headHash = ScienceSha256.parse(row.head.headHash);
    const recordHash = ScienceSha256.parse(row.head.recordHash);
    if (
      row.head.id.toLowerCase() !== row.head.id ||
      row.head.workspaceId !== workspaceId ||
      row.head.runId !== candidateRunId ||
      row.head.kind !== "numerical-equivalence" ||
      row.head.scopeBaselineRunId !== baselineRunId ||
      row.head.validationId !== record.id ||
      row.head.revision !== record.revision ||
      recordHash !== record.recordHash ||
      record.workspaceId !== workspaceId ||
      record.runId !== candidateRunId ||
      record.kind !== "numerical-equivalence" ||
      record.baselineRunId !== baselineRunId ||
      !verifyScienceDomainValidationRecordHash(record) ||
      scienceDomainValidationHeadHash({
        id: row.head.id,
        workspaceId: row.head.workspaceId,
        runId: row.head.runId,
        kind: "numerical-equivalence",
        scopeBaselineRunId: row.head.scopeBaselineRunId,
        validationId: row.head.validationId,
        revision: row.head.revision,
        recordHash,
      }) !== headHash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return record;
}

export async function getScienceRunByMissionForWorkspace(
  db: Db,
  workspaceId: string,
  missionId: string,
) {
  const [owned] = await db
    .select({ run: scienceRuns })
    .from(scienceRuns)
    .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
    .where(
      and(eq(scienceRuns.missionId, missionId), eq(scienceStudies.workspaceId, workspaceId)),
    )
    .limit(1);
  return owned ? parseRun(owned.run) : null;
}

/**
 * Dispatcher/reconciler work only. Draft and approval-blocked runs consume no
 * compute slot and deliberately stay out of this result.
 */
export async function listRecoverableScienceRuns(
  db: Db,
  input: { workspaceId?: string; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const activeStates = ["queued", "provisioning", "running", "finalizing", "cancelling"];
  const rows = await db
    .select({ run: scienceRuns })
    .from(scienceRuns)
    .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
    .where(
      input.workspaceId
        ? and(
            eq(scienceStudies.workspaceId, input.workspaceId),
            inArray(scienceRuns.state, activeStates),
          )
        : inArray(scienceRuns.state, activeStates),
    )
    .orderBy(asc(scienceRuns.createdAt), asc(scienceRuns.id))
    .limit(limit);
  return rows.map((row) => parseRun(row.run));
}

/** Count queued or execution-owning runs for workspace concurrency quotas. */
export async function countActiveScienceRuns(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)` })
    .from(scienceRuns)
    .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
    .where(
      and(
        eq(scienceStudies.workspaceId, workspaceId),
        inArray(scienceRuns.state, [
          "queued",
          "provisioning",
          "running",
          "finalizing",
          "cancelling",
        ]),
      ),
    );
  return Number(row?.value ?? 0);
}

export async function getLatestScienceRunEvent(
  db: Db,
  workspaceId: string,
  runId: string,
) {
  const run = await getScienceRunForWorkspace(db, workspaceId, runId);
  if (!run) return null;
  const [row] = await db
    .select()
    .from(scienceRunEvents)
    .where(eq(scienceRunEvents.runId, run.id))
    .orderBy(desc(scienceRunEvents.sequence))
    .limit(1);
  return row ? parseRunEvent(row) : null;
}

export async function requestScienceRunApproval(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    prompt: string;
    tier?: string;
    nodeId?: string;
    now?: Date;
  },
) {
  const prompt = canonicalText(input.prompt, "Science approval prompt", 4_000);
  const tier = canonicalText(input.tier ?? "write_approved", "Science approval tier", 100);
  const nodeId = canonicalText(input.nodeId ?? "science.run", "Science approval node", 300);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    if (!["draft", "awaiting_approval"].includes(run.state)) {
      conflict(`Science run in ${run.state} cannot request approval`);
    }
    await scoped.execute(sql`select id from missions where id = ${run.missionId} for update`);
    const [existing] = await scoped
      .select()
      .from(approvals)
      .where(and(eq(approvals.missionId, run.missionId), eq(approvals.nodeId, nodeId)))
      .orderBy(desc(approvals.createdAt))
      .limit(1);
    if (existing && existing.status !== "pending") {
      conflict("Science run approval was already resolved");
    }
    if (
      existing &&
      (existing.prompt !== prompt || existing.tier !== tier)
    ) {
      conflict("Pending science approval cannot be changed by an idempotent retry");
    }
    let approval = existing;
    let created = false;
    if (!approval) {
      [approval] = await scoped
        .insert(approvals)
        .values({
          missionId: run.missionId,
          nodeId,
          prompt,
          tier,
          status: "pending",
        })
        .returning();
      created = true;
    }
    if (run.state === "awaiting_approval") {
      const latestEvent = await getLatestScienceRunEvent(scoped, input.workspaceId, run.id);
      return { run: parseRun(run), approval: approval!, event: latestEvent, created };
    }
    const now = input.now ?? new Date();
    const [updated] = await scoped
      .update(scienceRuns)
      .set({ state: "awaiting_approval", updatedAt: now })
      .where(
        and(
          eq(scienceRuns.id, run.id),
          eq(scienceRuns.state, "draft"),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
        ),
      )
      .returning();
    if (!updated) conflict("Science approval request lost a concurrent race");
    await scoped
      .update(missions)
      .set({ status: "awaiting_approval" })
      .where(eq(missions.id, run.missionId));
    await scoped
      .update(missionSteps)
      .set({ status: "awaiting_approval" })
      .where(and(eq(missionSteps.missionId, run.missionId), eq(missionSteps.nodeId, "science.run")));
    const event = await appendScienceRunEventLocked(scoped, {
      run: updated,
      eventType: "science.run.awaiting_approval",
      payload: { approvalId: approval!.id, tier, nodeId },
      createdAt: now,
    });
    return { run: parseRun(updated), approval: approval!, event, created };
  });
}

export async function resolveScienceRunApproval(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    approvalId: string;
    decision: "approved" | "rejected";
    /** Atomic workspace concurrency ceiling. Omit only when quota is disabled. */
    maxActiveRuns?: number;
    now?: Date;
  },
) {
  if (
    input.maxActiveRuns !== undefined &&
    (!Number.isSafeInteger(input.maxActiveRuns) || input.maxActiveRuns < 1)
  ) {
    throw new Error("Science maxActiveRuns must be a positive safe integer");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    await scoped.execute(sql`select id from approvals where id = ${input.approvalId} for update`);
    const [approval] = await scoped
      .select()
      .from(approvals)
      .where(eq(approvals.id, input.approvalId))
      .limit(1);
    if (!approval || approval.missionId !== run.missionId) {
      conflict("Science approval does not belong to the run mission");
    }
    const target = input.decision === "approved" ? "queued" : "cancelled";
    if (approval.status === input.decision && run.state === target) {
      return {
        run: parseRun(run),
        approval,
        event: await getLatestScienceRunEvent(scoped, input.workspaceId, run.id),
        transitioned: false,
      };
    }
    if (approval.status !== "pending") conflict("Science approval was already resolved differently");
    if (run.state !== "awaiting_approval") {
      conflict(`Science run in ${run.state} cannot resolve approval`);
    }
    if (input.decision === "approved" && input.maxActiveRuns !== undefined) {
      // All approval-to-queue paths serialize on the workspace row. This makes
      // the count and queued transition one quota decision across processes.
      await scoped.execute(
        sql`select id from workspaces where id = ${input.workspaceId} for update`,
      );
      const activeRuns = await countActiveScienceRuns(scoped, input.workspaceId);
      if (activeRuns >= input.maxActiveRuns) {
        conflict(
          `Science workspace active-run quota ${input.maxActiveRuns} has been reached`,
        );
      }
    }
    const now = input.now ?? new Date();
    const [resolved] = await scoped
      .update(approvals)
      .set({ status: input.decision, decidedAt: now })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
      .returning();
    if (!resolved) conflict("Science approval resolution lost a concurrent race");
    const [updated] = await scoped
      .update(scienceRuns)
      .set({
        state: target,
        updatedAt: now,
        finishedAt: target === "cancelled" ? now : null,
      })
      .where(
        and(
          eq(scienceRuns.id, run.id),
          eq(scienceRuns.state, "awaiting_approval"),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
        ),
      )
      .returning();
    if (!updated) conflict("Science approval transition lost a concurrent race");
    await scoped
      .update(missions)
      .set({
        status: target,
        finishedAt: target === "cancelled" ? now : null,
      })
      .where(eq(missions.id, run.missionId));
    await scoped
      .update(missionSteps)
      .set({
        status: target === "cancelled" ? "skipped" : "pending",
        finishedAt: target === "cancelled" ? now : null,
      })
      .where(and(eq(missionSteps.missionId, run.missionId), eq(missionSteps.nodeId, "science.run")));
    const event = await appendScienceRunEventLocked(scoped, {
      run: updated,
      eventType:
        target === "queued" ? "science.run.queued" : "science.run.cancelled",
      payload: { approvalId: resolved.id, decision: input.decision },
      createdAt: now,
    });
    if (target === "cancelled") {
      await markWorkflowWaitsReadyForScienceRun(scoped, { runId: updated.id, now });
    }
    return { run: parseRun(updated), approval: resolved, event, transitioned: true };
  });
}

/**
 * Claim is the only queued -> provisioning path. Its generation increment is
 * the fencing token that every worker-side mutation must carry.
 */
export async function claimScienceRun(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    providerHandle?: string | null;
    now?: Date;
  },
) {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error("Expected run generation must be a nonnegative safe integer");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const current = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (current.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    if (current.state !== "queued") conflict("Only queued science runs can be claimed");
    const now = input.now ?? new Date();
    const executionGeneration = current.executionGeneration + 1;
    const providerHandle =
      input.providerHandle == null
        ? null
        : canonicalText(input.providerHandle, "Provider handle", 500);
    const [row] = await scoped
      .update(scienceRuns)
      .set({
        state: "provisioning",
        executionGeneration,
        providerHandle,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
        error: null,
      })
      .where(
        and(
          eq(scienceRuns.id, current.id),
          eq(scienceRuns.state, "queued"),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
        ),
      )
      .returning();
    if (!row) conflict("Science run claim lost a concurrent race");
    await scoped
      .update(missions)
      .set({ status: "running", error: null })
      .where(eq(missions.id, row.missionId));
    await scoped
      .update(missionSteps)
      .set({ status: "running", attempt: executionGeneration })
      .where(and(eq(missionSteps.missionId, row.missionId), eq(missionSteps.nodeId, "science.run")));
    await appendScienceRunEventLocked(scoped, {
      run: row,
      eventType: "science.run.provisioning",
      payload: { executionGeneration },
      createdAt: now,
    });
    return { run: parseRun(row), executionGeneration };
  });
}

function assertScienceRunLease(
  run: ScienceRunRow,
  leaseOwner: string | undefined,
  now: Date,
): string {
  const owner = canonicalText(leaseOwner ?? "", "Science run lease owner", 300);
  if (run.leaseOwner !== owner) {
    conflict(`Science run ${run.id} is leased by another worker`);
  }
  if (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= now.getTime()) {
    conflict(`Science run ${run.id} worker lease has expired`);
  }
  return owner;
}

export async function acquireScienceRunLease(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
) {
  const leaseOwner = canonicalText(input.leaseOwner, "Science run lease owner", 300);
  const now = input.now ?? new Date();
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    input.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science run lease expiry must be in the future");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    if (!["provisioning", "running", "finalizing", "cancelling"].includes(run.state)) {
      conflict(`Science run in ${run.state} cannot be leased`);
    }
    const liveLease =
      run.leaseOwner !== null &&
      run.leaseExpiresAt !== null &&
      run.leaseExpiresAt.getTime() > now.getTime();
    if (liveLease && run.leaseOwner !== leaseOwner) {
      conflict(`Science run ${run.id} already has a live worker lease`);
    }
    if (
      liveLease &&
      run.leaseOwner === leaseOwner &&
      run.leaseExpiresAt!.getTime() === input.leaseExpiresAt.getTime()
    ) {
      return parseRun(run);
    }
    const [row] = await scoped
      .update(scienceRuns)
      .set({
        leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(scienceRuns.id, run.id),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
        ),
      )
      .returning();
    if (!row) conflict("Science run lease acquisition lost a concurrent race");
    return parseRun(row);
  });
}

export async function renewScienceRunLease(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
) {
  const leaseOwner = canonicalText(input.leaseOwner, "Science run lease owner", 300);
  const now = input.now ?? new Date();
  if (
    !(input.leaseExpiresAt instanceof Date) ||
    input.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Science run lease expiry must be in the future");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    assertScienceRunLease(run, leaseOwner, now);
    if (
      run.leaseExpiresAt &&
      input.leaseExpiresAt.getTime() < run.leaseExpiresAt.getTime()
    ) {
      conflict("Science run lease renewal cannot shorten the lease");
    }
    const [row] = await scoped
      .update(scienceRuns)
      .set({
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(scienceRuns.id, run.id),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
          eq(scienceRuns.leaseOwner, leaseOwner),
        ),
      )
      .returning();
    if (!row) conflict("Science run lease renewal lost a concurrent race");
    return parseRun(row);
  });
}

export async function releaseScienceRunLease(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    now?: Date;
  },
) {
  const leaseOwner = canonicalText(input.leaseOwner, "Science run lease owner", 300);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    if (run.leaseOwner === null) return parseRun(run);
    if (run.leaseOwner !== leaseOwner) {
      conflict(`Science run ${run.id} is leased by another worker`);
    }
    const [row] = await scoped
      .update(scienceRuns)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: input.now ?? new Date(),
      })
      .where(
        and(
          eq(scienceRuns.id, run.id),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
          eq(scienceRuns.leaseOwner, leaseOwner),
        ),
      )
      .returning();
    if (!row) conflict("Science run lease release lost a concurrent race");
    return parseRun(row);
  });
}

function parseScienceRunSubmitAttempt(
  row: Pick<ScienceRunEventRow, "payload" | "createdAt" | "sequence">,
): ScienceRunSubmitAttempt {
  const payload = row.payload as Record<string, unknown>;
  if (
    payload.submitAttempt !== true ||
    typeof payload.providerKind !== "string" ||
    !/^[a-z0-9_-]{1,80}$/i.test(payload.providerKind) ||
    typeof payload.providerInstanceId !== "string" ||
    !/^[a-z0-9._-]{1,100}$/i.test(payload.providerInstanceId) ||
    typeof payload.idempotencyKey !== "string" ||
    !payload.idempotencyKey ||
    payload.idempotencyKey.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(payload.idempotencyKey)
  ) {
    throw new Error("science run has a malformed durable submit-attempt marker");
  }
  return {
    providerKind: payload.providerKind,
    providerInstanceId: payload.providerInstanceId,
    idempotencyKey: payload.idempotencyKey,
    createdAt: row.createdAt,
    sequence: row.sequence,
  };
}

async function getScienceRunSubmitAttemptLocked(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
  },
): Promise<ScienceRunSubmitAttempt | null> {
  const [row] = await db
    .select({
      payload: scienceRunEvents.payload,
      createdAt: scienceRunEvents.createdAt,
      sequence: scienceRunEvents.sequence,
    })
    .from(scienceRunEvents)
    .where(
      and(
        eq(scienceRunEvents.workspaceId, input.workspaceId),
        eq(scienceRunEvents.runId, input.runId),
        eq(scienceRunEvents.executionGeneration, input.expectedGeneration),
        eq(scienceRunEvents.eventType, "science.run.submit_attempted"),
      ),
    )
    .orderBy(desc(scienceRunEvents.sequence))
    .limit(1);
  return row ? parseScienceRunSubmitAttempt(row) : null;
}

export async function getScienceRunSubmitAttempt(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
  },
): Promise<ScienceRunSubmitAttempt | null> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error("Expected run generation must be a nonnegative safe integer");
  }
  return getScienceRunSubmitAttemptLocked(db, input);
}

/**
 * Persist the provider identity and idempotency key before the first external
 * submit call. The run lock makes this marker exactly-once for a generation;
 * retries may only reuse the identical identity.
 */
export async function recordScienceRunSubmitAttempt(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    providerKind: string;
    providerInstanceId: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<{
  attempt: ScienceRunSubmitAttempt;
  event: ScienceRunEvent | null;
  created: boolean;
}> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error("Expected run generation must be a nonnegative safe integer");
  }
  const providerKind = canonicalText(input.providerKind, "Compute provider kind", 80);
  const providerInstanceId = canonicalText(
    input.providerInstanceId,
    "Compute provider instance ID",
    100,
  );
  const idempotencyKey = canonicalText(input.idempotencyKey, "Submit idempotency key", 500);
  if (!/^[a-z0-9_-]+$/i.test(providerKind)) {
    throw new Error("Compute provider kind contains unsupported characters");
  }
  if (!/^[a-z0-9._-]+$/i.test(providerInstanceId)) {
    throw new Error("Compute provider instance ID contains unsupported characters");
  }
  if (/[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    throw new Error("Submit idempotency key contains control characters");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    assertScienceRunLease(run, input.leaseOwner, input.now ?? new Date());
    const existing = await getScienceRunSubmitAttemptLocked(scoped, input);
    if (existing) {
      if (
        existing.providerKind !== providerKind ||
        existing.providerInstanceId !== providerInstanceId ||
        existing.idempotencyKey !== idempotencyKey
      ) {
        conflict("Science run submit-attempt provider identity is immutable");
      }
      return { attempt: existing, event: null, created: false };
    }
    if (run.state === "cancelling") {
      conflict("Science run was cancelled before provider submission");
    }
    if (run.state !== "provisioning") {
      conflict(`Science run in ${run.state} cannot begin a provider submission`);
    }
    const event = await appendScienceRunEventLocked(scoped, {
      run,
      eventType: "science.run.submit_attempted",
      payload: {
        submitAttempt: true,
        providerKind,
        providerInstanceId,
        idempotencyKey,
      },
      createdAt: input.now,
    });
    return {
      attempt: {
        providerKind,
        providerInstanceId,
        idempotencyKey,
        createdAt: event.createdAt,
        sequence: event.sequence,
      },
      event,
      created: true,
    };
  });
}

export async function setScienceRunProviderHandle(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    providerHandle: string;
    now?: Date;
  },
) {
  const providerHandle = canonicalText(input.providerHandle, "Provider handle", 500);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const current = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (current.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    assertScienceRunLease(current, input.leaseOwner, input.now ?? new Date());
    if (!["provisioning", "running", "cancelling"].includes(current.state)) {
      conflict(`Science run in ${current.state} cannot receive a provider handle`);
    }
    if (current.providerHandle === providerHandle) return parseRun(current);
    if (current.providerHandle !== null) conflict("Science run provider handle is immutable");
    const [row] = await scoped
      .update(scienceRuns)
      .set({ providerHandle, updatedAt: input.now ?? new Date() })
      .where(
        and(
          eq(scienceRuns.id, current.id),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
        ),
      )
      .returning();
    if (!row) conflict("Science run provider handle lost a concurrent race");
    return parseRun(row);
  });
}

function sortedManifestRefs(
  refs: Array<{
    artifactVersionId: string;
    sha256: string;
    sizeBytes: number;
    semanticRole: string;
  }>,
) {
  return [...refs].sort((left, right) => {
    const byRole = left.semanticRole.localeCompare(right.semanticRole);
    return byRole || left.artifactVersionId.localeCompare(right.artifactVersionId);
  });
}

async function validateScienceSuccessManifest(
  db: Db,
  run: ScienceRunRow,
  value: unknown,
): Promise<{ manifest: ScienceManifest; manifestHash: string }> {
  const parsed = ScienceManifest.safeParse(value);
  if (!parsed.success) {
    conflict("Science manifest does not satisfy the persisted schema");
  }
  const manifest = parsed.data;
  if (
    manifest.runId !== run.id ||
    manifest.studyId !== run.studyId ||
    manifest.missionId !== run.missionId
  ) {
    conflict("Science manifest identity does not match its run");
  }
  if (
    !sameJson(manifest.compute, {
      ...(run.profileSnapshot as Record<string, unknown>),
      requestedResources: run.resourceRequest,
      adapterVersion: manifest.compute.adapterVersion,
      dependencyLock: manifest.compute.dependencyLock,
    })
  ) {
    conflict("Science manifest compute snapshot does not match the persisted run snapshot");
  }
  if (!sameJson(manifest.parameters, run.parameters)) {
    conflict("Science manifest parameters do not match the persisted run parameters");
  }

  const links = await db
    .select({
      link: scienceRunArtifacts,
      version: scienceArtifactVersions,
      artifactStudyId: scienceArtifacts.studyId,
      artifactKind: scienceArtifacts.kind,
      artifactFormat: scienceArtifacts.format,
    })
    .from(scienceRunArtifacts)
    .innerJoin(
      scienceArtifactVersions,
      eq(scienceRunArtifacts.artifactVersionId, scienceArtifactVersions.id),
    )
    .innerJoin(
      scienceArtifacts,
      eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
    )
    .where(eq(scienceRunArtifacts.runId, run.id))
    .orderBy(asc(scienceRunArtifacts.semanticRole), asc(scienceRunArtifacts.artifactVersionId));
  if (links.some((entry) => entry.version.status !== "ready")) {
    conflict("A successful science run cannot reference a non-ready artifact version");
  }
  if (links.some((entry) => entry.artifactStudyId !== run.studyId)) {
    conflict("A successful science run cannot reference another study's artifacts");
  }

  const expectedInputs = sortedManifestRefs(
    links
      .filter((entry) => entry.link.direction === "input")
      .map((entry) => ({
        artifactVersionId: entry.version.id,
        sha256: entry.version.sha256,
        sizeBytes: Number(entry.version.sizeBytes),
        semanticRole: entry.link.semanticRole,
      })),
  );
  const expectedOutputs = sortedManifestRefs(
    links
      .filter((entry) => entry.link.direction === "output")
      .map((entry) => ({
        artifactVersionId: entry.version.id,
        sha256: entry.version.sha256,
        sizeBytes: Number(entry.version.sizeBytes),
        semanticRole: entry.link.semanticRole,
      })),
  );
  if (expectedOutputs.length === 0) {
    conflict("A successful science run requires at least one ready output artifact");
  }
  if (!sameJson(manifest.inputs, expectedInputs) || !sameJson(manifest.outputs, expectedOutputs)) {
    conflict("Science manifest inputs and outputs must exactly match persisted run links");
  }

  const linkedCodeInput = manifest.codeArtifactVersionId !== null &&
    links.some((entry) =>
      entry.link.direction === "input" &&
      entry.version.id === manifest.codeArtifactVersionId &&
      ["code", "notebook", "solver"].includes(entry.link.semanticRole) &&
      isParsedIpynbArtifactVersion(entry.version, {
        kind: entry.artifactKind,
        format: entry.artifactFormat,
      }));
  // No trusted repository resolver exists in the current release. A caller
  // cannot promote a user-declared revision into verified top-level evidence,
  // even when it resembles a commit hash.
  if (manifest.sourceRevision !== null) {
    conflict("Science manifest source revision is unverified; link immutable code input instead");
  }
  if (manifest.codeArtifactVersionId !== null && !linkedCodeInput) {
    conflict(
      "Science manifest code artifact must be a linked code, notebook, or solver input",
    );
  }
  if (!linkedCodeInput) {
    if (manifest.complete) {
      conflict("A complete science manifest requires a linked immutable code input");
    }
    if (!manifest.gaps.includes("manifest.codeArtifactVersionId")) {
      conflict("An incomplete science manifest must name its missing code artifact gap");
    }
    const declaredSourceRevision = Object.prototype.hasOwnProperty.call(
      manifest.parameters,
      "sourceRevision",
    ) && manifest.parameters.sourceRevision !== null &&
      manifest.parameters.sourceRevision !== undefined;
    if (
      declaredSourceRevision &&
      !manifest.gaps.includes("manifest.sourceRevision.unverified")
    ) {
      conflict("An unverified declared source revision must remain an explicit manifest gap");
    }
  }

  if (manifest.codeArtifactVersionId) {
    const codeVersion = await getScienceArtifactVersionForWorkspace(
      db,
      (
        await db
          .select({ workspaceId: scienceStudies.workspaceId })
          .from(scienceStudies)
          .where(eq(scienceStudies.id, run.studyId))
          .limit(1)
      )[0]!.workspaceId,
      manifest.codeArtifactVersionId,
    );
    if (!codeVersion || codeVersion.status !== "ready") {
      conflict("Science manifest code artifact must be a ready version in the run workspace");
    }
    const [codeArtifact] = await db
      .select({ studyId: scienceArtifacts.studyId })
      .from(scienceArtifactVersions)
      .innerJoin(
        scienceArtifacts,
        eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
      )
      .where(eq(scienceArtifactVersions.id, manifest.codeArtifactVersionId))
      .limit(1);
    if (!codeArtifact || codeArtifact.studyId !== run.studyId) {
      conflict("Science manifest code artifact must belong to the run study");
    }
  }

  const structural = assessScienceManifest(manifest);
  if (
    manifest.complete !== structural.complete ||
    !sameJson(manifest.gaps, structural.gaps)
  ) {
    conflict(
      "Science manifest complete and gaps must exactly match the current structural assessment",
    );
  }

  const manifestHash = createHash("sha256")
    .update(canonicalScienceJson(manifest))
    .digest("hex");
  return { manifest, manifestHash: ScienceSha256.parse(manifestHash) };
}

/**
 * Reassess immutable manifest bytes against current structural and relational
 * trust rules. This deliberately does not rewrite legacy rows: callers receive
 * a current trust projection while the stored manifest and hash stay intact.
 */
export async function assessScienceRunManifestForWorkspace(
  db: Db,
  workspaceId: string,
  runId: string,
): Promise<{ complete: boolean; gaps: string[] } | null> {
  const [owned] = await db
    .select({ run: scienceRuns })
    .from(scienceRuns)
    .innerJoin(scienceStudies, eq(scienceRuns.studyId, scienceStudies.id))
    .where(and(eq(scienceRuns.id, runId), eq(scienceStudies.workspaceId, workspaceId)))
    .limit(1);
  if (!owned) return null;
  if (!owned.run.manifest) {
    return { complete: false, gaps: ["manifest-not-yet-available"] };
  }

  const structural = assessScienceManifest(owned.run.manifest);
  const gaps = new Set(structural.gaps);
  try {
    const validated = await validateScienceSuccessManifest(db, owned.run, owned.run.manifest);
    if (owned.run.manifestHash !== validated.manifestHash) {
      gaps.add("manifest.hash.mismatch");
    }
  } catch (error) {
    if (!(error instanceof ScienceConflictError)) throw error;
    // The success validator is the single relational policy: identity,
    // profile/resources, parameters, and exact input/output links all have to
    // match. A legacy row that fails any part remains immutable but untrusted.
    gaps.add("manifest.relational-integrity");
  }
  return { complete: gaps.size === 0, gaps: [...gaps].sort() };
}

export async function transitionScienceRun(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    to: typeof ScienceRunState._type;
    /** Required for worker-owned mutations after a run is claimed. */
    leaseOwner?: string;
    providerHandle?: string | null;
    error?: string | null;
    manifest?: unknown;
    eventPayload?: Record<string, unknown>;
    now?: Date;
  },
) {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error("Expected run generation must be a nonnegative safe integer");
  }
  const target = ScienceRunState.parse(input.to);
  if (target === "provisioning") {
    conflict("Science runs enter provisioning only through claimScienceRun");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const current = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (current.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    const now = input.now ?? new Date();
    if (
      ["provisioning", "running", "finalizing", "cancelling"].includes(current.state) &&
      target !== "cancelling"
    ) {
      assertScienceRunLease(current, input.leaseOwner, now);
    }
    if (current.state === target) {
      if (
        input.providerHandle !== undefined &&
        current.providerHandle !== input.providerHandle
      ) {
        conflict("Idempotent run transition changed the provider handle");
      }
      if (target === "failed" && current.error !== (input.error ?? null)) {
        conflict("Idempotent failed transition changed the persisted error");
      }
      if (
        target === "succeeded" &&
        input.manifest !== undefined &&
        !sameJson(current.manifest, ScienceManifest.parse(input.manifest))
      ) {
        conflict("Idempotent succeeded transition changed the persisted manifest");
      }
      return parseRun(current);
    }
    const from = ScienceRunState.parse(current.state);
    if (target === "awaiting_approval" || from === "awaiting_approval") {
      conflict(
        "Approval lifecycle transitions require requestScienceRunApproval or resolveScienceRunApproval",
      );
    }
    if (!canTransitionScienceRun(from, target)) {
      conflict(`Illegal science run transition ${from} -> ${target}`);
    }

    let providerHandle = current.providerHandle;
    if (input.providerHandle !== undefined && input.providerHandle !== null) {
      const candidate = canonicalText(input.providerHandle, "Provider handle", 500);
      if (providerHandle !== null && providerHandle !== candidate) {
        conflict("Science run provider handle is immutable");
      }
      providerHandle = candidate;
    }
    if (target === "running" && providerHandle === null) {
      conflict("A running science run requires a provider handle");
    }

    let manifest: ScienceManifest | null = null;
    let manifestHash: string | null = null;
    if (target === "succeeded") {
      if (input.manifest === undefined) {
        conflict("A successful science run requires its canonical manifest");
      }
      const validated = await validateScienceSuccessManifest(scoped, current, input.manifest);
      manifest = validated.manifest;
      manifestHash = validated.manifestHash;
    } else if (input.manifest !== undefined) {
      conflict("Only a successful terminal transition can persist a science manifest");
    }

    const error =
      target === "failed"
        ? canonicalText(input.error ?? "", "Science run failure", 8_000)
        : null;
    const startedAt =
      current.startedAt ?? (target === "running" ? now : null);
    const finishedAt = isTerminalRunState(target) ? now : null;
    const [row] = await scoped
      .update(scienceRuns)
      .set({
        state: target,
        providerHandle,
        leaseOwner: isTerminalRunState(target) ? null : current.leaseOwner,
        leaseExpiresAt: isTerminalRunState(target) ? null : current.leaseExpiresAt,
        heartbeatAt: isTerminalRunState(target) ? null : current.heartbeatAt,
        manifest,
        manifestHash,
        error,
        startedAt,
        finishedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(scienceRuns.id, current.id),
          eq(scienceRuns.state, current.state),
          eq(scienceRuns.executionGeneration, input.expectedGeneration),
        ),
      )
      .returning();
    if (!row) conflict("Science run transition lost a concurrent race");

    const missionStatus = missionStatusForScienceRun(target);
    await scoped
      .update(missions)
      .set({
        status: missionStatus,
        error,
        startedAt:
          ["running", "succeeded", "failed", "cancelled"].includes(missionStatus)
            ? startedAt ?? now
            : undefined,
        finishedAt: isTerminalRunState(target) ? now : null,
        output:
          target === "succeeded"
            ? { runId: row.id, manifestHash, manifest }
            : undefined,
      })
      .where(eq(missions.id, row.missionId));
    await scoped
      .update(missionSteps)
      .set({
        status: missionStepStatusForScienceRun(target),
        error,
        startedAt:
          ["provisioning", "running", "finalizing", "cancelling"].includes(target)
            ? startedAt ?? now
            : undefined,
        finishedAt: isTerminalRunState(target) ? now : null,
        output:
          target === "succeeded"
            ? { runId: row.id, manifestHash }
            : undefined,
      })
      .where(and(eq(missionSteps.missionId, row.missionId), eq(missionSteps.nodeId, "science.run")));
    const eventType = lifecycleEventForState(target);
    if (eventType) {
      await appendScienceRunEventLocked(scoped, {
        run: row,
        eventType,
        payload: {
          ...(input.eventPayload ?? {}),
          ...(error ? { error } : {}),
          ...(manifestHash ? { manifestHash } : {}),
        },
        createdAt: now,
      });
    }
    if (isTerminalRunState(target)) {
      await markWorkflowWaitsReadyForScienceRun(scoped, { runId: row.id, now });
    }
    return parseRun(row);
  });
}

// --- Run artifact links and append-only event history ----------------------------

/**
 * Makes an ingested provider output reusable and binds it to its producing run
 * in one transaction. A pending version must never be promoted to `ready`
 * separately from this fenced link: cancellation is allowed to move a run to
 * `cancelling` without its worker lease, so the run lock is the serialization
 * point between cancellation and output publication.
 */
export async function commitScienceRunOutput(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    artifactVersionId: string;
    semanticRole: string;
    now?: Date;
  },
): Promise<{
  version: ScienceArtifactVersion;
  link: ScienceRunArtifact;
  created: boolean;
}> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error("Expected run generation must be a nonnegative safe integer");
  }
  const semanticRole = canonicalText(input.semanticRole, "Artifact semantic role", 128);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    if (!["provisioning", "running", "finalizing"].includes(run.state)) {
      conflict("Science run outputs can only be committed by an active execution");
    }
    const now = input.now ?? new Date();
    assertScienceRunLease(run, input.leaseOwner, now);

    await scoped.execute(
      sql`select id from science_artifact_versions
          where id = ${input.artifactVersionId} for update`,
    );
    const [ownedVersion] = await scoped
      .select({
        version: scienceArtifactVersions,
        studyId: scienceArtifacts.studyId,
        workspaceId: scienceStudies.workspaceId,
      })
      .from(scienceArtifactVersions)
      .innerJoin(
        scienceArtifacts,
        eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
      )
      .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
      .where(eq(scienceArtifactVersions.id, input.artifactVersionId))
      .limit(1);
    if (
      !ownedVersion ||
      ownedVersion.workspaceId !== input.workspaceId ||
      ownedVersion.studyId !== run.studyId
    ) {
      conflict("Science run artifacts must belong to the same workspace and study");
    }

    const [existing] = await scoped
      .select()
      .from(scienceRunArtifacts)
      .where(
        and(
          eq(scienceRunArtifacts.runId, run.id),
          eq(scienceRunArtifacts.artifactVersionId, ownedVersion.version.id),
          eq(scienceRunArtifacts.direction, "output"),
          eq(scienceRunArtifacts.semanticRole, semanticRole),
        ),
      )
      .limit(1);
    if (ownedVersion.version.status === "ready") {
      if (!existing) {
        conflict("A ready science output must already have its atomic run link");
      }
      return {
        version: parseVersion(ownedVersion.version),
        link: parseRunArtifact(existing),
        created: false,
      };
    }
    if (ownedVersion.version.status !== "pending") {
      conflict("Only pending science output artifacts can become ready");
    }

    const [readyRow] = await scoped
      .update(scienceArtifactVersions)
      .set({ status: "ready", readyAt: now, cleanupEligible: false })
      .where(
        and(
          eq(scienceArtifactVersions.id, ownedVersion.version.id),
          eq(scienceArtifactVersions.status, "pending"),
        ),
      )
      .returning();
    if (!readyRow) conflict("Science output readiness lost a concurrent race");

    if (existing) {
      return {
        version: parseVersion(readyRow),
        link: parseRunArtifact(existing),
        created: false,
      };
    }
    const [link] = await scoped
      .insert(scienceRunArtifacts)
      .values({
        runId: run.id,
        artifactVersionId: readyRow.id,
        direction: "output",
        semanticRole,
      })
      .returning();
    return {
      version: parseVersion(readyRow),
      link: parseRunArtifact(link!),
      created: true,
    };
  });
}

export async function linkScienceRunArtifact(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner?: string;
    artifactVersionId: string;
    direction: "input" | "output";
    semanticRole: string;
  },
): Promise<{ link: ScienceRunArtifact; created: boolean }> {
  const direction = ScienceRunArtifactDirection.parse(input.direction);
  const semanticRole = canonicalText(input.semanticRole, "Artifact semantic role", 128);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    if (isTerminalRunState(run.state)) conflict("Terminal science run artifact links are immutable");
    if (
      direction === "input" &&
      !["draft", "awaiting_approval", "queued"].includes(run.state)
    ) {
      conflict("Science run inputs are immutable after execution is claimed");
    }
    if (
      direction === "output" &&
      !["provisioning", "running", "finalizing"].includes(run.state)
    ) {
      conflict("Science run outputs can only be linked by an active execution");
    }
    if (direction === "output") {
      assertScienceRunLease(run, input.leaseOwner, new Date());
    }
    await scoped.execute(
      sql`select id from science_artifact_versions
           where id = ${input.artifactVersionId}
           for update`,
    );
    const [ownedVersion] = await scoped
      .select({
        version: scienceArtifactVersions,
        studyId: scienceArtifacts.studyId,
        workspaceId: scienceStudies.workspaceId,
      })
      .from(scienceArtifactVersions)
      .innerJoin(
        scienceArtifacts,
        eq(scienceArtifactVersions.artifactId, scienceArtifacts.id),
      )
      .innerJoin(scienceStudies, eq(scienceArtifacts.studyId, scienceStudies.id))
      .where(eq(scienceArtifactVersions.id, input.artifactVersionId))
      .limit(1);
    if (
      !ownedVersion ||
      ownedVersion.workspaceId !== input.workspaceId ||
      ownedVersion.studyId !== run.studyId
    ) {
      conflict("Science run artifacts must belong to the same workspace and study");
    }
    if (ownedVersion.version.status !== "ready") {
      conflict("Pending, quarantined, or expired artifacts cannot be run inputs or outputs");
    }
    const [existing] = await scoped
      .select()
      .from(scienceRunArtifacts)
      .where(
        and(
          eq(scienceRunArtifacts.runId, run.id),
          eq(scienceRunArtifacts.artifactVersionId, ownedVersion.version.id),
          eq(scienceRunArtifacts.direction, direction),
          eq(scienceRunArtifacts.semanticRole, semanticRole),
        ),
      )
      .limit(1);
    if (existing) return { link: parseRunArtifact(existing), created: false };
    const [row] = await scoped
      .insert(scienceRunArtifacts)
      .values({
        runId: run.id,
        artifactVersionId: ownedVersion.version.id,
        direction,
        semanticRole,
      })
      .returning();
    return { link: parseRunArtifact(row!), created: true };
  });
}

export async function listScienceRunArtifacts(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    direction?: "input" | "output";
    page?: SciencePageInput;
  },
) {
  const run = await getScienceRunForWorkspace(db, input.workspaceId, input.runId);
  if (!run) return { items: [], nextOffset: null } satisfies SciencePage<ScienceRunArtifact>;
  const pagination = page(input.page);
  const direction =
    input.direction === undefined ? undefined : ScienceRunArtifactDirection.parse(input.direction);
  const rows = await db
    .select()
    .from(scienceRunArtifacts)
    .where(
      direction
        ? and(
            eq(scienceRunArtifacts.runId, run.id),
            eq(scienceRunArtifacts.direction, direction),
          )
        : eq(scienceRunArtifacts.runId, run.id),
    )
    .orderBy(asc(scienceRunArtifacts.createdAt), asc(scienceRunArtifacts.id))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseRunArtifact), pagination.offset, pagination.limit);
}

/**
 * Append worker telemetry. Lifecycle events are written only by the guarded
 * transition methods so state and history cannot diverge.
 */
export async function appendScienceRunEvent(
  db: Db,
  input: {
    workspaceId: string;
    runId: string;
    expectedGeneration: number;
    leaseOwner: string;
    eventType: "science.run.progress" | "science.run.log";
    payload?: Record<string, unknown>;
    createdAt?: Date;
  },
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const run = await lockRunForWorkspace(scoped, input.workspaceId, input.runId);
    if (run.executionGeneration !== input.expectedGeneration) {
      conflict(`Science run ${input.runId} execution generation is stale`);
    }
    assertScienceRunLease(run, input.leaseOwner, new Date());
    if (!["provisioning", "running", "finalizing", "cancelling"].includes(run.state)) {
      conflict(`Science run in ${run.state} cannot append worker telemetry`);
    }
    const eventType = ScienceRunEventType.parse(input.eventType);
    if (eventType !== "science.run.progress" && eventType !== "science.run.log") {
      conflict("Lifecycle events can only be emitted by a lifecycle transition");
    }
    return appendScienceRunEventLocked(scoped, {
      run,
      eventType,
      payload: input.payload,
      createdAt: input.createdAt,
    });
  });
}

export async function listScienceRunEvents(
  db: Db,
  input: { workspaceId: string; runId: string; page?: SciencePageInput },
) {
  const run = await getScienceRunForWorkspace(db, input.workspaceId, input.runId);
  if (!run) return { items: [], nextOffset: null } satisfies SciencePage<ScienceRunEvent>;
  const pagination = page(input.page);
  const rows = await db
    .select()
    .from(scienceRunEvents)
    .where(eq(scienceRunEvents.runId, run.id))
    .orderBy(asc(scienceRunEvents.sequence))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseRunEvent), pagination.offset, pagination.limit);
}

// --- Leased render sessions ------------------------------------------------------

export async function createScienceRenderSession(
  db: Db,
  input: {
    workspaceId: string;
    runId?: string | null;
    artifactVersionId?: string | null;
    providerHandle?: string | null;
    requestKeyHash: string;
    intentFingerprint: string;
    providerKind: string;
    mode: "client" | "remote" | "static";
    sourceSha256: string;
    sourceMediaType: string;
    sourceSizeBytes: number;
    sourceLogicalName: string;
    tokenHash: string;
    audience: string;
    ownerId: string;
    expiresAt: Date;
    replayExpiresAt: Date;
    maxConcurrentSessions: number;
  },
): Promise<{ session: ScienceRenderSession; created: boolean }> {
  if (!input.runId && !input.artifactVersionId) {
    throw new Error("A render session requires a science run or artifact version");
  }
  if (!(input.expiresAt instanceof Date) || input.expiresAt.getTime() <= Date.now()) {
    throw new Error("Render session expiry must be in the future");
  }
  const tokenHash = ScienceSha256.parse(input.tokenHash);
  const requestKeyHash = ScienceSha256.parse(input.requestKeyHash);
  const intentFingerprint = ScienceSha256.parse(input.intentFingerprint);
  const sourceSha256 = ScienceSha256.parse(input.sourceSha256);
  const providerKind = canonicalText(input.providerKind, "Render provider kind", 80);
  if (!/^[a-z0-9_-]{1,80}$/i.test(providerKind)) {
    throw new Error("Render provider kind is invalid");
  }
  if (!["client", "remote", "static"].includes(input.mode)) {
    throw new Error("Render mode is invalid");
  }
  const sourceMediaType = canonicalText(input.sourceMediaType, "Render source media type", 200);
  const sourceLogicalName = canonicalText(input.sourceLogicalName, "Render source logical name", 500);
  if (!Number.isSafeInteger(input.sourceSizeBytes) || input.sourceSizeBytes < 0) {
    throw new Error("Render source size must be a non-negative safe integer");
  }
  if (
    !(input.replayExpiresAt instanceof Date) ||
    input.replayExpiresAt.getTime() < input.expiresAt.getTime()
  ) {
    throw new Error("Render replay expiry must not precede the session expiry");
  }
  const audience = canonicalText(input.audience, "Render session audience", 300);
  const providerHandle =
    input.providerHandle == null
      ? null
      : canonicalText(input.providerHandle, "Render provider handle", 500);
  if (
    !Number.isSafeInteger(input.maxConcurrentSessions) ||
    input.maxConcurrentSessions <= 0 ||
    input.maxConcurrentSessions > 64
  ) {
    throw new Error("Render session concurrency limit must be an integer between 1 and 64");
  }

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    // Serialize admission before a provider is started. Terminal rows with a
    // durable handle remain charged until close proof removes them; this also
    // fail-closes ambiguous start attempts retained for administrator action.
    await scoped.execute(
      sql`select id from workspaces where id = ${input.workspaceId} for update`,
    );
    const [member] = await scoped
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, input.workspaceId),
          eq(memberships.userId, input.ownerId),
        ),
      )
      .limit(1);
    if (!member) conflict("Render session owner is not a workspace member");

    const run = input.runId
      ? await getScienceRunForWorkspace(scoped, input.workspaceId, input.runId)
      : null;
    if (input.runId && !run) conflict("Render session run is outside the workspace");
    if (input.artifactVersionId) {
      await scoped.execute(
        sql`select id from science_artifact_versions
             where id = ${input.artifactVersionId}
             for update`,
      );
    }
    const version = input.artifactVersionId
      ? await getScienceArtifactVersionForWorkspace(
          scoped,
          input.workspaceId,
          input.artifactVersionId,
        )
      : null;
    if (input.artifactVersionId && !version) {
      conflict("Render session artifact version is outside the workspace");
    }
    if (version && version.status !== "ready") {
      conflict("Only ready artifact versions can be rendered");
    }
    if (run && version) {
      const [artifact] = await scoped
        .select({ studyId: scienceArtifacts.studyId })
        .from(scienceArtifacts)
        .where(eq(scienceArtifacts.id, version.artifactId))
        .limit(1);
      if (!artifact || artifact.studyId !== run.studyId) {
        conflict("Render session run and artifact must belong to the same study");
      }
    }

    const [existing] = await scoped
      .select()
      .from(scienceRenderSessions)
      .where(
        and(
          eq(scienceRenderSessions.workspaceId, input.workspaceId),
          eq(scienceRenderSessions.ownerId, input.ownerId),
          eq(scienceRenderSessions.requestKeyHash, requestKeyHash),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.intentFingerprint !== intentFingerprint) {
        conflict("Render idempotency key was already used for a different request intent");
      }
      return { session: parseRenderSession(existing), created: false };
    }
    const [usage] = await scoped
      .select({ value: sql<number>`count(*)` })
      .from(scienceRenderSessions)
      .where(
        and(
          eq(scienceRenderSessions.workspaceId, input.workspaceId),
          or(
            inArray(scienceRenderSessions.state, ["starting", "ready"]),
            sql`${scienceRenderSessions.providerHandle} is not null`,
          ),
        ),
      );
    if (Number(usage?.value ?? 0) >= input.maxConcurrentSessions) {
      conflict("Science render session concurrency limit reached");
    }
    const [row] = await scoped
      .insert(scienceRenderSessions)
      .values({
        workspaceId: input.workspaceId,
        runId: input.runId ?? null,
        artifactVersionId: input.artifactVersionId ?? null,
        providerHandle,
        requestKeyHash,
        intentFingerprint,
        providerKind,
        mode: input.mode,
        sourceSha256,
        sourceMediaType,
        sourceSizeBytes: input.sourceSizeBytes,
        sourceLogicalName,
        tokenHash,
        audience,
        state: "starting",
        ownerId: input.ownerId,
        expiresAt: input.expiresAt,
        replayExpiresAt: input.replayExpiresAt,
      })
      .returning();
    return { session: parseRenderSession(row!), created: true };
  });
}

/** Claim the only provider start permitted for this request. An abandoned
 * claim becomes replayable after its short lease; an active concurrent replay
 * observes the same row without starting a second provider. */
export async function claimScienceRenderSessionLaunch(
  db: Db,
  input: {
    workspaceId: string;
    sessionId: string;
    ownerId: string;
    providerHandle: string;
    leaseId: string;
    leaseExpiresAt: Date;
    now?: Date;
  },
): Promise<{ session: ScienceRenderSession; claimed: boolean }> {
  const providerHandle = canonicalText(input.providerHandle, "Render launch marker", 500);
  const now = input.now ?? new Date();
  if (input.leaseExpiresAt.getTime() <= now.getTime()) {
    throw new Error("Render launch lease must expire in the future");
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_render_sessions where id = ${input.sessionId} for update`,
    );
    const current = await getScienceRenderSessionForWorkspace(
      scoped,
      input.workspaceId,
      input.sessionId,
    );
    if (!current) conflict("Science render session does not exist in the workspace");
    if (current.ownerId !== input.ownerId) conflict("Science render session owner guard failed");
    if (current.state !== "starting") return { session: current, claimed: false };
    if (current.providerHandle !== null && current.providerHandle !== providerHandle) {
      return { session: current, claimed: false };
    }
    if (
      current.launchLeaseExpiresAt !== null &&
      current.launchLeaseExpiresAt.getTime() > now.getTime()
    ) {
      return { session: current, claimed: false };
    }
    const [row] = await scoped
      .update(scienceRenderSessions)
      .set({
        providerHandle,
        launchLeaseId: input.leaseId,
        launchLeaseExpiresAt: input.leaseExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(scienceRenderSessions.id, current.id),
          eq(scienceRenderSessions.state, "starting"),
        ),
      )
      .returning();
    if (!row) conflict("Render launch claim lost a concurrent race");
    return { session: parseRenderSession(row), claimed: true };
  });
}

/** Release a failed pre-launch claim only when its lease still owns the marker. */
export async function releaseScienceRenderSessionLaunch(
  db: Db,
  input: {
    workspaceId: string;
    sessionId: string;
    ownerId: string;
    providerHandle: string;
    leaseId: string;
    now?: Date;
  },
): Promise<ScienceRenderSession | null> {
  const [row] = await db
    .update(scienceRenderSessions)
    .set({
      providerHandle: null,
      launchLeaseId: null,
      launchLeaseExpiresAt: null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(scienceRenderSessions.id, input.sessionId),
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        eq(scienceRenderSessions.ownerId, input.ownerId),
        eq(scienceRenderSessions.state, "starting"),
        eq(scienceRenderSessions.providerHandle, input.providerHandle),
        eq(scienceRenderSessions.launchLeaseId, input.leaseId),
      ),
    )
    .returning();
  return row ? parseRenderSession(row) : null;
}

export async function getScienceRenderSessionForWorkspace(
  db: Db,
  workspaceId: string,
  sessionId: string,
) {
  const [row] = await db
    .select()
    .from(scienceRenderSessions)
    .where(
      and(
        eq(scienceRenderSessions.id, sessionId),
        eq(scienceRenderSessions.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ? parseRenderSession(row) : null;
}

export async function setScienceRenderSessionProviderHandle(
  db: Db,
  input: {
    workspaceId: string;
    sessionId: string;
    ownerId: string;
    providerHandle: string;
    now?: Date;
  },
) {
  const providerHandle = canonicalText(input.providerHandle, "Render provider handle", 500);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_render_sessions where id = ${input.sessionId} for update`,
    );
    const current = await getScienceRenderSessionForWorkspace(
      scoped,
      input.workspaceId,
      input.sessionId,
    );
    if (!current) conflict("Science render session does not exist in the workspace");
    if (current.ownerId !== input.ownerId) conflict("Science render session owner guard failed");
    if (current.state !== "starting") {
      conflict("Only a starting render session can receive a provider handle");
    }
    if (current.providerHandle === providerHandle) return current;
    if (current.providerHandle !== null) conflict("Render provider handle is immutable");
    const [row] = await scoped
      .update(scienceRenderSessions)
      .set({ providerHandle, updatedAt: input.now ?? new Date() })
      .where(
        and(
          eq(scienceRenderSessions.id, current.id),
          eq(scienceRenderSessions.state, "starting"),
        ),
      )
      .returning();
    if (!row) conflict("Render provider handle update lost a concurrent race");
    return parseRenderSession(row);
  });
}

/** Replace only the durable pre-launch marker for the same starting session. */
export async function replaceScienceRenderSessionProviderHandle(
  db: Db,
  input: {
    workspaceId: string;
    sessionId: string;
    ownerId: string;
    expectedProviderHandle: string;
    launchLeaseId?: string;
    providerHandle: string;
    now?: Date;
  },
): Promise<ScienceRenderSession> {
  const expectedProviderHandle = canonicalText(
    input.expectedProviderHandle,
    "Expected render provider handle",
    500,
  );
  const providerHandle = canonicalText(input.providerHandle, "Render provider handle", 500);
  const [row] = await db
    .update(scienceRenderSessions)
    .set({
      providerHandle,
      launchLeaseId: null,
      launchLeaseExpiresAt: null,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(scienceRenderSessions.id, input.sessionId),
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        eq(scienceRenderSessions.ownerId, input.ownerId),
        eq(scienceRenderSessions.state, "starting"),
        eq(scienceRenderSessions.providerHandle, expectedProviderHandle),
        ...(input.launchLeaseId
          ? [eq(scienceRenderSessions.launchLeaseId, input.launchLeaseId)]
          : []),
      ),
    )
    .returning();
  if (!row) conflict("Render provider handle replacement lost its launch fence");
  return parseRenderSession(row);
}

export async function listScienceRenderSessions(
  db: Db,
  input: {
    workspaceId: string;
    state?: typeof ScienceRenderSessionState._type;
    page?: SciencePageInput;
  },
) {
  const pagination = page(input.page);
  const state =
    input.state === undefined ? undefined : ScienceRenderSessionState.parse(input.state);
  const rows = await db
    .select()
    .from(scienceRenderSessions)
    .where(
      state
        ? and(
            eq(scienceRenderSessions.workspaceId, input.workspaceId),
            eq(scienceRenderSessions.state, state),
          )
        : eq(scienceRenderSessions.workspaceId, input.workspaceId),
    )
    .orderBy(desc(scienceRenderSessions.createdAt), desc(scienceRenderSessions.id))
    .offset(pagination.offset)
    .limit(pagination.limit + 1);
  return paged(rows.map(parseRenderSession), pagination.offset, pagination.limit);
}

export async function transitionScienceRenderSession(
  db: Db,
  input: {
    workspaceId: string;
    sessionId: string;
    ownerId: string;
    to: "ready" | "expired" | "failed" | "revoked";
    providerHandle?: string | null;
    now?: Date;
  },
) {
  const target = ScienceRenderSessionState.parse(input.to);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_render_sessions where id = ${input.sessionId} for update`,
    );
    const current = await getScienceRenderSessionForWorkspace(
      scoped,
      input.workspaceId,
      input.sessionId,
    );
    if (!current) conflict("Science render session does not exist in the workspace");
    if (current.ownerId !== input.ownerId) conflict("Science render session owner guard failed");
    if (current.state === target) return current;
    const allowed =
      current.state === "starting"
        ? ["ready", "expired", "failed", "revoked"].includes(target)
        : current.state === "ready"
          ? ["expired", "failed", "revoked"].includes(target)
          : false;
    if (!allowed) conflict(`Illegal render session transition ${current.state} -> ${target}`);
    const now = input.now ?? new Date();
    if (target === "ready" && current.expiresAt.getTime() <= now.getTime()) {
      conflict("An expired render lease cannot become ready");
    }
    let providerHandle = current.providerHandle;
    if (input.providerHandle !== undefined && input.providerHandle !== null) {
      const candidate = canonicalText(input.providerHandle, "Render provider handle", 500);
      if (providerHandle !== null && providerHandle !== candidate) {
        conflict("Render provider handle is immutable");
      }
      providerHandle = candidate;
    }
    if (target === "ready" && providerHandle === null) {
      conflict("A ready render session requires a provider handle");
    }
    const [row] = await scoped
      .update(scienceRenderSessions)
      .set({
        state: target,
        providerHandle,
        heartbeatAt: target === "ready" ? now : current.heartbeatAt,
        ...(target === "ready"
          ? {}
          : {
              cleanupAttempts: 0,
              cleanupNotBefore: null,
              launchLeaseId: null,
              launchLeaseExpiresAt: null,
            }),
        updatedAt: now,
      })
      .where(eq(scienceRenderSessions.id, current.id))
      .returning();
    return parseRenderSession(row!);
  });
}

export async function heartbeatScienceRenderSession(
  db: Db,
  input: {
    workspaceId: string;
    sessionId: string;
    ownerId: string;
    extendExpiresAt?: Date;
    extendReplayExpiresAt?: Date;
    now?: Date;
  },
) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(
      sql`select id from science_render_sessions where id = ${input.sessionId} for update`,
    );
    const current = await getScienceRenderSessionForWorkspace(
      scoped,
      input.workspaceId,
      input.sessionId,
    );
    if (!current) conflict("Science render session does not exist in the workspace");
    if (current.ownerId !== input.ownerId) conflict("Science render session owner guard failed");
    const now = input.now ?? new Date();
    if (current.state !== "ready" || current.expiresAt.getTime() <= now.getTime()) {
      conflict("Only a live ready render session can heartbeat");
    }
    let expiresAt = current.expiresAt;
    if (input.extendExpiresAt !== undefined) {
      if (
        !(input.extendExpiresAt instanceof Date) ||
        input.extendExpiresAt.getTime() < current.expiresAt.getTime() ||
        input.extendExpiresAt.getTime() <= now.getTime()
      ) {
        conflict("Render lease extension cannot shorten or expire the lease");
      }
      expiresAt = input.extendExpiresAt;
    }
    let replayExpiresAt = current.replayExpiresAt;
    if (input.extendReplayExpiresAt !== undefined) {
      if (
        !(input.extendReplayExpiresAt instanceof Date) ||
        input.extendReplayExpiresAt.getTime() < expiresAt.getTime()
      ) {
        conflict("Render replay extension cannot precede the live lease");
      }
      if (input.extendReplayExpiresAt.getTime() > replayExpiresAt.getTime()) {
        replayExpiresAt = input.extendReplayExpiresAt;
      }
    }
    const [row] = await scoped
      .update(scienceRenderSessions)
      .set({ heartbeatAt: now, expiresAt, replayExpiresAt, updatedAt: now })
      .where(eq(scienceRenderSessions.id, current.id))
      .returning();
    return parseRenderSession(row!);
  });
}

export async function cleanupExpiredScienceRenderSessions(
  db: Db,
  input: { workspaceId?: string; now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const eligible = input.workspaceId
    ? and(
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        lt(scienceRenderSessions.expiresAt, now),
        inArray(scienceRenderSessions.state, ["starting", "ready"]),
      )
    : and(
        lt(scienceRenderSessions.expiresAt, now),
        inArray(scienceRenderSessions.state, ["starting", "ready"]),
      );
  const candidates = db
    .select({ id: scienceRenderSessions.id })
    .from(scienceRenderSessions)
    .where(eligible)
    .orderBy(asc(scienceRenderSessions.expiresAt), asc(scienceRenderSessions.id))
    .limit(limit);
  const rows = await db
    .update(scienceRenderSessions)
    .set({
      state: "expired",
      cleanupAttempts: 0,
      cleanupNotBefore: null,
      updatedAt: now,
    })
    // The state/expiry/workspace guard must be part of this same statement so
    // a heartbeat or terminal transition that wins the row lock stays won.
    .where(and(eligible, inArray(scienceRenderSessions.id, candidates)))
    .returning();
  return rows.map(parseRenderSession);
}

export async function listTerminalScienceRenderSessionsForCleanup(
  db: Db,
  input: { workspaceId: string; now?: Date; limit?: number },
): Promise<ScienceRenderSession[]> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const rows = await db
    .select()
    .from(scienceRenderSessions)
    .where(
      and(
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        inArray(scienceRenderSessions.state, ["expired", "failed", "revoked"]),
        isNotNull(scienceRenderSessions.providerHandle),
        or(
          isNull(scienceRenderSessions.cleanupNotBefore),
          lte(scienceRenderSessions.cleanupNotBefore, now),
        ),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${scienceRenderSessions.cleanupNotBefore}, ${scienceRenderSessions.updatedAt})`),
      asc(scienceRenderSessions.id),
    )
    .limit(limit);
  return rows.map(parseRenderSession);
}

export async function deferScienceRenderSessionCleanup(
  db: Db,
  input: { workspaceId: string; sessionId: string; retryAt: Date; now?: Date },
): Promise<boolean> {
  const [deferred] = await db
    .update(scienceRenderSessions)
    .set({
      cleanupAttempts: sql`${scienceRenderSessions.cleanupAttempts} + 1`,
      cleanupNotBefore: input.retryAt,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(scienceRenderSessions.id, input.sessionId),
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        inArray(scienceRenderSessions.state, ["expired", "failed", "revoked"]),
      ),
    )
    .returning({ id: scienceRenderSessions.id });
  return Boolean(deferred);
}

/** Release the provider/resource hold after close proof while preserving the
 * request tombstone until its replay horizon. */
export async function tombstoneTerminalScienceRenderSessionAfterClose(
  db: Db,
  input: { workspaceId: string; sessionId: string; replayExpiresAt?: Date; now?: Date },
): Promise<ScienceRenderSession | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(scienceRenderSessions)
    .set({
      providerHandle: null,
      launchLeaseId: null,
      launchLeaseExpiresAt: null,
      cleanupAttempts: 0,
      cleanupNotBefore: null,
      closedAt: now,
      ...(input.replayExpiresAt ? { replayExpiresAt: input.replayExpiresAt } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(scienceRenderSessions.id, input.sessionId),
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        inArray(scienceRenderSessions.state, ["expired", "failed", "revoked"]),
      ),
    )
    .returning();
  return row ? parseRenderSession(row) : null;
}

/** Owner/workspace-scoped idempotency lookup for a read-only replay path. */
export async function getScienceRenderSessionForRequest(
  db: Db,
  input: { workspaceId: string; ownerId: string; requestKeyHash: string },
): Promise<ScienceRenderSession | null> {
  const requestKeyHash = ScienceSha256.parse(input.requestKeyHash);
  const [row] = await db
    .select()
    .from(scienceRenderSessions)
    .where(
      and(
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        eq(scienceRenderSessions.ownerId, input.ownerId),
        eq(scienceRenderSessions.requestKeyHash, requestKeyHash),
      ),
    )
    .limit(1);
  return row ? parseRenderSession(row) : null;
}

/** Delete only provider-free tombstones whose replay horizon elapsed. */
export async function deleteExpiredScienceRenderSessionTombstones(
  db: Db,
  input: { workspaceId: string; now?: Date; limit?: number },
): Promise<number> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
  const candidates = db
    .select({ id: scienceRenderSessions.id })
    .from(scienceRenderSessions)
    .where(
      and(
        eq(scienceRenderSessions.workspaceId, input.workspaceId),
        inArray(scienceRenderSessions.state, ["expired", "failed", "revoked"]),
        isNull(scienceRenderSessions.providerHandle),
        lte(scienceRenderSessions.replayExpiresAt, now),
      ),
    )
    .orderBy(asc(scienceRenderSessions.replayExpiresAt), asc(scienceRenderSessions.id))
    .limit(limit);
  const rows = await db
    .delete(scienceRenderSessions)
    .where(inArray(scienceRenderSessions.id, candidates))
    .returning({ id: scienceRenderSessions.id });
  return rows.length;
}
