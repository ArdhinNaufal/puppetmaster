import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import {
  ArtifactKind,
  ProjectMode,
  ProjectPhase,
  ProjectStatus,
  TraceRefType,
  TraceRelation,
  VerifyCheckName,
  WorkflowGraph,
} from "@puppetmaster/shared";
import {
  appendAudit,
  budgetsForAgent,
  checkAndPinToolHash,
  cancelWorkflowMissionWait,
  createApproval,
  createBudget,
  createMcpServer,
  createProjectTraceLink,
  createRouterProfile,
  deleteMcpServer,
  deleteProjectTraceLink,
  deleteRouterProfile,
  getMcpServer,
  getRouterProfile,
  getRouterProfileByName,
  listMcpServers,
  listRouterProfiles,
  updateRouterProfile,
  deleteBudget,
  completeTodo,
  createAgent,
  createVerifyCheck,
  createDb,
  createProject,
  createTemplate,
  createWorkflow,
  deleteAgent,
  deleteDocument,
  deleteMemory,
  deleteTemplate,
  ensureDefaultWorkspace,
  finishClaudeRun,
  getAgent,
  getAgentMessages,
  getApproval,
  getArtifact,
  getDocument,
  getDocumentChunks,
  getMemory,
  getMembership,
  getScienceWorkspaceAdmission,
  getMission,
  getMissionSteps,
  getClaudeRunByMission,
  getProject,
  getTemplate,
  getVerifyCheck,
  getVerifyCheckByName,
  getWorkflow,
  getWorkflowVersionById,
  getWorkflowWithGraph,
  getWorkspace,
  listAgents,
  listApprovals,
  listArtifacts,
  listEvidenceForApproval,
  listVerifyChecks,
  listAudit,
  insertEvalRun,
  listBudgets,
  listDeadLetterMissions,
  listDocuments,
  listProjects,
  listEvalRuns,
  listMemories,
  listMissions,
  listPoliciesForAgent,
  listQueuedGenericMissionsForRecovery,
  listReadyWorkflowWaits,
  listProjectTraceLinks,
  listTemplates,
  listWorkflows,
  migrate,
  missionUsage,
  monthTokens,
  monthUsageBreakdown,
  recordUsage,
  requestMissionCancel,
  recoverExpiredWorkflowWaitClaims,
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
  updateProject,
  updateVerifyCheck,
  updateWorkspace,
  writeArtifact,
  type DbHandle,
  ScienceConflictError,
} from "@puppetmaster/db";
import {
  AgentRuntime,
  BuiltinToolRegistry,
  ClaudeCodeRuntime,
  connectMcpServer,
  createAgentInvoker,
  createWorkspaceMissionDispatcher,
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
  createBuiltinCheckRunner,
  DockerCommandExecutor,
  mirrorArtifactToKb,
  registerBenchTools,
  registerBridgeTools,
  registerKbTools,
  registerProjectTools,
  registerScienceTools,
  assertScienceProductionDeploymentEnv,
  resolveRequiredSections,
  resolveScienceRuntimeConfig,
  sectionCoverage,
  replayMission,
  startOtelExporter,
  resolveCredentialEnv,
  startAgentTick,
  startWorkflow,
  WorkflowExecutor,
  createArtifactStoreFromEnv,
  createComputeProvidersFromEnv,
  createRenderProvidersFromEnv,
  createSingleFlightTtlCache,
  InlineScienceScheduler,
  QueueScienceScheduler,
  ScienceDisabledError,
  ScienceService,
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
import { registerClaudeCodeRoutes, terminalizeClaudeQueueFailure } from "./claude-code-routes.js";
import {
  redactScienceRequestPath,
  registerScienceRoutes,
} from "./science-routes.js";
import {
  providerEnvEnabled,
  resolveAnthropicProviderReadiness,
  resolveOpenAiEndpointReadiness,
} from "./claude-code-readiness.js";
import {
  graphHasWebhookTrigger,
  newWebhookSecret,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhooks.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";
const REDIS_URL = process.env.REDIS_URL ?? null;

const app = Fastify({
  logger: {
    serializers: {
      // Signed artifact references carry a short-lived capability in the
      // query string. Never copy query parameters into normal request logs.
      req(request) {
        const rawUrl = typeof request.url === "string" ? request.url : "";
        return {
          method: request.method,
          url: redactScienceRequestPath(rawUrl),
          host: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  },
});
let shuttingDown = false;

const ApprovalDecisionInput = z.object({ approved: z.boolean() }).strict();

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
assertScienceProductionDeploymentEnv(process.env);
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
const baseAuditSink = createAuditSink(db, bus);
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
// Workshop WP3b.2: shell-backed verify checks (test/arch/custom) need a command
// executor. WORKBENCH_MODE=docker wires the containerized executor (ADR-005;
// verified on a Docker host via scripts/verify-workbench.mjs). Default off — no
// executor means shell checks refuse honestly (DB-native checks still run). A
// local (host-subprocess) executor is deliberately NOT offered here: running
// project commands on the host is not the container isolation model.
const workbenchSecretNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "DELEGATE_MODEL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
const workbenchSecrets: Record<string, string> = Object.fromEntries(
  workbenchSecretNames.flatMap((name) => {
    const value = process.env[name]?.trim();
    return value ? [[name, value]] : [];
  }),
);
// The server/router uses OPENAI_BASE_URL while Aider follows the established
// OPENAI_API_BASE name. Mirror it only inside the isolated workbench so one
// .env setting powers both paths.
if (!workbenchSecrets.OPENAI_API_BASE && workbenchSecrets.OPENAI_BASE_URL) {
  workbenchSecrets.OPENAI_API_BASE = workbenchSecrets.OPENAI_BASE_URL;
}
const anthropicReadiness = resolveAnthropicProviderReadiness(process.env);
const openaiWorkbenchAuthenticationConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
const workbenchEgressAllow = (process.env.WORKBENCH_EGRESS_ALLOW ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const egressAllowsHost = (host: string | null): boolean =>
  host !== null && workbenchEgressAllow.some((entry) => host === entry || host.endsWith(`.${entry}`));
const anthropicEndpoint = anthropicReadiness.endpoint;
const effectiveOpenAiEndpointValue =
  workbenchSecrets.OPENAI_API_BASE || workbenchSecrets.OPENAI_BASE_URL || "https://api.openai.com";
const openaiReadiness = resolveOpenAiEndpointReadiness(
  effectiveOpenAiEndpointValue,
  providerEnvEnabled(process.env.CLAUDE_CODE_ALLOW_INSECURE_OPENAI_BASE_URL),
);
const openaiEndpoint = openaiReadiness.endpoint;
const explicitOpenAiModel =
  process.env.CLAUDE_CODE_OPENAI_MODEL?.trim() ||
  process.env.OPENAI_CODE_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim();
const sharedOpenAiModel = [process.env.DELEGATE_MODEL, process.env.COPILOT_MODEL]
  .map((value) => value?.trim() ?? "")
  .find((value) => value.toLowerCase().startsWith("openai/"));
const normalizeOpenAiModel = (value: string): string =>
  value.toLowerCase().startsWith("openai/") ? `openai/${value.slice("openai/".length)}` : `openai/${value}`;
const openaiCodingModel = normalizeOpenAiModel(explicitOpenAiModel || sharedOpenAiModel || "gpt-5.6");
const workbenchExecutor =
  process.env.WORKBENCH_MODE === "docker"
    ? new DockerCommandExecutor({ secrets: workbenchSecrets })
    : undefined;
if (workbenchExecutor) app.log.info("workbench: docker executor enabled (shell verify checks active)");
const [claudeCliProbe, aiderCliProbe, egressProxyProbe] = workbenchExecutor
  ? await Promise.all([
      workbenchExecutor.probeCli("claude", "2.1.205"),
      workbenchExecutor.probeCli("aider", "0.86.1"),
      workbenchExecutor.probeEgressProxy(),
    ])
  : [
      { available: false, version: null, error: "WORKBENCH_MODE=docker is not enabled" },
      { available: false, version: null, error: "WORKBENCH_MODE=docker is not enabled" },
      { available: false, error: "WORKBENCH_MODE=docker is not enabled" },
    ];
const executor = new WorkflowExecutor({
  db,
  bus,
  tools,
  audit: auditSink,
  checkRunner: createBuiltinCheckRunner({ db, executor: workbenchExecutor }),
});
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
app.addHook("onRequest", async (request, reply) => {
  if (shuttingDown && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return reply.code(503).send({ error: "server is shutting down" });
  }
});
const claudeRuntime = new ClaudeCodeRuntime({
  db,
  bus,
  executor: workbenchExecutor,
  audit: auditSink,
  anthropicTransport: anthropicReadiness.transport,
});
try {
  const copybackRecovery = await claudeRuntime.reconcilePendingCopybacks();
  if (copybackRecovery.reconciled > 0 || copybackRecovery.orphaned > 0) {
    app.log.info(copybackRecovery, "reconciled Claude workbench state before queue startup");
  }
} catch (error) {
  // Reconciliation errors leave a ledger or running claim as a durable
  // project/session barrier. Keep the control plane available for diagnosis
  // instead of hiding the evidence behind a startup crash.
  app.log.error({ err: error }, "Claude workbench state remains blocked after startup reconciliation");
}

// Credentials vault (Stage 1): AES-256-GCM under PUPPETMASTER_MASTER_KEY.
// Unset key = vault routes disabled (503 on write) and no credential refs.
const masterKey = process.env.PUPPETMASTER_MASTER_KEY?.trim() || null;
const credentialLookup = makeCredentialLookup(db, workspaceId, masterKey);
const auditUnsub = startAuditProjector(bus, db);

// Science Operations is an independently recoverable subsystem. Its control
// plane shares auth/audit/mission primitives with Puppetmaster, while bytes and
// long-running computation stay behind artifact/provider adapters.
const scienceConfig = resolveScienceRuntimeConfig(process.env);
const configuredScienceSecret =
  process.env.SCIENCE_SIGNING_SECRET?.trim() || masterKey;
if (
  scienceConfig.enabled &&
  process.env.NODE_ENV === "production" &&
  !configuredScienceSecret
) {
  throw new Error(
    "SCIENCE_SIGNING_SECRET or PUPPETMASTER_MASTER_KEY is required when Science Operations is enabled in production",
  );
}
const scienceSecret =
  scienceConfig.enabled
    ? configuredScienceSecret || "puppetmaster-science-development-key-v1"
    : "puppetmaster-science-development-key-v1";
const scienceStore = createArtifactStoreFromEnv(process.env, scienceSecret);
const scienceComputeProviders = createComputeProvidersFromEnv(process.env);
const scienceRenderProviders = createRenderProvidersFromEnv(process.env);
const scienceWorkspaceAdmission = await getScienceWorkspaceAdmission(db, workspaceId);
const scienceService = new ScienceService({
  db,
  workspaceId,
  store: scienceStore,
  computeProviders: scienceComputeProviders,
  renderProviders: scienceRenderProviders,
  bus,
  config: scienceConfig,
  audit: auditSink,
  gatewaySecret: scienceSecret,
});
const scienceScheduler = REDIS_URL && scienceConfig.enabled
  ? new QueueScienceScheduler(
      REDIS_URL,
      (runId, generation) => scienceService.tick(runId, generation),
      {
        concurrency: scienceConfig.maxConcurrentRunsPerWorkspace,
        onError: (message, error) => app.log.error({ err: error }, message),
      },
    )
  : new InlineScienceScheduler(
      (runId, generation) => scienceService.tick(runId, generation),
      (message, error) => app.log.error({ err: error }, message),
    );
scienceService.attachScheduler(scienceScheduler);

const resolveScienceToolActor = async (
  ctx: import("@puppetmaster/kernel").ToolContext,
): Promise<string> => {
  // Preserve the initiating user across nested workflow/agent missions. Cron
  // and webhook automation must name an explicit service-account member; they
  // are never silently attributed to the workspace owner.
  let missionId = ctx.missionId ?? null;
  for (let depth = 0; missionId && depth < 20; depth++) {
    const mission = await getMission(db, missionId);
    if (!mission) break;
    const trigger = mission.trigger as Record<string, unknown>;
    const candidate = typeof trigger.actorId === "string" ? trigger.actorId : null;
    if (candidate && await getMembership(db, candidate, workspaceId)) return candidate;
    missionId = mission.parentMissionId;
  }
  const automationActor = process.env.SCIENCE_AUTOMATION_USER_ID?.trim();
  if (automationActor) {
    const membership = await getMembership(db, automationActor, workspaceId);
    if (membership && ["builder", "admin", "owner"].includes(membership.role)) {
      return automationActor;
    }
  }
  throw new Error(
    "science write tools require an initiating user or a builder SCIENCE_AUTOMATION_USER_ID",
  );
};

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
const agentInvoker = createAgentInvoker({ db, workspaceId, runtime: agentRuntime });
executor.setAgentInvoker(agentInvoker);
// Agent → workflow: workflows join the shared tool catalog (workflow.list/run/
// create_draft). Stage 8: agentInvoker also enables agent.ask delegation.
registerBridgeTools(tools, { db, workspaceId, executor, agentInvoker });

// Knowledge base (Stage 3): kb.search / kb.read join the shared catalog so
// agents and workflow nodes retrieve cited chunks from workspace documents.
const kbDeps = { db, workspaceId, embedder };
registerKbTools(tools, kbDeps);

// The Workshop (AI-SDLC plan WP2): project artifacts/todos join the shared
// catalog — same surface for agents and workflow action nodes.
registerProjectTools(tools, { db, workspaceId, kb: kbDeps });

// Workbench tools (WP3b.3): bench.read/exec/write + bench.git.* drive a
// project's container over the same executor as the shell verify checks.
// Shares the WORKBENCH_MODE executor — unset ⇒ every bench call refuses by name.
registerBenchTools(tools, { db, workspaceId, executor: workbenchExecutor });

// Science tools are bounded metadata/reference facades over the same service
// used by REST. Provider handles and artifact bytes are never registered as
// user-facing tools.
registerScienceTools(tools, {
  service: scienceService,
  resolveActorId: resolveScienceToolActor,
});

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
const dispatch: MissionDispatcher = createWorkspaceMissionDispatcher(
  db,
  workspaceId,
  async (mission) => {
    const missionId = mission.id;
    if (mission.kind === "science") {
      if (scienceConfig.submissionsEnabled) {
        const run = await scienceService.getRunByMission(mission.id);
        if (run && !["succeeded", "failed", "cancelled"].includes(run.state)) {
          await scienceScheduler.enqueue(run.id, null);
        }
      }
      // The science scheduler owns provider polling and terminalization. A
      // generic mission recovery job must hand off and then finish, not execute
      // a science mission as a workflow graph.
      return mission.status;
    }
    return mission.kind === "agent"
      ? agentRuntime.runMission(missionId)
      : mission.kind === "claude"
        ? claudeRuntime.runMission(missionId)
        : executor.runMission(missionId);
  },
);

const runner: WorkflowRunner = REDIS_URL
  ? new QueueRunner(REDIS_URL, { run: dispatch, db, workspaceId })
  : new InlineRunner(dispatch);

const QUEUED_MISSION_RECOVERY_LIMIT = 500;
async function recoverQueuedWorkspaceMissions(): Promise<number> {
  const queued = await listQueuedGenericMissionsForRecovery(db, {
    workspaceId,
    limit: QUEUED_MISSION_RECOVERY_LIMIT + 1,
  });
  if (queued.length > QUEUED_MISSION_RECOVERY_LIMIT) {
    throw new Error(
      `more than ${QUEUED_MISSION_RECOVERY_LIMIT} queued workflow/agent/Claude missions require recovery`,
    );
  }
  for (const mission of queued) {
    await runner.enqueue(mission.id, `startup-queued-${mission.id}`);
  }
  return queued.length;
}

async function wakeReadyWorkflowWaits(runId?: string): Promise<{
  recoveredClaims: number;
  enqueued: number;
}> {
  const recovered = runId
    ? []
    : await recoverExpiredWorkflowWaitClaims(db, { workspaceId, limit: 500 });
  const ready = await listReadyWorkflowWaits(db, { workspaceId, runId, limit: 500 });
  for (const wait of ready) {
    await runner.enqueue(
      wait.missionId,
      `workflow-wait-${wait.id}-${wait.generation}`,
    );
  }
  return { recoveredClaims: recovered.length, enqueued: ready.length };
}

scienceService.attachWorkflowWaitWaker(async (runId) => {
  await wakeReadyWorkflowWaits(runId);
});

app.log.info(
  {
    dbDriver: handle.driver,
    bus: REDIS_URL ? "redis" : "memory",
    runner: REDIS_URL ? "queue" : "inline",
    science: {
      enabled: scienceConfig.enabled,
      submissionsEnabled: scienceConfig.submissionsEnabled,
      workspaceAdmittedAtStartup: scienceWorkspaceAdmission.admitted,
      storage: scienceStore.adapter,
      computeProviders: scienceComputeProviders.list(),
      renderProviders: scienceRenderProviders.list(),
    },
  },
  "puppetmaster kernel ready",
);
const scienceRecovery = await scienceService.reconcile();
const workflowWaitRecovery = await wakeReadyWorkflowWaits();
const queuedMissionRecovery = await recoverQueuedWorkspaceMissions();
if (
  scienceRecovery.enqueued > 0 ||
  scienceRecovery.expiredUploads > 0 ||
  scienceRecovery.expiredArtifactVersions > 0 ||
  scienceRecovery.expiredRenderSessions > 0 ||
  workflowWaitRecovery.recoveredClaims > 0 ||
  workflowWaitRecovery.enqueued > 0 ||
  queuedMissionRecovery > 0
) {
  app.log.info(
    {
      ...scienceRecovery,
      workflowWaits: workflowWaitRecovery,
      queuedMissionRecovery,
    },
    "reconciled Science Operations durable state",
  );
}
const scienceReconcilePeriodMs = Math.max(
  5_000,
  Math.min(60_000, Math.floor(scienceConfig.uploadTtlSeconds * 500)),
);
let scienceReconcilePromise: Promise<void> | null = null;
const scienceReconcileTimer = setInterval(() => {
      if (scienceReconcilePromise) return;
      scienceReconcilePromise = (scienceConfig.enabled
        ? scienceService.reconcile()
        : Promise.resolve(null))
        .then(async (result) => {
          const workflowWaits = await wakeReadyWorkflowWaits();
          if (
            (result && (
              result.enqueued > 0 ||
              result.expiredUploads > 0 ||
              result.expiredArtifactVersions > 0 ||
              result.expiredRenderSessions > 0 ||
              result.orphanQuarantineObjects > 0
            )) ||
            workflowWaits.recoveredClaims > 0 ||
            workflowWaits.enqueued > 0
          ) {
            app.log.info(
              { ...(result ?? {}), workflowWaits },
              "completed periodic Science durable-state reconciliation",
            );
          }
        })
        .catch((error) => {
          app.log.error({ err: error }, "periodic Science durable-state reconciliation failed");
        })
        .finally(() => {
          scienceReconcilePromise = null;
        });
    }, scienceReconcilePeriodMs);
scienceReconcileTimer?.unref?.();
await scienceScheduler.start();
await runner.start();

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
registerScienceRoutes(app, { service: scienceService });

registerClaudeCodeRoutes(app, {
  db,
  workspaceId,
  runtime: claudeRuntime,
  runner,
  providers: {
    anthropic: {
      authenticationConfigured: anthropicReadiness.authenticationConfigured,
      authenticationError: anthropicReadiness.authenticationError,
      networkConfigured: anthropicReadiness.endpointError === null &&
        egressAllowsHost(anthropicEndpoint?.host ?? null),
      runtimeConfigured: claudeCliProbe.available && egressProxyProbe.available,
      runtimeError: claudeCliProbe.error ?? egressProxyProbe.error,
      detectedCliVersion: claudeCliProbe.version,
      networkError: anthropicReadiness.endpointError,
      defaultModel: "sonnet",
      modelOptions: ["sonnet", "opus", "haiku"],
      endpointHost: anthropicEndpoint?.host ?? null,
    },
    openai: {
      authenticationConfigured: openaiWorkbenchAuthenticationConfigured,
      networkConfigured: openaiReadiness.transportAllowed &&
        egressAllowsHost(openaiEndpoint?.host ?? null),
      runtimeConfigured: aiderCliProbe.available && egressProxyProbe.available,
      runtimeError: aiderCliProbe.error ?? egressProxyProbe.error,
      detectedCliVersion: aiderCliProbe.version,
      networkError: openaiReadiness.error,
      defaultModel: openaiCodingModel,
      modelOptions: [...new Set([
        openaiCodingModel,
        "openai/gpt-5.6",
        "openai/gpt-5.6-terra",
        "openai/gpt-5.6-luna",
      ])],
      endpointHost: openaiEndpoint?.host ?? null,
    },
  },
  egressAllow: workbenchEgressAllow,
});

// --- Meta --------------------------------------------------------------------
app.get("/api/health", async () => ({
  ok: true,
  service: "puppetmaster-server",
  version: "0.0.1",
}));

const currentReadiness = createSingleFlightTtlCache(
  () => scienceService.health(),
  { ttlMs: 5_000 },
);
app.get("/api/readiness", async (_request, reply) => {
  const readiness = await currentReadiness();
  return reply.code(readiness.ok ? 200 : 503).send({
    ok: readiness.ok,
    service: "puppetmaster-server",
    version: "0.0.1",
    science: readiness,
  });
});

app.get("/api/readyz", async (_request, reply) => {
  const readiness = await currentReadiness();
  return reply.code(readiness.ok ? 200 : 503).send({
    ok: readiness.ok,
    service: "puppetmaster-server",
  });
});

app.get("/api/bootstrap", async () => ({
  workspaceId,
  dbDriver: handle.driver,
  queue: REDIS_URL ? "bullmq" : "inline",
  tools: tools.list(),
  science: {
    enabled: scienceConfig.enabled,
    submissionsEnabled: scienceConfig.submissionsEnabled,
    storage: scienceStore.adapter,
    computeProviders: scienceComputeProviders.list(),
    renderProviders: scienceRenderProviders.list(),
  },
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
    if (!wf?.version || wf.workflow.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: "workflow not found" });
    }
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
    if (!agent || agent.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: "agent not found" });
    }
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


// --- The Workshop: projects + artifacts (AI-SDLC plan WP2, ADR-001/003/004) ---
// Reads are member-tier; mutations are builder+ (auth.ts). Artifact lifecycle
// rules are enforced in the repo layer; violations surface here as 400s.
const ProjectTraceLinkInput = z.object({
  sourceType: TraceRefType,
  sourceId: z.string().uuid(),
  targetType: TraceRefType,
  targetId: z.string().uuid(),
  relation: TraceRelation,
  rationale: z.string().trim().min(1),
});

app.get("/api/projects", async () => listProjects(db, workspaceId));

app.post("/api/projects", async (req, reply) => {
  const body = req.body as { name?: string; repoRef?: string; mode?: string };
  const name = body.name?.trim();
  if (!name) return reply.code(400).send({ error: "name required" });
  const mode = body.mode === "gated" ? "gated" : "supervised";
  const row = await createProject(db, { workspaceId, name, repoRef: body.repoRef ?? "", mode });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "project.create",
    target: row.id,
    detail: { name, mode },
  });
  return reply.code(201).send(row);
});

app.get("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  return project;
});

app.put("/api/projects/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const body = req.body as { phase?: string; status?: string; mode?: string };
  const phase = body.phase === undefined ? undefined : ProjectPhase.safeParse(body.phase);
  const status = body.status === undefined ? undefined : ProjectStatus.safeParse(body.status);
  const mode = body.mode === undefined ? undefined : ProjectMode.safeParse(body.mode);
  for (const [field, parsed] of [["phase", phase], ["status", status], ["mode", mode]] as const) {
    if (parsed && !parsed.success) return reply.code(400).send({ error: `invalid ${field}` });
  }
  const row = await updateProject(db, id, {
    ...(phase?.success ? { phase: phase.data } : {}),
    ...(status?.success ? { status: status.data } : {}),
    ...(mode?.success ? { mode: mode.data } : {}),
  });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "project.update",
    target: id,
    detail: req.body as Record<string, unknown>,
  });
  return row;
});

