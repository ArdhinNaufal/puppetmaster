import {
  appendAgentMessage,
  createApproval,
  getAgent,
  getAgentMessages,
  getApproval,
  getMission,
  insertStep,
  saveMemory,
  searchMemories,
  searchMemoriesByVector,
  setMemoryEmbedding,
  updateAgent,
  updateMission,
  updateStep,
  type Db,
} from "@puppetmaster/db";
import type { MissionStatus } from "@puppetmaster/shared";
import type { EventBus } from "./bridge.js";
import { toVectorLiteral, type EmbeddingProvider } from "./embeddings.js";
import { ModelRouter, type ChatMessage, type ChatToolDef } from "./model-router.js";
import { BuiltinToolRegistry, type ToolRegistry } from "./tools.js";

const MAX_ITERATIONS = 8;
const now = () => new Date();

/** Tools the runtime provides itself (memory + scratchpad); all read-tier. */
const RUNTIME_TOOLS: ChatToolDef[] = [
  {
    name: "memory__save",
    description: "Save a fact to your long-term memory for future conversations.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "The fact to remember" } },
      required: ["content"],
    },
  },
  {
    name: "memory__search",
    description: "Search your long-term memory for relevant facts.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "scratchpad__set",
    description: "Set a key in your persistent scratchpad (structured working notes).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
    },
  },
];

interface PendingToolCall {
  approvalId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentRuntimeDeps {
  db: Db;
  bus: EventBus;
  router: ModelRouter;
  tools?: ToolRegistry;
  /** When set, memories are embedded on save and recalled by pgvector cosine
   *  similarity (RAG); otherwise recall falls back to keyword search. */
  embedder?: EmbeddingProvider | null;
}

/**
 * Agent Runtime (docs/ARCHITECTURE.md §3.1). Each mission is one **tick**: an
 * agentic loop (LLM ↔ tools) run to completion or to an approval gate. State
 * lives in the DB — conversation window in agent_messages, long-term facts in
 * agent_memories, working notes in agents.scratchpad — so ticks resume across
 * process restarts. Tool calls are gated by autonomy tier: read = auto,
 * write/destructive = paused behind an approval (PRD §4).
 */
export class AgentRuntime {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly router: ModelRouter;
  private readonly tools: ToolRegistry;
  private readonly embedder: EmbeddingProvider | null;

  constructor(deps: AgentRuntimeDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.router = deps.router;
    this.tools = deps.tools ?? new BuiltinToolRegistry();
    this.embedder = deps.embedder ?? null;
  }

  /** Long-term recall: pgvector cosine similarity when an embedder is
   *  configured (and any memory is embedded), else keyword search. */
  private async recall(agentId: string, query: string, limit = 5): Promise<string[]> {
    if (this.embedder && query.trim()) {
      try {
        const [qv] = await this.embedder.embed([query]);
        const hits = await searchMemoriesByVector(this.db, agentId, toVectorLiteral(qv!), limit);
        if (hits.length > 0) return hits.map((h) => h.content);
      } catch {
        /* pgvector unavailable — fall through to keyword */
      }
    }
    const rows = await searchMemories(this.db, agentId, query, limit);
    return rows.map((r) => r.content);
  }

