import { and, asc, desc, eq } from "drizzle-orm";
import { TraceRefType, TraceRelation } from "@puppetmaster/shared";
import type { Db } from "./client.js";
import { evidence, missions, projectArtifacts, projects, projectTraceLinks, verifyChecks } from "./schema.js";

/**
 * Workshop repository (AI-SDLC plan WP2, ADR-003/004). The artifact lifecycle
 * rules live HERE, not in callers — enforced by code, not convention
 * (Invariant 2): learnings are append-only; accepted ADRs are immutable and
 * change only by supersession; todo completion requires the completing
 * mission's id; spec/plan changes are new versions chained via supersedesId.
 */

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectArtifactRow = typeof projectArtifacts.$inferSelect;

export async function createProject(
  db: Db,
  input: { workspaceId: string; name: string; repoRef?: string; mode?: "supervised" | "gated" },
): Promise<ProjectRow> {
  const [row] = await db
    .insert(projects)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      repoRef: input.repoRef ?? "",
      mode: input.mode ?? "supervised",
    })
    .returning();
  return row!;
}

export async function getProject(db: Db, id: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function listProjects(db: Db, workspaceId: string): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .orderBy(desc(projects.createdAt));
}

const PROJECT_PATCH_FIELDS = ["phase", "status", "mode", "workbenchId"] as const;

export async function updateProject(
  db: Db,
  id: string,
  patch: Partial<Pick<ProjectRow, (typeof PROJECT_PATCH_FIELDS)[number]>>,
): Promise<ProjectRow | null> {
  const values: Record<string, unknown> = {};
  for (const key of PROJECT_PATCH_FIELDS) {
    if (patch[key] !== undefined) values[key] = patch[key];
  }
  if (Object.keys(values).length === 0) return getProject(db, id);
  const [row] = await db.update(projects).set(values).where(eq(projects.id, id)).returning();
  return row ?? null;
}

export interface WriteArtifactInput {
  projectId: string;
  kind: "spec" | "plan" | "todo" | "learning" | "adr";
  title: string;
  body?: string;
  /** Todos: backlog (default) | active. ADRs: proposed (default) | accepted.
   *  Other kinds carry no status. */
  status?: string;
}

/**
 * Create an artifact under the kind's lifecycle rules. Spec/plan re-writes of
 * an existing title insert a NEW version superseding the previous row —
 * history is never edited in place.
 */
export async function writeArtifact(db: Db, input: WriteArtifactInput): Promise<ProjectArtifactRow> {
  const kind = input.kind;
  let status: string | null = null;

  if (kind === "todo") {
    status = input.status ?? "backlog";
    if (status === "completed") {
      throw new Error("todos are completed via completeTodo, which records the completing mission");
    }
    if (status !== "backlog" && status !== "active") {
      throw new Error(`invalid todo status "${status}" (backlog | active)`);
    }
  } else if (kind === "adr") {
    status = input.status ?? "proposed";
    if (status === "superseded") {
      throw new Error("ADRs become superseded only via supersedeAdr");
    }
    if (status !== "proposed" && status !== "accepted") {
      throw new Error(`invalid ADR status "${status}" (proposed | accepted)`);
    }
  } else if (input.status !== undefined) {
    throw new Error(`${kind} artifacts carry no status`);
  }

  let version = 1;
  let supersedesId: string | null = null;
  if (kind === "spec" || kind === "plan") {
    const [prev] = await db
      .select()
      .from(projectArtifacts)
      .where(
        and(
          eq(projectArtifacts.projectId, input.projectId),
          eq(projectArtifacts.kind, kind),
          eq(projectArtifacts.title, input.title),
        ),
      )
      .orderBy(desc(projectArtifacts.version))
      .limit(1);
    if (prev) {
      version = prev.version + 1;
      supersedesId = prev.id;
    }
  }

  const [row] = await db
    .insert(projectArtifacts)
    .values({
      projectId: input.projectId,
      kind,
      status,
      title: input.title,
      body: input.body ?? "",
      version,
      supersedesId,
    })
    .returning();
  return row!;
}

export async function getArtifact(db: Db, id: string): Promise<ProjectArtifactRow | null> {
  const [row] = await db.select().from(projectArtifacts).where(eq(projectArtifacts.id, id)).limit(1);
  return row ?? null;
}