app.get("/api/projects/:id/artifacts", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const { kind, status } = req.query as { kind?: string; status?: string };
  return listArtifacts(db, id, { kind, status });
});

// Forcing-section progress meter (WP7.5): the spec's unfilled sections are the
// interview's progress bar. Coverage is recomputed live from the newest spec
// artifact against the same required list the spec-sections gate uses (its
// `command` override if configured, else the default), so meter and gate agree.
app.get("/api/projects/:id/spec-coverage", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const check = await getVerifyCheckByName(db, id, "spec-sections");
  const required = resolveRequiredSections(check?.command ?? null);
  const specs = await listArtifacts(db, id, { kind: "spec" });
  if (specs.length === 0) {
    return { spec: null, required, present: [], thin: [], missing: required };
  }
  const latest = specs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const cov = sectionCoverage(latest.body, required);
  return { spec: { id: latest.id, title: latest.title, version: latest.version }, required, ...cov };
});

app.post("/api/projects/:id/artifacts", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const body = req.body as { kind?: string; title?: string; body?: string; status?: string };
  const kind = ArtifactKind.safeParse(body.kind);
  if (!kind.success) return reply.code(400).send({ error: "invalid artifact kind" });
  if (!body.title?.trim()) return reply.code(400).send({ error: "title required" });
  try {
    const row = await writeArtifact(db, {
      projectId: id,
      kind: kind.data,
      title: body.title.trim(),
      body: body.body,
      status: body.status,
    });
    await mirrorArtifactToKb(kbDeps, row).catch(() => {});
    await appendAudit(db, {
      workspaceId,
      actorKind: "user",
      actorId: req.authUser?.id ?? null,
      actorLabel: req.authUser?.email ?? "unknown",
      action: "project.artifact.write",
      target: row.id,
      detail: { projectId: id, kind: row.kind, title: row.title, version: row.version },
    });
    return reply.code(201).send(row);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid artifact" });
  }
});

