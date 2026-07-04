import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WorkflowGraph } from "@puppetmaster/shared";
import {
  createAgent,
  createDb,
  createWorkflow,
  deleteAgent,
  ensureDefaultWorkspace,
  getAgent,
  getAgentMessages,
  getApproval,
  getMission,
  getMissionSteps,
  getWorkflowWithGraph,
  listAgents,
  listApprovals,
  listMemories,
  listMissions,
  listWorkflows,
  migrate,
  resolveApproval,
  saveWorkflowVersion,
  updateAgent,
  type DbHandle,
} from "@puppetmaster/db";
import {
  AgentRuntime,
  BuiltinToolRegistry,
  InlineRunner,
  InMemoryEventBus,
  ModelRouter,
  QueueRunner,
  RedisEventBus,
  startAgentTick,
  startWorkflow,
  WorkflowExecutor,
  type EventBus,
  type MissionDispatcher,
  type WorkflowRunner,
} from "@puppetmaster/kernel";

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
const executor = new WorkflowExecutor({ db, bus, tools });
const agentRuntime = new AgentRuntime({ db, bus, router, tools });

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

// --- Meta --------------------------------------------------------------------
app.get("/api/health", async () => ({ ok: true, service: "puppetmaster-server", version: "0.0.1" }));

app.get("/api/bootstrap", async () => ({
  workspaceId,
  dbDriver: handle.driver,
  queue: REDIS_URL ? "bullmq" : "inline",
  tools: tools.list(),
}));

app.get("/api/tools", async () => tools.list());

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
  };
  if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
  const agent = await createAgent(db, {
    workspaceId,
    name: body.name.trim(),
    persona: body.persona ?? "You are a helpful assistant.",
    model: body.model ?? "mock",
    autonomy: body.autonomy,
    schedule: body.schedule ?? null,
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
  for (const key of ["name", "persona", "model", "autonomy", "schedule"]) {
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
  await runner.close();
  await bus.close?.();
  await handle.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
