import {
  appendAgentMessage,
  beginNodeExecution,
  commitNodeExecution,
  countMemories,
  createApproval,
  evictMemoryOverflow,
  findCommittedExecutionByKey,
  getAgent,
  getAgentMessages,
  getApproval,
  getMemory,
  getMission,
  insertStep,
  saveMemory,
  searchMemories,
  searchMemoriesByVector,
  setMemoryEmbedding,
  touchMemories,
  updateAgent,
  updateMemory,
  updateMission,
  updateStep,
  type Db,
} from "@puppetmaster/db";
import type { MissionStatus } from "@puppetmaster/shared";
import type { EventBus } from "./bridge.js";
import type { AuditSink } from "./audit-sink.js";
import { toVectorLiteral, type EmbeddingProvider } from "./embeddings.js";
import { ModelFloorError, ModelRouter, type ChatMessage, type ChatToolDef } from "./model-router.js";
import { rrfFuse } from "./kb.js";
import { findMatchingPolicy, type ApprovalPolicyLike } from "./policy.js";
import { BuiltinToolRegistry, type ToolRegistry } from "./tools.js";
import { UNTRUSTED_PROMPT_NOTE, wrapUntrusted } from "./untrusted.js";

/** Memory v2 admission control (Stage 4): near-duplicate merge threshold and
 *  the per-agent cap that decay-based eviction enforces. */
const MEMORY_DEDUP_TAU = 0.92;
const MEMORY_CAP = Math.max(10, Number(process.env.MEMORY_CAP ?? 200));

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
  audit?: AuditSink;
  /** Approval auto-allow policies for an agent (own + workspace-wide); a
   *  matching gated call executes without pausing, audited as approval.auto. */
  policyLookup?: (agentId: string) => Promise<ApprovalPolicyLike[]>;
  /** Budget gate (Stage 5, G8): non-null reason = month-to-date tokens exceed
   *  a budget → the tick pauses behind an approval before any LLM call. */
  budgetGate?: (workspaceId: string, agentId: string) => Promise<string | null>;
}

/** Tool results are external data: wrap them in untrusted-data delimiters
 *  before they re-enter the model context (Stage 1, G1). First-party runtime
 *  tools (memory/scratchpad) are exempt — their content is agent-authored. */
