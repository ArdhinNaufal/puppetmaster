import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { schema } from "./schema.js";

/** Driver-agnostic handle: both node-postgres and PGlite are PgDatabase subtypes. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  driver: "pg" | "pglite";
  close: () => Promise<void>;
}

/**
 * Open a database. With DATABASE_URL set, use node-postgres against the
 * pgvector Postgres from docker-compose; otherwise fall back to an embedded
 * PGlite instance (in-memory unless `dataDir` is given) for local/desktop and
 * end-to-end runs. Both paths share one Drizzle schema.
 */
export async function createDb(opts?: {
  databaseUrl?: string | null;
  dataDir?: string;
  /** Ignore DATABASE_URL/PGLITE_DATA_DIR: always a fresh in-memory PGlite
   *  (the eval harness's isolated per-run store). */
  ephemeral?: boolean;
}): Promise<DbHandle> {
  const url = opts?.ephemeral ? null : (opts?.databaseUrl ?? process.env.DATABASE_URL ?? null);

  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return { db, driver: "pg", close: () => pool.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  // A dataDir persists PGlite to disk — set PGLITE_DATA_DIR to share one store
  // between the demo seeder and the server (both keyless).
  const dataDir = opts?.ephemeral
    ? undefined
    : (opts?.dataDir ?? process.env.PGLITE_DATA_DIR ?? undefined);
  const client = await PGlite.create({
    dataDir,
    extensions: { vector },
  });
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, driver: "pglite", close: () => client.close() };
}