// Artifact/check traceability graph: project-scoped provenance, verification,
// and risk coverage links. Endpoint ownership is revalidated in the repo layer
// so a caller cannot stitch together ids from different projects.
app.get("/api/projects/:id/trace-links", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  return listProjectTraceLinks(db, id);
});

app.post("/api/projects/:id/trace-links", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const parsed = ProjectTraceLinkInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid trace link", detail: parsed.error.issues });
  }
  try {
    const row = await createProjectTraceLink(db, { projectId: id, ...parsed.data });
    await appendAudit(db, {
      workspaceId,
      actorKind: "user",
      actorId: req.authUser?.id ?? null,
      actorLabel: req.authUser?.email ?? "unknown",
      action: "project.trace-link.create",
      target: row.id,
      detail: {
        projectId: id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        targetType: row.targetType,
        targetId: row.targetId,
        relation: row.relation,
        rationale: row.rationale,
      },
    });
    return reply.code(201).send(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid trace link";
    const duplicate =
      message.includes("already exists") ||
      message.includes("project_trace_links_unique") ||
      message.includes("duplicate key");
    return reply.code(duplicate ? 409 : 400).send({ error: message });
  }
});

app.delete("/api/projects/:id/trace-links/:linkId", async (req, reply) => {
  const { id, linkId } = req.params as { id: string; linkId: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  if (!z.string().uuid().safeParse(linkId).success) {
    return reply.code(400).send({ error: "invalid trace link id" });
  }
  const row = await deleteProjectTraceLink(db, id, linkId);
  if (!row) return reply.code(404).send({ error: "trace link not found" });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "project.trace-link.delete",
    target: row.id,
    detail: {
      projectId: id,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      targetType: row.targetType,
      targetId: row.targetId,
      relation: row.relation,
    },
  });
  return reply.code(204).send();
});

