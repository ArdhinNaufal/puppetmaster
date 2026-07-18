import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  appendAudit,
  ClaudeSessionBusyError,
  createClaudeRunMission,
  createClaudeSession,
  deleteEmptyClaudeSession,
  finishClaudeRun,
  getClaudeSessionInWorkspace,
  getProject,
  hasActiveClaudeRun,
  listClaudeEvents,
  listClaudeRuns,
  listClaudeSessions,
  updateClaudeSession,
  type Db,
} from "@puppetmaster/db";
import type { ClaudeCodeRuntime, WorkflowRunner } from "@puppetmaster/kernel";
import type { CodingProvider } from "@puppetmaster/shared";
import { CLAUDE_CODE_CATALOG } from "./claude-code-catalog.js";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const RunMode = z.enum(["plan", "execute"]);
const ExecutePermission = z.literal("acceptEdits");
const Provider = z.enum(["anthropic", "openai"]);
const ProviderBackend = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("anthropic"), backend: z.literal("claude") }),
  z.object({ provider: z.literal("openai"), backend: z.literal("aider") }),
]);
const EmptyQuery = z.object({}).strict();
const SessionParams = z.object({ id: z.string().uuid() }).strict();
const SessionListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
const EventListQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  tail: z.enum(["true", "false"]).optional(),
}).strict();
const SessionUpdateInput = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "archived"]).optional(),
}).strict().refine(
  (value) => value.title !== undefined || value.status !== undefined,
  "title or status is required",
);

const RunInput = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  mode: RunMode.default("plan"),
  model: z.string().trim().min(1).max(200).optional(),
  effort: Effort.nullable().optional(),
  permissionMode: ExecutePermission.optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxBudgetUsd: z.number().min(0.01).max(100).nullable().optional(),
  timeoutMs: z.number().int().min(10_000).max(3_600_000).default(900_000),
}).strict();

const NewSessionInput = RunInput.extend({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(120).optional(),
  provider: Provider.default("anthropic"),
}).strict();

interface NormalizedRunInput {
  prompt: string;
  mode: "plan" | "execute";
  model: string;
  effort: z.infer<typeof Effort> | null;
  permissionMode: "plan" | "acceptEdits";
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  timeoutMs: number;
}

interface ProviderConfiguration {
  authenticationConfigured: boolean;
  authenticationError?: string | null;
  networkConfigured: boolean;
  runtimeConfigured: boolean;
  runtimeError?: string | null;
  detectedCliVersion?: string | null;
  networkError?: string | null;
  defaultModel: string;
  modelOptions: string[];
  endpointHost: string | null;
}

function normalizeOpenAiModel(value: string): string {
  const model = value.trim();
  if (!model) throw new Error("OpenAI model must not be empty");
  if (model.length > 200) throw new Error("OpenAI model must not exceed 200 characters");
  if (model.toLowerCase().startsWith("openai/")) {
    const suffix = model.slice("openai/".length).trim();
    if (!suffix) throw new Error("OpenAI model must include a name after openai/");
    return `openai/${suffix}`;
  }
  if (model.includes("/")) {
    throw new Error("OpenAI coding sessions only accept OpenAI models (use openai/<model>)");
  }
  return `openai/${model}`;
}

function normalizeAnthropicModel(value: string): string {
  const model = value.trim();
  if (!model) throw new Error("Anthropic model must not be empty");
  if (model.length > 200) throw new Error("Anthropic model must not exceed 200 characters");
  if (model.toLowerCase().startsWith("openai/")) {
    throw new Error("Anthropic/Claude sessions do not accept OpenAI model identifiers");
  }
  return model;
}

function normalizeProviderModel(provider: CodingProvider, value: string): string {
  return provider === "openai" ? normalizeOpenAiModel(value) : normalizeAnthropicModel(value);
}

function persistedSessionProvider(session: { provider: string; backend: string; model: string }): CodingProvider {
  const parsed = ProviderBackend.safeParse({ provider: session.provider, backend: session.backend });
  if (!parsed.success) {
    throw new Error("Coding session has an invalid provider/backend snapshot");
  }
  const model = normalizeProviderModel(parsed.data.provider, session.model);
  if (model !== session.model) {
    throw new Error("Coding session has a non-canonical model snapshot");
  }
  return parsed.data.provider;
}

