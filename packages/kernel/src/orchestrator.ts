import {
  createAgentMission,
  createMission,
  getAgent,
  getMission,
  getWorkflowWithGraph,
  type Db,
} from "@puppetmaster/db";

type WorkspaceMission = NonNullable<Awaited<ReturnType<typeof getMission>>>;

/**
 * Fence every queue/inline dispatch to the workspace owned by this server.
 * Queue names and mission UUIDs are infrastructure identifiers, not
 * authorization capabilities.
 */
export function createWorkspaceMissionDispatcher<T>(
  db: Db,
  workspaceId: string,
  dispatch: (mission: WorkspaceMission) => Promise<T>,
): (missionId: string) => Promise<T> {
  return async (missionId) => {
    const mission = await getMission(db, missionId);
    if (!mission || mission.workspaceId !== workspaceId) {
      throw new Error(`mission ${missionId} not found in this workspace`);
    }
    return dispatch(mission);
  };
}

/** Create a workflow mission ready to be enqueued/run (manual, webhook, or cron). */
export async function startWorkflow(
  db: Db,
  input: {
    workspaceId: string;
    workflowId: string;
    trigger: unknown;
    payload: unknown;
    parentMissionId?: string | null;
  },
) {
  const wf = await getWorkflowWithGraph(db, input.workflowId);
  if (!wf || !wf.version || wf.workflow.workspaceId !== input.workspaceId) {
    throw new Error(`workflow ${input.workflowId} not found or has no version in this workspace`);
  }
  return createMission(db, {
    workspaceId: input.workspaceId,
    subjectId: wf.workflow.id,
    workflowVersionId: wf.version.id,
    trigger: input.trigger,
    payload: input.payload,
    parentMissionId: input.parentMissionId ?? null,
  });
}

/** Create an agent-tick mission (direct chat, cron, or event subscription). */
export async function startAgentTick(
  db: Db,
  input: {
    workspaceId: string;
    agentId: string;
    trigger: unknown;
    payload: unknown;
    parentMissionId?: string | null;
  },
) {
  const agent = await getAgent(db, input.agentId);
  if (!agent || agent.workspaceId !== input.workspaceId) {
    throw new Error(`agent ${input.agentId} not found in this workspace`);
  }
  return createAgentMission(db, {
    workspaceId: input.workspaceId,
    agentId: agent.id,
    trigger: input.trigger,
    payload: input.payload,
    parentMissionId: input.parentMissionId ?? null,
  });
}