// Verify checks (WP4): earned policies — created disabled unless explicitly
// enabled with a note on what failure earned them. Mutations are admin
// (ADR-001 role matrix: check config is admin).
app.get("/api/projects/:id/checks", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  return listVerifyChecks(db, id);
});

app.post("/api/projects/:id/checks", async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const body = (req.body ?? {}) as {
    name?: string;
    command?: string;
    baseline?: number;
    enabled?: boolean;
    earnedNote?: string;
  };
  const name = VerifyCheckName.safeParse(body.name);
  if (!name.success) return reply.code(400).send({ error: "invalid check name" });
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return reply.code(400).send({ error: "enabled must be a boolean" });
  }
  if (body.earnedNote !== undefined && typeof body.earnedNote !== "string") {
    return reply.code(400).send({ error: "earnedNote must be a string" });
  }
  const enabled = body.enabled ?? false;
  const earnedNote = body.earnedNote?.trim() ?? "";
  if (enabled && !earnedNote) {
    return reply.code(400).send({ error: "an enabled verify check requires an earned note" });
  }
  if (await getVerifyCheckByName(db, id, name.data)) {
    return reply.code(409).send({ error: `check "${name.data}" already exists for this project` });
  }
  const row = await createVerifyCheck(db, {
    projectId: id,
    name: name.data,
    command: body.command ?? null,
    baseline: body.baseline ?? null,
    enabled,
    earnedNote,
  });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "project.check.create",
    target: row.id,
    detail: { projectId: id, name: name.data, enabled: row.enabled },
  });
  return reply.code(201).send(row);
});

