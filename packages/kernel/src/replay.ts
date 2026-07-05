import vm from "node:vm";
import { WorkflowGraph, type WorkflowNode } from "@puppetmaster/shared";

/**
 * Deterministic replay (Stage 2, G4 / §1.4 execution lineage). The step log
 * snapshots every node's IO, so a finished mission can be re-walked without
 * side effects: activation and edge conditions are re-derived from the
 * *recorded* outputs, and each node's recorded status is compared against
 * what the replay expects — a divergence flags non-determinism or an edit to
 * the workflow since the run. Pure function; never calls tools.
 */

export interface ReplayStepRecord {
  nodeId: string;
  status: string;
  input: unknown;
  output: unknown;
  error?: string | null;
  attempt?: number;
}

export interface ReplayEntry {
  nodeId: string;
  kind: WorkflowNode["kind"];
  label: string;
  /** What the replay derives for this node from the recorded outputs. */
  expected: "executed" | "skipped";
  /** The status the executor actually recorded (null = no step recorded). */
  recorded: string | null;
  diverged: boolean;
  activatedBy: string[];
  input: unknown;
  output: unknown;
  error: string | null;
}

function evalCondition(expr: string, out: unknown, context: Record<string, unknown>): unknown {
  try {
    return vm.runInNewContext(`(${expr})`, { out, context }, { timeout: 100 });
  } catch {
    return false;
  }
}

const EXECUTED_STATUSES = new Set(["succeeded", "failed", "running", "awaiting_approval"]);

export function replayMission(
  graphInput: unknown,
  steps: ReplayStepRecord[],
  missionInput: unknown,
): ReplayEntry[] {
  const graph = WorkflowGraph.parse(graphInput);
  const latestStep = new Map<string, ReplayStepRecord>();
  for (const s of steps) {
    const prev = latestStep.get(s.nodeId);
    if (!prev || (s.attempt ?? 0) >= (prev.attempt ?? 0)) latestStep.set(s.nodeId, s);
  }

  const incoming = new Map<string, { from: string; condition: string | null }[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) incoming.get(e.to)?.push({ from: e.from, condition: e.condition });

  // Walk in recorded order where possible, falling back to graph order for
  // nodes that never produced a step.
  const seen = new Set<string>();
  const order: WorkflowNode[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const s of steps) {
    const node = byId.get(s.nodeId);
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      order.push(node);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n);

  const outputs: Record<string, unknown> = {};
  const executed = new Set<string>();
  const entries: ReplayEntry[] = [];

  for (const node of order) {
    const record = latestStep.get(node.id) ?? null;
    const inEdges = incoming.get(node.id) ?? [];
    let expected: ReplayEntry["expected"] =
      node.kind === "trigger" || inEdges.length === 0 ? "executed" : "skipped";
    const activatedBy: string[] = [];
    for (const edge of inEdges) {
      if (!executed.has(edge.from)) continue;
      const passes =
        edge.condition == null ||
        Boolean(evalCondition(edge.condition, outputs[edge.from], outputs));
      if (passes) {
        expected = "executed";
        activatedBy.push(edge.from);
      }
    }

    const recorded = record?.status ?? null;
    const recordedExecuted = recorded != null && EXECUTED_STATUSES.has(recorded);
    const diverged =
      (expected === "executed") !== (recorded == null ? false : recordedExecuted);

    if (record && recordedExecuted) {
      outputs[node.id] = record.output ?? null;
      executed.add(node.id);
    }

    entries.push({
      nodeId: node.id,
      kind: node.kind,
      label: node.label,
      expected,
      recorded,
      diverged,
      activatedBy,
      input: record?.input ?? (inEdges.length === 0 ? missionInput : null),
      output: record?.output ?? null,
      error: record?.error ?? null,
    });
  }

  return entries;
}
