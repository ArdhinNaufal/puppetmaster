import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WorkflowGraph } from "@puppetmaster/shared";
import {
  appendAudit,
  budgetsForAgent,
  checkAndPinToolHash,
  createApproval,
  createBudget,
  createMcpServer,
  createRouterProfile,
  deleteMcpServer,
  deleteRouterProfile,
  getMcpServer,
  getRouterProfile,
  getRouterProfileByName,
  listMcpServers,
  listRouterProfiles,
  updateRouterProfile,
  deleteBudget,
  createAgent,
  createDb,
  createTemplate,
  createWorkflow,
  deleteAgent,
  deleteDocument,
  deleteMemory,
  deleteTemplate,
  ensureDefaultWorkspace,
  getAgent,
  getAgentMessages,
  getApproval,
  getDocument,
  getDocumentChunks,
  getMemory,
  getMission,
  getMissionSteps,
  getTemplate,
  getWorkflow,
  getWorkflowVersionById,
  getWorkflowWithGraph,
  getWorkspace,
  listAgents,
  listApprovals,
  listAudit,
  insertEvalRun,
  listBudgets,
  listDeadLetterMissions,
  listDocuments,
  listEvalRuns,
  listMemories,
  listMissions,
  listPoliciesForAgent,
  listTemplates,
  listWorkflows,
  migrate,
  missionUsage,
  monthTokens,
  monthUsageBreakdown,
  recordUsage,
  requestMissionCancel,
  resetMissionForRetry,
  resolveApproval,
  saveWorkflowVersion,
  searchMemories,
  searchMemoriesByVector,
  seedBuiltinTemplates,
  setWebhookSecret,
  updateAgent,
  updateMemory,
  updateMission,
  updateWorkspace,
  type DbHandle,
} from "@puppetmaster/db";
import {
  AgentRuntime,
  BuiltinToolRegistry,
  connectMcpServer,
  createAgentInvoker,
  createEmbedder,
  draftWorkflowGraph,
  explainFailure,
  InlineRunner,
  InMemoryEventBus,
  ModelRouter,
  toVectorLiteral,
  parseMcpServersEnv,
  kbIngest,
  kbSearch,
  lintWorkflowGraph,
  QueueRunner,
  RedisEventBus,
  registerBridgeTools,
  registerKbTools,
  replayMission,
  startOtelExporter,
  resolveCredentialEnv,
  startAgentTick,
  startWorkflow,
  WorkflowExecutor,
  COST_CLASSES,
  type CostClass,
  type EventBus,
  type McpConnection,
  type McpServerConfig,
  type MissionDispatcher,
  type WorkflowRunner,
} from "@puppetmaster/kernel";
import { utilsServerPath } from "@puppetmaster/mcp-connectors";
import { registerAuth } from "./auth.js";
import { makeCredentialLookup, registerSecurityRoutes } from "./security.js";
import { runSuite } from "./eval/harness.js";
import { BUILTIN_TEMPLATES } from "./seeds.js";
import { createAuditSink, startAuditProjector } from "./audit.js";
import {
  graphHasWebhookTrigger,
  newWebhookSecret,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhooks.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";
const REDIS_URL = process.env.REDIS_URL ?? null;

const app = Fastify({ logger: true });

// Keep the raw JSON body around so webhook HMAC signatures verify against the
// exact bytes the caller signed (re-serialising would change whitespace).
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (err) {
    done(err as Error, undefined);
  }
});

// --- Kernel wiring -----------------------------------------------------------
const handle: DbHandle = await createDb();
await migrate(handle);
const { db } = handle;
const workspaceId = await ensureDefaultWorkspace(db);