app.put("/api/projects/:id/checks/:checkId", async (req, reply) => {
  const { id, checkId } = req.params as { id: string; checkId: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const current = await getVerifyCheck(db, checkId);
  if (!current || current.projectId !== id) return reply.code(404).send({ error: "check not found" });
  const body = (req.body ?? {}) as { command?: string; baseline?: number; enabled?: boolean; earnedNote?: string };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return reply.code(400).send({ error: "enabled must be a boolean" });
  }
  if (body.earnedNote !== undefined && typeof body.earnedNote !== "string") {
    return reply.code(400).send({ error: "earnedNote must be a string" });
  }
  const nextEnabled = body.enabled ?? current.enabled;
  const nextEarnedNote = body.earnedNote === undefined ? current.earnedNote : body.earnedNote.trim();
  if (nextEnabled && !nextEarnedNote) {
    return reply.code(400).send({ error: "an enabled verify check requires an earned note" });
  }
  const patch = {
    ...body,
    ...(body.earnedNote !== undefined ? { earnedNote: nextEarnedNote } : {}),
  };
  const row = await updateVerifyCheck(db, checkId, patch);
  if (!row) return reply.code(404).send({ error: "check not found" });
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    action: "project.check.update",
    target: checkId,
    detail: { projectId: id, ...patch },
  });
  return row;
});

