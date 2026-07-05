import { WorkflowGraph } from "@puppetmaster/shared";
import type { ModelRouter } from "./model-router.js";

/**
 * Workflow copilot (Stage 6, G9 — AFlow product-grade takeaway): NL→draft
 * generation with a critique loop left to the human. The draft is *returned*,
 * never saved — the editor renders it as editable state and the builder
 * decides (human-in-command per §1.2). With a real model the graph is
 * model-drafted; with the keyless mock provider a deterministic heuristic
 * draft keeps the whole flow exercisable.
 */

const DRAFT_SYSTEM = `You design Puppetmaster workflow graphs. Reply with ONLY a JSON object:
{"nodes":[{"id":"t1","kind":"trigger|action|logic|code|agent|approval","label":"...","config":{...},"position":{"x":0,"y":0}}],"edges":[{"from":"t1","to":"n2","condition":null}]}
Node configs: trigger {"mode":"manual|cron|webhook"}; action {"server":"util|http|email|kb","tool":"echo|get|send|search","args":{}};
logic {"op":"branch|wait|passthrough","expression":"out > 5"}; code {"source":"return input;"}; approval {"prompt":"..."}.
Always start from one trigger. Put write/destructive steps behind an approval node. Space positions x by 220.`;

/** Deterministic keyword-based draft for keyless/mock operation. */
export function heuristicDraft(description: string): WorkflowGraph {
  const d = description.toLowerCase();
  const nodes: WorkflowGraph["nodes"] = [];
  const edges: WorkflowGraph["edges"] = [];
  let x = 60;
  const add = (node: Omit<WorkflowGraph["nodes"][number], "position" | "retries" | "timeoutMs">) => {
    nodes.push({ ...node, position: { x, y: 140 }, retries: 0, timeoutMs: 30_000 });
    if (nodes.length > 1) edges.push({ from: nodes[nodes.length - 2]!.id, to: node.id, condition: null });
    x += 220;
  };

  add({
    id: "t1",
    kind: "trigger",
    label: d.includes("webhook") ? "Webhook" : d.includes("schedule") || d.includes("cron") || d.includes("daily") ? "Cron" : "Manual",
    config: d.includes("webhook")
      ? { mode: "webhook" }
      : d.includes("schedule") || d.includes("cron") || d.includes("daily")
        ? { mode: "cron", cron: "0 9 * * *" }
        : { mode: "manual" },
  });
  if (d.includes("http") || d.includes("fetch") || d.includes("api")) {
    add({ id: "n_fetch", kind: "action", label: "Fetch", config: { server: "http", tool: "get", args: { url: "https://example.com" } } });
  }
  if (d.includes("search") || d.includes("knowledge") || d.includes("document")) {
    add({ id: "n_kb", kind: "action", label: "KB search", config: { server: "kb", tool: "search", args: { query: "{{input}}" } } });
  }
  add({ id: "n_code", kind: "code", label: "Transform", config: { source: "return input;" } });
  if (d.includes("agent") || d.includes("summar") || d.includes("analy")) {
    add({ id: "n_agent", kind: "agent", label: "Ask agent", config: { agentId: "", message: "{{input}}" } });
  }
  if (d.includes("email") || d.includes("send") || d.includes("notify")) {
    add({ id: "n_gate", kind: "approval", label: "Approve send", config: { prompt: "Approve the outgoing message?" } });
    add({ id: "n_send", kind: "action", label: "Send email", config: { server: "email", tool: "send", args: { to: "", subject: "", body: "{{input}}" } } });
  }
  return WorkflowGraph.parse({ nodes, edges });
}

/** Extract the first JSON object from a model reply (tolerates fences/prose). */
function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function draftWorkflowGraph(
  router: ModelRouter,
  model: string,
  description: string,
): Promise<{ graph: WorkflowGraph; source: "model" | "heuristic" }> {
  try {
    const res = await router.chat({
      model,
      system: DRAFT_SYSTEM,
      messages: [{ role: "user", text: `Draft a workflow for: ${description}` }],
      maxTokens: 2048,
    });
    const raw = extractJson(res.text);
    if (raw) {
      const parsed = WorkflowGraph.safeParse(raw);
      if (parsed.success && parsed.data.nodes.length > 0) {
        return { graph: parsed.data, source: "model" };
      }
    }
  } catch {
    /* fall through to the deterministic draft */
  }
  return { graph: heuristicDraft(description), source: "heuristic" };
}

/**
 * Failure explainer (Stage 6): a deterministic first line locating the
 * failure, then a model-written diagnosis of the recorded trace.
 */
export async function explainFailure(
  router: ModelRouter,
  model: string,
  mission: { id: string; status: string; error: string | null },
  steps: { nodeId: string; kind: string; status: string; attempt: number; input: unknown; output: unknown; error: string | null }[],
): Promise<{ summary: string; diagnosis: string; failedNodeId: string | null }> {
  const failed = steps.find((s) => s.status === "failed") ?? null;
  const summary = failed
    ? `Failed at node "${failed.nodeId}" (${failed.kind}) on attempt ${failed.attempt + 1}: ${failed.error ?? mission.error ?? "unknown error"}`
    : `Mission ended ${mission.status}: ${mission.error ?? "unknown error"}`;

  const trace = steps
    .map((s) => `- ${s.nodeId} [${s.kind}] ${s.status}${s.error ? ` error=${s.error}` : ""}`)
    .join("\n");
  let diagnosis = "";
  try {
    const res = await router.chat({
      model,
      system:
        "You diagnose failed automation runs. Given a step trace, explain the most likely root cause and one concrete fix, in at most three sentences.",
      messages: [
        {
          role: "user",
          text: `Mission error: ${mission.error ?? "n/a"}\nTrace:\n${trace}\nFailing step input: ${JSON.stringify(failed?.input ?? null)?.slice(0, 400)}`,
        },
      ],
      maxTokens: 300,
    });
    diagnosis = res.text.trim();
  } catch {
    diagnosis = "";
  }
  return { summary, diagnosis, failedNodeId: failed?.nodeId ?? null };
}
