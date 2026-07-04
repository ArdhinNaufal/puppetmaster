import vm from "node:vm";
import {
  ActionConfig,
  AgentNodeConfig,
  ApprovalConfig,
  CodeConfig,
  LogicConfig,
  WorkflowGraph,
  type MissionStatus,
  type StepStatus,
  type WorkflowNode,
} from "@puppetmaster/shared";
import {
  createApproval,
  findApprovalForNode,
  getMission,
  getMissionSteps,
  getWorkflowVersionById,
  insertStep,
  updateMission,
  updateStep,
  type Db,
} from "@puppetmaster/db";
import type { EventBus } from "./bridge.js";
import { runCodeNode } from "./sandbox.js";
import { BuiltinToolRegistry, type ToolRegistry } from "./tools.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date();

/** Evaluate an edge/branch expression in a locked-down vm context. */
function evalExpression(expr: string, out: unknown, context: Record<string, unknown>): unknown {
  try {
    return vm.runInNewContext(`(${expr})`, { out, context }, { timeout: 100 });
  } catch {
    return false;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Kahn topological sort; throws on cycles (workflows must be DAGs). */
function topoSort(nodes: WorkflowNode[], edges: { from: string; to: string }[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: WorkflowNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of adj.get(id)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new Error("workflow graph has a cycle");
  return order;
}

/** Bridge (workflow → agent): dispatch a task to an agent and await its result.
 *  Wired by the host after both engines exist, to avoid a construction cycle. */
export type AgentInvoker = (input: {
  agentId: string;
  message: string;
  parentMissionId: string;
}) => Promise<{ missionId: string; status: MissionStatus; output: unknown }>;

export interface ExecutorDeps {
  db: Db;
  bus: EventBus;
  tools?: ToolRegistry;
}

/**
 * Deterministic, resumable DAG executor (docs/ARCHITECTURE.md §3.2). Walks nodes
 * in topological order, snapshots every node's IO into `mission_steps`, honours
 * per-node retries/timeouts, and halts at approval gates — persisting a resume
 * cursor so `runMission` can be re-invoked to continue after a decision.
 */
export class WorkflowExecutor {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly tools: ToolRegistry;
  private agentInvoker: AgentInvoker | null = null;

  constructor(deps: ExecutorDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.tools = deps.tools ?? new BuiltinToolRegistry();
  }

  /** Wire the workflow → agent bridge (docs/ARCHITECTURE.md §3.3). */
  setAgentInvoker(invoker: AgentInvoker): void {
    this.agentInvoker = invoker;
  }

  async runMission(missionId: string): Promise<MissionStatus> {
    const mission = await getMission(this.db, missionId);
    if (!mission) throw new Error(`mission ${missionId} not found`);
    if (["succeeded", "failed", "cancelled"].includes(mission.status)) {
      return mission.status as MissionStatus;
    }
    if (!mission.workflowVersionId) throw new Error(`mission ${missionId} has no workflow version`);

    const versionRow = await getWorkflowVersionById(this.db, mission.workflowVersionId);
    if (!versionRow) throw new Error(`workflow version ${mission.workflowVersionId} not found`);
    const graph = WorkflowGraph.parse(versionRow.graph);

    const resuming = mission.status === "awaiting_approval";
    if (!resuming) {
      await updateMission(this.db, missionId, { status: "running", startedAt: now() });
      await this.bus.publish({
        type: "mission.started",
        missionId,
        workflowVersionId: mission.workflowVersionId,
        at: now().toISOString(),
      });
    } else {
      await updateMission(this.db, missionId, { status: "running" });
    }

    // Seed state from the resume cursor (nodeId -> output of completed nodes).
    const outputs: Record<string, unknown> = { ...((mission.cursor as Record<string, unknown>) ?? {}) };
    const completed = new Set(Object.keys(outputs));
    const skipped = new Set<string>();

    const existingSteps = await getMissionSteps(this.db, missionId);
    const stepIdByNode = new Map(existingSteps.map((s) => [s.nodeId, s.id]));

    const order = topoSort(graph.nodes, graph.edges);
    const incoming = new Map<string, { from: string; condition: string | null }[]>();
    for (const n of graph.nodes) incoming.set(n.id, []);
    for (const e of graph.edges) incoming.get(e.to)?.push({ from: e.from, condition: e.condition });

    const persistCursor = () => updateMission(this.db, missionId, { cursor: outputs });

    for (const node of order) {
      if (completed.has(node.id) || skipped.has(node.id)) continue;

      // Activation: triggers are entry points; other nodes need a satisfied edge.
      const inEdges = incoming.get(node.id) ?? [];
      let active = node.kind === "trigger" || inEdges.length === 0;
      let nodeInput: unknown = node.kind === "trigger" || inEdges.length === 0 ? mission.input : undefined;
      for (const edge of inEdges) {
        if (skipped.has(edge.from) || !completed.has(edge.from)) continue;
        const upstreamOut = outputs[edge.from];
        const passes = edge.condition == null || Boolean(evalExpression(edge.condition, upstreamOut, outputs));
        if (passes) {
          active = true;
          if (nodeInput === undefined) nodeInput = upstreamOut;
        }
      }

      if (!active) {
        await this.recordStep(missionId, node, "skipped", 0, nodeInput ?? null, null, null, stepIdByNode);
        skipped.add(node.id);
        continue;
      }

      // Approval gate — halt and persist, or resume past a decided approval.
      if (node.kind === "approval") {
        const cfg = ApprovalConfig.parse(node.config);
        const existing = await findApprovalForNode(this.db, missionId, node.id);
        if (!existing || existing.status === "pending") {
          const approval = existing ?? (await createApproval(this.db, {
            missionId,
            nodeId: node.id,
            prompt: cfg.prompt,
            tier: cfg.tier,
          }));
          await this.recordStep(missionId, node, "awaiting_approval", 0, nodeInput ?? null, null, null, stepIdByNode);
          await persistCursor();
          await updateMission(this.db, missionId, { status: "awaiting_approval" });
          await this.bus.publish({
            type: "approval.requested",
            missionId,
            nodeId: node.id,
            approvalId: approval.id,
            prompt: cfg.prompt,
            at: now().toISOString(),
          });
          return "awaiting_approval";
        }
        if (existing.status === "rejected") {
          await this.recordStep(missionId, node, "failed", 0, nodeInput ?? null, null, "approval rejected", stepIdByNode);
          return this.finishMission(missionId, "failed", null, "approval rejected");
        }
        // approved -> pass the input through and continue.
        outputs[node.id] = nodeInput ?? null;
        completed.add(node.id);
        await this.recordStep(missionId, node, "succeeded", 0, nodeInput ?? null, nodeInput ?? null, null, stepIdByNode);
        await persistCursor();
        continue;
      }

      // Execute with per-node retries + timeout.
      const retries = node.retries ?? 0;
      let attempt = 0;
      let lastError: string | null = null;
      let output: unknown;
      let ok = false;
      for (; attempt <= retries; attempt++) {
        await this.recordStep(missionId, node, "running", attempt, nodeInput ?? null, null, null, stepIdByNode);
        try {
          output = await withTimeout(
            this.executeNode(node, nodeInput, outputs, missionId),
            node.timeoutMs ?? 30_000,
            `node ${node.id}`,
          );
          ok = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (!ok) {
        await this.recordStep(missionId, node, "failed", attempt, nodeInput ?? null, null, lastError, stepIdByNode);
        return this.finishMission(missionId, "failed", null, lastError);
      }

      outputs[node.id] = output ?? null;
      completed.add(node.id);
      await this.recordStep(missionId, node, "succeeded", attempt, nodeInput ?? null, output ?? null, null, stepIdByNode);
      await persistCursor();
    }

    // Terminal nodes (no outgoing edges) define the mission output.
    const hasOutgoing = new Set(graph.edges.map((e) => e.from));
    const terminals = order.filter((n) => !hasOutgoing.has(n.id) && completed.has(n.id));
    const result =
      terminals.length === 1
        ? outputs[terminals[0]!.id]
        : Object.fromEntries(terminals.map((n) => [n.id, outputs[n.id]]));
    return this.finishMission(missionId, "succeeded", result, null);
  }

  private async executeNode(
    node: WorkflowNode,
    input: unknown,
    outputs: Record<string, unknown>,
    missionId: string,
  ): Promise<unknown> {
    switch (node.kind) {
      case "trigger":
        return input ?? null;
      case "action": {
        const cfg = ActionConfig.parse(node.config);
        const args = resolveArgs(cfg.args, input);
        return this.tools.callTool(cfg.server, cfg.tool, args, { input });
      }
      case "logic": {
        const cfg = LogicConfig.parse(node.config);
        if (cfg.op === "wait") {
          await sleep(Math.min(cfg.ms ?? 0, node.timeoutMs ?? 30_000));
          return input ?? null;
        }
        if (cfg.op === "branch") {
          return cfg.expression ? Boolean(evalExpression(cfg.expression, input, outputs)) : input ?? null;
        }
        return input ?? null;
      }
      case "code": {
        const cfg = CodeConfig.parse(node.config);
        return runCodeNode(cfg.source, outputs, input, cfg.timeoutMs);
      }
      case "agent": {
        // The bridge, workflow → agent: dispatch a task and await the result.
        if (!this.agentInvoker) throw new Error("agent nodes require the agent runtime (bridge not wired)");
        const cfg = AgentNodeConfig.parse(node.config);
        const message = cfg.message.replace(/\{\{\s*input\s*\}\}/g, () =>
          typeof input === "string" ? input : JSON.stringify(input ?? null),
        );
        const result = await this.agentInvoker({
          agentId: cfg.agentId,
          message,
          parentMissionId: missionId,
        });
        if (result.status !== "succeeded") {
          throw new Error(`agent mission ${result.missionId} ended ${result.status}`);
        }
        return { agentMissionId: result.missionId, result: result.output };
      }
      default:
        throw new Error(`unsupported node kind: ${node.kind}`);
    }
  }

  private async finishMission(
    missionId: string,
    status: MissionStatus,
    output: unknown,
    error: string | null,
  ): Promise<MissionStatus> {
    await updateMission(this.db, missionId, {
      status,
      output: output === undefined ? null : output,
      error,
      finishedAt: now(),
    });
    await this.bus.publish({ type: "mission.finished", missionId, status, at: now().toISOString() });
    return status;
  }

  private async recordStep(
    missionId: string,
    node: WorkflowNode,
    status: StepStatus,
    attempt: number,
    input: unknown,
    output: unknown,
    error: string | null,
    stepIdByNode: Map<string, string>,
  ): Promise<void> {
    const terminal = ["succeeded", "failed", "skipped"].includes(status);
    const existingId = stepIdByNode.get(node.id);
    if (existingId) {
      await updateStep(this.db, existingId, {
        status,
        attempt,
        input: input === undefined ? null : input,
        output: output === undefined ? null : output,
        error,
        finishedAt: terminal ? now() : null,
      });
    } else {
      const row = await insertStep(this.db, {
        missionId,
        nodeId: node.id,
        kind: node.kind,
        status,
        attempt,
        input: input === undefined ? null : input,
        output: output === undefined ? null : output,
        error,
        startedAt: now(),
        finishedAt: terminal ? now() : null,
      });
      stepIdByNode.set(node.id, row.id);
    }
    await this.bus.publish({
      type: "mission.step",
      missionId,
      nodeId: node.id,
      kind: node.kind,
      status,
      attempt,
      at: now().toISOString(),
      ...(error ? { error } : {}),
    });
  }
}

/** Replace `{{input}}` / `{{input.path}}` placeholders in string args. */
function resolveArgs(args: Record<string, unknown>, input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      const m = v.match(/^\{\{\s*input(?:\.([\w.]+))?\s*\}\}$/);
      if (m) {
        out[k] = m[1] ? m[1].split(".").reduce<unknown>((acc, key) => (acc as any)?.[key], input) : input;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}