export async function listArtifacts(
  db: Db,
  projectId: string,
  filter?: { kind?: string; status?: string },
): Promise<ProjectArtifactRow[]> {
  const conditions = [eq(projectArtifacts.projectId, projectId)];
  if (filter?.kind) conditions.push(eq(projectArtifacts.kind, filter.kind));
  if (filter?.status) conditions.push(eq(projectArtifacts.status, filter.status));
  return db
    .select()
    .from(projectArtifacts)
    .where(and(...conditions))
    .orderBy(asc(projectArtifacts.createdAt));
}

/**
 * The only in-place mutations any artifact permits:
 *   todo:  status backlog ↔ active (completion goes through completeTodo)
 *   adr:   while proposed — edit body/title or accept
 * Everything else is immutable: learnings append, spec/plan version,
 * accepted ADRs supersede.
 */
export async function updateArtifact(
  db: Db,
  id: string,
  patch: { title?: string; body?: string; status?: string },
): Promise<ProjectArtifactRow> {
  const row = await getArtifact(db, id);
  if (!row) throw new Error("artifact not found");

  if (row.kind === "learning") {
    throw new Error("learnings are append-only; write a new learning instead");
  }
  if (row.kind === "spec" || row.kind === "plan") {
    throw new Error(`${row.kind} artifacts are versioned; write a new version via writeArtifact`);
  }
  if (row.kind === "adr") {
    if (row.status !== "proposed") {
      throw new Error(`${row.status} ADRs are immutable; a changed decision is a new ADR via supersedeAdr`);
    }
    if (patch.status !== undefined && patch.status !== "accepted" && patch.status !== "proposed") {
      throw new Error(`a proposed ADR may only move to accepted (got "${patch.status}")`);
    }
  }
  if (row.kind === "todo") {
    if (patch.status === "completed") {
      throw new Error("todos are completed via completeTodo, which records the completing mission");
    }
    if (patch.status !== undefined && patch.status !== "backlog" && patch.status !== "active") {
      throw new Error(`invalid todo status "${patch.status}" (backlog | active)`);
    }
  }

  const values: Record<string, unknown> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.status !== undefined) values.status = patch.status;
  if (Object.keys(values).length === 0) return row;
  values.updatedAt = new Date();
  const [updated] = await db
    .update(projectArtifacts)
    .set(values)
    .where(eq(projectArtifacts.id, id))
    .returning();
  return updated!;
}

/** Complete a todo. The completing mission's id is REQUIRED — todo completion
 *  without an executing mission is exactly what the lifecycle forbids (the
 *  todos/completed audit-trail invariant, corpus §4.7). */
export async function completeTodo(db: Db, id: string, missionId: string): Promise<ProjectArtifactRow> {
  if (!missionId) throw new Error("completeTodo requires the completing mission's id");
  const row = await getArtifact(db, id);
  if (!row) throw new Error("artifact not found");
  if (row.kind !== "todo") throw new Error(`artifact ${id} is a ${row.kind}, not a todo`);
  if (row.status === "completed") throw new Error("todo is already completed");
  const [updated] = await db
    .update(projectArtifacts)
    .set({ status: "completed", missionId, updatedAt: new Date() })
    .where(eq(projectArtifacts.id, id))
    .returning();
  return updated!;
}

/** The one legal exit from `accepted`: a new ADR supersedes the old, which is
 *  marked superseded in the same call. History stays intact. */
export async function supersedeAdr(
  db: Db,
  oldId: string,
  input: { title: string; body?: string },
): Promise<ProjectArtifactRow> {
  const old = await getArtifact(db, oldId);
  if (!old) throw new Error("artifact not found");
  if (old.kind !== "adr") throw new Error(`artifact ${oldId} is a ${old.kind}, not an ADR`);
  if (old.status === "superseded") throw new Error("ADR is already superseded");
  const [next] = await db
    .insert(projectArtifacts)
    .values({
      projectId: old.projectId,
      kind: "adr",
      status: "proposed",
      title: input.title,
      body: input.body ?? "",
      version: 1,
      supersedesId: old.id,
    })
    .returning();
  await db
    .update(projectArtifacts)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(eq(projectArtifacts.id, old.id));
  return next!;
}

