import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WorkflowGraph } from "@puppetmaster/shared";
import {
  createDb,
  createWorkflow,
  ensureDefaultWorkspace,
  getApproval,
  getMission,
  getMissionSteps,
  getWorkflowWithGraph,
  listApprovals,
  listMissions,
  listWorkflows,
  migrate,
  resolveApproval,
  saveWorkflowVersion,
  type DbHandle,
} from "@puppetmaster/db";
import {
  BuiltinToolRegistry,
  InlineRunner,
  InMemoryEventBus,
  QueueRunner,
  RedisEventBus,
  startWorkflow,
  WorkflowExecutor,
  type EventBus,
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
const executor = new WorkflowExecutor({ db, bus, tools });
const runner: WorkflowRunner = REDIS_URL
  ? new QueueRunner(REDIS_URL, { executor, db })
  : new InlineRunner(executor);

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
  if (cronNode) await runner.scheduleCron(workflowId, String(cronNode.config.cron));
  else await runner.unscheduleCron(workflowId).catch(() => {});
}

// Re-arm cron triggers for existing workflows on boot.
for (const wf of await listWorkflows(db, workspaceId)) {
  const full = await getWorkflowWithGraph(db, wf.id);
  if (full?.version) await scheduleCrons(wf.id, full.version.graph);
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
