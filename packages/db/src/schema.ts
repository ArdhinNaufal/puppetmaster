import {
  integer,
  jsonb,
  pgTable,
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

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** White-label branding: { brandName?, accent? } (DESIGN-LANGUAGE.md §6). */
  branding: jsonb("branding").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
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
 *  configured (pgvector), otherwise recall falls back to keyword search. */
export const agentMemories = pgTable("agent_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  workspaces,
  workflows,
  workflowVersions,
  missions,
  missionSteps,
  approvals,
  agents,
  agentMessages,
  agentMemories,
};