/** Complete a todo. The completing mission's id is mandatory — the lifecycle
 *  rule that makes todos/completed an audit trail (corpus §4.7). */
app.post("/api/projects/:id/artifacts/:artifactId/complete", async (req, reply) => {
  const { id, artifactId } = req.params as { id: string; artifactId: string };
  const project = await getProject(db, id);
  if (!project || project.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "project not found" });
  }
  const artifact = await getArtifact(db, artifactId);
  if (!artifact || artifact.projectId !== id) {
    return reply.code(404).send({ error: "artifact not found" });
  }
  const body = (req.body ?? {}) as { missionId?: string };
  try {
    const row = await completeTodo(db, artifactId, body.missionId ?? "");
    await appendAudit(db, {
      workspaceId,
      actorKind: "user",
      actorId: req.authUser?.id ?? null,
      actorLabel: req.authUser?.email ?? "unknown",
      action: "project.todo.complete",
      target: artifactId,
      detail: { projectId: id, missionId: body.missionId },
    });
    return row;
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : "cannot complete" });
  }
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

async function getWorkspaceWorkflow(id: string) {
  const workflow = await getWorkflow(db, id);
  return workflow?.workspaceId === workspaceId ? workflow : null;
}

async function getWorkspaceWorkflowWithGraph(id: string) {
  const workflow = await getWorkflowWithGraph(db, id);
  return workflow?.workflow.workspaceId === workspaceId ? workflow : null;
}

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
  const wf = await getWorkspaceWorkflowWithGraph(id);
  if (!wf) return reply.code(404).send({ error: "workflow not found" });
  return wf;
});

app.put("/api/workflows/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { graph?: unknown };
  const graph = WorkflowGraph.safeParse(body.graph);
  if (!graph.success) return reply.code(400).send({ error: "invalid graph", detail: graph.error.issues });
  if (!await getWorkspaceWorkflow(id)) {
    return reply.code(404).send({ error: "workflow not found" });
  }
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
  const wf = await getWorkspaceWorkflow(id);
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
  const wf = await getWorkspaceWorkflow(id);
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
  const body = (req.body ?? {}) as { graph?: unknown; projectId?: string };
  // Workshop WP4/W8: graphs linted against a gated project get the gated-mode
  // rules (every agent node needs a verify gate downstream).
  let projectMode: "supervised" | "gated" | undefined;
  if (body.projectId) {
    const project = await getProject(db, body.projectId);
    if (project && project.workspaceId === workspaceId) {
      projectMode = project.mode as "supervised" | "gated";
    }
  }
  return lintWorkflowGraph(body.graph ?? { nodes: [], edges: [] }, (s, t) => tools.info(s, t), { projectMode });
});

app.post("/api/workflows/:id/run", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { input?: unknown };
  if (!await getWorkspaceWorkflow(id)) {
    return reply.code(404).send({ error: "workflow not found" });
  }
  try {
    const mission = await startWorkflow(db, {
      workspaceId,
      workflowId: id,
      trigger: { mode: "manual", actorId: req.authUser!.id },
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
  const wf = await getWorkspaceWorkflow(workflowId);
  if (!wf) return reply.code(404).send({ error: "workflow not found" });
  if (wf?.webhookSecret) {
    const sig = req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined;
    const raw = (req as { rawBody?: string }).rawBody ?? "";
    if (!verifyWebhookSignature(wf.webhookSecret, raw, sig)) {
      return reply.code(401).send({ error: "invalid or missing webhook signature" });
    }
  }
  try {
    const mission = await startWorkflow(db, {
      workspaceId,
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
      workspaceId,
      agentId: id,
      trigger: { mode: "chat", actorId: req.authUser!.id },
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
  if (!mission || mission.workspaceId !== workspaceId) return reply.code(404).send({ error: "mission not found" });
  const steps = await getMissionSteps(db, id);
  return { mission, steps };
});

/** Cooperative cancel (Stage 2): queued/paused missions cancel immediately;
 *  running missions get a flag checked between nodes/iterations. */
app.post("/api/missions/:id/cancel", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission || mission.workspaceId !== workspaceId) return reply.code(404).send({ error: "mission not found" });
  if (["succeeded", "failed", "cancelled"].includes(mission.status)) {
    return reply.code(409).send({ error: `mission is already ${mission.status}` });
  }
  const cancelledWait = mission.kind === "workflow"
    ? await cancelWorkflowMissionWait(db, { missionId: id })
    : null;
  if (cancelledWait) {
    const at = new Date().toISOString();
    await bus.publish({ type: "mission.finished", missionId: id, status: "cancelled", at });
    await appendAudit(db, {
      workspaceId,
      actorKind: "user",
      actorId: req.authUser?.id ?? null,
      actorLabel: req.authUser?.email ?? "unknown",
      missionId: id,
      action: "mission.cancel",
      detail: {
        immediateRequested: true,
        processAborted: false,
        cancelled: true,
        durableWaitId: cancelledWait.id,
        childScienceRunCancelled: false,
      },
    });
    return reply.code(202).send({ ok: true, cancelled: true, cancelling: false });
  }
  await requestMissionCancel(db, id);
  const immediateRequested =
    mission.status === "queued" ||
    mission.status === "waiting" ||
    mission.status === "awaiting_approval";
  const processAborted = mission.kind === "claude" ? await claudeRuntime.cancel(id) : false;
  if (immediateRequested && !processAborted) {
    if (mission.kind === "claude") {
      await claudeRuntime.markCancelled(id);
    } else {
      await updateMission(db, id, {
        status: "cancelled",
        error: "cancelled by operator",
        finishedAt: new Date(),
      });
      await bus.publish({ type: "mission.finished", missionId: id, status: "cancelled", at: new Date().toISOString() });
    }
  }
  const latestMission = await getMission(db, id);
  const cancelled = latestMission?.status === "cancelled";
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    missionId: id,
    action: "mission.cancel",
    detail: { immediateRequested, processAborted, cancelled },
  });
  return reply.code(202).send({ ok: true, cancelled, cancelling: !cancelled });
});

/** Retry-from-step (Stage 2): re-enqueue a failed/cancelled mission; the
 *  cursor + idempotency ledger make it resume where it stopped without
 *  repeating committed side effects. */
app.post("/api/missions/:id/retry", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission || mission.workspaceId !== workspaceId) return reply.code(404).send({ error: "mission not found" });
  if (!["failed", "cancelled"].includes(mission.status)) {
    return reply.code(409).send({ error: `only failed/cancelled missions can be retried (status: ${mission.status})` });
  }
  if (mission.kind === "claude") {
    const reset = await claudeRuntime.resetForRetry(id);
    if (!reset.ok) return reply.code(409).send({ error: reset.reason });
  } else {
    await resetMissionForRetry(db, id);
  }
  await appendAudit(db, {
    workspaceId,
    actorKind: "user",
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
    missionId: id,
    action: "mission.retry",
    detail: { retryCount: mission.retryCount + 1 },
  });
  try {
    await runner.enqueue(id);
  } catch (err) {
    if (mission.kind !== "claude") throw err;
    const run = await getClaudeRunByMission(db, id);
    if (!run) throw err;
    const { completion, finishedAt } = await terminalizeClaudeQueueFailure(db, {
      runId: run.id,
      sessionId: run.sessionId,
      missionId: id,
      error: err,
      prefix: "retry queue handoff failed",
      expectedStatuses: ["queued"],
    });
    if (completion.transitioned) {
      if (
        (run.provider === "anthropic" && run.backend === "claude") ||
        (run.provider === "openai" && run.backend === "aider")
      ) {
        await bus.publish({
          type: "claude.run.finished",
          sessionId: run.sessionId,
          runId: run.id,
          missionId: id,
          provider: run.provider,
          backend: run.backend,
          status: "failed",
          at: finishedAt.toISOString(),
        }).catch(() => {});
      }
      await bus.publish({
        type: "mission.finished",
        missionId: id,
        status: "failed",
        at: finishedAt.toISOString(),
      }).catch(() => {});
    }
    return reply.code(503).send({
      error: "Coding retry could not be queued; the mission was marked failed and can be retried again",
      sessionId: run.sessionId,
      runId: run.id,
      missionId: id,
    });
  }
  return reply.code(202).send({ ok: true, missionId: id });
});