  async runMission(missionId: string): Promise<MissionStatus> {
    const mission = await getMission(this.db, missionId);
    if (!mission) throw new Error(`mission ${missionId} not found`);
    if (["succeeded", "failed", "cancelled"].includes(mission.status)) {
      return mission.status as MissionStatus;
    }
    const agent = await getAgent(this.db, mission.subjectId);
    if (!agent) throw new Error(`agent ${mission.subjectId} not found`);

    const cursor = (mission.cursor ?? {}) as { pending?: PendingToolCall; iterations?: number };
    const resuming = mission.status === "awaiting_approval" && cursor.pending;

    if (!resuming) {
      await updateMission(this.db, missionId, { status: "running", startedAt: now() });
      await this.bus.publish({
        type: "mission.started",
        missionId,
        agentId: agent.id,
        at: now().toISOString(),
      });
      // A direct-chat tick starts with the incoming user message.
      const input = mission.input as { message?: string } | null;
      if (input?.message) {
        await appendAgentMessage(this.db, {
          agentId: agent.id,
          missionId,
          role: "user",
          content: { text: input.message },
        });
        await this.bus.publish({
          type: "agent.message",
          agentId: agent.id,
          missionId,
          role: "user",
          text: input.message,
          at: now().toISOString(),
        });
      }
    } else {
      await updateMission(this.db, missionId, { status: "running" });
      const pending = cursor.pending!;
      const approval = await getApproval(this.db, pending.approvalId);
      const approved = approval?.status === "approved";
      let result: unknown;
      let isError = false;
      if (approved) {
        try {
          result = await this.executeTool(agent.id, missionId, pending.name, pending.args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          isError = true;
        }
      } else {
        result = { error: "approval rejected by operator" };
        isError = true;
      }
      await this.recordToolStep(missionId, pending.name, approved && !isError, pending.args, result);
      await appendAgentMessage(this.db, {
        agentId: agent.id,
        missionId,
        role: "tool",
        content: { toolResults: [{ toolCallId: pending.toolCallId, result, isError }] },
      });
    }

    let iterations = cursor.iterations ?? 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const history = await getAgentMessages(this.db, agent.id);
      const messages = toChatMessages(history);
      const lastUserText =
        [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
      const memories = await this.recall(agent.id, lastUserText, 5);
      const system = buildSystemPrompt(agent, memories);

      // Shared tool catalog filtered by this agent's grants (ARCHITECTURE.md
      // §3.4): empty grants = full catalog; entries like "util.echo" or
      // "workflow.*" restrict it. Runtime memory/scratchpad tools always apply.
      const grants = Array.isArray(agent.toolGrants) ? (agent.toolGrants as string[]) : [];
      const granted = (server: string, tool: string) =>
        grants.length === 0 ||
        grants.includes(`${server}.${tool}`) ||
        grants.includes(`${server}.*`);
      const toolDefs: ChatToolDef[] = [
        ...RUNTIME_TOOLS,
        ...this.tools
          .list()
          .filter((t) => granted(t.server, t.tool))
          .map((t) => ({
            name: `${t.server}__${t.tool}`,
            description: `${t.description} (autonomy tier: ${t.tier})`,
            inputSchema: t.inputSchema,
          })),
      ];

      const modelStep = await insertStep(this.db, {
        missionId,
        nodeId: `llm-${iterations}`,
        kind: "agent",
        status: "running",
        attempt: 0,
        input: { model: agent.model, messages: messages.length },
        startedAt: now(),
      });

      let response;
      try {
        response = await this.router.chat({
          model: agent.model,
          system,
          messages,
          tools: toolDefs,
          maxTokens: 4096,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateStep(this.db, modelStep.id, { status: "failed", error: msg, finishedAt: now() });
        return this.finish(missionId, "failed", null, msg);
      }

      await updateStep(this.db, modelStep.id, {
        status: "succeeded",
        output: { text: response.text, toolCalls: response.toolCalls, usage: response.usage },
        finishedAt: now(),
      });

      // Persist the assistant turn (text and/or tool calls).
      if (response.text || response.toolCalls.length > 0) {
        await appendAgentMessage(this.db, {
          agentId: agent.id,
          missionId,
          role: "assistant",
          content: { text: response.text, toolCalls: response.toolCalls },
        });
      }

      if (response.toolCalls.length === 0) {
        await this.bus.publish({
          type: "agent.message",
          agentId: agent.id,
          missionId,
          role: "assistant",
          text: response.text,
          at: now().toISOString(),
        });
        return this.finish(missionId, "succeeded", response.text, null);
      }

      // Execute tool calls sequentially; a gated call pauses the tick.
      const toolResults: { toolCallId: string; result: unknown; isError?: boolean }[] = [];
      for (const call of response.toolCalls) {
        const tier = this.tierOf(call.name);
        if (tier !== "read_auto") {
          const approval = await createApproval(this.db, {
            missionId,
            nodeId: call.name,
            prompt: `Agent "${agent.name}" wants to call ${call.name.replace("__", ".")} with ${JSON.stringify(call.args)}`,
            tier,
          });
          // Persist results already gathered so the resume rebuilds cleanly.
          if (toolResults.length > 0) {
            await appendAgentMessage(this.db, {
              agentId: agent.id,
              missionId,
              role: "tool",
              content: { toolResults },
            });
          }
          await insertStep(this.db, {
            missionId,
            nodeId: call.name,
            kind: "approval",
            status: "awaiting_approval",
            attempt: 0,
            input: call.args,
            startedAt: now(),
          });
          await updateMission(this.db, missionId, {
            status: "awaiting_approval",
            cursor: {
              iterations,
              pending: {
                approvalId: approval.id,
                toolCallId: call.id,
                name: call.name,
                args: call.args,
              } satisfies PendingToolCall,
            },
          });
          await this.bus.publish({
            type: "approval.requested",
            missionId,
            nodeId: call.name,
            approvalId: approval.id,
            prompt: approval.prompt,
            at: now().toISOString(),
          });
          return "awaiting_approval";
        }

        let result: unknown;
        let isError = false;
        try {
          result = await this.executeTool(agent.id, missionId, call.name, call.args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          isError = true;
        }
        await this.recordToolStep(missionId, call.name, !isError, call.args, result);
        toolResults.push({ toolCallId: call.id, result, isError });
      }

      await appendAgentMessage(this.db, {
        agentId: agent.id,
        missionId,
        role: "tool",
        content: { toolResults },
      });
      await updateMission(this.db, missionId, { cursor: { iterations } });
    }

    return this.finish(missionId, "failed", null, `tick exceeded ${MAX_ITERATIONS} iterations`);
  }

  private tierOf(toolName: string): string {
    if (toolName.startsWith("memory__") || toolName.startsWith("scratchpad__")) return "read_auto";
    const [server, tool] = toolName.split("__");
    return this.tools.info(server ?? "", tool ?? "")?.tier ?? "write_approved";
  }

  private async executeTool(
    agentId: string,
    missionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (toolName === "memory__save") {
      const content = String(args.content ?? "");
      const row = await saveMemory(this.db, agentId, content);
      if (this.embedder && content.trim()) {
        try {
          const [emb] = await this.embedder.embed([content]);
          await setMemoryEmbedding(this.db, row.id, toVectorLiteral(emb!));
        } catch {
          /* keyword recall still works without the vector */
        }
      }
      return { saved: true, id: row.id };
    }
    if (toolName === "memory__search") {
      return this.recall(agentId, String(args.query ?? ""));
    }
    if (toolName === "scratchpad__set") {
      const agent = await getAgent(this.db, agentId);
      const pad = { ...((agent?.scratchpad as Record<string, unknown>) ?? {}) };
      pad[String(args.key)] = args.value;
      await updateAgent(this.db, agentId, { scratchpad: pad });
      return { ok: true };
    }
    const [server, tool] = toolName.split("__");
    if (!server || !tool) throw new Error(`malformed tool name: ${toolName}`);
    // Enforce grants at execution too, not just when advertising tools.
    const agent = await getAgent(this.db, agentId);
    const grants = Array.isArray(agent?.toolGrants) ? (agent!.toolGrants as string[]) : [];
    if (grants.length > 0 && !grants.includes(`${server}.${tool}`) && !grants.includes(`${server}.*`)) {
      throw new Error(`tool ${server}.${tool} is not granted to this agent`);
    }
    return this.tools.callTool(server, tool, args, { input: null, agentId, missionId });
  }

  private async recordToolStep(
    missionId: string,
    toolName: string,
    ok: boolean,
    input: unknown,
    output: unknown,
  ): Promise<void> {
    await insertStep(this.db, {
      missionId,
      nodeId: toolName,
      kind: "action",
      status: ok ? "succeeded" : "failed",
      attempt: 0,
      input,
      output,
      error: ok ? null : JSON.stringify(output),
      startedAt: now(),
      finishedAt: now(),
    });
  }

  private async finish(
    missionId: string,
    status: MissionStatus,
    output: unknown,
    error: string | null,
  ): Promise<MissionStatus> {
    await updateMission(this.db, missionId, { status, output, error, finishedAt: now() });
    await this.bus.publish({
      type: "mission.finished",
      missionId,
      status,
      at: now().toISOString(),
    });
    return status;
  }
}

function buildSystemPrompt(
  agent: { name: string; persona: string; scratchpad: unknown },
  memories: string[],
): string {
  const pad = agent.scratchpad && Object.keys(agent.scratchpad as object).length > 0
    ? `\n\nYour scratchpad (working notes):\n${JSON.stringify(agent.scratchpad, null, 2)}`
    : "";
  const mem = memories.length > 0
    ? `\n\nRelevant long-term memories:\n${memories.map((m) => `- ${m}`).join("\n")}`
    : "";
  return `You are ${agent.name}, an agent on the Puppetmaster platform.\n\n${agent.persona}${pad}${mem}\n\nUse tools when they help. Save durable facts with memory__save. Tools marked write/destructive pause for human approval.`;
}



/** Rebuild the provider-agnostic conversation from persisted rows, merging
 *  consecutive tool-result rows into one turn (providers require tool results
 *  grouped in a single message). */
function toChatMessages(
  rows: { role: string; content: unknown }[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const row of rows) {
    const c = (row.content ?? {}) as Record<string, unknown>;
    if (row.role === "user") {
      out.push({ role: "user", text: String(c.text ?? "") });
    } else if (row.role === "assistant") {
      out.push({
        role: "assistant",
        text: typeof c.text === "string" ? c.text : "",
        toolCalls: Array.isArray(c.toolCalls) ? (c.toolCalls as ChatMessage["toolCalls"]) : [],
      });
    } else if (row.role === "tool") {
      const results = Array.isArray(c.toolResults)
        ? (c.toolResults as NonNullable<ChatMessage["toolResults"]>)
        : [];
      const prev = out[out.length - 1];
      if (prev?.role === "tool") {
        prev.toolResults = [...(prev.toolResults ?? []), ...results];
      } else {
        out.push({ role: "tool", toolResults: results });
      }
    }
  }
  return out;
}