const tools = new BuiltinToolRegistry();
const bus: EventBus = REDIS_URL ? new RedisEventBus(REDIS_URL) : new InMemoryEventBus();
const healthEnv = (name: string): number | undefined => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const router = new ModelRouter({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  openaiApiKey: process.env.OPENAI_API_KEY,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  // Candidate health/cooldowns (Stage 9B); all optional env overrides.
  health: {
    failureThreshold: healthEnv("ROUTER_FAILURE_THRESHOLD"),
    baseCooldownMs: healthEnv("ROUTER_COOLDOWN_MS"),
    quotaCooldownMs: healthEnv("ROUTER_QUOTA_COOLDOWN_MS"),
    maxCooldownMs: healthEnv("ROUTER_COOLDOWN_MAX_MS"),
  },
});
// Cooldown transitions land in the audit trail so route-arounds are visible
// (`router.cooldown`, system actor) — one entry per transition, not per failure.
router.setCooldownSink((e) => {
  appendAudit(db, {
    workspaceId,
    actorKind: "system",
    actorLabel: "model-router",
    action: "router.cooldown",
    target: e.model,
    detail: {
      reason: e.reason,
      consecutiveFailures: e.consecutiveFailures,
      cooldownUntil: e.cooldownUntil,
      error: e.error,
    },
  }).catch(() => {});
});
// Router profiles (Stage 9A): `model: "profile:NAME"` resolves to a named
// workspace chain at call time — editing the profile re-routes every consumer.
router.setProfileResolver(async (name) => {
  const row = await getRouterProfileByName(db, workspaceId, name);
  if (!row) return null;
  return {
    name: row.name,
    candidates: (Array.isArray(row.candidates) ? row.candidates : []) as {
      model: string;
      costClass: CostClass;
    }[],
    minClassForGatedTools: (row.minClassForGatedTools as CostClass | null) ?? null,
  };
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
// Stage 5: llm.call entries also feed the usage ledger (cost/budgets).
const baseAuditSink = createAuditSink(db);
const auditSink: typeof baseAuditSink = async (entry) => {
  await baseAuditSink(entry);
  if (entry.action === "llm.call" && entry.detail && typeof entry.detail === "object") {
    const detail = entry.detail as {
      usage?: { inputTokens?: number; outputTokens?: number };
      servedBy?: string;
    };
    const usage = detail.usage;
    if (usage) {
      recordUsage(db, {
        workspaceId: entry.workspaceId,
        agentId: entry.actorKind === "agent" ? entry.actorId : null,
        missionId: entry.missionId ?? null,
        // Cost accrues to the model that actually answered (Stage 9A: a
        // profile/fallback chain may be served by any of its candidates).
        model: detail.servedBy ?? entry.target ?? "",
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      }).catch(() => {});
    }
  }
};
const executor = new WorkflowExecutor({ db, bus, tools, audit: auditSink });
const agentRuntime = new AgentRuntime({
  db,
  bus,
  router,
  tools,
  embedder,
  audit: auditSink,
  // Approval auto-allow policies (Stage 1): matching gated calls skip the
  // human gate and are audited as approval.auto.
  policyLookup: (agentId) => listPoliciesForAgent(db, workspaceId, agentId),
  // Budget gate (Stage 5): an exhausted monthly token budget pauses new
  // ticks behind an approval instead of silently burning tokens.
  budgetGate: async (wsId, agentId) => {
    for (const b of await budgetsForAgent(db, wsId, agentId)) {
      const used = await monthTokens(db, wsId, b.agentId ? agentId : undefined);
      if (used >= b.monthlyTokenLimit) {
        return `${used}/${b.monthlyTokenLimit} tokens used${b.agentId ? "" : " across the workspace"}`;
      }
    }
    return null;
  },
});

// Credentials vault (Stage 1): AES-256-GCM under PUPPETMASTER_MASTER_KEY.
// Unset key = vault routes disabled (503 on write) and no credential refs.
const masterKey = process.env.PUPPETMASTER_MASTER_KEY?.trim() || null;
const credentialLookup = makeCredentialLookup(db, workspaceId, masterKey);
const auditUnsub = startAuditProjector(bus, db);

// OTel GenAI export (Stage 5): finished missions become gen_ai.* traces
// POSTed as OTLP/HTTP JSON — pluggable into any observability stack.
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
const otelUnsub = otelEndpoint
  ? startOtelExporter(bus, db, otelEndpoint, { log: (msg, err) => app.log.warn({ err }, msg) })
  : null;

// Seed the first-party template catalog (PRD §6 marketplace), idempotently.
const seededTemplates = await seedBuiltinTemplates(db, BUILTIN_TEMPLATES);
if (seededTemplates > 0) app.log.info({ seededTemplates }, "seeded builtin templates");

// --- The bridge (ARCHITECTURE.md §3.3) ----------------------------------------
// Workflow → agent: agent nodes dispatch a task and await the child mission.
const agentInvoker = createAgentInvoker({ db, runtime: agentRuntime });
executor.setAgentInvoker(agentInvoker);
// Agent → workflow: workflows join the shared tool catalog (workflow.list/run/
// create_draft). Stage 8: agentInvoker also enables agent.ask delegation.
registerBridgeTools(tools, { db, workspaceId, executor, agentInvoker });

// Knowledge base (Stage 3): kb.search / kb.read join the shared catalog so
// agents and workflow nodes retrieve cited chunks from workspace documents.
const kbDeps = { db, workspaceId, embedder };
registerKbTools(tools, kbDeps);

// --- Tool layer: MCP servers (ARCHITECTURE.md §3.4) ---------------------------
// Bundled utils connector by default; extend/override via MCP_SERVERS JSON.
const mcpConfigs = parseMcpServersEnv(process.env.MCP_SERVERS);
if (mcpConfigs.length === 0 && process.env.MCP_DISABLE_BUNDLED !== "1") {
  mcpConfigs.push({ name: "mcputil", command: process.execPath, args: [utilsServerPath] });
}
// Tool-description hash pinning (Stage 1): drift since the last connect is a
// tool-poisoning canary — surfaced in the log and the audit trail.
const checkPin = async (server: string, tool: string, hash: string) => {
  const { result, previousHash } = await checkAndPinToolHash(db, server, tool, hash);
  if (result === "drifted") {
    app.log.warn({ server, tool }, "mcp tool description drifted since it was pinned");
    await appendAudit(db, {
      workspaceId,
      actorKind: "system",
      actorLabel: "mcp",
      action: "mcp.description.drift",
      target: `${server}.${tool}`,
      detail: { previousHash, hash },
    });
  }
  return result;
};

// Elicitation → approvals (Stage 7): a server-initiated question pauses in
// the approval inbox of the mission whose tool call triggered it; the tool
// call blocks until the operator decides (bounded by the caller's timeout).
const elicitation = async (missionId: string, message: string): Promise<boolean> => {
  const approval = await createApproval(db, {
    missionId,
    nodeId: "elicitation",
    prompt: message,
    tier: "write_approved",
  });
  await bus.publish({
    type: "approval.requested",
    missionId,
    nodeId: "elicitation",
    approvalId: approval.id,
    prompt: message,
    at: new Date().toISOString(),
  });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const current = await getApproval(db, approval.id);
    if (current?.status === "approved") return true;
    if (current?.status === "rejected") return false;
  }
  return false;
};

/** Live MCP connections by catalog name (env-configured + workspace-added). */
const mcpConnections = new Map<string, McpConnection>();

async function connectConfiguredMcp(cfg: McpServerConfig): Promise<McpConnection> {
  // Resolve {{credential:NAME}} refs from the vault; a missing credential
  // fails this server's connect loudly rather than passing a placeholder.
  const env = cfg.env ? await resolveCredentialEnv(cfg.env, credentialLookup) : cfg.env;
  const headers = cfg.headers
    ? await resolveCredentialEnv(cfg.headers, credentialLookup)
    : cfg.headers;
  const conn = await connectMcpServer(tools, { ...cfg, env, headers }, { checkPin, elicitation });
  mcpConnections.set(cfg.name, conn);
  app.log.info(
    { server: cfg.name, transport: conn.transport, tools: conn.toolCount, drifted: conn.driftedTools },
    "mcp server connected",
  );
  return conn;
}

for (const cfg of mcpConfigs) {
  try {
    await connectConfiguredMcp(cfg);
  } catch (err) {
    app.log.error({ server: cfg.name, err }, "mcp server failed to connect");
  }
}

// Workspace-persisted MCP servers (Stage 7): added from the Tools view /
// registry, stored in the DB rather than env, reconnected on boot.
const workspaceMcpConfig = (row: {
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: unknown;
  env: unknown;
  headers: unknown;
  tier: string;
}): McpServerConfig => ({
  name: row.name,
  transport: row.transport === "stdio" ? "stdio" : "http",
  url: row.url ?? undefined,
  command: row.command ?? undefined,
  args: Array.isArray(row.args) ? (row.args as string[]) : [],
  env: (row.env ?? {}) as Record<string, string>,
  headers: (row.headers ?? {}) as Record<string, string>,
  tier: (row.tier as McpServerConfig["tier"]) ?? "read_auto",
});

for (const row of await listMcpServers(db, workspaceId)) {
  if (!row.enabled) continue;
  try {
    await connectConfiguredMcp(workspaceMcpConfig(row));
  } catch (err) {
    app.log.error({ server: row.name, err }, "workspace mcp server failed to connect");
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

// --- Security surface: credentials vault + approval policies (Stage 1) --------
registerSecurityRoutes(app, { db, workspaceId, masterKey });

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
  // Signed webhooks by default: a webhook-trigger workflow gets an HMAC secret.
  const webhookSecret = graphHasWebhookTrigger(graph.data) ? newWebhookSecret() : null;
  const created = await createWorkflow(db, { workspaceId, name, graph: graph.data, webhookSecret });
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
    // Mint a signing secret the first time a workflow gains a webhook trigger.
    if (graphHasWebhookTrigger(graph.data)) {
      const wf = await getWorkflow(db, id);
      if (wf && !wf.webhookSecret) await setWebhookSecret(db, id, newWebhookSecret());
    }
    return version;
  } catch {
    return reply.code(404).send({ error: "workflow not found" });
  }
});