/** Failure explainer (Stage 6): deterministic locator line + model-written
 *  diagnosis of the recorded step trace. */
app.post("/api/missions/:id/explain", async (req, reply) => {
  const { id } = req.params as { id: string };
  const mission = await getMission(db, id);
  if (!mission || mission.workspaceId !== workspaceId) return reply.code(404).send({ error: "mission not found" });
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
  if (!mission || mission.workspaceId !== workspaceId) return reply.code(404).send({ error: "mission not found" });
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
  const rows = await listApprovals(db, status);
  const scoped = (
    await Promise.all(rows.map(async (approval) => ({ approval, mission: await getMission(db, approval.missionId) })))
  ).filter(({ mission }) => mission?.workspaceId === workspaceId);
  // Workshop WP4 (org layer §1): the inbox judges evidence, not assertions —
  // verify-gate escalations carry their check runs alongside the prompt.
  return Promise.all(
    scoped.map(async ({ approval }) => ({
      ...approval,
      evidence: await listEvidenceForApproval(db, approval.id),
    })),
  );
});

app.post("/api/approvals/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const decision = ApprovalDecisionInput.safeParse(req.body);
  if (!decision.success) {
    return reply.code(400).send({ error: "approved must be provided as an explicit boolean" });
  }
  const approval = await getApproval(db, id);
  if (!approval) return reply.code(404).send({ error: "approval not found" });
  const approvalMission = await getMission(db, approval.missionId);
  if (!approvalMission || approvalMission.workspaceId !== workspaceId) {
    return reply.code(404).send({ error: "approval not found" });
  }
  const approved = decision.data.approved;
  if (approvalMission.kind === "science") {
    const scienceRun = await scienceService.getRunByMission(approvalMission.id);
    if (!scienceRun) {
      return reply.code(409).send({ error: "science approval is missing its durable run" });
    }
    try {
      const result = await scienceService.resolveApproval({
        runId: scienceRun.id,
        approvalId: approval.id,
        approved,
        actorId: req.authUser!.id,
      });
      return {
        ok: true,
        approved,
        runId: result.run.id,
        state: result.run.state,
      };
    } catch (error) {
      if (error instanceof ScienceConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof ScienceDisabledError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  }
  const resolved = await resolveApproval(db, id, approved);
  if (!resolved) return reply.code(409).send({ error: "approval has already been resolved" });
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
    try {
      await runner.enqueue(approval.missionId);
    } catch (err) {
      const queueError = err instanceof Error ? err.message : String(err);
      const finishedAt = new Date();
      if (gated.kind === "claude") {
        const run = await getClaudeRunByMission(db, approval.missionId);
        if (run && (run.status === "queued" || run.status === "awaiting_approval")) {
          const completion = await finishClaudeRun(db, {
            runId: run.id,
            sessionId: run.sessionId,
            missionId: approval.missionId,
            status: "failed",
            result: null,
            error: `queue handoff failed: ${queueError.slice(0, 1_000)}`,
            finishedAt,
            expectedStatuses: [run.status],
          });
          if (completion.transitioned) {
            if (
              (run.provider === "anthropic" && run.backend === "claude") ||
              (run.provider === "openai" && run.backend === "aider")
            ) {
              await bus.publish({
                type: "claude.run.finished",
                sessionId: run.sessionId,
                runId: run.id,
                missionId: approval.missionId,
                provider: run.provider,
                backend: run.backend,
                status: "failed",
                at: finishedAt.toISOString(),
              }).catch(() => {});
            }
            await bus.publish({
              type: "mission.finished",
              missionId: approval.missionId,
              status: "failed",
              at: finishedAt.toISOString(),
            }).catch(() => {});
          }
        } else if (!run) {
          await updateMission(db, approval.missionId, {
            status: "failed",
            error: "queue handoff failed for Claude mission without a durable run",
            finishedAt,
          });
          await bus.publish({
            type: "mission.finished",
            missionId: approval.missionId,
            status: "failed",
            at: finishedAt.toISOString(),
          }).catch(() => {});
        }
      } else {
        await updateMission(db, approval.missionId, {
          status: "failed",
          error: `queue handoff failed: ${queueError.slice(0, 1_000)}`,
          finishedAt,
        });
        await bus.publish({
          type: "mission.finished",
          missionId: approval.missionId,
          status: "failed",
          at: finishedAt.toISOString(),
        }).catch(() => {});
      }
      app.log.error({ err, approvalId: id, missionId: approval.missionId }, "approval resolved but mission queue handoff failed");
      return reply.code(503).send({ error: "approval was recorded, but the mission could not be queued" });
    }
  }
  return { ok: true, approved };
});