function normalizeRunInput(
  provider: CodingProvider,
  input: z.infer<typeof RunInput>,
  defaultModel: string,
): NormalizedRunInput {
  if (provider === "openai" && (input.maxTurns !== undefined || input.maxBudgetUsd !== undefined)) {
    throw new Error("OpenAI/Aider sessions do not support maxTurns or maxBudgetUsd controls");
  }
  const requestedModel = input.model?.trim() || defaultModel;
  return {
    prompt: input.prompt,
    mode: input.mode,
    model: normalizeProviderModel(provider, requestedModel),
    effort: input.effort ?? null,
    permissionMode: input.mode === "plan" ? "plan" : (input.permissionMode ?? "acceptEdits"),
    maxTurns: provider === "anthropic" ? (input.maxTurns ?? 24) : null,
    maxBudgetUsd: provider === "anthropic" ? (input.maxBudgetUsd === undefined ? 5 : input.maxBudgetUsd) : null,
    timeoutMs: input.timeoutMs,
  };
}

function defaultTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0]!.trim().replace(/\s+/g, " ");
  return (line || "Claude Code session").slice(0, 80);
}

function runConfig(provider: CodingProvider, input: NormalizedRunInput) {
  return {
    ...(provider === "anthropic" ? { maxTurns: input.maxTurns, maxBudgetUsd: input.maxBudgetUsd } : {}),
    timeoutMs: input.timeoutMs,
    allowedTools: [],
    disallowedTools: [],
    additionalDirectories: [],
  };
}

async function enqueueClaudeRun(
  deps: { db: Db; runner: WorkflowRunner },
  input: {
    run: Awaited<ReturnType<typeof createClaudeRunMission>>["run"];
    sessionId: string;
    missionId: string;
    beforeEnqueue: () => Promise<void>;
  },
): Promise<void> {
  try {
    await input.beforeEnqueue();
    await deps.runner.enqueue(input.missionId);
  } catch (err) {
    await terminalizeClaudeQueueFailure(deps.db, {
      runId: input.run.id,
      sessionId: input.sessionId,
      missionId: input.missionId,
      error: err,
      expectedStatuses: ["queued"],
    });
    throw err;
  }
}

/** Shared durable queue-failure transition used by create/continue and by the
 * mission retry route. Keeping it here makes the retry handoff independently
 * regression-testable without booting a real Redis queue. */
export async function terminalizeClaudeQueueFailure(
  db: Db,
  input: {
    runId: string;
    sessionId: string;
    missionId: string;
    error: unknown;
    prefix?: string;
    expectedStatuses: readonly ["queued" | "awaiting_approval"];
  },
) {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const finishedAt = new Date();
  const completion = await finishClaudeRun(db, {
    runId: input.runId,
    sessionId: input.sessionId,
    missionId: input.missionId,
    status: "failed",
    result: null,
    error: `${input.prefix ?? "queue handoff failed"}: ${message.slice(0, 1_000)}`,
    finishedAt,
    expectedStatuses: input.expectedStatuses,
  });
  return { completion, finishedAt };
}

