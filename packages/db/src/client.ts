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
}): Promise<DbHandle> {
  const url = opts?.databaseUrl ?? process.env.DATABASE_URL ?? null;

  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return { db, driver: "pg", close: () => pool.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const client = await PGlite.create({
    dataDir: opts?.dataDir,
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
  `CREATE INDEX IF NOT EXISTS mission_steps_mission_idx ON mission_steps(mission_id)`,
  `CREATE INDEX IF NOT EXISTS missions_workspace_idx ON missions(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status)`,
];

export async function migrate(handle: DbHandle): Promise<void> {
  for (const statement of DDL) {
    try {
      await handle.db.execute(sql.raw(statement));
    } catch (err) {
      // `CREATE EXTENSION vector` may be unavailable on a stock Postgres without
      // pgvector; the rest of the schema must still apply. Surface anything else.
      if (statement.includes("EXTENSION")) continue;
      throw err;
    }
  }
}
