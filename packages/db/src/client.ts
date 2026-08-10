import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { schema } from "./schema.js";

/** Driver-agnostic handle: both node-postgres and PGlite are PgDatabase subtypes. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const databaseHealthProbes = new WeakMap<Db, () => Promise<void>>();

/**
 * Probe the database through the bounded driver-specific health path registered
 * by createDb. The fallback preserves support for injected test databases.
 */
export async function probeScienceDatabase(db: Db): Promise<void> {
  const probe = databaseHealthProbes.get(db);
  if (probe) {
    await probe();
    return;
  }
  await db.execute(sql`select 1 as science_database_ready`);
}

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
    // Keep readiness independent from the application pool. Driver-level
    // acquisition and query limits prevent blackholed probes from accumulating
    // behind the outer service deadline.
    const healthPool = new Pool({
      connectionString: url,
      max: 1,
      allowExitOnIdle: true,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      statement_timeout: 2_000,
    });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    databaseHealthProbes.set(db, async () => {
      await healthPool.query("select 1 as science_database_ready");
    });
    return {
      db,
      driver: "pg",
      close: async () => {
        databaseHealthProbes.delete(db);
        await Promise.all([pool.end(), healthPool.end()]);
      },
    };
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
  databaseHealthProbes.set(db, async () => {
    await db.execute(sql`select 1 as science_database_ready`);
  });
  return {
    db,
    driver: "pglite",
    close: async () => {
      databaseHealthProbes.delete(db);
      await client.close();
    },
  };
}

