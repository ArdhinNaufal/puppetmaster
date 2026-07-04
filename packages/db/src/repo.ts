import { and, asc, desc, eq } from "drizzle-orm";
import type { WorkflowGraph } from "@puppetmaster/shared";
import type { Db } from "./client.js";
import {
  approvals,
  missions,
  missionSteps,
  workflows,
  workflowVersions,
  workspaces,
} from "./schema.js";

/** Return the first workspace, creating a default one if none exists. */
export async function ensureDefaultWorkspace(db: Db, name = "Default"): Promise<string> {
  const existing = await db.select().from(workspaces).limit(1);
  if (existing.length > 0) return existing[0]!.id;
  const [created] = await db.insert(workspaces).values({ name }).returning();
  return created!.id;
}

export async function getWorkspace(db: Db, id: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ?? null;
}

export async function updateWorkspace(
  db: Db,
  id: string,
  patch: Partial<typeof workspaces.$inferInsert>,
) {
  await db.update(workspaces).set(patch).where(eq(workspaces.id, id));
}

export async function createWorkflow(
  db: Db,
  input: { workspaceId: string; name: string; graph: WorkflowGraph },
) {
  const [wf] = await db
    .insert(workflows)
    .values({ workspaceId: input.workspaceId, name: input.name, currentVersion: 1 })
    .returning();
  const [version] = await db
    .insert(workflowVersions)
    .values({ workflowId: wf!.id, version: 1, graph: input.graph })
    .returning();
  return { workflow: wf!, version: version! };
}

export async function listWorkflows(db: Db, workspaceId: string) {
  return db
    .select()
    .from(workflows)
    .where(eq(workflows.workspaceId, workspaceId))
    .orderBy(desc(workflows.createdAt));
}

export async function getWorkflowWithGraph(db: Db, id: string) {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  if (!wf) return null;
  const version = await getWorkflowVersionByNumber(db, id, wf.currentVersion);
  return { workflow: wf, version };
}

export async function getWorkflowVersionByNumber(db: Db, workflowId: string, version: number) {
  const [row] = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)))
    .limit(1);
  return row ?? null;
}

export async function getWorkflowVersionById(db: Db, versionId: string) {
  const [row] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

/** Save a new immutable version of a workflow and bump its current pointer. */
export async function saveWorkflowVersion(db: Db, workflowId: string, graph: WorkflowGraph) {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  if (!wf) throw new Error(`workflow ${workflowId} not found`);
  const next = wf.currentVersion + 1;
  const [version] = await db
    .insert(workflowVersions)
    .values({ workflowId, version: next, graph })
    .returning();
  await db
    .update(workflows)
    .set({ currentVersion: next })
    .where(eq(workflows.id, workflowId));
  return version!;
}

export async function createMission(
  db: Db,
  input: {
    workspaceId: string;
    subjectId: string;
    workflowVersionId: string;
    trigger: unknown;
    payload: unknown;
    parentMissionId?: string | null;
  },
) {
  const [m] = await db
    .insert(missions)
    .values({
      workspaceId: input.workspaceId,
      kind: "workflow",
      subjectId: input.subjectId,
      workflowVersionId: input.workflowVersionId,
      parentMissionId: input.parentMissionId ?? null,
      status: "queued",
      trigger: input.trigger,
      input: input.payload,
      cursor: {},
    })
    .returning();
  return m!;
}

export async function createAgentMission(
  db: Db,
  input: {
    workspaceId: string;
    agentId: string;
    trigger: unknown;
    payload: unknown;
    parentMissionId?: string | null;
  },
) {
  const [m] = await db
    .insert(missions)
    .values({
      workspaceId: input.workspaceId,
      kind: "agent",
      subjectId: input.agentId,
      workflowVersionId: null,
      parentMissionId: input.parentMissionId ?? null,
      status: "queued",
      trigger: input.trigger,
      input: input.payload,
      cursor: {},
    })
    .returning();
  return m!;
}

export async function getMission(db: Db, id: string) {
  const [m] = await db.select().from(missions).where(eq(missions.id, id)).limit(1);
  return m ?? null;
}

export async function listMissions(db: Db, workspaceId: string, limit = 50) {
  return db
    .select()
    .from(missions)
    .where(eq(missions.workspaceId, workspaceId))
    .orderBy(desc(missions.createdAt))
    .limit(limit);
}

export async function updateMission(
  db: Db,
  id: string,
  patch: Partial<typeof missions.$inferInsert>,
) {
  await db.update(missions).set(patch).where(eq(missions.id, id));
}

export async function getMissionSteps(db: Db, missionId: string) {
  return db
    .select()
    .from(missionSteps)
    .where(eq(missionSteps.missionId, missionId))
    .orderBy(asc(missionSteps.startedAt));
}

export async function insertStep(db: Db, step: typeof missionSteps.$inferInsert) {
  const [row] = await db.insert(missionSteps).values(step).returning();
  return row!;
}

export async function updateStep(
  db: Db,
  id: string,
  patch: Partial<typeof missionSteps.$inferInsert>,
) {
  await db.update(missionSteps).set(patch).where(eq(missionSteps.id, id));
}

export async function createApproval(
  db: Db,
  input: { missionId: string; nodeId: string; prompt: string; tier: string },
) {
  const [row] = await db
    .insert(approvals)
    .values({
      missionId: input.missionId,
      nodeId: input.nodeId,
      prompt: input.prompt,
      tier: input.tier,
      status: "pending",
    })
    .returning();
  return row!;
}

export async function getApproval(db: Db, id: string) {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  return row ?? null;
}

export async function listApprovals(db: Db, status?: string) {
  const q = db.select().from(approvals);
  const rows = status
    ? await q.where(eq(approvals.status, status)).orderBy(desc(approvals.createdAt))
    : await q.orderBy(desc(approvals.createdAt));
  return rows;
}

export async function resolveApproval(db: Db, id: string, approved: boolean) {
  await db
    .update(approvals)
    .set({ status: approved ? "approved" : "rejected", decidedAt: new Date() })
    .where(eq(approvals.id, id));
}

/** The approval a mission is currently blocked on for a given node, if resolved. */
export async function findApprovalForNode(db: Db, missionId: string, nodeId: string) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.missionId, missionId), eq(approvals.nodeId, nodeId)))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return row ?? null;
}