export function registerClaudeCodeRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    workspaceId: string;
    runtime: ClaudeCodeRuntime;
    runner: WorkflowRunner;
    providers: Record<CodingProvider, ProviderConfiguration>;
    egressAllow: string[];
  },
): void {
  const { db, workspaceId, runtime, runner } = deps;
  const providerUnavailableReason = (provider: CodingProvider): string | null => {
    const config = deps.providers[provider];
    const label = provider === "anthropic" ? "Claude Code" : "OpenAI/Aider";
    if (!runtime.enabled()) return `${label} sessions require WORKBENCH_MODE=docker`;
    if (!config.authenticationConfigured) {
      if (config.authenticationError) return config.authenticationError;
      return provider === "anthropic"
        ? "Claude Code provider authentication is not configured for the workbench"
        : "OpenAI provider authentication is not configured; set OPENAI_API_KEY in the server environment";
    }
    if (!config.networkConfigured) {
      if (config.networkError) return config.networkError;
      const host = config.endpointHost ? ` (${config.endpointHost})` : "";
      return `${label} requires its model API host${host} in WORKBENCH_EGRESS_ALLOW`;
    }
    if (!config.runtimeConfigured) {
      return config.runtimeError ?? `${label} is unavailable in the configured workbench image`;
    }
    return null;
  };

  const providerRuntime = {
    anthropic: {
      id: "anthropic" as const,
      label: "Anthropic / Claude Code",
      backend: "claude" as const,
      authenticationConfigured: deps.providers.anthropic.authenticationConfigured,
      networkConfigured: deps.providers.anthropic.networkConfigured,
      runtimeConfigured: deps.providers.anthropic.runtimeConfigured,
      detectedCliVersion: deps.providers.anthropic.detectedCliVersion ?? null,
      ready: providerUnavailableReason("anthropic") === null,
      unavailableReason: providerUnavailableReason("anthropic"),
      defaultModel: deps.providers.anthropic.defaultModel,
      modelOptions: deps.providers.anthropic.modelOptions,
      pinnedCliVersion: "2.1.205 (image default)",
      transport: "docker-stream-json",
      capabilities: {
        plan: true,
        execute: true,
        resume: true,
        effort: true,
        maxTurns: true,
        maxBudgetUsd: true,
        structuredEvents: true,
      },
      approvalBoundary:
        "Plan runs use Claude Code's read-only permission mode. Execute runs require one Puppetmaster write approval.",
    },
    openai: {
      id: "openai" as const,
      label: "OpenAI / Aider",
      backend: "aider" as const,
      authenticationConfigured: deps.providers.openai.authenticationConfigured,
      networkConfigured: deps.providers.openai.networkConfigured,
      runtimeConfigured: deps.providers.openai.runtimeConfigured,
      detectedCliVersion: deps.providers.openai.detectedCliVersion ?? null,
      ready: providerUnavailableReason("openai") === null,
      unavailableReason: providerUnavailableReason("openai"),
      defaultModel: deps.providers.openai.defaultModel,
      modelOptions: deps.providers.openai.modelOptions,
      pinnedCliVersion: "0.86.1 (image default)",
      transport: "docker-aider-text",
      capabilities: {
        plan: true,
        execute: true,
        resume: false,
        effort: true,
        maxTurns: false,
        maxBudgetUsd: false,
        structuredEvents: false,
      },
      approvalBoundary:
        "Plan runs use Aider ask mode (no file edits). Execute runs use Aider code mode after one Puppetmaster write approval.",
    },
  };

  app.get("/api/claude-code/catalog", async (req, reply) => {
    const parsed = EmptyQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid catalog query", detail: parsed.error.issues });
    return {
      ...CLAUDE_CODE_CATALOG,
      runtime: {
        workbenchEnabled: runtime.enabled(),
        authenticationConfigured: deps.providers.anthropic.authenticationConfigured,
        egressAllow: deps.egressAllow,
        pinnedCliVersion: "2.1.205 (image default)",
        transport: "docker-stream-json",
        granularToolApprovals: false,
        approvalBoundary:
          "Plan runs are read-only. Execute runs require one Puppetmaster write approval before Claude Code starts.",
        providers: providerRuntime,
      },
    };
  });

  app.get("/api/claude-code/sessions", async (req, reply) => {
    const parsed = SessionListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid session query", detail: parsed.error.issues });
    return listClaudeSessions(db, workspaceId, parsed.data.limit);
  });

  app.get("/api/claude-code/sessions/:id", async (req, reply) => {
    const parsed = EmptyQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid session query", detail: parsed.error.issues });
    const params = SessionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid session id", detail: params.error.issues });
    const { id } = params.data;
    const session = await getClaudeSessionInWorkspace(db, workspaceId, id);
    if (!session) return reply.code(404).send({ error: "Claude session not found" });
    return { session, runs: await listClaudeRuns(db, session.id) };
  });

  app.get("/api/claude-code/sessions/:id/events", async (req, reply) => {
    const parsed = EventListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid event query", detail: parsed.error.issues });
    const params = SessionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid session id", detail: params.error.issues });
    const { id } = params.data;
    const session = await getClaudeSessionInWorkspace(db, workspaceId, id);
    if (!session) return reply.code(404).send({ error: "Claude session not found" });
    const query = parsed.data;
    return listClaudeEvents(db, session.id, {
      after: query.after,
      before: query.before,
      limit: query.limit,
      tail: query.tail === "true",
    });
  });

  app.get("/api/claude-code/sessions/:id/workbench", async (req, reply) => {
    const parsed = EmptyQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid workbench query", detail: parsed.error.issues });
    const params = SessionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid session id", detail: params.error.issues });
    const { id } = params.data;
    const session = await getClaudeSessionInWorkspace(db, workspaceId, id);
    if (!session) return reply.code(404).send({ error: "Claude session not found" });
    try {
      return await runtime.inspectWorkbench(session.projectId);
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : "workbench unavailable" });
    }
  });

  app.put("/api/claude-code/sessions/:id", async (req, reply) => {
    const query = EmptyQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid session query", detail: query.error.issues });
    const params = SessionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid session id", detail: params.error.issues });
    const parsed = SessionUpdateInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid session update", detail: parsed.error.issues });
    const { id } = params.data;
    const session = await getClaudeSessionInWorkspace(db, workspaceId, id);
    if (!session) return reply.code(404).send({ error: "Claude session not found" });
    return updateClaudeSession(db, id, parsed.data);
  });

  app.post("/api/claude-code/sessions", async (req, reply) => {
    const query = EmptyQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid session query", detail: query.error.issues });
    const parsed = NewSessionInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid coding session", detail: parsed.error.issues });
    const request = parsed.data;
    const provider = request.provider;
    const unavailable = providerUnavailableReason(provider);
    if (unavailable) return reply.code(503).send({ error: unavailable });
    let input: NormalizedRunInput;
    try {
      input = normalizeRunInput(provider, request, deps.providers[provider].defaultModel);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid provider configuration" });
    }
    const project = await getProject(db, request.projectId);
    if (!project || project.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: "project not found" });
    }
    const session = await createClaudeSession(db, {
      workspaceId,
      projectId: project.id,
      title: request.title ?? defaultTitle(input.prompt),
      provider,
      backend: provider === "anthropic" ? "claude" : "aider",
      model: input.model,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode,
      config: {},
    });
    let created;
    try {
      created = await createClaudeRunMission(db, {
        sessionId: session.id,
        mode: input.mode,
        prompt: input.prompt,
        model: input.model,
        effort: input.effort ?? null,
        permissionMode: input.permissionMode,
        config: runConfig(provider, input),
        actorId: req.authUser?.id ?? null,
      });
    } catch (err) {
      await deleteEmptyClaudeSession(db, session.id);
      if (err instanceof ClaudeSessionBusyError) {
        return reply.code(409).send({ error: "another turn is already queued or running" });
      }
      throw err;
    }
    const { run, mission } = created;
    try {
      await enqueueClaudeRun(
        { db, runner },
        {
          run,
          sessionId: session.id,
          missionId: mission.id,
          beforeEnqueue: () => appendAudit(db, {
            workspaceId,
            actorKind: "user",
            actorId: req.authUser?.id ?? null,
            actorLabel: req.authUser?.email ?? "unknown",
            missionId: mission.id,
            action: provider === "anthropic" ? "claude.session.create" : "openai.session.create",
            target: session.id,
            detail: { projectId: project.id, runId: run.id, provider, backend: session.backend, model: run.model, mode: run.mode },
          }).then(() => undefined),
        },
      );
    } catch {
      return reply.code(503).send({
        error: "Coding run could not be queued; the mission was marked failed and can be retried",
        sessionId: session.id,
        runId: run.id,
        missionId: mission.id,
      });
    }
    return reply.code(202).send({ session, run, missionId: mission.id });
  });

  app.post("/api/claude-code/sessions/:id/messages", async (req, reply) => {
    const query = EmptyQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid session query", detail: query.error.issues });
    const params = SessionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid session id", detail: params.error.issues });
    const parsed = RunInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid coding turn", detail: parsed.error.issues });
    const { id } = params.data;
    const session = await getClaudeSessionInWorkspace(db, workspaceId, id);
    if (!session) return reply.code(404).send({ error: "Claude session not found" });
    let provider: CodingProvider;
    try {
      provider = persistedSessionProvider(session);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : "invalid coding session snapshot",
      });
    }
    const unavailable = providerUnavailableReason(provider);
    if (unavailable) return reply.code(503).send({ error: unavailable });
    if (session.status !== "active") return reply.code(409).send({ error: "Claude session is archived" });
    if (await hasActiveClaudeRun(db, session.id)) {
      return reply.code(409).send({ error: "another turn is already queued or running" });
    }
    let input: NormalizedRunInput;
    try {
      input = normalizeRunInput(provider, {
        ...parsed.data,
        model: parsed.data.model ?? session.model,
        effort: parsed.data.effort === undefined
          ? session.effort as z.infer<typeof Effort> | null
          : parsed.data.effort,
      }, deps.providers[provider].defaultModel);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid provider configuration" });
    }
    let created;
    try {
      created = await createClaudeRunMission(db, {
        sessionId: session.id,
        mode: input.mode,
        prompt: input.prompt,
        model: input.model,
        effort: input.effort ?? null,
        permissionMode: input.permissionMode,
        config: runConfig(provider, input),
        actorId: req.authUser?.id ?? null,
      });
    } catch (err) {
      if (err instanceof ClaudeSessionBusyError) {
        return reply.code(409).send({ error: "another turn is already queued or running" });
      }
      throw err;
    }
    const { run, mission } = created;
    try {
      await enqueueClaudeRun(
        { db, runner },
        {
          run,
          sessionId: session.id,
          missionId: mission.id,
          beforeEnqueue: () => appendAudit(db, {
            workspaceId,
            actorKind: "user",
            actorId: req.authUser?.id ?? null,
            actorLabel: req.authUser?.email ?? "unknown",
            missionId: mission.id,
            action: provider === "anthropic" ? "claude.turn.create" : "openai.turn.create",
            target: session.id,
            detail: { runId: run.id, turnNumber: run.turnNumber, provider, backend: session.backend, model: run.model, mode: run.mode },
          }).then(() => undefined),
        },
      );
    } catch {
      return reply.code(503).send({
        error: "Coding run could not be queued; the mission was marked failed and can be retried",
        sessionId: session.id,
        runId: run.id,
        missionId: mission.id,
      });
    }
    return reply.code(202).send({ session, run, missionId: mission.id });
  });
}