/** Historical idempotent schema baseline, preserved byte-for-byte for upgrades. */
const LEGACY_DDL: readonly string[] = [
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
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS context_compaction boolean NOT NULL DEFAULT false`,
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
  // The Workshop (AI-SDLC plan WP2, ADR-003/004): projects + typed artifacts
  // + earned verify checks + gate evidence.
  `CREATE TABLE IF NOT EXISTS projects (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     repo_ref text NOT NULL DEFAULT '',
     mode text NOT NULL DEFAULT 'supervised',
     phase text NOT NULL DEFAULT 'idle',
     status text NOT NULL DEFAULT 'active',
     workbench_id text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS claude_sessions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     provider text NOT NULL DEFAULT 'anthropic',
     backend text NOT NULL DEFAULT 'claude',
     title text NOT NULL,
     claude_session_id text,
     status text NOT NULL DEFAULT 'active',
     model text NOT NULL,
     effort text,
     permission_mode text NOT NULL DEFAULT 'plan',
     config jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT claude_sessions_provider_backend_check CHECK (
       (provider = 'anthropic' AND backend = 'claude') OR
       (provider = 'openai' AND backend = 'aider')
     ),
     CONSTRAINT claude_sessions_provider_model_check CHECK (
       length(btrim(model)) BETWEEN 1 AND 200 AND (
         (provider = 'anthropic' AND lower(model) NOT LIKE 'openai/%') OR
         (provider = 'openai' AND model LIKE 'openai/%' AND length(btrim(substr(model, 8))) > 0)
       )
     ),
     CONSTRAINT claude_sessions_model_canonical_check CHECK (
       model = btrim(model) AND
       (provider <> 'openai' OR model = 'openai/' || btrim(substr(model, 8)))
     )
   )`,
  `CREATE TABLE IF NOT EXISTS claude_runs (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     session_id uuid NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
     mission_id uuid NOT NULL UNIQUE REFERENCES missions(id) ON DELETE CASCADE,
     provider text NOT NULL DEFAULT 'anthropic',
     backend text NOT NULL DEFAULT 'claude',
     turn_number integer NOT NULL,
     mode text NOT NULL,
     prompt text NOT NULL,
     status text NOT NULL DEFAULT 'queued',
     execution_generation integer NOT NULL DEFAULT 0,
     model text NOT NULL,
     effort text,
     permission_mode text NOT NULL,
     config jsonb NOT NULL DEFAULT '{}',
     result jsonb,
     result_text text,
     is_error boolean,
     usage jsonb,
     cost_usd real,
     duration_ms integer,
     duration_api_ms integer,
     num_turns integer,
     error text,
     started_at timestamptz,
     finished_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (session_id, turn_number),
     CONSTRAINT claude_runs_provider_backend_check CHECK (
       (provider = 'anthropic' AND backend = 'claude') OR
       (provider = 'openai' AND backend = 'aider')
     ),
     CONSTRAINT claude_runs_provider_model_check CHECK (
       length(btrim(model)) BETWEEN 1 AND 200 AND (
         (provider = 'anthropic' AND lower(model) NOT LIKE 'openai/%') OR
         (provider = 'openai' AND model LIKE 'openai/%' AND length(btrim(substr(model, 8))) > 0)
       )
     ),
     CONSTRAINT claude_runs_model_canonical_check CHECK (
       model = btrim(model) AND
       (provider <> 'openai' OR model = 'openai/' || btrim(substr(model, 8)))
     ),
     CONSTRAINT claude_runs_execution_generation_check CHECK (
       execution_generation >= 0
     )
   )`,
  `CREATE TABLE IF NOT EXISTS claude_events (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     session_id uuid NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
     run_id uuid NOT NULL REFERENCES claude_runs(id) ON DELETE CASCADE,
     sequence integer NOT NULL,
     stream text NOT NULL,
     event_type text NOT NULL,
     raw text NOT NULL DEFAULT '',
     payload jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (session_id, sequence)
   )`,
  `ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'anthropic'`,
  `ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS backend text NOT NULL DEFAULT 'claude'`,
  `ALTER TABLE claude_runs ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'anthropic'`,
  `ALTER TABLE claude_runs ADD COLUMN IF NOT EXISTS backend text NOT NULL DEFAULT 'claude'`,
  `ALTER TABLE claude_runs ADD COLUMN IF NOT EXISTS execution_generation integer NOT NULL DEFAULT 0`,
  `UPDATE claude_sessions
     SET backend = CASE provider WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'aider' ELSE backend END
     WHERE (provider = 'anthropic' AND backend IS DISTINCT FROM 'claude')
        OR (provider = 'openai' AND backend IS DISTINCT FROM 'aider')`,
  `UPDATE claude_runs AS run
     SET provider = session.provider, backend = session.backend
     FROM claude_sessions AS session
     WHERE run.session_id = session.id
       AND (run.provider IS DISTINCT FROM session.provider OR run.backend IS DISTINCT FROM session.backend)`,
  `UPDATE claude_sessions SET model = btrim(model) WHERE model IS DISTINCT FROM btrim(model)`,
  `UPDATE claude_runs SET model = btrim(model) WHERE model IS DISTINCT FROM btrim(model)`,
  `UPDATE claude_sessions
     SET model = 'openai/' || btrim(substr(model, 8))
     WHERE provider = 'openai'
       AND lower(model) LIKE 'openai/%'
       AND model IS DISTINCT FROM 'openai/' || btrim(substr(model, 8))`,
  `UPDATE claude_runs
     SET model = 'openai/' || btrim(substr(model, 8))
     WHERE provider = 'openai'
       AND lower(model) LIKE 'openai/%'
       AND model IS DISTINCT FROM 'openai/' || btrim(substr(model, 8))`,
  `UPDATE claude_sessions
     SET model = 'openai/' || model
     WHERE provider = 'openai' AND model <> '' AND position('/' in model) = 0`,
  `UPDATE claude_runs
     SET model = 'openai/' || model
     WHERE provider = 'openai' AND model <> '' AND position('/' in model) = 0`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_sessions_provider_backend_check'
         AND conrelid = 'claude_sessions'::regclass
     ) THEN
       ALTER TABLE claude_sessions ADD CONSTRAINT claude_sessions_provider_backend_check CHECK (
         (provider = 'anthropic' AND backend = 'claude') OR
         (provider = 'openai' AND backend = 'aider')
       );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_sessions_model_canonical_check'
         AND conrelid = 'claude_sessions'::regclass
     ) THEN
       ALTER TABLE claude_sessions ADD CONSTRAINT claude_sessions_model_canonical_check CHECK (
         model = btrim(model) AND
         (provider <> 'openai' OR model = 'openai/' || btrim(substr(model, 8)))
       );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_sessions_provider_model_check'
         AND conrelid = 'claude_sessions'::regclass
     ) THEN
       ALTER TABLE claude_sessions ADD CONSTRAINT claude_sessions_provider_model_check CHECK (
         length(btrim(model)) BETWEEN 1 AND 200 AND (
           (provider = 'anthropic' AND lower(model) NOT LIKE 'openai/%') OR
           (provider = 'openai' AND model LIKE 'openai/%' AND length(btrim(substr(model, 8))) > 0)
         )
       );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_runs_model_canonical_check'
         AND conrelid = 'claude_runs'::regclass
     ) THEN
       ALTER TABLE claude_runs ADD CONSTRAINT claude_runs_model_canonical_check CHECK (
         model = btrim(model) AND
         (provider <> 'openai' OR model = 'openai/' || btrim(substr(model, 8)))
       );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_runs_provider_backend_check'
         AND conrelid = 'claude_runs'::regclass
     ) THEN
       ALTER TABLE claude_runs ADD CONSTRAINT claude_runs_provider_backend_check CHECK (
         (provider = 'anthropic' AND backend = 'claude') OR
         (provider = 'openai' AND backend = 'aider')
       );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_runs_provider_model_check'
         AND conrelid = 'claude_runs'::regclass
     ) THEN
       ALTER TABLE claude_runs ADD CONSTRAINT claude_runs_provider_model_check CHECK (
         length(btrim(model)) BETWEEN 1 AND 200 AND (
           (provider = 'anthropic' AND lower(model) NOT LIKE 'openai/%') OR
           (provider = 'openai' AND model LIKE 'openai/%' AND length(btrim(substr(model, 8))) > 0)
         )
       );
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'claude_runs_execution_generation_check'
         AND conrelid = 'claude_runs'::regclass
     ) THEN
       ALTER TABLE claude_runs ADD CONSTRAINT claude_runs_execution_generation_check CHECK (
         execution_generation >= 0
       );
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS claude_sessions_workspace_idx ON claude_sessions(workspace_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS claude_sessions_project_idx ON claude_sessions(project_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS claude_runs_session_idx ON claude_runs(session_id, turn_number)`,
  `CREATE INDEX IF NOT EXISTS claude_runs_status_idx ON claude_runs(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS claude_runs_one_active_per_session_idx
     ON claude_runs(session_id)
     WHERE status IN ('queued', 'awaiting_approval', 'running')`,
  `CREATE TABLE IF NOT EXISTS workbench_copybacks (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     claude_run_id uuid NOT NULL REFERENCES claude_runs(id) ON DELETE CASCADE,
     execution_id text NOT NULL,
     execution_identity_sha256 text NOT NULL,
     execution_generation integer NOT NULL,
     state text NOT NULL DEFAULT 'intent',
     baseline jsonb NOT NULL,
     candidate jsonb,
     receipt jsonb,
     pending_completion jsonb,
     error text,
     files_committed_at timestamptz,
     db_committed_at timestamptz,
     rolled_back_at timestamptz,
     quarantined_at timestamptz,
     cleaned_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT workbench_copybacks_run_generation_unique UNIQUE (claude_run_id, execution_generation),
     CONSTRAINT workbench_copybacks_execution_id_unique UNIQUE (execution_id),
     CONSTRAINT workbench_copybacks_execution_identity_unique UNIQUE (execution_identity_sha256),
     CONSTRAINT workbench_copybacks_state_check CHECK (
       state IN ('intent', 'files_committed', 'db_committed', 'rolled_back', 'quarantined', 'cleaned')
     ),
     CONSTRAINT workbench_copybacks_execution_generation_check CHECK (execution_generation > 0),
     CONSTRAINT workbench_copybacks_execution_identity_check CHECK (
       execution_identity_sha256 ~ '^[0-9a-f]{64}$'
     ),
     CONSTRAINT workbench_copybacks_execution_id_check CHECK (
       execution_id = btrim(execution_id) AND length(execution_id) BETWEEN 1 AND 300
     )
   )`,
  `CREATE INDEX IF NOT EXISTS workbench_copybacks_project_state_idx
     ON workbench_copybacks(project_id, state, created_at)`,
  `CREATE INDEX IF NOT EXISTS workbench_copybacks_run_idx
     ON workbench_copybacks(claude_run_id, execution_generation)`,
  `CREATE INDEX IF NOT EXISTS claude_events_session_idx ON claude_events(session_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS claude_events_run_idx ON claude_events(run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS project_artifacts (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind text NOT NULL,
     status text,
     title text NOT NULL,
     body text NOT NULL DEFAULT '',
     version integer NOT NULL DEFAULT 1,
     supersedes_id uuid,
     mission_id uuid,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS verify_checks (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name text NOT NULL,
     command text,
     baseline integer,
     enabled boolean NOT NULL DEFAULT false,
     earned_note text NOT NULL DEFAULT '',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS project_trace_links (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     source_type text NOT NULL CHECK (source_type IN ('artifact', 'check')),
     source_id uuid NOT NULL,
     target_type text NOT NULL CHECK (target_type IN ('artifact', 'check')),
     target_id uuid NOT NULL,
     relation text NOT NULL CHECK (relation IN ('informs', 'derives', 'verifies', 'mitigates')),
     rationale text NOT NULL CHECK (length(trim(rationale)) > 0),
     created_at timestamptz NOT NULL DEFAULT now(),
     CHECK (source_type <> target_type OR source_id <> target_id),
     CHECK (relation <> 'derives' OR (source_type = 'artifact' AND target_type = 'artifact')),
     CHECK (relation <> 'verifies' OR (source_type = 'artifact' AND target_type = 'check'))
   )`,
  `CREATE TABLE IF NOT EXISTS evidence (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     step_id uuid REFERENCES mission_steps(id) ON DELETE CASCADE,
     approval_id uuid REFERENCES approvals(id) ON DELETE CASCADE,
     kind text NOT NULL,
     content jsonb,
     ref text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE project_artifacts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS project_artifacts_project_idx ON project_artifacts(project_id, kind, status)`,
  `CREATE INDEX IF NOT EXISTS verify_checks_project_idx ON verify_checks(project_id)`,
  `CREATE INDEX IF NOT EXISTS project_trace_links_project_idx ON project_trace_links(project_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_trace_links_unique_idx
     ON project_trace_links(project_id, source_type, source_id, target_type, target_id, relation)`,
];

