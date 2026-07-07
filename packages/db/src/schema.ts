import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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
  projectArtifacts,
  verifyChecks,
  evidence,
};