/** Reveal the webhook URL + signing secret (builder+). */
app.get("/api/workflows/:id/webhook", async (req, reply) => {
  const { id } = req.params as { id: string };
  const wf = await getWorkflow(db, id);
  if (!wf) return reply.code(404).send({ error: "workflow not found" });
  return {
    url: `/api/hooks/${id}`,
    hasSecret: Boolean(wf.webhookSecret),
    secret: wf.webhookSecret,
    header: "X-Puppetmaster-Signature",
    scheme: "sha256=HMAC_SHA256(secret, rawBody)",
  };
});

/** Rotate (or set) the webhook signing secret (builder+). */
app.post("/api/workflows/:id/webhook/rotate", async (req, reply) => {
  const { id } = req.params as { id: string };
  const wf = await getWorkflow(db, id);
  if (!wf) return reply.code(404).send({ error: "workflow not found" });
  const secret = newWebhookSecret();
  await setWebhookSecret(db, id, secret);
  return { secret };
});

/** NL→draft (Stage 6): model-drafted WorkflowGraph, returned as an editable
 *  draft — never saved. Lint issues ride along so the editor can surface them. */
app.post("/api/workflows/draft", async (req, reply) => {
  const body = (req.body ?? {}) as { description?: string; model?: string };
  if (!body.description?.trim()) return reply.code(400).send({ error: "description is required" });
  const model = body.model?.trim() || process.env.COPILOT_MODEL || "mock";
  const { graph, source } = await draftWorkflowGraph(router, model, body.description.trim());
  return { graph, source, model, issues: lintWorkflowGraph(graph, (s, t) => tools.info(s, t)) };
});