/** The next undone task: oldest active todo, else oldest backlog todo. */
export async function nextTodo(db: Db, projectId: string): Promise<ProjectArtifactRow | null> {
  for (const status of ["active", "backlog"]) {
    const [row] = await db
      .select()
      .from(projectArtifacts)
      .where(
        and(
          eq(projectArtifacts.projectId, projectId),
          eq(projectArtifacts.kind, "todo"),
          eq(projectArtifacts.status, status),
        ),
      )
      .orderBy(asc(projectArtifacts.createdAt))
      .limit(1);
    if (row) return row;
  }
  return null;
}

/* ————— Verify checks (WP4) — earned policies, disabled by default ————— */

export type VerifyCheckRow = typeof verifyChecks.$inferSelect;

export async function createVerifyCheck(
  db: Db,
  input: {
    projectId: string;
    name: string;
    command?: string | null;
    baseline?: number | null;
    enabled?: boolean;
    earnedNote?: string;
  },
): Promise<VerifyCheckRow> {
  const enabled = input.enabled ?? false;
  const earnedNote = input.earnedNote?.trim() ?? "";
  if (enabled && !earnedNote) {
    throw new Error("an enabled verify check requires an earned note");
  }
  const [row] = await db
    .insert(verifyChecks)
    .values({
      projectId: input.projectId,
      name: input.name,
      command: input.command ?? null,
      baseline: input.baseline ?? null,
      enabled,
      earnedNote,
    })
    .returning();
  return row!;
}

export async function listVerifyChecks(db: Db, projectId: string): Promise<VerifyCheckRow[]> {
  return db
    .select()
    .from(verifyChecks)
    .where(eq(verifyChecks.projectId, projectId))
    .orderBy(asc(verifyChecks.createdAt));
}

export async function getVerifyCheckByName(
  db: Db,
  projectId: string,
  name: string,
): Promise<VerifyCheckRow | null> {
  const [row] = await db
    .select()
    .from(verifyChecks)
    .where(and(eq(verifyChecks.projectId, projectId), eq(verifyChecks.name, name)))
    .limit(1);
  return row ?? null;
}

export async function getVerifyCheck(db: Db, id: string): Promise<VerifyCheckRow | null> {
  const [row] = await db.select().from(verifyChecks).where(eq(verifyChecks.id, id)).limit(1);
  return row ?? null;
}

export async function updateVerifyCheck(
  db: Db,
  id: string,
  patch: { command?: string | null; baseline?: number | null; enabled?: boolean; earnedNote?: string },
): Promise<VerifyCheckRow | null> {
  const current = await getVerifyCheck(db, id);
  if (!current) return null;
  const nextEnabled = patch.enabled ?? current.enabled;
  const nextEarnedNote = patch.earnedNote === undefined ? current.earnedNote : patch.earnedNote.trim();
  if (nextEnabled && !nextEarnedNote) {
    throw new Error("an enabled verify check requires an earned note");
  }
  const values: Record<string, unknown> = {};
  if (patch.command !== undefined) values.command = patch.command;
  if (patch.baseline !== undefined) values.baseline = patch.baseline;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.earnedNote !== undefined) values.earnedNote = nextEarnedNote;
  if (Object.keys(values).length === 0) {
    return current;
  }
  const [row] = await db.update(verifyChecks).set(values).where(eq(verifyChecks.id, id)).returning();
  return row ?? null;
}

/* ————— Project trace links: artifact/check provenance and coverage ————— */

export type ProjectTraceLinkRow = typeof projectTraceLinks.$inferSelect;

