import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WorkflowGraph } from "@puppetmaster/shared";
import {
  appendAudit,
  createAgent,
  createDb,
  createTemplate,
  createWorkflow,
  deleteAgent,
  deleteTemplate,
  ensureDefaultWorkspace,
  getAgent,
  getAgentMessages,
  getApproval,
  getMission,
  getMissionSteps,
  getTemplate,
  getWorkflowWithGraph,
  getWorkspace,
  listAgents,
  listApprovals,
  listAudit,
  listMemories,
  listMissions,
  listTemplates,
  listWorkflows,
  migrate,
  missionUsage,
  resolveApproval,
  saveWorkflowVersion,
  searchMemories,
  searchMemoriesByVector,
  seedBuiltinTemplates,
  updateAgent,
  updateWorkspace,
  type DbHandle,
} from "@puppetmaster/db";
import {
  AgentRuntime,
  BuiltinToolRegistry,
  connectMcpServer,
  createAgentInvoker,
  createEmbedder,
  InlineRunner,
  InMemoryEventBus,
  ModelRouter,
  toVectorLiteral,
  parseMcpServersEnv,
  QueueRunner,
  RedisEventBus,
  registerBridgeTools,
  startAgentTick,
  startWorkflow,
  WorkflowExecutor,
  type EventBus,
  type McpConnection,
  type MissionDispatcher,
  type WorkflowRunner,
} from "@puppetmaster/kernel";
import { utilsServerPath } from "@puppetmaster/mcp-connectors";
import { registerAuth } from "./auth.js";
import { BUILTIN_TEMPLATES } from "./seeds.js";
import { createAuditSink, startAuditProjector } from "./audit.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";
const REDIS_URL = process.env.REDIS_URL ?? null;

const app = Fastify({ logger: true });

// --- Kernel wiring -----------------------------------------------------------
const handle: DbHandle = await createDb();
await migrate(handle);
const { db } = handle;
const workspaceId = await ensureDefaultWorkspace(db);

const tools = new BuiltinToolRegistry();
const bus: EventBus = REDIS_URL ? new RedisEventBus(REDIS_URL) : new InMemoryEventBus();
const router = new ModelRouter({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  openaiApiKey: process.env.OPENAI_API_KEY,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
});
// RAG: embed agent memories into pgvector for semantic recall (PRD §5). Defaults
// to the keyless mock embedder so the pipeline is live in dev; set
// EMBEDDING_PROVIDER=openai (+ key) for a real model, or =none for keyword-only.
const embedder = createEmbedder({
  provider: process.env.EMBEDDING_PROVIDER,
  model: process.env.EMBEDDING_MODEL,
  baseUrl: process.env.EMBEDDING_BASE_URL ?? process.env.OPENAI_BASE_URL,
  apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY,
});
// Append-only audit log (ARCHITECTURE.md §3.6): the kernel writes LLM/tool
// calls through this sink; a bus projector adds mission lifecycle + approval
// requests; endpoints add approval decisions and auth/member actions.
const auditSink = createAuditSink(db);
const executor = new WorkflowExecutor({ db, bus, tools, audit: auditSink });
const agentRuntime = new AgentRuntime({ db, bus, router, tools, embedder, audit: auditSink });
const auditUnsub = startAuditProjector(bus, db);

// Seed the first-party template catalog (PRD §6 marketplace), idempotently.
const seededTemplates = await seedBuiltinTemplates(db, BUILTIN_TEMPLATES);
if (seededTemplates > 0) app.log.info({ seededTemplates }, "seeded builtin templates");

// --- The bridge (ARCHITECTURE.md §3.3) ----------------------------------------
// Workflow → agent: agent nodes dispatch a task and await the child mission.
executor.setAgentInvoker(createAgentInvoker({ db, runtime: agentRuntime }));
// Agent → workflow: workflows join the shared tool catalog (workflow.list/run/create_draft).
registerBridgeTools(tools, { db, workspaceId, executor });