// --- Live event stream -------------------------------------------------------
let wsClients = 0;
const eventMissionWorkspaces = new Map<string, string | null>();
const eventBelongsToWorkspace = async (event: import("@puppetmaster/kernel").BusEvent): Promise<boolean> => {
  if (event.type === "ops.vitals") return event.workspaceId === workspaceId;
  if (event.type === "audit.appended") return event.workspaceId === workspaceId;
  if (event.type.startsWith("science.") && "workspaceId" in event) {
    return event.workspaceId === workspaceId;
  }
  if (!("missionId" in event) || typeof event.missionId !== "string") return false;
  let owner = eventMissionWorkspaces.get(event.missionId);
  if (owner === undefined) {
    owner = (await getMission(db, event.missionId))?.workspaceId ?? null;
    if (eventMissionWorkspaces.size >= 10_000) {
      const oldest = eventMissionWorkspaces.keys().next().value as string | undefined;
      if (oldest) eventMissionWorkspaces.delete(oldest);
    }
    eventMissionWorkspaces.set(event.missionId, owner);
  }
  return owner === workspaceId;
};
app.get("/api/events", { websocket: true }, (socket) => {
  wsClients++;
  let outbound = Promise.resolve();
  const unsubscribe = bus.subscribe((event) => {
    outbound = outbound
      .then(async () => {
        if (await eventBelongsToWorkspace(event)) socket.send(JSON.stringify(event));
      })
      .catch(() => {
        /* socket closing or workspace lookup failed */
      });
  });
  socket.on("close", () => {
    wsClients--;
    unsubscribe();
  });
});

// --- Kernel vitals (docs/PROCESS-WATCH.md R-VITALS) ----------------------------
// Real process measurements sampled every 2.5s: CPU% (cpuUsage delta), RSS/heap,
// event-loop lag (timer drift), uptime, live sockets, mission status counts.
// Published on the bus only while operators are connected; a short ring buffer
// backs the REST endpoint so the watch paints history on entry.
type Vitals = Extract<import("@puppetmaster/kernel").BusEvent, { type: "ops.vitals" }>;
const vitalsHistory: Vitals[] = [];
const VITALS_PERIOD_MS = 2500;
let lastCpu = process.cpuUsage();
let lastSampleAt = performance.now();
const vitalsTimer = setInterval(() => {
  void (async () => {
    const now = performance.now();
    const elapsedMs = now - lastSampleAt;
    const lag = Math.max(0, elapsedMs - VITALS_PERIOD_MS);
    const cpu = process.cpuUsage();
    const cpuPct =
      elapsedMs > 0 ? ((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000 / elapsedMs) * 100 : 0;
    lastCpu = cpu;
    lastSampleAt = now;
    const mem = process.memoryUsage();
    let running = 0;
    let gated = 0;
    let queued = 0;
    try {
      for (const m of await listMissions(db, workspaceId)) {
        if (m.status === "running") running++;
        else if (m.status === "awaiting_approval") gated++;
        else if (m.status === "queued") queued++;
      }
    } catch {
      /* counts are best-effort */
    }
    const sample: Vitals = {
      type: "ops.vitals",
      workspaceId,
      at: new Date().toISOString(),
      cpuPct: Math.round(cpuPct * 10) / 10,
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      loopLagMs: Math.round(lag * 10) / 10,
      upSec: Math.round(process.uptime()),
      wsClients,
      running,
      gated,
      queued,
    };
    vitalsHistory.push(sample);
    if (vitalsHistory.length > 120) vitalsHistory.shift();
    if (wsClients > 0) await bus.publish(sample).catch(() => {});
  })();
}, VITALS_PERIOD_MS);
vitalsTimer.unref?.();

app.get("/api/ops/vitals", async () => ({ samples: vitalsHistory }));

// --- Lifecycle ---------------------------------------------------------------
let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  clearInterval(vitalsTimer);
  if (scienceReconcileTimer) clearInterval(scienceReconcileTimer);
  app.log.info("shutting down: stopping intake and draining managed executions");
  shutdownPromise = (async () => {
    // Stop HTTP/queue intake first, but keep DB, event bus, audit projections,
    // and MCP connections alive until every managed execution has terminated.
    const httpClosed = app.close();
    claudeRuntime.beginShutdown();
    await Promise.all([
      httpClosed,
      runner.close(),
      scienceScheduler.close(),
      claudeRuntime.drain(),
      scienceReconcilePromise ?? Promise.resolve(),
    ]);
    auditUnsub();
    otelUnsub?.();
    for (const conn of mcpConnections.values()) await conn.close().catch(() => {});
    await bus.close?.();
    await handle.close();
  })();
  return shutdownPromise;
}
const signalShutdown = () => {
  void shutdown().catch((error) => {
    process.exitCode = 1;
    app.log.error({ err: error }, "shutdown could not prove managed execution termination");
  });
};
process.once("SIGINT", signalShutdown);
process.once("SIGTERM", signalShutdown);

await app.listen({ port: PORT, host: HOST });