/** Graph linter (Stage 6): static checks against the live tool catalog. */
app.post("/api/workflows/lint", async (req) => {
  const body = (req.body ?? {}) as { graph?: unknown };
  return lintWorkflowGraph(body.graph ?? { nodes: [], edges: [] }, (s, t) => tools.info(s, t));
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
  // Enforce the HMAC signature when the workflow has a signing secret.
  const wf = await getWorkflow(db, workflowId);
  if (wf?.webhookSecret) {
    const sig = req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined;
    const raw = (req as { rawBody?: string }).rawBody ?? "";
    if (!verifyWebhookSignature(wf.webhookSecret, raw, sig)) {
      return reply.code(401).send({ error: "invalid or missing webhook signature" });
    }
  }
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
    contextCompaction?: boolean;
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
    contextCompaction: body.contextCompaction === true,
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
  for (const key of ["name", "persona", "model", "autonomy", "schedule", "toolGrants", "contextCompaction"]) {
    if (key in body) patch[key] = body[key];
  }
  if ("contextCompaction" in patch) patch.contextCompaction = patch.contextCompaction === true;
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

/** Memory governance (Stage 4, SSGM): edit content or pin/unpin. */
app.put("/api/agents/:id/memories/:memId", async (req, reply) => {
  const { id, memId } = req.params as { id: string; memId: string };
  const memory = await getMemory(db, memId);
  if (!memory || memory.agentId !== id) return reply.code(404).send({ error: "memory not found" });
  const body = (req.body ?? {}) as { content?: string; pinned?: boolean; importance?: number };
  const patch: Record<string, unknown> = {};
  if (typeof body.content === "string" && body.content.trim()) patch.content = body.content.trim();
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.importance === "number" && body.importance >= 0 && body.importance <= 1) {
    patch.importance = body.importance;
  }
  if (Object.keys(patch).length > 0) await updateMemory(db, memId, patch);
  return getMemory(db, memId);
});

app.delete("/api/agents/:id/memories/:memId", async (req, reply) => {
  const { id, memId } = req.params as { id: string; memId: string };
  const memory = await getMemory(db, memId);
  if (!memory || memory.agentId !== id) return reply.code(404).send({ error: "memory not found" });
  await deleteMemory(db, memId);
  return reply.code(204).send();
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

// --- MCP servers & registry (Stage 7, G10) ---------------------------------------
app.get("/api/mcp/servers", async () => {
  const rows = await listMcpServers(db, workspaceId);
  return rows.map((r) => {
    const conn = mcpConnections.get(r.name);
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      url: r.url,
      command: r.command,
      tier: r.tier,
      enabled: r.enabled,
      connected: Boolean(conn),
      toolCount: conn?.toolCount ?? 0,
      createdAt: r.createdAt,
    };
  });
});

/** Add + connect a workspace MCP server (streamable HTTP or stdio). Header/env
 *  values may reference the vault as {{credential:NAME}} — stored unresolved. */
app.post("/api/mcp/servers", async (req, reply) => {
  const body = (req.body ?? {}) as {
    name?: string;
    transport?: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    tier?: string;
  };
  if (!body.name?.trim() || !/^[\w-]{1,64}$/.test(body.name.trim())) {
    return reply.code(400).send({ error: "name is required (1-64 chars of [A-Za-z0-9_-])" });
  }
  const transport = body.transport === "stdio" ? "stdio" : "http";
  if (transport === "http" && !body.url?.trim()) {
    return reply.code(400).send({ error: "url is required for http transport" });
  }
  if (transport === "stdio" && !body.command?.trim()) {
    return reply.code(400).send({ error: "command is required for stdio transport" });
  }
  const name = body.name.trim();
  if (mcpConnections.has(name)) return reply.code(409).send({ error: `server "${name}" already connected` });

  const row = await createMcpServer(db, {
    workspaceId,
    name,
    transport,
    url: body.url?.trim() ?? null,
    command: body.command?.trim() ?? null,
    args: Array.isArray(body.args) ? body.args : [],
    env: body.env ?? {},
    headers: body.headers ?? {},
    tier: body.tier,
  });
  try {
    const conn = await connectConfiguredMcp(workspaceMcpConfig(row));
    await appendAudit(db, {
      workspaceId,
      actorKind: "user",
      actorId: req.authUser?.id ?? null,
      actorLabel: req.authUser?.email ?? "unknown",
      action: "mcp.server.add",
      target: name,
      detail: { transport, url: row.url, tools: conn.toolCount },
    });
    return reply.code(201).send({ id: row.id, name, connected: true, toolCount: conn.toolCount });
  } catch (err) {
    // Keep the config (it may need a credential added first) but report the failure.
    return reply.code(201).send({
      id: row.id,
      name,
      connected: false,
      error: err instanceof Error ? err.message : "connect failed",
    });
  }
});

app.delete("/api/mcp/servers/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = await getMcpServer(db, id);
  if (!row || row.workspaceId !== workspaceId) return reply.code(404).send({ error: "server not found" });
  const conn = mcpConnections.get(row.name);
  if (conn) {
    await conn.close().catch(() => {});
    mcpConnections.delete(row.name);
  }
  tools.unregister(row.name);
  await deleteMcpServer(db, id);
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "mcp.server.remove",
    target: row.name,
  });
  return reply.code(204).send();
});