// --- Tool layer: MCP servers (ARCHITECTURE.md §3.4) ---------------------------
// Bundled utils connector by default; extend/override via MCP_SERVERS JSON.
const mcpConfigs = parseMcpServersEnv(process.env.MCP_SERVERS);
if (mcpConfigs.length === 0 && process.env.MCP_DISABLE_BUNDLED !== "1") {
  mcpConfigs.push({ name: "mcputil", command: process.execPath, args: [utilsServerPath] });
}
const mcpConnections: McpConnection[] = [];
for (const cfg of mcpConfigs) {
  try {
    const conn = await connectMcpServer(tools, cfg);
    mcpConnections.push(conn);
    app.log.info({ server: cfg.name, tools: conn.toolCount }, "mcp server connected");
  } catch (err) {
    app.log.error({ server: cfg.name, err }, "mcp server failed to connect");
  }
}

/** Route a mission to the right executor based on its kind. */
const dispatch: MissionDispatcher = async (missionId) => {
  const mission = await getMission(db, missionId);
  if (!mission) throw new Error(`mission ${missionId} not found`);
  return mission.kind === "agent"
    ? agentRuntime.runMission(missionId)
    : executor.runMission(missionId);
};

const runner: WorkflowRunner = REDIS_URL
  ? new QueueRunner(REDIS_URL, { run: dispatch, db })
  : new InlineRunner(dispatch);

app.log.info(
  { dbDriver: handle.driver, bus: REDIS_URL ? "redis" : "memory", runner: REDIS_URL ? "queue" : "inline" },
  "puppetmaster kernel ready",
);

/** Register cron schedulers for any cron-mode trigger nodes in a workflow. */
async function scheduleCrons(workflowId: string, graph: unknown): Promise<void> {
  const parsed = WorkflowGraph.safeParse(graph);
  if (!parsed.success) return;
  const cronNode = parsed.data.nodes.find(
    (n) => n.kind === "trigger" && n.config?.mode === "cron" && typeof n.config?.cron === "string",
  );
  if (cronNode) await runner.scheduleCron("workflow", workflowId, String(cronNode.config.cron));
  else await runner.unscheduleCron("workflow", workflowId).catch(() => {});
}

/** Register/unregister an agent's cron schedule. */
async function scheduleAgentCron(agentId: string, cron: string | null): Promise<void> {
  if (cron) await runner.scheduleCron("agent", agentId, cron);
  else await runner.unscheduleCron("agent", agentId).catch(() => {});
}

// Re-arm cron triggers for existing workflows and agents on boot.
for (const wf of await listWorkflows(db, workspaceId)) {
  const full = await getWorkflowWithGraph(db, wf.id);
  if (full?.version) await scheduleCrons(wf.id, full.version.graph);
}
for (const agent of await listAgents(db, workspaceId)) {
  if (agent.schedule) await scheduleAgentCron(agent.id, agent.schedule);
}

await app.register(websocket);

// --- Auth + RBAC gateway (ARCHITECTURE.md §6) ---------------------------------
// Must come before route definitions so the session/RBAC hook attaches to them.
await registerAuth(app, { db, workspaceId });

// --- Meta --------------------------------------------------------------------
app.get("/api/health", async () => ({ ok: true, service: "puppetmaster-server", version: "0.0.1" }));

app.get("/api/bootstrap", async () => ({
  workspaceId,
  dbDriver: handle.driver,
  queue: REDIS_URL ? "bullmq" : "inline",
  tools: tools.list(),
}));

app.get("/api/tools", async () => tools.list());

// --- Workspace / branding (M4) ------------------------------------------------
app.get("/api/workspace", async () => getWorkspace(db, workspaceId));

app.put("/api/workspace", async (req) => {
  const body = (req.body ?? {}) as { name?: string; branding?: Record<string, unknown> };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (body.branding && typeof body.branding === "object") {
    // Merge so concurrent editors of different branding keys don't clobber each other.
    const current = await getWorkspace(db, workspaceId);
    patch.branding = { ...((current?.branding as object) ?? {}), ...body.branding };
  }
  if (Object.keys(patch).length > 0) await updateWorkspace(db, workspaceId, patch);
  return getWorkspace(db, workspaceId);
});