/** Idempotent schema creation, applied on startup for both drivers. */
const DDL: string[] = [
  // pgvector-ready: enables semantic memory tables in M2 (agent_memories).
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     name text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS workflows (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     current_version integer NOT NULL DEFAULT 1,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS workflow_versions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
     version integer NOT NULL,
     graph jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (workflow_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS missions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     kind text NOT NULL,
     subject_id uuid NOT NULL,
     workflow_version_id uuid REFERENCES workflow_versions(id) ON DELETE SET NULL,
     parent_mission_id uuid,
     status text NOT NULL DEFAULT 'queued',
     trigger jsonb,
     input jsonb,
     output jsonb,
     error text,
     cursor jsonb,
     started_at timestamptz,
     finished_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS mission_steps (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
     node_id text NOT NULL,
     kind text NOT NULL,
     status text NOT NULL DEFAULT 'pending',
     attempt integer NOT NULL DEFAULT 0,
     input jsonb,
     output jsonb,
     error text,
     started_at timestamptz,
     finished_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS approvals (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
     node_id text NOT NULL,
     prompt text NOT NULL,
     tier text NOT NULL DEFAULT 'write_approved',
     status text NOT NULL DEFAULT 'pending',
     created_at timestamptz NOT NULL DEFAULT now(),
     decided_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS agents (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     persona text NOT NULL DEFAULT '',
     model text NOT NULL,
     autonomy text NOT NULL DEFAULT 'write_approved',
     tool_grants jsonb NOT NULL DEFAULT '[]',
     schedule text,
     scratchpad jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     mission_id uuid,
     role text NOT NULL,
     content jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS agent_memories (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     content text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email text NOT NULL UNIQUE,
     name text NOT NULL,
     password_hash text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     token text NOT NULL UNIQUE,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS memberships (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     role text NOT NULL DEFAULT 'member',
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (user_id, workspace_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ui_preferences (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     layout jsonb NOT NULL DEFAULT '{}',
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (user_id, workspace_id)
   )`,
  `CREATE TABLE IF NOT EXISTS templates (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
     kind text NOT NULL,
     name text NOT NULL,
     description text NOT NULL DEFAULT '',
     category text NOT NULL DEFAULT 'general',
     spec jsonb NOT NULL,
     builtin boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // pgvector column for semantic memory; separate statement so the rest of the
  // schema still applies when the vector extension is unavailable.
  `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS embedding vector(1024)`,
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}'`,
  `CREATE INDEX IF NOT EXISTS mission_steps_mission_idx ON mission_steps(mission_id)`,
  `CREATE INDEX IF NOT EXISTS missions_workspace_idx ON missions(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status)`,
  `CREATE INDEX IF NOT EXISTS agent_messages_agent_idx ON agent_messages(agent_id)`,
  `CREATE INDEX IF NOT EXISTS agent_memories_agent_idx ON agent_memories(agent_id)`,
  `CREATE INDEX IF NOT EXISTS templates_kind_idx ON templates(kind)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     actor_kind text NOT NULL DEFAULT 'system',
     actor_id text,
     actor_label text,
     mission_id uuid,
     action text NOT NULL,
     target text,
     detail jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS audit_log_workspace_idx ON audit_log(workspace_id, created_at)`,
  `ALTER TABLE workflows ADD COLUMN IF NOT EXISTS webhook_secret text`,
  `CREATE TABLE IF NOT EXISTS credentials (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     encrypted text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (workspace_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS mcp_tool_pins (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     server text NOT NULL,
     tool text NOT NULL,
     hash text NOT NULL,
     first_seen_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (server, tool)
   )`,
  `CREATE TABLE IF NOT EXISTS approval_policies (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
     tool text NOT NULL,
     predicates jsonb NOT NULL DEFAULT '[]',
     description text NOT NULL DEFAULT '',
     enabled boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS approval_policies_workspace_idx ON approval_policies(workspace_id)`,
  `ALTER TABLE missions ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false`,
  `ALTER TABLE missions ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS node_executions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
     node_id text NOT NULL,
     attempt integer NOT NULL DEFAULT 0,
     key text NOT NULL UNIQUE,
     output jsonb,
     committed boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS node_executions_mission_idx ON node_executions(mission_id, node_id)`,
  `CREATE TABLE IF NOT EXISTS documents (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     title text NOT NULL,
     source text NOT NULL DEFAULT '',
     mime text NOT NULL DEFAULT 'text/markdown',
     content text NOT NULL,
     chunk_count integer NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS document_chunks (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     idx integer NOT NULL,
     heading text NOT NULL DEFAULT '',
     content text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding vector(1024)`,
  `CREATE INDEX IF NOT EXISTS document_chunks_document_idx ON document_chunks(document_id)`,
  `CREATE INDEX IF NOT EXISTS documents_workspace_idx ON documents(workspace_id)`,
  `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact'`,
  `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS mission_id uuid`,
  `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.5`,
  `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS eval_runs (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     suite text NOT NULL DEFAULT 'golden',
     k integer NOT NULL DEFAULT 3,
     passed integer NOT NULL DEFAULT 0,
     total integer NOT NULL DEFAULT 0,
     results jsonb NOT NULL DEFAULT '[]',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS usage_ledger (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     agent_id uuid,
     mission_id uuid,
     model text NOT NULL DEFAULT '',
     input_tokens integer NOT NULL DEFAULT 0,
     output_tokens integer NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS usage_ledger_workspace_idx ON usage_ledger(workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS budgets (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
     monthly_token_limit integer NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS router_profiles (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     description text NOT NULL DEFAULT '',
     candidates jsonb NOT NULL DEFAULT '[]',
     min_class_for_gated_tools text,
     enabled boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (workspace_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     transport text NOT NULL DEFAULT 'http',
     url text,
     command text,
     args jsonb NOT NULL DEFAULT '[]',
     env jsonb NOT NULL DEFAULT '{}',
     headers jsonb NOT NULL DEFAULT '{}',
     tier text NOT NULL DEFAULT 'read_auto',
     enabled boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (workspace_id, name)
   )`,
];

export async function migrate(handle: DbHandle): Promise<void> {
  for (const statement of DDL) {
    try {
      await handle.db.execute(sql.raw(statement));
    } catch (err) {
      // `CREATE EXTENSION vector` (and the vector-typed column that depends on
      // it) may be unavailable on a stock Postgres without pgvector; the rest
      // of the schema must still apply. Surface anything else.
      if (statement.includes("EXTENSION") || statement.includes("vector(")) continue;
      throw err;
    }
  }
}
