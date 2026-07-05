# Installing Puppetmaster locally

Two paths: **Docker Compose** (fastest, runs the API + its dependencies in containers) or
**manual dev setup** (runs Postgres/Redis in Docker but the server and web app on your
machine with hot reload — this is how the project is actually developed).

## Prerequisites

- **Node.js 22+**
- **pnpm 10+** (`corepack enable` will pick up the version pinned in `package.json`)
- **Docker** and **Docker Compose** (for Postgres + Redis; not required if you only want to
  poke at the code with the embedded PGlite database and no queue — see the note at the end)

## Option A — Docker Compose (API only)

This brings up Postgres (with pgvector), Redis, and the built server container.

```bash
git clone <this-repo-url> puppetmaster
cd puppetmaster
docker compose -f docker/docker-compose.yml up --build
```

- API: http://localhost:4000/api/health
- Postgres: `localhost:5432` (user/db `puppetmaster`, password `puppetmaster` unless you set
  `POSTGRES_PASSWORD` in your shell before running `up`)
- Redis: `localhost:6379`

The web app is **not** built into this compose stack yet — run it separately per Option B's
web step, pointed at this API (it proxies `/api` to `localhost:4000` by default, so no config
is needed if you leave the API on its default port).

To stop: `docker compose -f docker/docker-compose.yml down` (add `-v` to also drop the
Postgres volume).

## Option B — Manual dev setup (recommended for development)

### 1. Install dependencies

```bash
git clone <this-repo-url> puppetmaster
cd puppetmaster
corepack enable
pnpm install
```

### 2. Start Postgres + Redis

Use just the two dependency services from the compose file (skip building the server image):

```bash
docker compose -f docker/docker-compose.yml up postgres redis
```

Or point at any Postgres 14+ / Redis 6+ you already have running — pgvector isn't required
for M1, but the server will try to enable it (`CREATE EXTENSION vector`) and silently skips
that step if it's unavailable.

### 3. Configure environment

The server reads plain environment variables — no `.env` loader is wired up yet, so export
them in your shell or prefix the run command:

| Variable       | Default                | Notes                                                   |
|----------------|-------------------------|----------------------------------------------------------|
| `DATABASE_URL` | *(unset → PGlite)*      | `postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster` |
| `REDIS_URL`    | *(unset → in-memory bus)* | `redis://127.0.0.1:6379`                                |
| `PORT`         | `4000`                  | server HTTP port                                        |
| `HOST`         | `0.0.0.0`               |                                                          |
| `ANTHROPIC_API_KEY` | *(unset)*          | enables agents on `claude-*` models                     |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | *(unset)* | enables `openai/<model>` agents (or any OpenAI-compatible runtime, e.g. vLLM) |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | used by `ollama/<model>` agents                     |
| `MCP_SERVERS` | *(unset → bundled utils connector)* | JSON array of MCP servers to spawn over stdio, e.g. `[{"name":"gh","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"tier":"write_approved"}]` |
| `MCP_DISABLE_BUNDLED` | *(unset)* | set to `1` to skip the bundled demo MCP connector      |
| `EMBEDDING_PROVIDER` | `mock`          | RAG memory embeddings: `mock` (keyless, deterministic), `openai` (needs a key/base URL), or `none` (keyword-only recall) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | embedding model when `EMBEDDING_PROVIDER=openai` |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | *(fall back to `OPENAI_*`)* | override the embeddings endpoint independently of the chat provider |
| `PGLITE_DATA_DIR` | *(unset → in-memory)* | persist the keyless PGlite store to disk; share it between the demo seeder and the server |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | *(unset → OIDC off)* | enable "Sign in with SSO" (OpenID Connect authorization-code flow); redirect URI is `<base>/api/auth/oidc/callback` |
| `OIDC_SCOPES` | `openid email profile` | requested OIDC scopes |
| `OIDC_DEFAULT_ROLE` | `member` | role granted to newly provisioned SSO users (the first user of an empty instance becomes owner) |
| `PUPPETMASTER_MASTER_KEY` | *(unset → vault off)* | passphrase sealing the credentials vault (AES-256-GCM); required to store secrets and resolve `{{credential:NAME}}` refs in `MCP_SERVERS` env |
| `HTTP_ALLOWED_HOSTS` | *(unset → unrestricted)* | comma-separated egress allowlist for the `http.get` tool, e.g. `api.github.com,acme.io` (subdomains match) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset → off)* | OTLP/HTTP collector base URL; finished missions are exported as gen_ai.* traces to `<base>/v1/traces` |
| `COPILOT_MODEL` | `mock` | model used for NL→workflow drafts and failure diagnoses (heuristic/deterministic under `mock`) |
| `MEMORY_CAP` | `200` | per-agent long-term memory cap; overflow evicts the lowest importance×recency-decay unpinned memories |