// --- Templates / marketplace (M5, PRD §6) -------------------------------------
app.get("/api/templates", async () => listTemplates(db, workspaceId));

/** Instantiate a template into this workspace as a live workflow or agent. */
app.post("/api/templates/:id/instantiate", async (req, reply) => {
  const { id } = req.params as { id: string };
  const tpl = await getTemplate(db, id);
  if (!tpl) return reply.code(404).send({ error: "template not found" });
  const body = (req.body ?? {}) as { name?: string };

  if (tpl.kind === "workflow") {
    const graph = WorkflowGraph.safeParse(tpl.spec);
    if (!graph.success) return reply.code(400).send({ error: "template spec is not a valid workflow graph" });
    const created = await createWorkflow(db, {
      workspaceId,
      name: body.name?.trim() || tpl.name,
      graph: graph.data,
    });
    await scheduleCrons(created.workflow.id, graph.data);
    return reply.code(201).send({ kind: "workflow", id: created.workflow.id, workflow: created.workflow });
  }

  const spec = (tpl.spec ?? {}) as {
    name?: string; persona?: string; model?: string; autonomy?: string;
    toolGrants?: unknown; schedule?: string | null;
  };
  const agent = await createAgent(db, {
    workspaceId,
    name: body.name?.trim() || spec.name || tpl.name,
    persona: spec.persona ?? "You are a helpful assistant.",
    model: spec.model ?? "mock",
    autonomy: spec.autonomy,
    toolGrants: Array.isArray(spec.toolGrants) ? (spec.toolGrants as string[]) : undefined,
    schedule: spec.schedule ?? null,
  });
  if (agent.schedule) await scheduleAgentCron(agent.id, agent.schedule);
  return reply.code(201).send({ kind: "agent", id: agent.id, agent });
});

/** Publish an existing workflow or agent as a workspace template. */
app.post("/api/templates", async (req, reply) => {
  const body = (req.body ?? {}) as {
    kind?: string; sourceId?: string; name?: string; description?: string; category?: string;
  };
  if (!body.sourceId) return reply.code(400).send({ error: "sourceId is required" });

  if (body.kind === "workflow") {
    const wf = await getWorkflowWithGraph(db, body.sourceId);
    if (!wf?.version) return reply.code(404).send({ error: "workflow not found" });
    const created = await createTemplate(db, {
      workspaceId,
      kind: "workflow",
      name: body.name?.trim() || wf.workflow.name,
      description: body.description ?? "",
      category: body.category?.trim() || "published",
      spec: wf.version.graph,
    });
    return reply.code(201).send(created);
  }
  if (body.kind === "agent") {
    const agent = await getAgent(db, body.sourceId);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const created = await createTemplate(db, {
      workspaceId,
      kind: "agent",
      name: body.name?.trim() || agent.name,
      description: body.description ?? "",
      category: body.category?.trim() || "published",
      spec: {
        name: agent.name,
        persona: agent.persona,
        model: agent.model,
        autonomy: agent.autonomy,
        toolGrants: agent.toolGrants,
        schedule: agent.schedule,
      },
    });
    return reply.code(201).send(created);
  }
  return reply.code(400).send({ error: "kind must be 'workflow' or 'agent'" });
});

app.delete("/api/templates/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const tpl = await getTemplate(db, id);
  if (!tpl) return reply.code(404).send({ error: "template not found" });
  if (tpl.builtin) return reply.code(400).send({ error: "cannot delete a built-in template" });
  await deleteTemplate(db, id);
  return reply.code(204).send();
});

// --- Audit log (ARCHITECTURE.md §3.6) -----------------------------------------
// Append-only; admin+ only (RBAC rule in auth.ts). No write/delete surface.
app.get("/api/audit", async (req) => {
  const { action, limit } = req.query as { action?: string; limit?: string };
  return listAudit(db, workspaceId, { action, limit: limit ? Number(limit) : undefined });
});