/** Browse the public MCP registry (Stage 7): proxied search, one-click add. */
app.get("/api/mcp/registry", async (req, reply) => {
  const { q } = req.query as { q?: string };
  const base = process.env.MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";
  try {
    const url = `${base.replace(/\/$/, "")}/v0/servers?limit=20${q?.trim() ? `&search=${encodeURIComponent(q.trim())}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return reply.code(502).send({ error: `registry responded ${res.status}` });
    const data = (await res.json()) as { servers?: unknown[] };
    const servers = (data.servers ?? []).map((s) => {
      const entry = s as {
        name?: string;
        description?: string;
        version?: string;
        remotes?: { type?: string; url?: string }[];
        server?: { name?: string; description?: string; version?: string; remotes?: { type?: string; url?: string }[] };
      };
      const info = entry.server ?? entry;
      const remote = (info.remotes ?? []).find((r) => r.url);
      return {
        name: info.name ?? "unknown",
        description: info.description ?? "",
        version: info.version ?? "",
        remoteUrl: remote?.url ?? null,
        remoteType: remote?.type ?? null,
      };
    });
    return { servers };
  } catch (err) {
    return reply.code(502).send({
      error: `registry unreachable: ${err instanceof Error ? err.message : "unknown"}`,
    });
  }
});