const SCIENCE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS science_studies (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     description text NOT NULL DEFAULT '',
     status text NOT NULL DEFAULT 'active'
       CONSTRAINT science_studies_status_check CHECK (status IN ('active', 'archived')),
     classification text NOT NULL DEFAULT 'non_regulated'
       CONSTRAINT science_studies_classification_check CHECK (classification = 'non_regulated'),
     workshop_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
     created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS science_studies_workspace_idx
     ON science_studies(workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS science_artifacts (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     study_id uuid NOT NULL REFERENCES science_studies(id) ON DELETE CASCADE,
     logical_name text NOT NULL,
     kind text NOT NULL
       CONSTRAINT science_artifacts_kind_check
       CHECK (kind IN ('dataset', 'notebook', 'geometry', 'result', 'log', 'manifest', 'environment', 'other')),
     format text NOT NULL,
     status text NOT NULL DEFAULT 'active'
       CONSTRAINT science_artifacts_status_check CHECK (status IN ('active', 'archived')),
     created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT science_artifacts_study_logical_name_unique UNIQUE (study_id, logical_name)
   )`,
  `CREATE INDEX IF NOT EXISTS science_artifacts_study_idx
     ON science_artifacts(study_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS science_artifact_versions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     artifact_id uuid NOT NULL REFERENCES science_artifacts(id) ON DELETE CASCADE,
     version integer NOT NULL CONSTRAINT science_artifact_versions_version_check CHECK (version > 0),
     status text NOT NULL DEFAULT 'pending'
       CONSTRAINT science_artifact_versions_status_check
       CHECK (status IN ('pending', 'ready', 'quarantined', 'expired')),
     storage_key text NOT NULL UNIQUE,
     sha256 text NOT NULL
       CONSTRAINT science_artifact_versions_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
     size_bytes bigint NOT NULL
       CONSTRAINT science_artifact_versions_size_check CHECK (size_bytes >= 0),
     media_type text NOT NULL,
     metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
     cleanup_eligible boolean NOT NULL DEFAULT false,
     cleanup_attempts integer NOT NULL DEFAULT 0,
     cleanup_not_before timestamptz,
     parent_version_id uuid REFERENCES science_artifact_versions(id) ON DELETE RESTRICT,
     created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     ready_at timestamptz,
     CONSTRAINT science_artifact_versions_artifact_version_unique UNIQUE (artifact_id, version),
     CONSTRAINT science_artifact_versions_artifact_checksum_unique UNIQUE (artifact_id, sha256)
   )`,
  `CREATE INDEX IF NOT EXISTS science_artifact_versions_artifact_idx
     ON science_artifact_versions(artifact_id, version)`,
  `CREATE TABLE IF NOT EXISTS science_uploads (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     artifact_id uuid NOT NULL REFERENCES science_artifacts(id) ON DELETE CASCADE,
     artifact_version_id uuid REFERENCES science_artifact_versions(id) ON DELETE RESTRICT,
     token_hash text NOT NULL UNIQUE
       CONSTRAINT science_uploads_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
     expected_size_bytes bigint NOT NULL,
     expected_sha256 text NOT NULL
       CONSTRAINT science_uploads_expected_sha256_check CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
     quarantine_key text NOT NULL UNIQUE,
     received_bytes bigint NOT NULL DEFAULT 0,
     state text NOT NULL DEFAULT 'pending'
       CONSTRAINT science_uploads_state_check
       CHECK (state IN ('pending', 'uploading', 'finalizing', 'completed', 'quarantined', 'expired')),
     error text,
     transfer_lease_id uuid,
     finalization_lease_id uuid,
     cleanup_attempts integer NOT NULL DEFAULT 0,
     cleanup_not_before timestamptz,
     expires_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     completed_at timestamptz,
     CONSTRAINT science_uploads_size_check
       CHECK (expected_size_bytes >= 0 AND received_bytes >= 0 AND received_bytes <= expected_size_bytes)
   )`,
  `CREATE INDEX IF NOT EXISTS science_uploads_workspace_state_idx
     ON science_uploads(workspace_id, state, expires_at)`,
  `CREATE INDEX IF NOT EXISTS science_uploads_artifact_idx
     ON science_uploads(artifact_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS science_compute_profiles (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     name text NOT NULL,
     provider_kind text NOT NULL
       CONSTRAINT science_compute_profiles_provider_check
       CHECK (provider_kind IN ('local_container', 'jupyter_enterprise_gateway')),
     image_digest text NOT NULL
       CONSTRAINT science_compute_profiles_image_digest_check
       CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
     kernel_name text NOT NULL,
     resource_bounds jsonb NOT NULL,
     config jsonb NOT NULL DEFAULT '{}'::jsonb,
     enabled boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT science_compute_profiles_workspace_name_unique UNIQUE (workspace_id, name)
   )`,
  `CREATE INDEX IF NOT EXISTS science_compute_profiles_workspace_idx
     ON science_compute_profiles(workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS science_runs (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     study_id uuid NOT NULL REFERENCES science_studies(id) ON DELETE CASCADE,
     mission_id uuid NOT NULL UNIQUE REFERENCES missions(id) ON DELETE RESTRICT,
     compute_profile_id uuid NOT NULL REFERENCES science_compute_profiles(id) ON DELETE RESTRICT,
     profile_snapshot jsonb NOT NULL,
     resource_request jsonb NOT NULL,
     provider_handle text,
     lease_owner text,
     lease_expires_at timestamptz,
     heartbeat_at timestamptz,
     state text NOT NULL DEFAULT 'draft'
       CONSTRAINT science_runs_state_check
       CHECK (state IN ('draft', 'awaiting_approval', 'queued', 'provisioning', 'running', 'finalizing', 'cancelling', 'succeeded', 'failed', 'cancelled')),
     execution_generation integer NOT NULL DEFAULT 0
       CONSTRAINT science_runs_generation_check CHECK (execution_generation >= 0),
     idempotency_key text NOT NULL,
     parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
     manifest jsonb,
     manifest_hash text
       CONSTRAINT science_runs_manifest_hash_check
       CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$'),
     error text,
     created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     finished_at timestamptz,
     CONSTRAINT science_runs_study_idempotency_unique UNIQUE (study_id, idempotency_key),
     CONSTRAINT science_runs_lease_check CHECK (
       (lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
       OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS science_runs_study_state_idx
     ON science_runs(study_id, state, created_at)`,
  `CREATE TABLE IF NOT EXISTS science_run_artifacts (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     run_id uuid NOT NULL REFERENCES science_runs(id) ON DELETE CASCADE,
     artifact_version_id uuid NOT NULL REFERENCES science_artifact_versions(id) ON DELETE RESTRICT,
     direction text NOT NULL
       CONSTRAINT science_run_artifacts_direction_check CHECK (direction IN ('input', 'output')),
     semantic_role text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT science_run_artifacts_unique
       UNIQUE (run_id, artifact_version_id, direction, semantic_role)
   )`,
  `CREATE INDEX IF NOT EXISTS science_run_artifacts_run_idx
     ON science_run_artifacts(run_id, direction, created_at)`,
  `CREATE TABLE IF NOT EXISTS science_run_events (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL
       CONSTRAINT science_run_events_workspace_fk REFERENCES workspaces(id) ON DELETE CASCADE,
     study_id uuid NOT NULL
       CONSTRAINT science_run_events_study_fk REFERENCES science_studies(id) ON DELETE CASCADE,
     run_id uuid NOT NULL REFERENCES science_runs(id) ON DELETE CASCADE,
     mission_id uuid NOT NULL
       CONSTRAINT science_run_events_mission_fk REFERENCES missions(id) ON DELETE CASCADE,
     sequence integer NOT NULL
       CONSTRAINT science_run_events_sequence_check CHECK (sequence > 0),
     event_type text NOT NULL,
     execution_generation integer NOT NULL
       CONSTRAINT science_run_events_generation_check CHECK (execution_generation >= 0),
     state text NOT NULL,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT science_run_events_run_sequence_unique UNIQUE (run_id, sequence)
   )`,
  `CREATE INDEX IF NOT EXISTS science_run_events_run_idx
     ON science_run_events(run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS science_render_sessions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     run_id uuid REFERENCES science_runs(id) ON DELETE CASCADE,
     artifact_version_id uuid REFERENCES science_artifact_versions(id) ON DELETE CASCADE,
     provider_handle text,
     token_hash text NOT NULL UNIQUE
       CONSTRAINT science_render_sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
     audience text NOT NULL,
     state text NOT NULL DEFAULT 'starting'
       CONSTRAINT science_render_sessions_state_check
       CHECK (state IN ('starting', 'ready', 'expired', 'failed', 'revoked')),
     cleanup_attempts integer NOT NULL DEFAULT 0,
     cleanup_not_before timestamptz,
     owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at timestamptz NOT NULL,
     heartbeat_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT science_render_sessions_target_check
       CHECK (run_id IS NOT NULL OR artifact_version_id IS NOT NULL)
   )`,
  `CREATE INDEX IF NOT EXISTS science_render_sessions_workspace_state_idx
     ON science_render_sessions(workspace_id, state, expires_at)`,
];

const SCIENCE_RUN_RESOURCE_LEASE_DDL: readonly string[] = [
  `ALTER TABLE science_runs ADD COLUMN IF NOT EXISTS resource_request jsonb`,
  `DO $science_resource_upgrade$
   BEGIN
     IF EXISTS (SELECT 1 FROM science_runs WHERE resource_request IS NULL) THEN
       RAISE EXCEPTION
         'science run resource_request cannot be inferred from its profile ceiling; backfill explicit requests before retrying migration';
     END IF;
   END
   $science_resource_upgrade$`,
  `ALTER TABLE science_runs ALTER COLUMN resource_request SET NOT NULL`,
  `ALTER TABLE science_runs ADD COLUMN IF NOT EXISTS lease_owner text`,
  `ALTER TABLE science_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`,
  `ALTER TABLE science_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz`,
  `DO $science_lease_constraint$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'science_runs_lease_check'
     ) THEN
       ALTER TABLE science_runs ADD CONSTRAINT science_runs_lease_check CHECK (
         (lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
         OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
       );
     END IF;
   END
   $science_lease_constraint$`,
];

const SCIENCE_EVENT_SCOPE_DDL: readonly string[] = [
  `ALTER TABLE science_run_events ADD COLUMN IF NOT EXISTS workspace_id uuid`,
  `ALTER TABLE science_run_events ADD COLUMN IF NOT EXISTS study_id uuid`,
  `ALTER TABLE science_run_events ADD COLUMN IF NOT EXISTS mission_id uuid`,
  `UPDATE science_run_events AS event
     SET workspace_id = study.workspace_id,
         study_id = run.study_id,
         mission_id = run.mission_id
     FROM science_runs AS run
     JOIN science_studies AS study ON study.id = run.study_id
     WHERE event.run_id = run.id
       AND (event.workspace_id IS NULL OR event.study_id IS NULL OR event.mission_id IS NULL)`,
  `ALTER TABLE science_run_events ALTER COLUMN workspace_id SET NOT NULL`,
  `ALTER TABLE science_run_events ALTER COLUMN study_id SET NOT NULL`,
  `ALTER TABLE science_run_events ALTER COLUMN mission_id SET NOT NULL`,
  `DO $science_event_workspace_fk$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'science_run_events_workspace_fk'
     ) THEN
       ALTER TABLE science_run_events
         ADD CONSTRAINT science_run_events_workspace_fk
         FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
     END IF;
   END
   $science_event_workspace_fk$`,
  `DO $science_event_study_fk$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'science_run_events_study_fk'
     ) THEN
       ALTER TABLE science_run_events
         ADD CONSTRAINT science_run_events_study_fk
         FOREIGN KEY (study_id) REFERENCES science_studies(id) ON DELETE CASCADE;
     END IF;
   END
   $science_event_study_fk$`,
  `DO $science_event_mission_fk$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'science_run_events_mission_fk'
     ) THEN
       ALTER TABLE science_run_events
         ADD CONSTRAINT science_run_events_mission_fk
         FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE;
     END IF;
   END
   $science_event_mission_fk$`,
];

const SCIENCE_ATOMIC_AUDIT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS audit_subject_scope (
     domain_table text NOT NULL,
     target_id uuid NOT NULL,
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     PRIMARY KEY (domain_table, target_id)
   )`,
  `INSERT INTO audit_subject_scope (domain_table, target_id, workspace_id)
   SELECT 'science_studies', study.id, study.workspace_id
     FROM science_studies AS study
   UNION ALL
   SELECT 'science_artifacts', artifact.id, study.workspace_id
     FROM science_artifacts AS artifact
     JOIN science_studies AS study ON study.id = artifact.study_id
   UNION ALL
   SELECT 'science_artifact_versions', version.id, study.workspace_id
     FROM science_artifact_versions AS version
     JOIN science_artifacts AS artifact ON artifact.id = version.artifact_id
     JOIN science_studies AS study ON study.id = artifact.study_id
   UNION ALL
   SELECT 'science_uploads', upload.id, upload.workspace_id
     FROM science_uploads AS upload
   UNION ALL
   SELECT 'science_compute_profiles', profile.id, profile.workspace_id
     FROM science_compute_profiles AS profile
   UNION ALL
   SELECT 'science_runs', run.id, study.workspace_id
     FROM science_runs AS run
     JOIN science_studies AS study ON study.id = run.study_id
   UNION ALL
   SELECT 'science_run_artifacts', link.id, study.workspace_id
     FROM science_run_artifacts AS link
     JOIN science_runs AS run ON run.id = link.run_id
     JOIN science_studies AS study ON study.id = run.study_id
   UNION ALL
   SELECT 'science_run_events', event.id, event.workspace_id
     FROM science_run_events AS event
   UNION ALL
   SELECT 'science_render_sessions', session.id, session.workspace_id
     FROM science_render_sessions AS session
   ON CONFLICT (domain_table, target_id)
   DO UPDATE SET workspace_id = EXCLUDED.workspace_id`,
  `DO $science_audit_scope_validation$
   BEGIN
     IF EXISTS (
       SELECT 1
         FROM science_uploads AS upload
         LEFT JOIN audit_subject_scope AS artifact_scope
           ON artifact_scope.domain_table = 'science_artifacts'
          AND artifact_scope.target_id = upload.artifact_id
        WHERE artifact_scope.workspace_id IS DISTINCT FROM upload.workspace_id
     ) THEN
       RAISE EXCEPTION 'science upload workspace does not match its artifact';
     END IF;

     IF EXISTS (
       SELECT 1
         FROM science_runs AS run
         JOIN audit_subject_scope AS study_scope
           ON study_scope.domain_table = 'science_studies'
          AND study_scope.target_id = run.study_id
         LEFT JOIN audit_subject_scope AS profile_scope
           ON profile_scope.domain_table = 'science_compute_profiles'
          AND profile_scope.target_id = run.compute_profile_id
        WHERE profile_scope.workspace_id IS DISTINCT FROM study_scope.workspace_id
     ) THEN
       RAISE EXCEPTION 'science run workspace does not match its compute profile';
     END IF;

     IF EXISTS (
       SELECT 1
         FROM science_run_artifacts AS link
         LEFT JOIN audit_subject_scope AS run_scope
           ON run_scope.domain_table = 'science_runs'
          AND run_scope.target_id = link.run_id
         LEFT JOIN audit_subject_scope AS version_scope
           ON version_scope.domain_table = 'science_artifact_versions'
          AND version_scope.target_id = link.artifact_version_id
        WHERE version_scope.workspace_id IS DISTINCT FROM run_scope.workspace_id
     ) THEN
       RAISE EXCEPTION 'science run artifact workspace does not match its run';
     END IF;

     IF EXISTS (
       SELECT 1
         FROM science_run_events AS event
         LEFT JOIN audit_subject_scope AS study_scope
           ON study_scope.domain_table = 'science_studies'
          AND study_scope.target_id = event.study_id
         LEFT JOIN audit_subject_scope AS run_scope
           ON run_scope.domain_table = 'science_runs'
          AND run_scope.target_id = event.run_id
         LEFT JOIN missions AS mission ON mission.id = event.mission_id
        WHERE study_scope.workspace_id IS DISTINCT FROM event.workspace_id
           OR run_scope.workspace_id IS DISTINCT FROM event.workspace_id
           OR mission.workspace_id IS DISTINCT FROM event.workspace_id
     ) THEN
       RAISE EXCEPTION 'science run event workspace lineage is inconsistent';
     END IF;

     IF EXISTS (
       SELECT 1
         FROM science_render_sessions AS session
         LEFT JOIN audit_subject_scope AS run_scope
           ON run_scope.domain_table = 'science_runs'
          AND run_scope.target_id = session.run_id
         LEFT JOIN audit_subject_scope AS version_scope
           ON version_scope.domain_table = 'science_artifact_versions'
          AND version_scope.target_id = session.artifact_version_id
        WHERE (session.run_id IS NOT NULL
               AND run_scope.workspace_id IS DISTINCT FROM session.workspace_id)
           OR (session.artifact_version_id IS NOT NULL
               AND version_scope.workspace_id IS DISTINCT FROM session.workspace_id)
     ) THEN
       RAISE EXCEPTION 'science render session workspace lineage is inconsistent';
     END IF;
   END
   $science_audit_scope_validation$`,
  `CREATE OR REPLACE FUNCTION science_audit_domain_mutation()
   RETURNS trigger
   LANGUAGE plpgsql
   AS $science_audit_domain_mutation$
   DECLARE
     row_data jsonb;
     prior_data jsonb;
     audit_workspace_id uuid;
     existing_workspace_id uuid;
     related_workspace_id uuid;
     audit_state text;
     audit_target_id uuid;
     emit_audit boolean := true;
     audit_actor_kind text;
     audit_actor_id text;
     audit_actor_label text;
     audit_action text;
     audit_reason text;
   BEGIN
     row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
     audit_target_id := (row_data ->> 'id')::uuid;

     IF TG_OP = 'DELETE' THEN
       SELECT scope.workspace_id
         INTO audit_workspace_id
         FROM audit_subject_scope AS scope
        WHERE scope.domain_table = TG_TABLE_NAME
          AND scope.target_id = audit_target_id;
     ELSE
       CASE TG_TABLE_NAME
          WHEN 'science_workspace_admissions' THEN
            audit_workspace_id := (row_data ->> 'workspace_id')::uuid;
         WHEN 'science_studies' THEN
           audit_workspace_id := (row_data ->> 'workspace_id')::uuid;
         WHEN 'science_artifacts' THEN
           SELECT scope.workspace_id
             INTO audit_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_studies'
              AND scope.target_id = (row_data ->> 'study_id')::uuid;
         WHEN 'science_artifact_versions' THEN
           SELECT scope.workspace_id
             INTO audit_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_artifacts'
              AND scope.target_id = (row_data ->> 'artifact_id')::uuid;
         WHEN 'science_uploads' THEN
           audit_workspace_id := (row_data ->> 'workspace_id')::uuid;
           SELECT scope.workspace_id
             INTO related_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_artifacts'
              AND scope.target_id = (row_data ->> 'artifact_id')::uuid;
           IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
             RAISE EXCEPTION 'science upload workspace does not match its artifact'
               USING ERRCODE = '23514';
           END IF;
         WHEN 'science_compute_profiles' THEN
           audit_workspace_id := (row_data ->> 'workspace_id')::uuid;
         WHEN 'science_runs' THEN
           SELECT scope.workspace_id
             INTO audit_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_studies'
              AND scope.target_id = (row_data ->> 'study_id')::uuid;
           SELECT scope.workspace_id
             INTO related_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_compute_profiles'
              AND scope.target_id = (row_data ->> 'compute_profile_id')::uuid;
           IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
             RAISE EXCEPTION 'science run workspace does not match its compute profile'
               USING ERRCODE = '23514';
           END IF;
         WHEN 'science_run_artifacts' THEN
           SELECT scope.workspace_id
             INTO audit_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_runs'
              AND scope.target_id = (row_data ->> 'run_id')::uuid;
           SELECT scope.workspace_id
             INTO related_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_artifact_versions'
              AND scope.target_id = (row_data ->> 'artifact_version_id')::uuid;
           IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
             RAISE EXCEPTION 'science run artifact workspace does not match its run'
               USING ERRCODE = '23514';
           END IF;
         WHEN 'science_run_events' THEN
           audit_workspace_id := (row_data ->> 'workspace_id')::uuid;
           SELECT scope.workspace_id
             INTO related_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_studies'
              AND scope.target_id = (row_data ->> 'study_id')::uuid;
           IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
             RAISE EXCEPTION 'science run event study workspace is inconsistent'
               USING ERRCODE = '23514';
           END IF;
           SELECT scope.workspace_id
             INTO related_workspace_id
             FROM audit_subject_scope AS scope
            WHERE scope.domain_table = 'science_runs'
              AND scope.target_id = (row_data ->> 'run_id')::uuid;
           IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
             RAISE EXCEPTION 'science run event run workspace is inconsistent'
               USING ERRCODE = '23514';
           END IF;
           SELECT mission.workspace_id
             INTO related_workspace_id
             FROM missions AS mission
            WHERE mission.id = (row_data ->> 'mission_id')::uuid;
           IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
             RAISE EXCEPTION 'science run event mission workspace is inconsistent'
               USING ERRCODE = '23514';
           END IF;
         WHEN 'science_render_sessions' THEN
           audit_workspace_id := (row_data ->> 'workspace_id')::uuid;
           IF row_data ->> 'run_id' IS NOT NULL THEN
             SELECT scope.workspace_id
               INTO related_workspace_id
               FROM audit_subject_scope AS scope
              WHERE scope.domain_table = 'science_runs'
                AND scope.target_id = (row_data ->> 'run_id')::uuid;
             IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
               RAISE EXCEPTION 'science render run workspace is inconsistent'
                 USING ERRCODE = '23514';
             END IF;
           END IF;
           IF row_data ->> 'artifact_version_id' IS NOT NULL THEN
             SELECT scope.workspace_id
               INTO related_workspace_id
               FROM audit_subject_scope AS scope
              WHERE scope.domain_table = 'science_artifact_versions'
                AND scope.target_id = (row_data ->> 'artifact_version_id')::uuid;
             IF related_workspace_id IS DISTINCT FROM audit_workspace_id THEN
               RAISE EXCEPTION 'science render artifact workspace is inconsistent'
                 USING ERRCODE = '23514';
             END IF;
           END IF;
         ELSE
           RAISE EXCEPTION 'unsupported science audit table: %', TG_TABLE_NAME
             USING ERRCODE = '23514';
       END CASE;

       IF TG_OP = 'UPDATE' THEN
         prior_data := to_jsonb(OLD);
         IF prior_data ->> 'id' IS DISTINCT FROM row_data ->> 'id' THEN
           RAISE EXCEPTION 'science audit targets cannot change primary identity'
             USING ERRCODE = '23514';
         END IF;
         SELECT scope.workspace_id
           INTO existing_workspace_id
           FROM audit_subject_scope AS scope
          WHERE scope.domain_table = TG_TABLE_NAME
            AND scope.target_id = audit_target_id;
         IF existing_workspace_id IS DISTINCT FROM audit_workspace_id THEN
           RAISE EXCEPTION 'science domain rows cannot move between workspaces'
             USING ERRCODE = '23514';
         END IF;

         -- Scheduler lease renewal is operational coordination, not a domain
         -- mutation. Its high write rate must not duplicate the actor-rich
         -- lifecycle evidence already recorded by the application.
         IF TG_TABLE_NAME = 'science_runs'
            AND (prior_data
                   - 'lease_owner'
                   - 'lease_expires_at'
                   - 'heartbeat_at'
                   - 'updated_at')
                = (row_data
                   - 'lease_owner'
                   - 'lease_expires_at'
                   - 'heartbeat_at'
                   - 'updated_at') THEN
           emit_audit := false;
         END IF;

         -- A finalizer heartbeat only renews its distributed ownership fence.
         -- The initial claim/release still changes state and remains audited.
         IF TG_TABLE_NAME = 'science_uploads'
            AND (prior_data
                   - 'expires_at'
                   - 'updated_at')
                = (row_data
                   - 'expires_at'
                   - 'updated_at') THEN
           emit_audit := false;
         END IF;

         -- Persisted cleanup retry/backoff is operational scheduling state.
         -- Initial terminalization and final quota release still change other
         -- fields and therefore retain their generic mutation audit.
         IF TG_TABLE_NAME IN (
              'science_artifact_versions',
              'science_uploads',
              'science_render_sessions'
            )
            AND (prior_data
                   - 'cleanup_attempts'
                   - 'cleanup_not_before'
                   - 'updated_at')
                = (row_data
                   - 'cleanup_attempts'
                   - 'cleanup_not_before'
                   - 'updated_at') THEN
           emit_audit := false;
         END IF;
       END IF;
     END IF;

     -- A run event is itself append-only audit evidence. Keep the trigger's
     -- workspace-lineage validation and scope mapping, but do not write a
     -- second generic audit row for every event insert.
     IF TG_TABLE_NAME = 'science_run_events' AND TG_OP = 'INSERT' THEN
       emit_audit := false;
     END IF;

     IF audit_workspace_id IS NULL THEN
       RAISE EXCEPTION 'science audit could not derive workspace for %.%', TG_TABLE_NAME, audit_target_id
         USING ERRCODE = '23514';
     END IF;

     audit_state := NULLIF(
       left(COALESCE(row_data ->> 'state', row_data ->> 'status', ''), 64),
       ''
     );

     -- Application mutations may set a transaction-local actor context on the
     -- same connection. Missing context is the deliberate recovery/system
     -- fallback; partial or malformed attribution aborts the mutation.
     audit_actor_kind := NULLIF(
       lower(left(current_setting('puppetmaster.science_actor_kind', true), 16)),
       ''
     );
     audit_actor_id := NULLIF(
       left(current_setting('puppetmaster.science_actor_id', true), 300),
       ''
     );
     audit_actor_label := NULLIF(
       left(current_setting('puppetmaster.science_actor_label', true), 200),
       ''
     );
     audit_action := NULLIF(
       left(current_setting('puppetmaster.science_action', true), 200),
       ''
     );
     audit_reason := NULLIF(
       left(current_setting('puppetmaster.science_reason', true), 1000),
       ''
     );

     IF audit_actor_kind IS NULL THEN
       IF audit_actor_id IS NOT NULL
          OR audit_actor_label IS NOT NULL
          OR audit_action IS NOT NULL
          OR audit_reason IS NOT NULL THEN
         RAISE EXCEPTION 'science audit context is partial'
           USING ERRCODE = '23514';
       END IF;
       audit_actor_kind := 'system';
       audit_actor_id := 'science-db';
       audit_actor_label := 'Science database trigger';
       audit_action := 'science.db.' || lower(TG_OP);
     ELSE
       IF audit_actor_kind NOT IN ('user', 'agent', 'system') THEN
         RAISE EXCEPTION 'science audit actor kind is invalid'
           USING ERRCODE = '23514';
       END IF;
       IF audit_action IS NULL THEN
         RAISE EXCEPTION 'science audit action is required'
           USING ERRCODE = '23514';
       END IF;
       IF audit_actor_kind IN ('user', 'agent') AND audit_actor_id IS NULL THEN
         RAISE EXCEPTION 'science audit actor identity is required'
           USING ERRCODE = '23514';
       END IF;
       IF audit_actor_kind = 'system' THEN
         audit_actor_id := COALESCE(audit_actor_id, 'science-runtime');
         audit_actor_label := COALESCE(audit_actor_label, 'Science runtime');
       END IF;
     END IF;

     IF emit_audit THEN
       INSERT INTO audit_log (
         workspace_id,
         actor_kind,
         actor_id,
         actor_label,
         action,
         target,
         detail
       )
       VALUES (
         audit_workspace_id,
         audit_actor_kind,
         audit_actor_id,
         audit_actor_label,
         audit_action,
         TG_TABLE_NAME || ':' || audit_target_id::text,
         jsonb_strip_nulls(jsonb_build_object(
           'operation', lower(TG_OP),
           'table', TG_TABLE_NAME,
           'state', audit_state,
            'admitted', CASE WHEN TG_TABLE_NAME = 'science_workspace_admissions'
              THEN (row_data ->> 'admitted')::boolean ELSE NULL END,
           'reason', audit_reason
         ))
       );
     END IF;

     IF TG_OP = 'DELETE' THEN
       DELETE FROM audit_subject_scope
        WHERE domain_table = TG_TABLE_NAME
          AND target_id = audit_target_id;
       RETURN OLD;
     END IF;

     INSERT INTO audit_subject_scope (domain_table, target_id, workspace_id)
     VALUES (TG_TABLE_NAME, audit_target_id, audit_workspace_id)
     ON CONFLICT (domain_table, target_id)
     DO UPDATE SET workspace_id = EXCLUDED.workspace_id;
     RETURN NEW;
   END
   $science_audit_domain_mutation$`,
  `DO $science_audit_triggers$
   DECLARE
     domain_table text;
   BEGIN
     FOREACH domain_table IN ARRAY ARRAY[
       'science_studies',
       'science_artifacts',
       'science_artifact_versions',
       'science_uploads',
       'science_compute_profiles',
       'science_runs',
       'science_run_artifacts',
       'science_run_events',
       'science_render_sessions'
     ]
     LOOP
       EXECUTE format(
         'DROP TRIGGER IF EXISTS science_domain_audit_mutation ON %I',
         domain_table
       );
       EXECUTE format(
         'CREATE TRIGGER science_domain_audit_mutation
            BEFORE INSERT OR UPDATE OR DELETE ON %I
            FOR EACH ROW EXECUTE FUNCTION science_audit_domain_mutation()',
         domain_table
       );
     END LOOP;
   END
   $science_audit_triggers$`,
];

const SCIENCE_QUARANTINE_RETENTION_DDL: readonly string[] = [
  `ALTER TABLE science_artifact_versions
     ADD COLUMN IF NOT EXISTS cleanup_eligible boolean NOT NULL DEFAULT false`,
  `UPDATE science_artifact_versions
      SET cleanup_eligible = true
    WHERE status IN ('pending', 'quarantined')
      AND metadata ? 'providerReferenceHash'`,
  `CREATE INDEX IF NOT EXISTS science_artifact_versions_cleanup_idx
     ON science_artifact_versions(cleanup_eligible, status, created_at)`,
  // Version 5 may already be installed. Replacing the function in version 6
  // applies bounded generic-audit behavior without recreating its triggers.
  SCIENCE_ATOMIC_AUDIT_DDL.find((statement) =>
    statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
  )!,
];

const SCIENCE_UPLOAD_FINALIZATION_FENCE_DDL: readonly string[] = [
  `ALTER TABLE science_uploads
     ADD COLUMN IF NOT EXISTS finalization_lease_id uuid`,
  // Version 6 may already be installed. Reapply the audit function so pure
  // finalizer-heartbeat updates do not create unbounded generic audit churn.
  SCIENCE_ATOMIC_AUDIT_DDL.find((statement) =>
    statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
  )!,
];

const SCIENCE_CLEANUP_RETRY_DDL: readonly string[] = [
  `ALTER TABLE science_artifact_versions
     ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0`,
  `ALTER TABLE science_artifact_versions
     ADD COLUMN IF NOT EXISTS cleanup_not_before timestamptz`,
  `ALTER TABLE science_uploads
     ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0`,
  `ALTER TABLE science_uploads
     ADD COLUMN IF NOT EXISTS cleanup_not_before timestamptz`,
  `ALTER TABLE science_render_sessions
     ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0`,
  `ALTER TABLE science_render_sessions
     ADD COLUMN IF NOT EXISTS cleanup_not_before timestamptz`,
  `CREATE INDEX IF NOT EXISTS science_artifact_versions_cleanup_retry_idx
     ON science_artifact_versions(cleanup_eligible, status, cleanup_not_before, created_at)`,
  `CREATE INDEX IF NOT EXISTS science_uploads_cleanup_retry_idx
     ON science_uploads(state, cleanup_not_before, updated_at)`,
  `CREATE INDEX IF NOT EXISTS science_render_sessions_cleanup_retry_idx
     ON science_render_sessions(state, cleanup_not_before, updated_at)`,
  SCIENCE_ATOMIC_AUDIT_DDL.find((statement) =>
    statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
  )!,
];

const SCIENCE_UPLOAD_TRANSFER_FENCE_DDL: readonly string[] = [
  `ALTER TABLE science_uploads
     ADD COLUMN IF NOT EXISTS transfer_lease_id uuid`,
];

const SCIENCE_ACTOR_ATTRIBUTED_AUDIT_DDL: readonly string[] = [
  SCIENCE_ATOMIC_AUDIT_DDL.find((statement) =>
    statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
  )!,
];
const SCIENCE_WORKSPACE_ADMISSION_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS science_workspace_admissions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     admitted boolean NOT NULL DEFAULT false,
     updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT science_workspace_admissions_workspace_unique UNIQUE (workspace_id)
   )`,
  SCIENCE_ATOMIC_AUDIT_DDL.find((statement) =>
    statement.includes("CREATE OR REPLACE FUNCTION science_audit_domain_mutation()")
  )!,
  `DROP TRIGGER IF EXISTS science_domain_audit_mutation ON science_workspace_admissions`,
  `CREATE TRIGGER science_domain_audit_mutation
     BEFORE INSERT OR UPDATE OR DELETE ON science_workspace_admissions
     FOR EACH ROW EXECUTE FUNCTION science_audit_domain_mutation()`,
];


export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "legacy-baseline",
    statements: LEGACY_DDL,
    allowUnavailableVector: true,
  },
  {
    version: 2,
    name: "science-operations-wp1",
    statements: SCIENCE_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 3,
    name: "science-run-resource-request-and-lease",
    statements: SCIENCE_RUN_RESOURCE_LEASE_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 4,
    name: "science-event-scope",
    statements: SCIENCE_EVENT_SCOPE_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 5,
    name: "science-domain-atomic-audit",
    statements: SCIENCE_ATOMIC_AUDIT_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 6,
    name: "science-quarantine-retention",
    statements: SCIENCE_QUARANTINE_RETENTION_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 7,
    name: "science-upload-finalization-fence",
    statements: SCIENCE_UPLOAD_FINALIZATION_FENCE_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 8,
    name: "science-cleanup-retry-backoff",
    statements: SCIENCE_CLEANUP_RETRY_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 9,
    name: "science-upload-transfer-fence",
    statements: SCIENCE_UPLOAD_TRANSFER_FENCE_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 10,
    name: "science-actor-attributed-atomic-audit",
    statements: SCIENCE_ACTOR_ATTRIBUTED_AUDIT_DDL,
    allowUnavailableVector: false,
  },
  {
    version: 11,
    name: "science-workspace-pilot-admission",
    statements: SCIENCE_WORKSPACE_ADMISSION_DDL,
    allowUnavailableVector: false,
  },
] as const;

const MIGRATION_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const migrationQueues = new WeakMap<DbHandle, Promise<void>>();
const MIGRATION_ADVISORY_LOCK_NAMESPACE = 1_347_240_276;
const MIGRATION_ADVISORY_LOCK_ID = 1_396_915_269;

/**
 * Apply schema changes in version order on both Postgres and PGlite. Statements
 * and their ledger row commit atomically. PostgreSQL instances serialize
 * migrators across processes with a transaction-scoped advisory lock; PGlite
 * handles serialize calls in-process before opening their transaction.
 */
export async function migrate(handle: DbHandle): Promise<void> {
  const previous = migrationQueues.get(handle) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await handle.db.transaction(async (tx) => {
      const scoped = tx as unknown as Db;
      if (handle.driver === "pg") {
        await scoped.execute(sql`
          SELECT pg_advisory_xact_lock(
            ${MIGRATION_ADVISORY_LOCK_NAMESPACE},
            ${MIGRATION_ADVISORY_LOCK_ID}
          )
        `);
      }

      await scoped.execute(sql.raw(MIGRATION_LEDGER_DDL));
      const ledgerResult = await scoped.execute(sql<{ version: number }>`
        SELECT version FROM schema_migrations ORDER BY version
      `);
      const ledgerRows =
        (ledgerResult as unknown as { rows?: Array<{ version: number }> }).rows ??
        (ledgerResult as unknown as Array<{ version: number }>);
      const applied = new Set(ledgerRows.map((row) => Number(row.version)));

      for (const migration of SCHEMA_MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        for (const [statementIndex, statement] of migration.statements.entries()) {
          const optionalVectorStatement =
            migration.allowUnavailableVector &&
            (statement.includes("EXTENSION") || statement.includes("vector("));
          if (!optionalVectorStatement) {
            await scoped.execute(sql.raw(statement));
            continue;
          }

          // A failed PostgreSQL statement aborts its transaction even when the
          // JavaScript exception is caught. Isolate optional pgvector DDL in a
          // savepoint so the migration and ledger can still commit together.
          const savepoint = `migration_${migration.version}_${statementIndex}`;
          await scoped.execute(sql.raw(`SAVEPOINT ${savepoint}`));
          try {
            await scoped.execute(sql.raw(statement));
            await scoped.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
          } catch {
            await scoped.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
            await scoped.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
          }
        }
        await scoped.execute(sql`
          INSERT INTO schema_migrations (version, name)
          VALUES (${migration.version}, ${migration.name})
        `);
      }
    });
  });
  migrationQueues.set(handle, current);
  try {
    await current;
  } finally {
    if (migrationQueues.get(handle) === current) migrationQueues.delete(handle);
  }
}