// --- Adaptive suggestions (M5, PRD §5) ----------------------------------------
// "Frequently used" agents/workflows, derived from mission counts.
app.get("/api/suggestions", async () => {
  const usage = await missionUsage(db, workspaceId, 20);
  const [wfs, ags] = await Promise.all([listWorkflows(db, workspaceId), listAgents(db, workspaceId)]);
  const wfName = new Map(wfs.map((w) => [w.id, w.name]));
  const agName = new Map(ags.map((a) => [a.id, a.name]));
  return usage
    .map((u) => ({
      subjectId: u.subjectId,
      kind: u.kind,
      runs: Number(u.runs),
      lastRun: u.lastRun,
      name: (u.kind === "agent" ? agName.get(u.subjectId) : wfName.get(u.subjectId)) ?? null,
    }))
    .filter((s) => s.name)
    .slice(0, 6);
});

// --- Workflows ---------------------------------------------------------------
app.get("/api/workflows", async () => listWorkflows(db, workspaceId));

app.post("/api/workflows", async (req, reply) => {
  const body = req.body as { name?: string; graph?: unknown };
  const graph = WorkflowGraph.safeParse(body.graph ?? { nodes: [], edges: [] });
  if (!graph.success) return reply.code(400).send({ error: "invalid graph", detail: graph.error.issues });
  const name = body.name?.trim() || "Untitled workflow";
  const created = await createWorkflow(db, { workspaceId, name, graph: graph.data });
  await scheduleCrons(created.workflow.id, graph.data);
  return reply.code(201).send(created);
});

app.get("/api/workflows/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const wf = await getWorkflowWithGraph(db, id);
  if (!wf) return reply.code(404).send({ error: "workflow not found" });
  return wf;
});

app.put("/api/workflows/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { graph?: unknown };
  const graph = WorkflowGraph.safeParse(body.graph);
  if (!graph.success) return reply.code(400).send({ error: "invalid graph", detail: graph.error.issues });
  try {
    const version = await saveWorkflowVersion(db, id, graph.data);
    await scheduleCrons(id, graph.data);
    return version;
  } catch {
    return reply.code(404).send({ error: "workflow not found" });
  }
});

app.post("/api/workflows/:id/run", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { input?: unknown };
  try {
    const mission = await startWorkflow(db, {
      workflowId: id,
      trigger: { mode: "manual" },
      payload: body.input ?? {},
    });
    await runner.enqueue(mission.id);
    return reply.code(202).send({ missionId: mission.id });
  } catch (err) {
    return reply.code(404).send({ error: err instanceof Error ? err.message : "run failed" });
  }
});

// --- Webhook trigger ---------------------------------------------------------
app.post("/api/hooks/:workflowId", async (req, reply) => {
  const { workflowId } = req.params as { workflowId: string };
  try {
    const mission = await startWorkflow(db, {
      workflowId,
      trigger: { mode: "webhook" },
      payload: req.body ?? {},
    });
    await runner.enqueue(mission.id);
    return reply.code(202).send({ missionId: mission.id });
  } catch (err) {
    return reply.code(404).send({ error: err instanceof Error ? err.message : "hook failed" });
  }
});

// --- Agents (M2) ---------------------------------------------------------------
app.get("/api/agents", async () => listAgents(db, workspaceId));

app.post("/api/agents", async (req, reply) => {
  const body = (req.body ?? {}) as {
    name?: string;
    persona?: string;
    model?: string;
    autonomy?: string;
    schedule?: string | null;
    toolGrants?: string[];
  };
  if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
  const agent = await createAgent(db, {
    workspaceId,
    name: body.name.trim(),
    persona: body.persona ?? "You are a helpful assistant.",
    model: body.model ?? "mock",
    autonomy: body.autonomy,
    schedule: body.schedule ?? null,
    toolGrants: Array.isArray(body.toolGrants) ? body.toolGrants : undefined,
  });
  if (agent.schedule) await scheduleAgentCron(agent.id, agent.schedule);
  return reply.code(201).send(agent);
});

