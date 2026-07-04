import {
  createWorkflow,
  getMission,
  getWorkflowWithGraph,
  listWorkflows,
  type Db,
} from "@puppetmaster/db";
import { WorkflowGraph, type MissionStatus } from "@puppetmaster/shared";
import type { AgentInvoker, WorkflowExecutor } from "./executor.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { startAgentTick, startWorkflow } from "./orchestrator.js";
import type { BuiltinToolRegistry } from "./tools.js";

const TERMINAL: MissionStatus[] = ["succeeded", "failed", "cancelled"];

/**
 * The Bridge (docs/ARCHITECTURE.md §3.3).
 *
 * Workflow → agent: `createAgentInvoker` runs an agent tick as a child mission
 * and awaits its result. If the tick pauses at an approval gate, it keeps
 * polling until the mission is terminal — the workflow node's own timeout
 * bounds the wait (sync-with-timeout mode).
 *
 * Agent → workflow: `registerBridgeTools` exposes workflows to agents as
 * ordinary tools (`workflow.list/run/create_draft`) on the shared catalog, so
 * an agent can launch or draft workflows. Child missions carry the caller's
 * mission id, nesting the traces.
 */
export function createAgentInvoker(deps: { db: Db; runtime: AgentRuntime }): AgentInvoker {
  return async ({ agentId, message, parentMissionId }) => {
    const mission = await startAgentTick(deps.db, {
      agentId,
      trigger: { mode: "workflow" },
      payload: { message },
      parentMissionId,
    });
    let status = await deps.runtime.runMission(mission.id);

    // An approval gate pauses the tick; wait for the operator's decision
    // (resumed out-of-band by the dispatcher) until the node timeout fires.
    const deadline = Date.now() + 10 * 60_000;
    while (!TERMINAL.includes(status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const current = await getMission(deps.db, mission.id);
      if (!current) break;
      status = current.status as MissionStatus;
    }

    const final = await getMission(deps.db, mission.id);
    return {
      missionId: mission.id,
      status: (final?.status ?? "failed") as MissionStatus,
      output: final?.output ?? null,
    };
  };
}

export function registerBridgeTools(
  registry: BuiltinToolRegistry,
  deps: { db: Db; workspaceId: string; executor: WorkflowExecutor },
): void {
  registry.register(
    "workflow",
    "list",
    "List the workflows available in this workspace (id, name, version).",
    "read_auto",
    { type: "object", properties: {} },
    async () => {
      const rows = await listWorkflows(deps.db, deps.workspaceId);
      return rows.map((w) => ({ id: w.id, name: w.name, version: w.currentVersion }));
    },
  );

  registry.register(
    "workflow",
    "run",
    "Run a workflow by id or exact name with a JSON input, and wait for its result. Risky steps inside the workflow still pause for human approval.",
    "read_auto",
    {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Workflow id (preferred) or exact name" },
        input: { type: "object", description: "Input payload for the trigger node" },
      },
      required: ["workflowId"],
    },
    async (args, ctx) => {
      let id = String(args.workflowId ?? "");
      const direct = await getWorkflowWithGraph(deps.db, id).catch(() => null);
      if (!direct) {
        const byName = (await listWorkflows(deps.db, deps.workspaceId)).find(
          (w) => w.name === id,
        );
        if (!byName) throw new Error(`workflow "${id}" not found`);
        id = byName.id;
      }
      const mission = await startWorkflow(deps.db, {
        workflowId: id,
        trigger: { mode: "agent" },
        payload: args.input ?? {},
        parentMissionId: ctx.missionId ?? null,
      });
      const status = await deps.executor.runMission(mission.id);
      const final = await getMission(deps.db, mission.id);
      return { missionId: mission.id, status, output: final?.output ?? null };
    },
  );

  registry.register(
    "workflow",
    "create_draft",
    "Create a new workflow from a graph of nodes and edges. The draft is saved but not run.",
    "write_approved",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        graph: {
          type: "object",
          description:
            'Workflow graph: {"nodes":[{"id","kind","label","config"}],"edges":[{"from","to","condition"}]}',
        },
      },
      required: ["name", "graph"],
    },
    async (args) => {
      const graph = WorkflowGraph.parse(args.graph ?? { nodes: [], edges: [] });
      const created = await createWorkflow(deps.db, {
        workspaceId: deps.workspaceId,
        name: String(args.name),
        graph,
      });
      return { workflowId: created.workflow.id, version: created.version.version };
    },
  );
}