// --- Evals & observability (Stage 5) --------------------------------------------
app.get("/api/evals", async () => listEvalRuns(db, workspaceId));

/** Run the golden suite (ephemeral PGlite per run, mock provider) and store
 *  the pass^k results for the EVALS panel. */
app.post("/api/evals/run", async (req) => {
  const body = (req.body ?? {}) as { k?: number };
  const k = Math.min(Math.max(Number(body.k ?? 3), 1), 10);
  const suite = await runSuite(k);
  const row = await insertEvalRun(db, { workspaceId, ...suite });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "eval.run",
    detail: { k, passed: suite.passed, total: suite.total },
  });
  return row;
});

/** Month-to-date cost ledger, grouped by agent + model. */
app.get("/api/usage", async () => {
  const [rows, total] = await Promise.all([
    monthUsageBreakdown(db, workspaceId),
    monthTokens(db, workspaceId),
  ]);
  const routerFailures = router.failureStats();
  const names = new Map((await listAgents(db, workspaceId)).map((a) => [a.id, a.name]));
  return {
    monthTokens: total,
    routerFailures,
    // Stage 9B: candidate health (cooling/healthy, cooldown expiry, last error).
    routerHealth: router.healthStats(),
    // Stage 9C: context-compaction savings since boot (~4 chars/token estimate).
    compaction: (() => {
      const c = agentRuntime.compactionStats();
      return { ...c, tokensAvoided: Math.max(0, Math.round((c.rawBytes - c.sentBytes) / 4)) };
    })(),
    breakdown: rows.map((r) => ({
      ...r,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      calls: Number(r.calls),
      agentName: r.agentId ? (names.get(r.agentId) ?? null) : null,
    })),
  };
});

// --- Router profiles (Stage 9A, docs/9ROUTER-ADOPTION.md) -----------------------
// Listing is member-open (builders reference profiles as `profile:NAME` in the
// agent model field); mutations are admin (RBAC rule in auth.ts).
app.get("/api/router/profiles", async () => ({
  costClasses: COST_CLASSES,
  profiles: await listRouterProfiles(db, workspaceId),
}));

app.post("/api/router/profiles", async (req, reply) => {
  const body = (req.body ?? {}) as {
    name?: string;
    description?: string;
    candidates?: { model?: string; costClass?: string }[];
    minClassForGatedTools?: string | null;
  };
  if (!body.name?.trim() || !/^[\w-]{1,64}$/.test(body.name.trim())) {
    return reply.code(400).send({ error: "name is required (1-64 chars of [A-Za-z0-9_-])" });
  }
  const candidates: { model: string; costClass: string }[] = [];
  for (const c of Array.isArray(body.candidates) ? body.candidates : []) {
    if (!c?.model?.trim()) return reply.code(400).send({ error: "every candidate needs a model" });
    if (c.model.includes("|") || c.model.trim().startsWith("profile:")) {
      return reply.code(400).send({ error: "candidates are single models (no chains or nested profiles)" });
    }
    const costClass = c.costClass ?? "premium";
    if (!COST_CLASSES.includes(costClass as CostClass)) {
      return reply.code(400).send({ error: `costClass must be one of ${COST_CLASSES.join(", ")}` });
    }
    candidates.push({ model: c.model.trim(), costClass });
  }
  if (candidates.length === 0) return reply.code(400).send({ error: "at least one candidate is required" });
  const minClass = body.minClassForGatedTools ?? null;
  if (minClass !== null && !COST_CLASSES.includes(minClass as CostClass)) {
    return reply.code(400).send({ error: `minClassForGatedTools must be null or one of ${COST_CLASSES.join(", ")}` });
  }
  const existing = await getRouterProfileByName(db, workspaceId, body.name.trim());
  if (existing) return reply.code(409).send({ error: `profile "${body.name.trim()}" already exists` });
  const row = await createRouterProfile(db, {
    workspaceId,
    name: body.name.trim(),
    description: body.description ?? "",
    candidates,
    minClassForGatedTools: minClass,
  });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "router.profile.create",
    target: row.name,
    detail: { profileId: row.id, candidates, minClassForGatedTools: minClass },
  });
  return reply.code(201).send(row);
});

