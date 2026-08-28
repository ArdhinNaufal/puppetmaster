import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema for the M1 persistence layer (ARCHITECTURE.md §4). The DDL is
 * applied idempotently by `migrate()` so the same schema runs on both the
 * node-postgres (production, pgvector image) and PGlite (local/desktop) drivers.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** scrypt hash, `salthex:hashhex` (see apps/server auth). */
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Opaque bearer sessions; the token travels in an HttpOnly cookie. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** White-label branding: { brandName?, accent? } (DESIGN-LANGUAGE.md §6). */
  branding: jsonb("branding").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** User ↔ workspace with a role: owner | admin | builder | member (PRD). */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqMember: unique().on(t.userId, t.workspaceId) }),
);

/** Per-user, per-workspace UI state: panel layouts, theme, default view. */
export const uiPreferences = pgTable(
  "ui_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    layout: jsonb("layout").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqPrefs: unique().on(t.userId, t.workspaceId) }),
);

/** Default-deny, persisted admission for the opt-in Science pilot. */
export const scienceWorkspaceAdmissions = pgTable(
  "science_workspace_admissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    admitted: boolean("admitted").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqWorkspace: unique("science_workspace_admissions_workspace_unique").on(t.workspaceId),
  }),
);


export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  /** HMAC secret for signed webhook triggers; set when the graph has a webhook
   *  trigger node (see /api/hooks/:id enforcement). Null = unsigned/open. */
  webhookSecret: text("webhook_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** { nodes, edges } — validated against WorkflowGraph in @puppetmaster/shared. */
    graph: jsonb("graph").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqVersion: unique().on(t.workflowId, t.version) }),
);

