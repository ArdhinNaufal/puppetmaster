import { createAgentMission, createMission, getAgent, getWorkflowWithGraph, type Db } from "@puppetmaster/db";

/** Create a workflow mission ready to be enqueued/run (manual, webhook, or cron). */
export async function startWorkflow(
  db: Db,
  input: { workflowId: string; trigger: unknown; payload: unknown; parentMissionId?: string | null },
) {
  const wf = await getWorkflowWithGraph(db, input.workflowId);
  if (!wf || !wf.version) throw new Error(`workflow ${input.workflowId} not found or has no version`);
  return createMission(db, {
    workspaceId: wf.workflow.workspaceId,
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
  input: { agentId: string; trigger: unknown; payload: unknown; parentMissionId?: string | null },
) {
  const agent = await getAgent(db, input.agentId);
  if (!agent) throw new Error(`agent ${input.agentId} not found`);
  return createAgentMission(db, {
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    trigger: input.trigger,
    payload: input.payload,
    parentMissionId: input.parentMissionId ?? null,
  });
}