app.put("/api/router/profiles/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = await getRouterProfile(db, id);
  if (!existing || existing.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "profile not found" });
  }
  const body = (req.body ?? {}) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return reply.code(400).send({ error: "enabled (boolean) is required" });
  }
  await updateRouterProfile(db, id, { enabled: body.enabled });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "router.profile.update",
    target: existing.name,
    detail: { profileId: id, enabled: body.enabled },
  });
  return { ...existing, enabled: body.enabled };
});

app.delete("/api/router/profiles/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = await getRouterProfile(db, id);
  if (!existing || existing.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "profile not found" });
  }
  await deleteRouterProfile(db, id);
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "router.profile.delete",
    target: existing.name,
    detail: { profileId: id },
  });
  return reply.code(204).send();
});

app.get("/api/budgets", async () => listBudgets(db, workspaceId));

app.post("/api/budgets", async (req, reply) => {
  const body = (req.body ?? {}) as { agentId?: string | null; monthlyTokenLimit?: number };
  const limit = Number(body.monthlyTokenLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return reply.code(400).send({ error: "monthlyTokenLimit must be a positive number" });
  }
  const row = await createBudget(db, {
    workspaceId,
    agentId: body.agentId ?? null,
    monthlyTokenLimit: Math.floor(limit),
  });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "budget.create",
    target: body.agentId ?? "workspace",
    detail: { monthlyTokenLimit: Math.floor(limit) },
  });
  return reply.code(201).send(row);
});

app.delete("/api/budgets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  await deleteBudget(db, id);
  return reply.code(204).send();
});

// --- Knowledge base (Stage 3, PRD use-case 4) ----------------------------------
app.get("/api/kb/documents", async () => listDocuments(db, workspaceId));

/** Upload a md/txt document: heading-aware chunking + embedding at ingest. */
app.post("/api/kb/documents", async (req, reply) => {
  const body = (req.body ?? {}) as { title?: string; content?: string; source?: string; mime?: string };
  if (!body.title?.trim() || typeof body.content !== "string" || !body.content.trim()) {
    return reply.code(400).send({ error: "title and content are required" });
  }
  const result = await kbIngest(kbDeps, {
    title: body.title.trim(),
    content: body.content,
    source: body.source,
    mime: body.mime,
  });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "kb.upload",
    target: result.document.title,
    detail: { documentId: result.document.id, chunks: result.chunkCount, embedded: result.embedded },
  });
  return reply.code(201).send(result);
});

app.get("/api/kb/documents/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const doc = await getDocument(db, id);
  if (!doc || doc.workspaceId !== workspaceId) return reply.code(404).send({ error: "document not found" });
  const chunks = await getDocumentChunks(db, id);
  return { document: doc, chunks };
});

app.delete("/api/kb/documents/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const doc = await getDocument(db, id);
  if (!doc || doc.workspaceId !== workspaceId) return reply.code(404).send({ error: "document not found" });
  await deleteDocument(db, id);
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "kb.delete",
    target: doc.title,
    detail: { documentId: id },
  });
  return reply.code(204).send();
});

/** Search-test surface for the KNOWLEDGE view (same path the kb.search tool uses). */
app.get("/api/kb/search", async (req) => {
  const { q, limit } = req.query as { q?: string; limit?: string };
  if (!q?.trim()) return [];
  return kbSearch(kbDeps, q, limit ? Math.min(Number(limit), 20) : 5);
});