function wrapToolResultForContext(toolName: string, result: unknown): unknown {
  if (toolName.startsWith("memory__") || toolName.startsWith("scratchpad__")) return result;
  return wrapUntrusted(`tool:${toolName.replace("__", ".")}`, result);
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
  private readonly audit: AuditSink | null;
  private readonly policyLookup: AgentRuntimeDeps["policyLookup"] | null;
  private readonly budgetGate: AgentRuntimeDeps["budgetGate"] | null;

  constructor(deps: AgentRuntimeDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.router = deps.router;
    this.tools = deps.tools ?? new BuiltinToolRegistry();
    this.embedder = deps.embedder ?? null;
    this.audit = deps.audit ?? null;
    this.policyLookup = deps.policyLookup ?? null;
    this.budgetGate = deps.budgetGate ?? null;
  }

  /** Best-effort audit; never let a logging failure break the tick. */
  private async recordAudit(entry: Parameters<AuditSink>[0]): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit(entry);
    } catch {
      /* audit is advisory */
    }
  }

  /** Hybrid long-term recall (Stage 4, reusing Stage 3's fusion): pgvector
   *  cosine + keyword lists fused by reciprocal rank. Recalled memories are
   *  touched so decay-based eviction keeps useful ones alive. */
  private async recall(agentId: string, query: string, limit = 5): Promise<string[]> {
    const lists: { id: string; content: string }[][] = [];
    if (this.embedder && query.trim()) {
      try {
        const [qv] = await this.embedder.embed([query]);
        lists.push(await searchMemoriesByVector(this.db, agentId, toVectorLiteral(qv!), 10));
      } catch {
        /* pgvector unavailable — keyword leg still applies */
      }
    }
    const kw = await searchMemories(this.db, agentId, query, 10);
    lists.push(kw.map((r) => ({ id: r.id, content: r.content })));
    const top = rrfFuse(lists, (m) => m.id)
      .slice(0, limit)
      .map(({ item }) => item);
    touchMemories(this.db, top.map((m) => m.id)).catch(() => {});
    return top.map((m) => m.content);
  }

  /**
   * Admission-controlled memory write (Stage 4): a near-duplicate of an
   * existing same-kind memory (cosine > τ) is merged — importance bumped,
   * recency touched — instead of inserted; otherwise insert + embed, then
   * evict decay-scored overflow above the per-agent cap (pins survive).
   */
  private async admitMemory(
    agentId: string,
    content: string,
    opts: { kind?: string; missionId?: string | null; importance?: number } = {},
  ): Promise<{ id: string; merged: boolean }> {
    const kind = opts.kind ?? "fact";
    let vector: string | null = null;
    if (this.embedder && content.trim()) {
      try {
        const [emb] = await this.embedder.embed([content]);
        vector = toVectorLiteral(emb!);
        const [nearest] = await searchMemoriesByVector(this.db, agentId, vector, 1, kind);
        if (nearest && nearest.score > MEMORY_DEDUP_TAU) {
          const existing = await getMemory(this.db, nearest.id);
          await updateMemory(this.db, nearest.id, {
            importance: Math.min(1, Math.max(existing?.importance ?? 0.5, opts.importance ?? 0.5) + 0.05),
            lastAccessedAt: new Date(),
          });
          return { id: nearest.id, merged: true };
        }
      } catch {
        vector = null; /* embedding unavailable — plain insert */
      }
    }
    const row = await saveMemory(this.db, agentId, content, {
      kind,
      missionId: opts.missionId ?? null,
      importance: opts.importance,
    });
    if (vector) await setMemoryEmbedding(this.db, row.id, vector);
    if ((await countMemories(this.db, agentId)) > MEMORY_CAP) {
      await evictMemoryOverflow(this.db, agentId, MEMORY_CAP).catch(() => {});
    }
    return { id: row.id, merged: false };
  }

  /** Episodic + procedural memories for a finished tick (Stage 4): a
   *  model-written one-line summary linked to the mission, and — when tools
   *  ran — a LEGOMem-style "steps that worked" procedure. Best-effort. */
  private async writeMissionMemories(
    agent: { id: string; name: string; model: string },
    missionId: string,
    task: string,
    toolsUsed: string[],
    finalReply: string,
  ): Promise<void> {
    if (!task.trim()) return;
    try {
      const summary = await this.router.chat({
        model: agent.model,
        system:
          "Summarize the completed task in one factual sentence (what was asked, what was done). Reply with the sentence only.",
        messages: [
          {
            role: "user",
            text: `Task: ${task.slice(0, 300)}\nTools used: ${toolsUsed.join(", ") || "none"}\nFinal reply: ${finalReply.slice(0, 300)}`,
          },
        ],
        maxTokens: 200,
      });
      if (summary.text.trim()) {
        await this.admitMemory(agent.id, `[episode] ${summary.text.trim()}`, {
          kind: "episodic",
          missionId,
          importance: 0.6,
        });
      }
    } catch {
      /* episodic memory is advisory */
    }
    if (toolsUsed.length > 0) {
      const procedure = `[procedure] task: "${task.slice(0, 160)}" | steps: ${toolsUsed
        .map((t) => t.replace("__", "."))
        .join(" → ")} | outcome: success`;
      await this.admitMemory(agent.id, procedure, {
        kind: "procedural",
        missionId,
        importance: 0.7,
      }).catch(() => {});
    }
  }

  async runMission(missionId: string): Promise<MissionStatus> {
    const mission = await getMission(this.db, missionId);
    if (!mission) throw new Error(`mission ${missionId} not found`);
    if (["succeeded", "failed", "cancelled"].includes(mission.status)) {
      return mission.status as MissionStatus;
    }
    const agent = await getAgent(this.db, mission.subjectId);
    if (!agent) throw new Error(`agent ${mission.subjectId} not found`);

    // Actor identity stamped on this tick's audit entries (ARCHITECTURE.md §3.6).
    const auditActor = {
      workspaceId: mission.workspaceId,
      actorKind: "agent" as const,
      actorId: agent.id,
      actorLabel: agent.name,
      missionId,
    };

    const cursor = (mission.cursor ?? {}) as { pending?: PendingToolCall; iterations?: number };
    const resuming = mission.status === "awaiting_approval" && cursor.pending;

    // Router-profile floor gate (Stage 9A): a tick paused because its profile
    // could only answer below the gated-tools floor resumes here — approved
    // means this mission may downgrade for the rest of the tick.
    const floorCursor = cursor as typeof cursor & { floorApprovalId?: string; floorCleared?: boolean };
    let allowDowngrade = Boolean(floorCursor.floorCleared);
    if (!resuming && floorCursor.floorApprovalId && !floorCursor.floorCleared) {
      const approval = await getApproval(this.db, floorCursor.floorApprovalId);
      if (!approval || approval.status === "pending") return "awaiting_approval";
      if (approval.status === "rejected") {
        return this.finish(missionId, "failed", null, "model-class downgrade rejected by operator");
      }
      allowDowngrade = true;
      floorCursor.floorCleared = true;
      await updateMission(this.db, missionId, { cursor: { ...floorCursor } });
    }

    // Stage 4: the task text + successful tool sequence feed the episodic and
    // procedural memories written when the tick succeeds.
    const taskMessage = ((mission.input ?? {}) as { message?: string }).message ?? "";
    const toolsUsed: string[] = [];

    // Budget gate (Stage 5, G8): a new tick whose agent/workspace is over a
    // monthly token budget pauses behind an approval before any LLM call; the
    // operator may approve to run anyway or reject to stop it.
    const budgetCursor = cursor as typeof cursor & { budgetApprovalId?: string; budgetCleared?: boolean };
    if (!resuming) {
      if (budgetCursor.budgetApprovalId && !budgetCursor.budgetCleared) {
        const approval = await getApproval(this.db, budgetCursor.budgetApprovalId);
        if (!approval || approval.status === "pending") return "awaiting_approval";
        if (approval.status === "rejected") {
          return this.finish(missionId, "failed", null, "budget-exceeded tick rejected by operator");
        }
        budgetCursor.budgetCleared = true;
        await updateMission(this.db, missionId, { cursor: { ...budgetCursor } });
      } else if (!budgetCursor.budgetApprovalId && this.budgetGate) {
        let reason: string | null = null;
        try {
          reason = await this.budgetGate(mission.workspaceId, agent.id);
        } catch {
          reason = null; /* a broken gate must not block normal operation */
        }
        if (reason) {
          const approval = await createApproval(this.db, {
            missionId,
            nodeId: "budget",
            prompt: `Token budget exceeded for agent "${agent.name}" (${reason}). Run this tick anyway?`,
            tier: "write_approved",
          });
          await updateMission(this.db, missionId, {
            status: "awaiting_approval",
            cursor: { ...budgetCursor, budgetApprovalId: approval.id },
          });
          await this.recordAudit({
            ...auditActor,
            action: "budget.gate",
            target: agent.id,
            detail: { reason },
          });
          await this.bus.publish({
            type: "approval.requested",
            missionId,
            nodeId: "budget",
            approvalId: approval.id,
            prompt: approval.prompt,
            at: now().toISOString(),
          });
          return "awaiting_approval";
        }
      }
    }

    if (!resuming) {
      await updateMission(this.db, missionId, { status: "running", startedAt: now() });
      await this.bus.publish({
        type: "mission.started",
        missionId,
        agentId: agent.id,
        at: now().toISOString(),
      });
      // A direct-chat tick starts with the incoming user message — unless this
      // is a floor-gate resume, where the message was appended before the gate.
      const input = mission.input as { message?: string } | null;
      if (input?.message && !floorCursor.floorApprovalId) {
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
        // Idempotency (Stage 2): if a previous resume executed this approved
        // call but died before persisting the result, don't repeat the side
        // effect — reuse the committed output.
        const execKey = `${missionId}:approval:${pending.approvalId}`;
        const committed = await findCommittedExecutionByKey(this.db, execKey);
        if (committed) {
          result = committed.output;
        } else {
          const exec = await beginNodeExecution(this.db, {
            missionId,
            nodeId: pending.name,
            key: execKey,
          });
          try {
            result = await this.executeTool(agent.id, missionId, pending.name, pending.args);
            await commitNodeExecution(this.db, exec.id, result);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
            isError = true;
          }
        }
      } else {
        result = { error: "approval rejected by operator" };
        isError = true;
      }
      if (approved && !isError) toolsUsed.push(pending.name);
      await this.recordToolStep(missionId, pending.name, approved && !isError, pending.args, result);
      await this.recordAudit({
        ...auditActor,
        action: "tool.call",
        target: pending.name.replace("__", "."),
        detail: { ok: approved && !isError, gated: true, approved, args: pending.args },
      });
      await appendAgentMessage(this.db, {
        agentId: agent.id,
        missionId,
        role: "tool",
        content: {
          toolResults: [
            {
              toolCallId: pending.toolCallId,
              result: wrapToolResultForContext(pending.name, result),
              isError,
            },
          ],
        },
      });
    }

    let iterations = cursor.iterations ?? 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Cooperative cancellation (Stage 2): honour a cancel request between
      // iterations of the tick loop.
      const freshMission = await getMission(this.db, missionId);
      if (freshMission?.cancelRequested) {
        return this.finish(missionId, "cancelled", null, "cancelled by operator");
      }

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

      // Stage 9A: an agent that can reach write/destructive tools never
      // silently downgrades below its profile's floor — the router throws
      // ModelFloorError instead, converted below into an approval gate.
      const hasGatedTools = this.tools
        .list()
        .some((t) => granted(t.server, t.tool) && t.tier !== "read_auto");

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
        // Stream deltas onto the bus (Stage 6): the UI renders them as a live
        // bubble that is replaced by the persisted message when the turn ends.
        response = await this.router.chatStream(
          {
            model: agent.model,
            system,
            messages,
            tools: toolDefs,
            maxTokens: 4096,
            enforceGatedFloor: hasGatedTools && !allowDowngrade,
          },
          (delta) => {
            void Promise.resolve(
              this.bus.publish({
                type: "agent.message.delta",
                agentId: agent.id,
                missionId,
                delta,
                at: now().toISOString(),
              }),
            ).catch(() => {});
          },
        );
      } catch (err) {
        if (err instanceof ModelFloorError) {
          // The profile refused to serve below its floor: pause for a human
          // downgrade decision instead of silently substituting (9ROUTER §4).
          const approval = await createApproval(this.db, {
            missionId,
            nodeId: "router-floor",
            prompt:
              `Router profile "${err.profileName}" for agent "${agent.name}" can only answer ` +
              `below its "${err.floor}" floor right now (candidates: ${err.blocked.join(", ")}). ` +
              `Serve this tick on a lower-class model?`,
            tier: "write_approved",
          });
          await updateStep(this.db, modelStep.id, { status: "awaiting_approval", finishedAt: now() });
          await updateMission(this.db, missionId, {
            status: "awaiting_approval",
            cursor: {
              // Redo this iteration on resume — nothing was served.
              iterations: iterations - 1,
              floorApprovalId: approval.id,
              ...(budgetCursor.budgetApprovalId
                ? { budgetApprovalId: budgetCursor.budgetApprovalId, budgetCleared: budgetCursor.budgetCleared }
                : {}),
            },
          });
          await this.recordAudit({
            ...auditActor,
            action: "router.floor.gate",
            target: agent.model,
            detail: { profile: err.profileName, floor: err.floor, blocked: err.blocked },
          });
          await this.bus.publish({
            type: "approval.requested",
            missionId,
            nodeId: "router-floor",
            approvalId: approval.id,
            prompt: approval.prompt,
            at: now().toISOString(),
          });
          return "awaiting_approval";
        }
        const msg = err instanceof Error ? err.message : String(err);
        await updateStep(this.db, modelStep.id, { status: "failed", error: msg, finishedAt: now() });
        return this.finish(missionId, "failed", null, msg);
      }

      await updateStep(this.db, modelStep.id, {
        status: "succeeded",
        output: { text: response.text, toolCalls: response.toolCalls, usage: response.usage },
        finishedAt: now(),
      });
      await this.recordAudit({
        ...auditActor,
        action: "llm.call",
        target: agent.model,
        detail: {
          iteration: iterations,
          usage: response.usage,
          toolCalls: response.toolCalls.length,
          ...(response.servedBy && response.servedBy !== agent.model
            ? { servedBy: response.servedBy }
            : {}),
          ...(response.profile ? { profile: response.profile } : {}),
        },
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
        await this.writeMissionMemories(agent, missionId, taskMessage, toolsUsed, response.text);
        return this.finish(missionId, "succeeded", response.text, null);
      }

      // Execute tool calls sequentially; a gated call pauses the tick.
      const toolResults: { toolCallId: string; result: unknown; isError?: boolean }[] = [];
      for (const call of response.toolCalls) {
        const tier = this.tierOf(call.name);
        // Auto-allow policies (Stage 1, G2): a gated call matching a reviewed
        // policy skips the human gate; a policy-lookup failure fails closed.
        let autoPolicy: ApprovalPolicyLike | null = null;
        if (tier !== "read_auto" && this.policyLookup) {
          const [server, tool] = call.name.split("__");
          if (server && tool) {
            try {
              const policies = await this.policyLookup(agent.id);
              autoPolicy = findMatchingPolicy(policies, { server, tool, args: call.args });
            } catch {
              autoPolicy = null;
            }
          }
        }
        if (autoPolicy) {
          await this.recordAudit({
            ...auditActor,
            action: "approval.auto",
            target: call.name.replace("__", "."),
            detail: { policyId: autoPolicy.id, tier, args: call.args },
          });
        }
        if (tier !== "read_auto" && !autoPolicy) {
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
        if (!isError && !call.name.startsWith("memory__") && !call.name.startsWith("scratchpad__")) {
          toolsUsed.push(call.name);
        }
        await this.recordToolStep(missionId, call.name, !isError, call.args, result);
        await this.recordAudit({
          ...auditActor,
          action: "tool.call",
          target: call.name.replace("__", "."),
          detail: { ok: !isError, args: call.args, ...(autoPolicy ? { autoApproved: true } : {}) },
        });
        toolResults.push({
          toolCallId: call.id,
          result: wrapToolResultForContext(call.name, result),
          isError,
        });
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
      const { id, merged } = await this.admitMemory(agentId, content, { missionId });
      return { saved: true, id, merged };
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
  return `You are ${agent.name}, an agent on the Puppetmaster platform.\n\n${agent.persona}${pad}${mem}\n\nUse tools when they help. Save durable facts with memory__save. Tools marked write/destructive pause for human approval.\n\n${UNTRUSTED_PROMPT_NOTE}`;
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
