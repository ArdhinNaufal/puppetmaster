import {
  createWorkflow,
  getMission,
  getWorkflowWithGraph,
  listAgents,
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

/** Max delegation hops for agent.ask (Stage 8, §1.2 scoped multi-agent):
 *  a mission already 2 hops deep may not delegate further. */
const MAX_DELEGATION_DEPTH = 2;

export function registerBridgeTools(
  registry: BuiltinToolRegistry,
  deps: {
    db: Db;
    workspaceId: string;
    executor: WorkflowExecutor;
    /** Enables agent.ask (agent → agent delegation via nested missions). */
    agentInvoker?: AgentInvoker;
  },
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

  // Agent-as-tool delegation (Stage 8, G12-lite): agent.ask runs another
  // agent's tick as a nested mission and returns its reply. Depth-capped so
  // delegation chains stay shallow (§1.2: strong single agents over deep
  // teams); risky tools inside the child still gate on their own tiers.
  if (deps.agentInvoker) {
    const invoker = deps.agentInvoker;
    registry.register(
      "agent",
      "ask",
      `Delegate a task to another agent by id or exact name and await its reply (nested mission, max ${MAX_DELEGATION_DEPTH} hops).`,
      "read_auto",
      {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent id (preferred) or exact name" },
          message: { type: "string", description: "The task or question for that agent" },
        },
        required: ["agent", "message"],
      },
      async (args, ctx) => {
        const callerMissionId = ctx.missionId;
        if (!callerMissionId) throw new Error("agent.ask requires a mission context");
        // Depth = number of mission ancestors of the caller.
        let depth = 0;
        let cursor: string | null = callerMissionId;
        while (cursor && depth <= MAX_DELEGATION_DEPTH) {
          const m = await getMission(deps.db, cursor);
          cursor = m?.parentMissionId ?? null;
          if (cursor) depth++;
        }
        if (depth >= MAX_DELEGATION_DEPTH) {
          throw new Error(`agent.ask: delegation depth cap (${MAX_DELEGATION_DEPTH}) reached`);
        }

        const ref = String(args.agent ?? "");
        const roster = await listAgents(deps.db, deps.workspaceId);
        const target = roster.find((a) => a.id === ref) ?? roster.find((a) => a.name === ref);
        if (!target) throw new Error(`agent "${ref}" not found`);
        if (ctx.agentId && target.id === ctx.agentId) {
          throw new Error("agent.ask: an agent cannot delegate to itself");
        }

        const result = await invoker({
          agentId: target.id,
          message: String(args.message ?? ""),
          parentMissionId: callerMissionId,
        });
        return {
          agentId: target.id,
          agentName: target.name,
          missionId: result.missionId,
          status: result.status,
          reply: result.output,
        };
      },
    );
  }
}