Without any provider keys, agents on the `mock` model still work — a scripted provider used
for demos and tests.

If you omit `DATABASE_URL` and `REDIS_URL`, the server falls back to an in-memory event bus
and an embedded PGlite database — handy for a quick look, but state doesn't persist across
restarts and cron triggers won't run (see the note at the end).

### 4. Build and run the server

```bash
pnpm build
DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster \
REDIS_URL=redis://127.0.0.1:6379 \
node apps/server/dist/main.js
```

Or for hot reload during development:

```bash
DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster \
REDIS_URL=redis://127.0.0.1:6379 \
pnpm --filter @puppetmaster/server dev
```

Check it's up: `curl localhost:4000/api/health` and `curl localhost:4000/api/bootstrap`.

### 5. Run the web app

In a second terminal:

```bash
pnpm --filter @puppetmaster/web dev
```

Open http://localhost:3000 — it proxies `/api` and the `/api/events` WebSocket to
`localhost:4000`.

### 6. First run — create the owner account

The first visit to http://localhost:3000 shows the **FIRST RUN · CREATE OWNER** screen
(no accounts exist yet). Enter a name, email, and a password of 8+ characters — this
account becomes the workspace **owner**. Afterwards the same screen is a normal sign-in.

Sessions are HttpOnly-cookie based and live 30 days. Additional users are created from the
**ADMIN** view (owner/admin only) with a role per member:

| Role      | Can do |
| --------- | ------ |
| `member`  | Observe everything (missions, agents, tools) and chat with agents |
| `builder` | + author/run workflows, manage agents, resolve approvals |
| `admin`   | + manage members and workspace branding |
| `owner`   | Everything; fixed at first-run setup, cannot be demoted or removed |

## Verifying the install

1. Open the web app, click **SAMPLE** to create the bundled example workflow.
2. Click **▶ RUN** — the mission trace panel (right) should show each node turning green in
   order and then pause on the amber approval gate.
3. Click **APPROVE** in the Approvals panel (left) — the mission should finish
   `SUCCEEDED` with an output value.
4. **Templates:** open **TEMPLATES**, click **USE THIS** on "Starter: transform & echo" —
   it clones into a live workflow on the canvas; run it. Any workflow/agent can be published
   back with **PUBLISH A TEMPLATE**.
5. **Semantic memory:** instantiate the **Research Scout** agent, chat `remember: <fact>` a
   few times, then in **AGENTS** → inspector use the memory **SEARCH** box — results come back
   ranked by pgvector cosine similarity (scores shown).
6. **Adaptive suggestions:** the **SUGGESTED** sidebar panel lists your most-run agents and
   workflows, most-used first.
7. **Audit log:** as an admin/owner, open **ADMIN** → **AUDIT LOG** — every LLM call, tool
   call, and approval decision (plus auth/membership changes) appears in an append-only trail,
   filterable by action.
8. **Signed webhooks:** on a workflow with a webhook trigger, the Canvas shows a **⚿ WEBHOOK**
   box with the URL and HMAC secret; calls to `/api/hooks/:id` must send
   `X-Puppetmaster-Signature: sha256=HMAC_SHA256(secret, body)` or they're rejected 401.

### Try the demo dataset

To explore a fully populated system instead of an empty one:

```bash
pnpm build
PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server seed:demo   # populate
PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server start        # serve it
```

Sign in with `avery.owner@acme.io` / `demodemo123` (or the admin/builder/member accounts it
prints) to browse seeded agents, workflows, missions, approvals, memories, and the audit log.

## Notes

- **No `DATABASE_URL`/`REDIS_URL` set:** the server still runs, using an in-process PGlite
  database (data is lost on restart) and an in-memory event bus (single-process only, no
  cron scheduling). Fine for a quick local trial; not for anything you want to keep.
- **pgvector** backs agent long-term memory: memories are embedded on save (default keyless
  `mock` embedder; set `EMBEDDING_PROVIDER=openai` for a real model) and recalled by cosine
  similarity, with keyword search as the fallback when the extension is unavailable.
- **Ports:** server `4000`, web dev server `3000`, Postgres `5432`, Redis `6379`. Change via
  the environment variables above (server) or `apps/web/vite.config.ts` (web dev server / proxy
  target).