export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // "workflow" | "agent"
  subjectId: uuid("subject_id").notNull(), // workflow id (or agent id in M2)
  workflowVersionId: uuid("workflow_version_id").references(() => workflowVersions.id, {
    onDelete: "set null",
  }),
  parentMissionId: uuid("parent_mission_id"),
  status: text("status").notNull().default("queued"),
  trigger: jsonb("trigger"),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  /** Resume cursor: map of completed nodeId -> output, so approval gates resume. */
  cursor: jsonb("cursor"),
  /** Cooperative cancellation (Stage 2): checked between nodes/iterations. */
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  /** Times this mission has been re-enqueued after failing (dead-letter signal). */
  retryCount: integer("retry_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionSteps = pgTable("mission_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(0),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  prompt: text("prompt").notNull(),
  tier: text("tier").notNull().default("write_approved"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  persona: text("persona").notNull().default(""),
  model: text("model").notNull(),
  autonomy: text("autonomy").notNull().default("write_approved"),
  toolGrants: jsonb("tool_grants").notNull().default([]),
  schedule: text("schedule"),
  /** Structured scratchpad the agent maintains across ticks (ARCHITECTURE.md §3.1). */
  scratchpad: jsonb("scratchpad").notNull().default({}),
  /** Stage 9C opt-in: large tool results are compacted before entering this
   *  agent's context (raw output always stays in the mission step). */
  contextCompaction: boolean("context_compaction").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentMessages = pgTable("agent_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id"),
  role: text("role").notNull(), // "user" | "assistant" | "tool"
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Long-term memory; `embedding` is filled when an embedding provider is
 *  configured (pgvector), otherwise recall falls back to keyword search.
 *  Memory v2 (Stage 4): tiered kinds — `fact` (agent-saved), `episodic`
 *  (auto mission summaries, linked via missionId), `procedural` (tool
 *  sequences that worked, LEGOMem-style) — with admission control
 *  (dedup-merge at save), importance scoring, decay-based eviction under a
 *  per-agent cap, and pinning (pinned memories are never evicted). */
export const agentMemories = pgTable("agent_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  kind: text("kind").notNull().default("fact"),
  missionId: uuid("mission_id"),
  importance: real("importance").notNull().default(0.5),
  pinned: boolean("pinned").notNull().default(false),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Shareable agent + workflow templates (PRD §6 marketplace). First-party
 *  templates are seeded on boot with `builtin=true`; users publish their own
 *  from an existing workflow/agent. `spec` is the kind-specific payload:
 *  a WorkflowGraph for kind="workflow", an agent definition for kind="agent". */
export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** null = global/first-party catalog; set = published within a workspace. */
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // "workflow" | "agent"
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("general"),
  spec: jsonb("spec").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit trail (ARCHITECTURE.md §3.6): every LLM call, tool call,
 *  and approval decision, plus auth/member actions. Never updated or deleted. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** "user" | "agent" | "system" — who/what took the action. */
  actorKind: text("actor_kind").notNull().default("system"),
  /** user id, agent id, or a label like "system"; nullable for anonymous. */
  actorId: text("actor_id"),
  actorLabel: text("actor_label"),
  missionId: uuid("mission_id"),
  /** dotted verb, e.g. "llm.call", "tool.call", "approval.decision", "member.role". */
  action: text("action").notNull(),
  target: text("target"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Knowledge base documents (Stage 3, G5 / PRD use-case 4). Raw content is
 *  kept for `kb.read`; retrieval happens over `document_chunks`. */
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Original filename or origin label. */
  source: text("source").notNull().default(""),
  mime: text("mime").notNull().default("text/markdown"),
  content: text("content").notNull(),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Heading-aware chunks with pgvector embeddings (added via ALTER, like
 *  agent_memories). Hybrid retrieval = Postgres full-text + cosine, fused
 *  by reciprocal rank (§1.6). `heading` is the breadcrumb ("A › B"). */
export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  heading: text("heading").notNull().default(""),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Idempotency ledger for side-effectful node executions (Stage 2, G4).
 *  A row is written *before* the tool call and committed with the output
 *  after it; a retried mission reuses any committed output for a node
 *  instead of re-executing the side effect (at-most-once for committed
 *  work, at-least-once for work that died mid-call). */
export const nodeExecutions = pgTable("node_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  attempt: integer("attempt").notNull().default(0),
  /** `missionId:nodeId:attempt` (or an explicit key, e.g. per approval). */
  key: text("key").notNull().unique(),
  output: jsonb("output"),
  committed: boolean("committed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Encrypted-at-rest secrets (ARCHITECTURE §4, Stage 1). `encrypted` is an
 *  AES-256-GCM envelope (`v1:iv:tag:ciphertext`, hex) sealed with
 *  PUPPETMASTER_MASTER_KEY; plaintext is never stored and never returned by
 *  the API after write. Referenced from MCP server env as `{{credential:NAME}}`. */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    encrypted: text("encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqName: unique().on(t.workspaceId, t.name) }),
);

/** Hash pins for MCP tool descriptions (Stage 1 injection defense): the
 *  sha-256 of each tool's description+schema is recorded at first connect;
 *  a changed hash on a later connect is surfaced + audited as description
 *  drift (tool-poisoning canary) before the pin is updated. */
export const mcpToolPins = pgTable(
  "mcp_tool_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    server: text("server").notNull(),
    tool: text("tool").notNull(),
    hash: text("hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqTool: unique().on(t.server, t.tool) }),
);

/** Approval auto-allow policies (Stage 1, PRD §4 refinement): a gated tool
 *  call matching a policy (tool pattern + every arg predicate) is executed
 *  without pausing and audited as `approval.auto`. agentId null = whole
 *  workspace. Predicates: [{ path, op, value }] evaluated against call args. */
export const approvalPolicies = pgTable("approval_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  /** `server.tool` or `server.*`. */
  tool: text("tool").notNull(),
  predicates: jsonb("predicates").notNull().default([]),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Router profiles (Stage 9A, 9ROUTER-ADOPTION.md): named workspace-level
 *  fallback chains — `model: "profile:NAME"` resolves to the ordered
 *  candidates at call time. Each candidate carries a cost class
 *  (premium|cheap|local|free); `minClassForGatedTools` is the floor below
 *  which an agent holding write/destructive tools never silently downgrades
 *  (the tick gates on an approval instead). */
export const routerProfiles = pgTable(
  "router_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Ordered [{ model, costClass }] tried first-to-last. */
    candidates: jsonb("candidates").notNull().default([]),
    minClassForGatedTools: text("min_class_for_gated_tools"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqName: unique().on(t.workspaceId, t.name) }),
);

/** Eval harness results (Stage 5, G7): one row per suite run — per-task
 *  pass^k outcomes and trajectory verdicts, shown in the EVALS view. */
export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  suite: text("suite").notNull().default("golden"),
  k: integer("k").notNull().default(3),
  passed: integer("passed").notNull().default(0),
  total: integer("total").notNull().default(0),
  /** Per-task detail: [{ id, passes: bool[], passK, trajectoryOk, notes }]. */
  results: jsonb("results").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cost ledger (Stage 5, G8): one row per LLM call, aggregated into monthly
 *  workspace/agent usage for the budgets below. */
export const usageLedger = pgTable("usage_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id"),
  missionId: uuid("mission_id"),
  model: text("model").notNull().default(""),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Monthly token budgets; agentId null = whole workspace. When month-to-date
 *  usage exceeds the limit, new agent ticks gate behind an approval. */
export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  monthlyTokenLimit: integer("monthly_token_limit").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Workspace-persisted MCP server configs (Stage 7, G10): stdio commands or
 *  streamable-HTTP endpoints, added from the Tools view / MCP registry (not
 *  env). `headers`/`env` values may reference the vault as
 *  `{{credential:NAME}}` — resolved at connect, never stored resolved. */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** "stdio" | "http" (streamable HTTP). */
    transport: text("transport").notNull().default("http"),
    url: text("url"),
    command: text("command"),
    args: jsonb("args").notNull().default([]),
    env: jsonb("env").notNull().default({}),
    headers: jsonb("headers").notNull().default({}),
    tier: text("tier").notNull().default("read_auto"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqName: unique().on(t.workspaceId, t.name) }),
);

/** Workshop projects (AI-SDLC plan WP2, ADR-003): a repo plus its artifact
 *  set; phase executions are ordinary missions carrying the project id. */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  repoRef: text("repo_ref").notNull().default(""),
  mode: text("mode").notNull().default("supervised"),
  phase: text("phase").notNull().default("idle"),
  status: text("status").notNull().default("active"),
  workbenchId: text("workbench_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Typed artifact store (ADR-004). Lifecycle rules live in project-repo.ts:
 *  learnings append-only, accepted ADRs immutable (supersede only), todo
 *  completion requires the completing mission id, spec/plan changes are new
 *  versions chained via supersedes_id. */
export const projectArtifacts = pgTable("project_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // spec | plan | todo | learning | adr
  status: text("status"), // TodoStatus for todos, AdrStatus for ADRs, else null
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  version: integer("version").notNull().default(1),
  supersedesId: uuid("supersedes_id"),
  missionId: uuid("mission_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set on every legal mutation (todo transitions, ADR acceptance) — the
   *  todo-sync check compares this against the latest spec's createdAt. */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Deterministic checks for a project's verify nodes (WP4). Earned policies:
 *  disabled by default; `baseline` is the legacy-ratchet violation count. */
export const verifyChecks = pgTable("verify_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // test | arch | refactor-gate | todo-sync | load | custom
  command: text("command"),
  baseline: integer("baseline"),
  enabled: boolean("enabled").notNull().default(false),
  earnedNote: text("earned_note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Durable Claude Code conversation. Claude's own session id is recorded after
 *  the first init event; Puppetmaster owns the workspace/project boundary. */
export const claudeSessions = pgTable(
  "claude_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("anthropic"),
    backend: text("backend").notNull().default("claude"),
    title: text("title").notNull(),
    claudeSessionId: text("claude_session_id"),
    status: text("status").notNull().default("active"),
    model: text("model").notNull(),
    effort: text("effort"),
    permissionMode: text("permission_mode").notNull().default("plan"),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerBackend: check(
      "claude_sessions_provider_backend_check",
      sql`(${t.provider} = 'anthropic' AND ${t.backend} = 'claude') OR (${t.provider} = 'openai' AND ${t.backend} = 'aider')`,
    ),
    providerModel: check(
      "claude_sessions_provider_model_check",
      sql`length(btrim(${t.model})) BETWEEN 1 AND 200 AND ((${t.provider} = 'anthropic' AND lower(${t.model}) NOT LIKE 'openai/%') OR (${t.provider} = 'openai' AND ${t.model} LIKE 'openai/%' AND length(btrim(substr(${t.model}, 8))) > 0))`,
    ),
    canonicalModel: check(
      "claude_sessions_model_canonical_check",
      sql`${t.model} = btrim(${t.model}) AND (${t.provider} <> 'openai' OR ${t.model} = 'openai/' || btrim(substr(${t.model}, 8)))`,
    ),
  }),
);

/** One user prompt / Claude response. Each turn is also a Puppetmaster mission
 *  so approvals, cancellation, audit, and observability remain shared. */
export const claudeRuns = pgTable(
  "claude_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => claudeSessions.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" })
      .unique(),
    provider: text("provider").notNull().default("anthropic"),
    backend: text("backend").notNull().default("claude"),
    turnNumber: integer("turn_number").notNull(),
    mode: text("mode").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("queued"),
    /** Monotonic claim generation. A worker may commit terminal state only for
     *  the exact generation returned by its queued -> running transition. */
    executionGeneration: integer("execution_generation").notNull().default(0),
    model: text("model").notNull(),
    effort: text("effort"),
    permissionMode: text("permission_mode").notNull(),
    config: jsonb("config").notNull().default({}),
    result: jsonb("result"),
    resultText: text("result_text"),
    isError: boolean("is_error"),
    usage: jsonb("usage"),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms"),
    durationApiMs: integer("duration_api_ms"),
    numTurns: integer("num_turns"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTurn: unique("claude_runs_session_turn_unique").on(t.sessionId, t.turnNumber),
    providerBackend: check(
      "claude_runs_provider_backend_check",
      sql`(${t.provider} = 'anthropic' AND ${t.backend} = 'claude') OR (${t.provider} = 'openai' AND ${t.backend} = 'aider')`,
    ),
    providerModel: check(
      "claude_runs_provider_model_check",
      sql`length(btrim(${t.model})) BETWEEN 1 AND 200 AND ((${t.provider} = 'anthropic' AND lower(${t.model}) NOT LIKE 'openai/%') OR (${t.provider} = 'openai' AND ${t.model} LIKE 'openai/%' AND length(btrim(substr(${t.model}, 8))) > 0))`,
    ),
    canonicalModel: check(
      "claude_runs_model_canonical_check",
      sql`${t.model} = btrim(${t.model}) AND (${t.provider} <> 'openai' OR ${t.model} = 'openai/' || btrim(substr(${t.model}, 8)))`,
    ),
    nonnegativeExecutionGeneration: check(
      "claude_runs_execution_generation_check",
      sql`${t.executionGeneration} >= 0`,
    ),
  }),
);

/** Crash-recovery ledger for copying a disposable workbench execution back to
 *  its durable project volume. The execution identity is deliberately stored
 *  in full (a lowercase SHA-256 digest), and every row belongs to one exact
 *  Claude run claim generation. Runtime code advances this journal only via
 *  the guarded repository helpers in workbench-copyback-repo.ts. */
export const workbenchCopybacks = pgTable(
  "workbench_copybacks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    claudeRunId: uuid("claude_run_id")
      .notNull()
      .references(() => claudeRuns.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    executionIdentitySha256: text("execution_identity_sha256").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    state: text("state").notNull().default("intent"),
    /** Pre-mutation project snapshot used to prove or perform rollback. */
    baseline: jsonb("baseline").notNull(),
    /** Prepared post-execution snapshot. It is durable before files mutate. */
    candidate: jsonb("candidate"),
    /** Authenticated filesystem-commit/rollback acknowledgement. */
    receipt: jsonb("receipt"),
    /** Terminal Claude result retained until the DB commit can be reconciled. */
    pendingCompletion: jsonb("pending_completion"),
    error: text("error"),
    filesCommittedAt: timestamp("files_committed_at", { withTimezone: true }),
    dbCommittedAt: timestamp("db_committed_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqRunGeneration: unique("workbench_copybacks_run_generation_unique").on(
      t.claudeRunId,
      t.executionGeneration,
    ),
    uniqExecutionId: unique("workbench_copybacks_execution_id_unique").on(t.executionId),
    uniqExecutionIdentity: unique("workbench_copybacks_execution_identity_unique").on(
      t.executionIdentitySha256,
    ),
    validState: check(
      "workbench_copybacks_state_check",
      sql`${t.state} IN ('intent', 'files_committed', 'db_committed', 'rolled_back', 'quarantined', 'cleaned')`,
    ),
    positiveGeneration: check(
      "workbench_copybacks_execution_generation_check",
      sql`${t.executionGeneration} > 0`,
    ),
    fullExecutionIdentity: check(
      "workbench_copybacks_execution_identity_check",
      sql`${t.executionIdentitySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    canonicalExecutionId: check(
      "workbench_copybacks_execution_id_check",
      sql`${t.executionId} = btrim(${t.executionId}) AND length(${t.executionId}) BETWEEN 1 AND 300`,
    ),
  }),
);

  /** Bounded line-oriented Claude process event log. `payload` is a decoded
   *  best effort while `raw` preserves inspectable malformed/future records. */
export const claudeEvents = pgTable(
  "claude_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => claudeSessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => claudeRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    eventType: text("event_type").notNull(),
    raw: text("raw").notNull().default(""),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqSequence: unique("claude_events_session_sequence_unique").on(t.sessionId, t.sequence) }),
);

/** Project-scoped traceability graph. Endpoints are polymorphic references to
 *  either project_artifacts or verify_checks, so repository validation (rather
 *  than a cross-table foreign key) enforces endpoint ownership. */
export const projectTraceLinks = pgTable(
  "project_trace_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // artifact | check
    sourceId: uuid("source_id").notNull(),
    targetType: text("target_type").notNull(), // artifact | check
    targetId: uuid("target_id").notNull(),
    relation: text("relation").notNull(), // informs | derives | verifies | mitigates
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTrace: unique("project_trace_links_unique").on(
      t.projectId,
      t.sourceType,
      t.sourceId,
      t.targetType,
      t.targetId,
      t.relation,
    ),
  }),
);

/** Machine-checkable evidence attached to verify steps / approvals (org
 *  layer §1: the gate reviews evidence, not assertions). Written by WP4. */
export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  stepId: uuid("step_id").references(() => missionSteps.id, { onDelete: "cascade" }),
  approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // test-output | diff | screenshot | state-assert
  content: jsonb("content"),
  ref: text("ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Science Operations (scientific subsystem WP1) -----------------------------

export const scienceStudies = pgTable(
  "science_studies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active"),
    /** MVP admits non-regulated research data only. */
    classification: text("classification").notNull().default("non_regulated"),
    workshopProjectId: uuid("workshop_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("science_studies_workspace_idx").on(t.workspaceId, t.createdAt),
    validStatus: check("science_studies_status_check", sql`${t.status} IN ('active', 'archived')`),
    validClassification: check(
      "science_studies_classification_check",
      sql`${t.classification} = 'non_regulated'`,
    ),
  }),
);

export const scienceArtifacts = pgTable(
  "science_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => scienceStudies.id, { onDelete: "cascade" }),
    logicalName: text("logical_name").notNull(),
    kind: text("kind").notNull(),
    format: text("format").notNull(),
    status: text("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqLogicalName: unique("science_artifacts_study_logical_name_unique").on(
      t.studyId,
      t.logicalName,
    ),
    studyIdx: index("science_artifacts_study_idx").on(t.studyId, t.createdAt),
    validStatus: check("science_artifacts_status_check", sql`${t.status} IN ('active', 'archived')`),
    validKind: check(
      "science_artifacts_kind_check",
      sql`${t.kind} IN ('dataset', 'notebook', 'geometry', 'result', 'log', 'manifest', 'environment', 'other')`,
    ),
  }),
);

export const scienceArtifactVersions = pgTable(
  "science_artifact_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => scienceArtifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("pending"),
    storageKey: text("storage_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    /** Internal retention fence; cleared atomically when a version becomes ready. */
    cleanupEligible: boolean("cleanup_eligible").notNull().default(false),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    cleanupNotBefore: timestamp("cleanup_not_before", { withTimezone: true }),
    /** Repository validation keeps a parent inside the same logical artifact. */
    parentVersionId: uuid("parent_version_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => ({
    uniqVersion: unique("science_artifact_versions_artifact_version_unique").on(
      t.artifactId,
      t.version,
    ),
    uniqChecksum: unique("science_artifact_versions_artifact_checksum_unique").on(
      t.artifactId,
      t.sha256,
    ),
    artifactIdx: index("science_artifact_versions_artifact_idx").on(t.artifactId, t.version),
    validVersion: check("science_artifact_versions_version_check", sql`${t.version} > 0`),
    validSize: check("science_artifact_versions_size_check", sql`${t.sizeBytes} >= 0`),
    validSha: check(
      "science_artifact_versions_sha256_check",
      sql`${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    validStatus: check(
      "science_artifact_versions_status_check",
      sql`${t.status} IN ('pending', 'ready', 'quarantined', 'expired')`,
    ),
  }),
);

/** Durable upload intent and lease. Raw upload tokens are never persisted. */
export const scienceUploads = pgTable(
  "science_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => scienceArtifacts.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id").references(() => scienceArtifactVersions.id, {
      onDelete: "restrict",
    }),
    tokenHash: text("token_hash").notNull().unique(),
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    expectedSha256: text("expected_sha256").notNull(),
    quarantineKey: text("quarantine_key").notNull().unique(),
    receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
    state: text("state").notNull().default("pending"),
    error: text("error"),
    transferLeaseId: uuid("transfer_lease_id"),
    transferLeaseExpiresAt: timestamp("transfer_lease_expires_at", { withTimezone: true }),
    externalTransfer: boolean("external_transfer").notNull().default(false),
    finalizationLeaseId: uuid("finalization_lease_id"),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    cleanupNotBefore: timestamp("cleanup_not_before", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceStateIdx: index("science_uploads_workspace_state_idx").on(
      t.workspaceId,
      t.state,
      t.expiresAt,
    ),
    artifactIdx: index("science_uploads_artifact_idx").on(t.artifactId, t.createdAt),
    externalTransferIdx: index("science_uploads_external_transfer_idx").on(
      t.workspaceId,
      t.externalTransfer,
      t.state,
      t.transferLeaseExpiresAt,
    ),
    validSize: check(
      "science_uploads_size_check",
      sql`${t.expectedSizeBytes} >= 0 AND ${t.receivedBytes} >= 0 AND ${t.receivedBytes} <= ${t.expectedSizeBytes}`,
    ),
    validTokenHash: check(
      "science_uploads_token_hash_check",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validExpectedSha: check(
      "science_uploads_expected_sha256_check",
      sql`${t.expectedSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    validState: check(
      "science_uploads_state_check",
      sql`${t.state} IN ('pending', 'uploading', 'finalizing', 'completed', 'quarantined', 'expired')`,
    ),
  }),
);

export const scienceComputeProfiles = pgTable(
  "science_compute_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    providerKind: text("provider_kind").notNull(),
    imageDigest: text("image_digest").notNull(),
    kernelName: text("kernel_name").notNull(),
    resourceBounds: jsonb("resource_bounds").notNull(),
    config: jsonb("config").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqName: unique("science_compute_profiles_workspace_name_unique").on(t.workspaceId, t.name),
    workspaceIdx: index("science_compute_profiles_workspace_idx").on(t.workspaceId, t.createdAt),
    validProvider: check(
      "science_compute_profiles_provider_check",
      sql`${t.providerKind} IN ('local_container', 'jupyter_enterprise_gateway')`,
    ),
    immutableDigest: check(
      "science_compute_profiles_image_digest_check",
      sql`${t.imageDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

export const scienceRuns = pgTable(
  "science_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => scienceStudies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "restrict" })
      .unique(),
    computeProfileId: uuid("compute_profile_id")
      .notNull()
      .references(() => scienceComputeProfiles.id, { onDelete: "restrict" }),
    profileSnapshot: jsonb("profile_snapshot").notNull(),
    resourceRequest: jsonb("resource_request").notNull(),
    providerHandle: text("provider_handle"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    state: text("state").notNull().default("draft"),
    executionGeneration: integer("execution_generation").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    parameters: jsonb("parameters").notNull().default({}),
    manifest: jsonb("manifest"),
    manifestHash: text("manifest_hash"),
    error: text("error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    uniqIdempotency: unique("science_runs_study_idempotency_unique").on(
      t.studyId,
      t.idempotencyKey,
    ),
    studyStateIdx: index("science_runs_study_state_idx").on(t.studyId, t.state, t.createdAt),
    validState: check(
      "science_runs_state_check",
      sql`${t.state} IN ('draft', 'awaiting_approval', 'queued', 'provisioning', 'running', 'finalizing', 'cancelling', 'succeeded', 'failed', 'cancelled')`,
    ),
    nonnegativeGeneration: check(
      "science_runs_generation_check",
      sql`${t.executionGeneration} >= 0`,
    ),
    validManifestHash: check(
      "science_runs_manifest_hash_check",
      sql`${t.manifestHash} IS NULL OR ${t.manifestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validLease: check(
      "science_runs_lease_check",
      sql`(${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL AND ${t.heartbeatAt} IS NULL)
        OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * Durable workflow suspension on one exact asynchronous Science run. The
 * Science lifecycle marks pending rows ready in the same transaction as the
 * terminal run state; queue delivery is only a recoverable notification.
 */
export const workflowWaits = pgTable(
  "workflow_waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    kind: text("kind").notNull(),
    targetRunId: uuid("target_run_id")
      .notNull()
      .references(() => scienceRuns.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("pending"),
    generation: integer("generation").notNull().default(0),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqMissionNode: unique("workflow_waits_mission_node_unique").on(t.missionId, t.nodeId),
    targetStateIdx: index("workflow_waits_target_state_idx").on(t.targetRunId, t.state),
    recoveryIdx: index("workflow_waits_recovery_idx").on(t.state, t.claimExpiresAt, t.updatedAt),
    validKind: check(
      "workflow_waits_kind_check",
      sql`${t.kind} = 'science_run_terminal'`,
    ),
    validState: check(
      "workflow_waits_state_check",
      sql`${t.state} IN ('pending', 'ready', 'claimed', 'consumed', 'cancelled')`,
    ),
    nonnegativeGeneration: check(
      "workflow_waits_generation_check",
      sql`${t.generation} >= 0`,
    ),
    pairedClaim: check(
      "workflow_waits_claim_check",
      sql`(${t.state} = 'claimed' AND ${t.claimToken} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL)
        OR (${t.state} <> 'claimed' AND ${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL)`,
    ),
  }),
);

/**
 * Append-only human/domain review evidence. The database migration installs a
 * mutation-rejection trigger; this declaration intentionally exposes no
 * mutable lifecycle fields.
 */
export const scienceDomainValidations = pgTable(
  "science_domain_validations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => scienceRuns.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    baselineRunId: uuid("baseline_run_id")
      .references(() => scienceRuns.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    metric: text("metric").notNull(),
    tolerance: doublePrecision("tolerance").notNull(),
    observedValue: doublePrecision("observed_value").notNull(),
    units: text("units").notNull(),
    methodProtocolId: text("method_protocol_id").notNull(),
    decision: boolean("decision").notNull(),
    limitationsReason: text("limitations_reason").notNull(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewerRole: text("reviewer_role").notNull(),
    runManifestHash: text("run_manifest_hash").notNull(),
    runOutputChecksums: jsonb("run_output_checksums").notNull(),
    baselineManifestHash: text("baseline_manifest_hash"),
    baselineOutputChecksums: jsonb("baseline_output_checksums"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    recordHash: text("record_hash").notNull().unique(),
  },
  (t) => ({
    uniqRunRevision: unique("science_domain_validations_run_revision_unique").on(
      t.runId,
      t.revision,
    ),
    runRevisionIdx: index("science_domain_validations_run_revision_idx").on(
      t.runId,
      t.revision,
    ),
    comparisonIdx: index("science_domain_validations_comparison_idx").on(
      t.runId,
      t.baselineRunId,
      t.kind,
      t.revision,
    ),
    validRevision: check(
      "science_domain_validations_revision_check",
      sql`${t.revision} > 0`,
    ),
    validKind: check(
      "science_domain_validations_kind_check",
      sql`${t.kind} IN ('domain-validation', 'numerical-equivalence')`,
    ),
    validMetric: check(
      "science_domain_validations_metric_check",
      sql`char_length(btrim(${t.metric})) BETWEEN 1 AND 200`,
    ),
    validTolerance: check(
      "science_domain_validations_tolerance_check",
      sql`${t.tolerance} >= 0 AND ${t.tolerance} < 'Infinity'::double precision`,
    ),
    validObserved: check(
      "science_domain_validations_observed_check",
      sql`${t.observedValue} > '-Infinity'::double precision
          AND ${t.observedValue} < 'Infinity'::double precision`,
    ),
    validUnits: check(
      "science_domain_validations_units_check",
      sql`char_length(btrim(${t.units})) BETWEEN 1 AND 100`,
    ),
    validProtocol: check(
      "science_domain_validations_protocol_check",
      sql`char_length(btrim(${t.methodProtocolId})) BETWEEN 1 AND 300`,
    ),
    validLimitations: check(
      "science_domain_validations_limitations_check",
      sql`char_length(btrim(${t.limitationsReason})) BETWEEN 1 AND 2000`,
    ),
    validReviewerRole: check(
      "science_domain_validations_reviewer_role_check",
      sql`${t.reviewerRole} IN ('admin', 'owner')`,
    ),
    validRunHash: check(
      "science_domain_validations_run_manifest_hash_check",
      sql`${t.runManifestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validRecordHash: check(
      "science_domain_validations_record_hash_check",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validOutputChecksums: check(
      "science_domain_validations_outputs_check",
      sql`jsonb_typeof(${t.runOutputChecksums}) = 'array'
          AND jsonb_array_length(${t.runOutputChecksums}) > 0`,
    ),
    validBaseline: check(
      "science_domain_validations_baseline_check",
      sql`(
        ${t.kind} = 'domain-validation'
        AND ${t.baselineRunId} IS NULL
        AND ${t.baselineManifestHash} IS NULL
        AND ${t.baselineOutputChecksums} IS NULL
      ) OR (
        ${t.kind} = 'numerical-equivalence'
        AND ${t.baselineRunId} IS NOT NULL
        AND ${t.baselineRunId} <> ${t.runId}
        AND ${t.baselineManifestHash} ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(${t.baselineOutputChecksums}) = 'array'
        AND jsonb_array_length(${t.baselineOutputChecksums}) > 0
      )`,
    ),
  }),
);

/**
 * Mutable, actor-audited pointer to the authoritative latest validation for
 * one exact canonical scope. Domain-only reviews use the candidate run itself
 * as `scopeBaselineRunId`; numerical reviews use their distinct baseline run.
 * The database guard permits only monotonic pointer advancement.
 */
export const scienceDomainValidationHeads = pgTable(
  "science_domain_validation_heads",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => scienceRuns.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    scopeBaselineRunId: uuid("scope_baseline_run_id")
      .notNull()
      .references(() => scienceRuns.id, { onDelete: "restrict" }),
    validationId: uuid("validation_id")
      .notNull()
      .unique()
      .references(() => scienceDomainValidations.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    recordHash: text("record_hash").notNull(),
    headHash: text("head_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqScope: unique("science_domain_validation_heads_scope_unique").on(
      t.workspaceId,
      t.runId,
      t.kind,
      t.scopeBaselineRunId,
    ),
    validRevision: check(
      "science_domain_validation_heads_revision_check",
      sql`${t.revision} > 0`,
    ),
    validKindAndScope: check(
      "science_domain_validation_heads_scope_check",
      sql`(
        ${t.kind} = 'domain-validation'
        AND ${t.scopeBaselineRunId} = ${t.runId}
      ) OR (
        ${t.kind} = 'numerical-equivalence'
        AND ${t.scopeBaselineRunId} <> ${t.runId}
      )`,
    ),
    validRecordHash: check(
      "science_domain_validation_heads_record_hash_check",
      sql`${t.recordHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validHeadHash: check(
      "science_domain_validation_heads_head_hash_check",
      sql`${t.headHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const scienceRunArtifacts = pgTable(
  "science_run_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => scienceRuns.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => scienceArtifactVersions.id, { onDelete: "restrict" }),
    direction: text("direction").notNull(),
    semanticRole: text("semantic_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqLink: unique("science_run_artifacts_unique").on(
      t.runId,
      t.artifactVersionId,
      t.direction,
      t.semanticRole,
    ),
    runIdx: index("science_run_artifacts_run_idx").on(t.runId, t.direction, t.createdAt),
    validDirection: check(
      "science_run_artifacts_direction_check",
      sql`${t.direction} IN ('input', 'output')`,
    ),
  }),
);

export const scienceRunEvents = pgTable(
  "science_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    studyId: uuid("study_id")
      .notNull()
      .references(() => scienceStudies.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => scienceRuns.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    state: text("state").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqSequence: unique("science_run_events_run_sequence_unique").on(t.runId, t.sequence),
    runIdx: index("science_run_events_run_idx").on(t.runId, t.sequence),
    positiveSequence: check("science_run_events_sequence_check", sql`${t.sequence} > 0`),
    nonnegativeGeneration: check(
      "science_run_events_generation_check",
      sql`${t.executionGeneration} >= 0`,
    ),
  }),
);

export const scienceRenderSessions = pgTable(
  "science_render_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => scienceRuns.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id").references(() => scienceArtifactVersions.id, {
      onDelete: "cascade",
    }),
    providerHandle: text("provider_handle"),
    requestKeyHash: text("request_key_hash").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    providerKind: text("provider_kind").notNull(),
    mode: text("mode").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceMediaType: text("source_media_type").notNull(),
    sourceSizeBytes: bigint("source_size_bytes", { mode: "number" }).notNull(),
    sourceLogicalName: text("source_logical_name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    audience: text("audience").notNull(),
    state: text("state").notNull().default("starting"),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    cleanupNotBefore: timestamp("cleanup_not_before", { withTimezone: true }),
    launchLeaseId: uuid("launch_lease_id"),
    launchLeaseExpiresAt: timestamp("launch_lease_expires_at", { withTimezone: true }),
    replayExpiresAt: timestamp("replay_expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceStateIdx: index("science_render_sessions_workspace_state_idx").on(
      t.workspaceId,
      t.state,
      t.expiresAt,
    ),
    requestKeyUnique: unique("science_render_sessions_workspace_owner_request_unique").on(
      t.workspaceId,
      t.ownerId,
      t.requestKeyHash,
    ),
    validTarget: check(
      "science_render_sessions_target_check",
      sql`${t.runId} IS NOT NULL OR ${t.artifactVersionId} IS NOT NULL`,
    ),
    validTokenHash: check(
      "science_render_sessions_token_hash_check",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validRequestKeyHash: check(
      "science_render_sessions_request_key_hash_check",
      sql`${t.requestKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validIntentFingerprint: check(
      "science_render_sessions_intent_fingerprint_check",
      sql`${t.intentFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    validSourceSha256: check(
      "science_render_sessions_source_sha256_check",
      sql`${t.sourceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    validMode: check(
      "science_render_sessions_mode_check",
      sql`${t.mode} IN ('client', 'remote', 'static')`,
    ),
    validProviderKind: check(
      "science_render_sessions_provider_kind_check",
      sql`${t.providerKind} ~ '^[A-Za-z0-9_-]{1,80}$'`,
    ),
    validSourceMetadata: check(
      "science_render_sessions_source_metadata_check",
      sql`${t.sourceSizeBytes} >= 0 AND char_length(${t.sourceMediaType}) BETWEEN 1 AND 200 AND char_length(${t.sourceLogicalName}) BETWEEN 1 AND 500`,
    ),
    validReplayHorizon: check(
      "science_render_sessions_replay_horizon_check",
      sql`${t.replayExpiresAt} >= ${t.expiresAt}`,
    ),
    validLaunchLease: check(
      "science_render_sessions_launch_lease_check",
      sql`(${t.launchLeaseId} IS NULL AND ${t.launchLeaseExpiresAt} IS NULL) OR (${t.launchLeaseId} IS NOT NULL AND ${t.launchLeaseExpiresAt} IS NOT NULL)`,
    ),
    validState: check(
      "science_render_sessions_state_check",
      sql`${t.state} IN ('starting', 'ready', 'expired', 'failed', 'revoked')`,
    ),
  }),
);

export const schema = {
  users,
  sessions,
  memberships,
  uiPreferences,
  templates,
  auditLog,
  workspaces,
  workflows,
  workflowVersions,
  missions,
  missionSteps,
  approvals,
  agents,
  agentMessages,
  agentMemories,
  credentials,
  mcpToolPins,
  approvalPolicies,
  nodeExecutions,
  documents,
  documentChunks,
  evalRuns,
  usageLedger,
  budgets,
  mcpServers,
  routerProfiles,
  projects,
  claudeSessions,
  claudeRuns,
  workbenchCopybacks,
  claudeEvents,
  projectArtifacts,
  verifyChecks,
  projectTraceLinks,
  evidence,
  scienceStudies,
  scienceArtifacts,
  scienceArtifactVersions,
  scienceUploads,
  scienceComputeProfiles,
  scienceRuns,
  workflowWaits,
  scienceDomainValidations,
  scienceDomainValidationHeads,
  scienceRunArtifacts,
  scienceRunEvents,
  scienceRenderSessions,
};