app.get("/api/agents/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const agent = await getAgent(db, id);
  if (!agent) return reply.code(404).send({ error: "agent not found" });
  return agent;
});

app.put("/api/agents/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const agent = await getAgent(db, id);
  if (!agent) return reply.code(404).send({ error: "agent not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of ["name", "persona", "model", "autonomy", "schedule", "toolGrants"]) {
    if (key in body) patch[key] = body[key];
  }
  await updateAgent(db, id, patch);
  if ("schedule" in patch) await scheduleAgentCron(id, (patch.schedule as string | null) ?? null);
  return getAgent(db, id);
});

app.delete("/api/agents/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  await scheduleAgentCron(id, null);
  await deleteAgent(db, id);
  return reply.code(204).send();
});

/** Direct chat: queue an agent tick carrying the user message. */
app.post("/api/agents/:id/chat", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { message?: string };
  if (!body.message?.trim()) return reply.code(400).send({ error: "message is required" });
  try {
    const mission = await startAgentTick(db, {
      agentId: id,
      trigger: { mode: "chat" },
      payload: { message: body.message },
    });
    await runner.enqueue(mission.id);
    return reply.code(202).send({ missionId: mission.id });
  } catch (err) {
    return reply.code(404).send({ error: err instanceof Error ? err.message : "chat failed" });
  }
});

app.get("/api/agents/:id/messages", async (req) => {
  const { id } = req.params as { id: string };
  return getAgentMessages(db, id, 100);
});

app.get("/api/agents/:id/memories", async (req) => {
  const { id } = req.params as { id: string };
  return listMemories(db, id);
});

/** Ranked recall for the inspector: pgvector semantic search when an embedder is
 *  configured (scores included), else keyword match. */
app.get("/api/agents/:id/memory-search", async (req) => {
  const { id } = req.params as { id: string };
  const query = String((req.query as { q?: string }).q ?? "").trim();
  if (!query) return listMemories(db, id, 10);
  if (embedder) {
    try {
      const [qv] = await embedder.embed([query]);
      const hits = await searchMemoriesByVector(db, id, toVectorLiteral(qv!), 10);
      if (hits.length > 0) return hits;
    } catch {
      /* fall back to keyword */
    }
  }
  const rows = await searchMemories(db, id, query, 10);
  return rows.map((r) => ({ id: r.id, content: r.content, score: null }));
});

// --- Missions & traces -------------------------------------------------------
app.get("/api/missions", async () => listMissions(db, workspaceId));

app.get("/api/missions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission) return reply.code(404).send({ error: "mission not found" });
  const steps = await getMissionSteps(db, id);
  return { mission, steps };
});

// --- Approvals ---------------------------------------------------------------
app.get("/api/approvals", async (req) => {
  const { status } = req.query as { status?: string };
  return listApprovals(db, status);
});

app.post("/api/approvals/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { approved?: boolean };
  const approval = await getApproval(db, id);
  if (!approval) return reply.code(404).send({ error: "approval not found" });
  const approved = body.approved !== false;
  await resolveApproval(db, id, approved);
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    missionId: approval.missionId,
    action: "approval.decision",
    target: approval.nodeId,
    detail: { approved, tier: approval.tier },
  });
  await bus.publish({
    type: "approval.resolved",
    missionId: approval.missionId,
    approvalId: id,
    approved,
    at: new Date().toISOString(),
  });
  // Resume the mission from its approval gate.
  await runner.enqueue(approval.missionId);
  return { ok: true, approved };
});

// --- Live event stream -------------------------------------------------------
app.get("/api/events", { websocket: true }, (socket) => {
  const unsubscribe = bus.subscribe((event) => {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      /* socket closing */
    }
  });
  socket.on("close", unsubscribe);
});

// --- Lifecycle ---------------------------------------------------------------
async function shutdown() {
  app.log.info("shutting down");
  auditUnsub();
  await runner.close();
  for (const conn of mcpConnections) await conn.close().catch(() => {});
  await bus.close?.();
  await handle.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
