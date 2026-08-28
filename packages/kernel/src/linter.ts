import { ActionConfig, VerifyNodeConfig, WorkflowGraph } from "@puppetmaster/shared";
import type { ToolInfo } from "./tools.js";

/**
 * Graph linter (Stage 6, G9 — GraphFlow: formally checkable workflows).
 * Static checks run before a graph is saved/run, surfaced in the editor:
 * structural problems (missing trigger, dangling edges, cycles, unreachable
 * nodes) and policy smells (destructive actions with no approval upstream,
 * network calls without retries, unknown tools).
 */

export interface LintIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
}

export function lintWorkflowGraph(
  graphInput: unknown,
  toolInfo?: (server: string, tool: string) => ToolInfo | null,
  opts?: {
    /** Workshop WP4: graphs run under a gated project need verify gates —
     *  every agent node must have a verify node downstream. */
    projectMode?: "supervised" | "gated";
  },
): LintIssue[] {
  const parsed = WorkflowGraph.safeParse(graphInput);
  if (!parsed.success) {
    return [{ severity: "error", code: "invalid-graph", message: "graph does not validate against the schema" }];
  }
  const graph = parsed.data;
  const issues: LintIssue[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));

  // Structure: triggers, dangling edges, duplicate ids.
  const triggers = graph.nodes.filter((n) => n.kind === "trigger");
  if (graph.nodes.length > 0 && triggers.length === 0) {
    issues.push({ severity: "error", code: "no-trigger", message: "workflow has no trigger node" });
  }
  if (ids.size !== graph.nodes.length) {
    issues.push({ severity: "error", code: "duplicate-node-id", message: "two nodes share the same id" });
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({
        severity: "error",
        code: "dangling-edge",
        message: `edge ${e.from} → ${e.to} references a missing node`,
      });
    }
    if (e.from === e.to) {
      issues.push({ severity: "error", code: "self-loop", message: `node ${e.from} points at itself`, nodeId: e.from });
    }
  }

  // Cycle detection (the executor requires a DAG).
  const adj = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  const indeg = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== graph.nodes.length) {
    issues.push({ severity: "error", code: "cycle", message: "graph contains a cycle — workflows must be DAGs" });
  }

  // Reachability from entry points (triggers or in-degree-0 nodes).
  const entries = graph.nodes
    .filter((n) => n.kind === "trigger" || graph.edges.every((e) => e.to !== n.id))
    .map((n) => n.id);
  const reachable = new Set(entries);
  const stack = [...entries];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adj.get(id) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.id)) {
      issues.push({
        severity: "warning",
        code: "unreachable-node",
        message: `node "${n.label}" (${n.id}) can never activate`,
        nodeId: n.id,
      });
    }
  }

  // Ancestor map for the approval-guard check.
  const parents = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (ids.has(e.from) && ids.has(e.to)) parents.get(e.to)!.push(e.from);
  const hasApprovalUpstream = (id: string, seen = new Set<string>()): boolean => {
    for (const p of parents.get(id) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      const node = graph.nodes.find((n) => n.id === p);
      if (node?.kind === "approval") return true;
      if (hasApprovalUpstream(p, seen)) return true;
    }
    return false;
  };

  // Per-node policy checks.
  for (const n of graph.nodes) {
    if (n.kind === "action") {
      const parsedAction = ActionConfig.safeParse(n.config);
      const cfg = parsedAction.success
        ? parsedAction.data
        : n.config as { server?: string; tool?: string; defer?: unknown };
      const info = toolInfo && cfg.server && cfg.tool ? toolInfo(cfg.server, cfg.tool) : null;
      if (cfg.defer !== undefined) {
        const exactDeferredStatus =
          parsedAction.success &&
          parsedAction.data.defer?.kind === "science_run_terminal" &&
          parsedAction.data.server === "science" &&
          parsedAction.data.tool === "run.status";
        if (!exactDeferredStatus || (info !== null && info?.tier !== "read_auto")) {
          issues.push({
            severity: "error",
            code: "unsafe-deferred-action",
            message:
              `node "${n.label}": durable defer is restricted to the read-only ` +
              "science.run.status tool",
            nodeId: n.id,
          });
        }
      }
      if (toolInfo && cfg.server && cfg.tool && !info) {
        issues.push({
          severity: "warning",
          code: "unknown-tool",
          message: `node "${n.label}": ${cfg.server}.${cfg.tool} is not in the tool catalog`,
          nodeId: n.id,
        });
      }
      if (info && info.tier !== "read_auto" && !hasApprovalUpstream(n.id)) {
        issues.push({
          severity: info.tier === "destructive_confirmed" ? "error" : "warning",
          code: "unguarded-write",
          message: `node "${n.label}" calls ${info.tier.replace("_", " ")} tool ${cfg.server}.${cfg.tool} with no approval node upstream`,
          nodeId: n.id,
        });
      }
      if (cfg.server === "http" && (n.retries ?? 0) === 0) {
        issues.push({
          severity: "warning",
          code: "no-retries-network",
          message: `node "${n.label}" makes a network call with retries=0`,
          nodeId: n.id,
        });
      }
    }
    if (n.kind === "agent" && !(n.config as { agentId?: string }).agentId) {
      issues.push({
        severity: "error",
        code: "agent-missing-id",
        message: `agent node "${n.label}" has no agentId configured`,
        nodeId: n.id,
      });
    }
    if (n.kind === "code" && !String((n.config as { source?: string }).source ?? "").trim()) {
      issues.push({
        severity: "warning",
        code: "empty-code",
        message: `code node "${n.label}" has an empty source`,
        nodeId: n.id,
      });
    }
    // Workshop WP4: verify nodes must carry a valid gate config.
    if (n.kind === "verify" && !VerifyNodeConfig.safeParse(n.config).success) {
      issues.push({
        severity: "error",
        code: "verify-invalid-config",
        message: `verify node "${n.label}" needs { projectId, check } (check: test | arch | refactor-gate | todo-sync | load | custom)`,
        nodeId: n.id,
      });
    }
  }

  // Workshop WP4 (gap W8): a gated project's graph must gate its agents —
  // every agent node needs a verify node downstream, and the graph needs at
  // least one verify gate at all.
  if (opts?.projectMode === "gated") {
    const verifyIds = new Set(graph.nodes.filter((n) => n.kind === "verify").map((n) => n.id));
    if (verifyIds.size === 0) {
      issues.push({
        severity: "error",
        code: "gated-without-verify",
        message: "gated project: the graph has no verify gate — gated execution without a deterministic check is unverified autonomy",
      });
    }
    const reachesVerify = (start: string, seen = new Set<string>()): boolean => {
      for (const next of adj.get(start) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (verifyIds.has(next)) return true;
        if (reachesVerify(next, seen)) return true;
      }
      return false;
    };
    for (const n of graph.nodes) {
      if (n.kind === "agent" && !reachesVerify(n.id)) {
        issues.push({
          severity: "error",
          code: "gated-agent-without-verify",
          message: `gated project: agent node "${n.label}" has no verify gate downstream`,
          nodeId: n.id,
        });
      }
    }
  }

  return issues;
}