// --- Missions & traces -------------------------------------------------------
app.get("/api/missions", async () => listMissions(db, workspaceId));

/** Dead-letter queue: missions retried at least once and still failed. */
app.get("/api/missions/dead-letter", async () =>
  listDeadLetterMissions(db, workspaceId, 1));

app.get("/api/missions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission) return reply.code(404).send({ error: "mission not found" });
  const steps = await getMissionSteps(db, id);
  return { mission, steps };
});

/** Cooperative cancel (Stage 2): queued/paused missions cancel immediately;
 *  running missions get a flag checked between nodes/iterations. */
app.post("/api/missions/:id/cancel", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission) return reply.code(404).send({ error: "mission not found" });
  if (["succeeded", "failed", "cancelled"].includes(mission.status)) {
    return reply.code(409).send({ error: `mission is already ${mission.status}` });
  }
  await requestMissionCancel(db, id);
  const immediate = mission.status === "queued" || mission.status === "awaiting_approval";
  if (immediate) {
    await updateMission(db, id, {
      status: "cancelled",
      error: "cancelled by operator",
      finishedAt: new Date(),
    });
    await bus.publish({ type: "mission.finished", missionId: id, status: "cancelled", at: new Date().toISOString() });
  }
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    missionId: id,
    action: "mission.cancel",
    detail: { immediate },
  });
  return reply.code(202).send({ ok: true, cancelled: immediate, cancelling: !immediate });
});

/** Retry-from-step (Stage 2): re-enqueue a failed/cancelled mission; the
 *  cursor + idempotency ledger make it resume where it stopped without
 *  repeating committed side effects. */
app.post("/api/missions/:id/retry", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission) return reply.code(404).send({ error: "mission not found" });
  if (!["failed", "cancelled"].includes(mission.status)) {
    return reply.code(409).send({ error: `only failed/cancelled missions can be retried (status: ${mission.status})` });
  }
  await resetMissionForRetry(db, id);
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    missionId: id,
    action: "mission.retry",
    detail: { retryCount: mission.retryCount + 1 },
  });
  await runner.enqueue(id);
  return reply.code(202).send({ ok: true, missionId: id });
});

/** Failure explainer (Stage 6): deterministic locator line + model-written
 *  diagnosis of the recorded step trace. */
app.post("/api/missions/:id/explain", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission) return reply.code(404).send({ error: "mission not found" });
  if (mission.status !== "failed") {
    return reply.code(409).send({ error: `mission is ${mission.status}, not failed` });
  }
  const steps = await getMissionSteps(db, id);
  const model = process.env.COPILOT_MODEL || "mock";
  return explainFailure(router, model, mission, steps);
});

/** Deterministic replay (Stage 2): re-walk the DAG over recorded outputs,
 *  no side effects — flags divergence between expected and recorded steps. */
app.get("/api/missions/:id/replay", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission) return reply.code(404).send({ error: "mission not found" });
  const steps = await getMissionSteps(db, id);
  if (mission.kind !== "workflow" || !mission.workflowVersionId) {
    // Agent ticks are linear: the ordered step log is already the lineage.
    return { mission, kind: mission.kind, lineage: steps };
  }
  const version = await getWorkflowVersionById(db, mission.workflowVersionId);
  if (!version) return reply.code(404).send({ error: "workflow version not found" });
  const lineage = replayMission(
    version.graph,
    steps.map((s) => ({
      nodeId: s.nodeId,
      status: s.status,
      input: s.input,
      output: s.output,
      error: s.error,
      attempt: s.attempt,
    })),
    mission.input,
  );
  return { mission, kind: "workflow", lineage };
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
  // Resume the mission from its approval gate — but only when it is actually
  // paused. Elicitation approvals (Stage 7) resolve while the mission is still
  // running (the tool call is blocked in-process); re-enqueueing would run it
  // concurrently with itself.
  const gated = await getMission(db, approval.missionId);
  if (gated?.status === "awaiting_approval" || gated?.status === "queued") {
    await runner.enqueue(approval.missionId);
  }
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
  otelUnsub?.();
  await runner.close();
  for (const conn of mcpConnections.values()) await conn.close().catch(() => {});
  await bus.close?.();
  await handle.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