async function requireTraceEndpoint(
  db: Db,
  projectId: string,
  type: TraceRefType,
  id: string,
  side: "source" | "target",
): Promise<void> {
  if (type === "artifact") {
    const [row] = await db
      .select({ id: projectArtifacts.id })
      .from(projectArtifacts)
      .where(and(eq(projectArtifacts.id, id), eq(projectArtifacts.projectId, projectId)))
      .limit(1);
    if (!row) throw new Error(`trace link ${side} artifact "${id}" was not found in this project`);
    return;
  }

  const [row] = await db
    .select({ id: verifyChecks.id })
    .from(verifyChecks)
    .where(and(eq(verifyChecks.id, id), eq(verifyChecks.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`trace link ${side} check "${id}" was not found in this project`);
}

export async function listProjectTraceLinks(db: Db, projectId: string): Promise<ProjectTraceLinkRow[]> {
  return db
    .select()
    .from(projectTraceLinks)
    .where(eq(projectTraceLinks.projectId, projectId))
    .orderBy(asc(projectTraceLinks.createdAt));
}

export async function createProjectTraceLink(
  db: Db,
  input: {
    projectId: string;
    sourceType: TraceRefType;
    sourceId: string;
    targetType: TraceRefType;
    targetId: string;
    relation: TraceRelation;
    rationale: string;
  },
): Promise<ProjectTraceLinkRow> {
  const sourceType = TraceRefType.parse(input.sourceType);
  const targetType = TraceRefType.parse(input.targetType);
  const relation = TraceRelation.parse(input.relation);
  const rationale = input.rationale.trim();
  if (!rationale) throw new Error("trace link rationale is required");
  if (relation === "derives" && (sourceType !== "artifact" || targetType !== "artifact")) {
    throw new Error('a "derives" link must connect an artifact to an artifact');
  }
  if (relation === "verifies" && (sourceType !== "artifact" || targetType !== "check")) {
    throw new Error('a "verifies" link must connect an artifact to a check');
  }

  await requireTraceEndpoint(db, input.projectId, sourceType, input.sourceId, "source");
  await requireTraceEndpoint(db, input.projectId, targetType, input.targetId, "target");
  if (sourceType === targetType && input.sourceId === input.targetId) {
    throw new Error("a trace link cannot reference itself");
  }

  const [duplicate] = await db
    .select({ id: projectTraceLinks.id })
    .from(projectTraceLinks)
    .where(
      and(
        eq(projectTraceLinks.projectId, input.projectId),
        eq(projectTraceLinks.sourceType, sourceType),
        eq(projectTraceLinks.sourceId, input.sourceId),
        eq(projectTraceLinks.targetType, targetType),
        eq(projectTraceLinks.targetId, input.targetId),
        eq(projectTraceLinks.relation, relation),
      ),
    )
    .limit(1);
  if (duplicate) throw new Error("trace link already exists");

  const [row] = await db
    .insert(projectTraceLinks)
    .values({
      projectId: input.projectId,
      sourceType,
      sourceId: input.sourceId,
      targetType,
      targetId: input.targetId,
      relation,
      rationale,
    })
    .returning();
  return row!;
}

export async function deleteProjectTraceLink(
  db: Db,
  projectId: string,
  id: string,
): Promise<ProjectTraceLinkRow | null> {
  const [row] = await db
    .delete(projectTraceLinks)
    .where(and(eq(projectTraceLinks.id, id), eq(projectTraceLinks.projectId, projectId)))
    .returning();
  return row ?? null;
}

/* Gate evidence attached to verify steps / escalation approvals. */

export type EvidenceRow = typeof evidence.$inferSelect;

export async function createEvidence(
  db: Db,
  input: {
    stepId?: string | null;
    approvalId?: string | null;
    kind: string;
    content?: unknown;
    ref?: string | null;
  },
): Promise<EvidenceRow> {
  if (!input.stepId && !input.approvalId) {
    throw new Error("evidence must attach to a step or an approval");
  }
  const [row] = await db
    .insert(evidence)
    .values({
      stepId: input.stepId ?? null,
      approvalId: input.approvalId ?? null,
      kind: input.kind,
      content: input.content ?? null,
      ref: input.ref ?? null,
    })
    .returning();
  return row!;
}

export async function listEvidenceForApproval(db: Db, approvalId: string): Promise<EvidenceRow[]> {
  return db
    .select()
    .from(evidence)
    .where(eq(evidence.approvalId, approvalId))
    .orderBy(asc(evidence.createdAt));
}

export async function listEvidenceForStep(db: Db, stepId: string): Promise<EvidenceRow[]> {
  return db.select().from(evidence).where(eq(evidence.stepId, stepId)).orderBy(asc(evidence.createdAt));
}

/** Nested missions launched under a parent (verify fix loops, bridge calls). */
export async function listChildMissions(db: Db, parentMissionId: string) {
  return db
    .select()
    .from(missions)
    .where(eq(missions.parentMissionId, parentMissionId))
    .orderBy(asc(missions.createdAt));
}
