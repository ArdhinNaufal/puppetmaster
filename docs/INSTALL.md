# Installing Puppetmaster locally

Two paths: **Docker Compose** (fastest, runs the API + its dependencies in containers) or
**manual dev setup** (runs Postgres/Redis in Docker but the server and web app on your
machine with hot reload — this is how the project is actually developed).

## Prerequisites

- **Node.js 22+**
- **pnpm 10+** (`corepack enable` will pick up the version pinned in `package.json`)
- **Docker** and **Docker Compose** (for Postgres + Redis and required for CLAUDE/Workshop
  workbenches; not required for an embedded-PGlite quick look with no shell execution)

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

This Compose server is also **not a CLAUDE workbench host**. It has neither a Docker client nor
access to the host Docker daemon, and the service currently passes only its database/Redis
settings. Run the server on the host via Option B when using the CLAUDE page. Giving an API
container access to the host Docker socket would be a separate privileged deployment decision,
not an implicit setup step.

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

Put local settings in the repository-root `.env`, export them in the shell, or prefix the run
command. The `dev` and `start` package commands load the root `.env` before the runtime starts;
explicit process variables retain precedence. The Compose service does not forward arbitrary
root `.env` values into its container.

| Variable       | Default                | Notes                                                   |
|----------------|-------------------------|----------------------------------------------------------|
| `DATABASE_URL` | *(unset → PGlite)*      | `postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster` |
| `REDIS_URL`    | *(unset → in-memory bus)* | `redis://127.0.0.1:6379`                                |
| `PORT`         | `4000`                  | server HTTP port                                        |
| `HOST`         | `0.0.0.0`               |                                                          |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` | *(unset)* | direct Anthropic readiness requires an API key or auth token; `ANTHROPIC_BASE_URL` selects a compatible endpoint but is not authentication by itself |
| `CLAUDE_CODE_USE_BEDROCK` | *(unset)* | selects Bedrock; readiness ignores unrelated direct-Anthropic keys and requires `AWS_BEARER_TOKEN_BEDROCK` or an `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` pair |
| `CLAUDE_CODE_USE_FOUNDRY` | *(unset)* | selects Foundry; readiness ignores direct-Anthropic keys and requires both `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_BASE_URL` |
| `CLAUDE_CODE_USE_VERTEX` | *(unset)* | selects Vertex, but readiness deliberately remains unavailable because the workbench does not forward or prove Google ADC |
| `WORKBENCH_MODE` | *(unset → disabled)*  | set to `docker` to enable isolated Workshop and Claude Code execution |
| `WORKBENCH_IMAGE` | `puppetmaster-workbench:spike` | image built from `docker/workbench.Dockerfile`          |
| `WORKBENCH_EGRESS_PROXY_IMAGE` | `puppetmaster-egress-proxy:spike` | allowlisting proxy image built from `docker/egress-proxy.Dockerfile` |
| `WORKBENCH_EGRESS_ALLOW` | *(unset)*      | comma-separated proxy destinations; each CLAUDE-page provider requires its effective API hostname |
| `WORKBENCH_EGRESS_OUTBOUND_NET` | `bridge` | Docker network that gives only the proxy its outbound route |
| `WORKBENCH_MEMORY` / `WORKBENCH_CPUS` / `WORKBENCH_PIDS_LIMIT` | `512m` / `1` / `256` | per-container resource limits |
| `WORKBENCH_NETWORK` | `none` | network used when the egress allowlist is empty; changing it weakens the default deny boundary |
| `OPENAI_API_KEY` / `OPENAI_API_BASE` / `OPENAI_BASE_URL` | *(unset)* | enables `openai/<model>` agents and the OpenAI/Aider provider on the CLAUDE page; Aider uses `OPENAI_API_BASE`, with `OPENAI_BASE_URL` mirrored when that value is absent |
| `CLAUDE_CODE_OPENAI_MODEL` | `openai/gpt-5.6` | default model shown for new OpenAI sessions; `OPENAI_CODE_MODEL`, `OPENAI_MODEL`, and an `openai/*` `DELEGATE_MODEL`/`COPILOT_MODEL` are also recognized |
| `CLAUDE_CODE_ALLOW_INSECURE_OPENAI_BASE_URL` | *(unset)* | set to `1` only for a trusted non-HTTPS remote custom endpoint. Literal loopback/unspecified hosts remain rejected because they address the disposable container; plaintext `host.docker.internal` is allowed for an explicit Docker-host mapping |
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
| `MCP_REGISTRY_URL` | `https://registry.modelcontextprotocol.io` | registry endpoint proxied by `GET /api/mcp/registry` |
| `COPILOT_MODEL` | `mock` | model used for NL→workflow drafts and failure diagnoses (heuristic/deterministic under `mock`) |
| `MEMORY_CAP` | `200` | per-agent long-term memory cap; overflow evicts the lowest importance×recency-decay unpinned memories |

#### Build the CLAUDE workbench images

The normal server deliberately does not build or pull privileged execution images. Build both
local images before enabling `WORKBENCH_MODE=docker`:

```bash
docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
docker build -t puppetmaster-egress-proxy:spike -f docker/egress-proxy.Dockerfile docker
```

Set at most one of the Bedrock, Foundry, and Vertex transport flags; multiple cloud flags are an
invalid configuration. Every selected transport also needs its effective endpoint hostname in
`WORKBENCH_EGRESS_ALLOW`.

Rebuild after changing either Dockerfile or `docker/workbench-sync.mjs` /
`docker/egress-proxy.mjs`. The Docker verifier/preflight paths fingerprint those declared inputs and
rebuild their test images when required; normal server startup only probes the configured workbench
and proxy images and does not build, pull, or replace an absent image.

#### OpenAI provider on the CLAUDE page

The existing Anthropic provider remains the default. To enable the additional OpenAI path, put
the following values in the repository-root `.env` (or export them before starting the server):

For a complete beginner walkthrough covering both providers, project preparation, Plan, Execute,
authorization, diff review, cancellation, and troubleshooting, use the
[CLAUDE Code Feature Manual](./CLAUDE-CODE-MANUAL.md).

```dotenv
WORKBENCH_MODE=docker
OPENAI_API_KEY=your-platform-api-key
WORKBENCH_EGRESS_ALLOW=api.openai.com,github.com
CLAUDE_CODE_OPENAI_MODEL=openai/gpt-5.6
```

For an OpenAI-compatible endpoint, set `OPENAI_API_BASE` (or `OPENAI_BASE_URL`) and allowlist that
URL's hostname instead of `api.openai.com`. Literal `localhost`, `127.0.0.1`, `::1`, and `0.0.0.0`
URLs are rejected even with the insecure override because they resolve inside the disposable
provider container. Use `host.docker.internal` for an explicitly mapped service on the Docker
host; trusted plaintext remote endpoints require `CLAUDE_CODE_ALLOW_INSECURE_OPENAI_BASE_URL=1`.
The model input remains free-form but is normalized
to `openai/<model>` so an OpenAI session cannot silently select another provider. Provider
credentials stay server-side. Their values are supplied only in the Docker CLI child environment;
`docker exec` receives names (`-e NAME`), not `NAME=value`, and persistent holder
`Config.Env`/`Config.Cmd` contains neither configured secret values nor provider commands. Secrets
are never stored in the browser or base container environment. At server startup, readiness also
verifies that the configured workbench image contains the pinned Aider `0.86.1` binary/helper and
that the configured proxy image exists locally; credentials and an allowlisted host alone are not
reported as ready.

Anthropic Plan mounts the durable project read-only. OpenAI Plan uses a sanitized disposable copy.
After approval, both Anthropic and OpenAI Execute edit an attempt-owned scratch copy and use the
same signed, journaled copy-back/DB-ledger protocol; neither provider receives the durable project
writable.

Build and run the complete deterministic, keyless suite with:

```powershell
pnpm test
```

`pnpm test` builds fresh `dist` output once, then runs the architecture dependency gate,
persistence, routes, stream/parser, OpenAI/Anthropic dispatch, cancellation, server-hardening,
provider-readiness, environment-bootstrap, names-only secret transport, signed commit-wins
copy-back/recovery, pre-intent exact-generation and legacy-orphan recovery, tamper quarantine, and
runner shutdown/drain checks. Individual `verify:*` aliases that import generated code also rebuild
first, so they cannot silently exercise stale output.

Docker boundary checks are separate because they require a running daemon (and the egress check
requires outbound access):

```powershell
pnpm verify:docker
```

That aggregate runs workbench lifecycle/resource/network checks, holder and scratch/state metadata
secrecy checks, exact-attempt cancellation with concurrent holder/volume teardown, per-project
shared/exclusive locking, signed Claude Execute scratch copy-back, the egress proxy check, the
offline pinned-Aider Plan isolation check, and an Anthropic control-plane turn that forcibly uses a
dummy credential even if the shell contains real provider keys. The Plan fixture includes hostile
tracked `.env`/`.aider*` controls and proves the real Aider process reaches its expected offline
provider failure without modifying the durable repository. Mocked OpenAI Execute/copy-back plumbing
is covered by `pnpm test`; this Docker aggregate does not prove a successful OpenAI Execute
copy-back. The aggregate is no-cost: it neither proves provider success nor consumes provider
tokens.

An opt-in live OpenAI request consumes API tokens and therefore is not part of the deterministic
suite. Run it explicitly when you want provider-level proof:

```powershell
pnpm verify:openai-live
```

This live check forces a successful OpenAI response; an API failure cannot be reported as a pass.
It currently exercises a Plan turn, not an approved Execute edit.

Mutating `bench.delegate(cli=aider)` intentionally fails closed because workflow nodes do not yet
own the durable run ID/generation required by copy-back recovery. Aider Plan remains available;
OpenAI mutation is supported through the CLAUDE page Execute flow. Do not bypass this restriction
with a direct writable workbench command.

Run one active Puppetmaster server against one Docker daemon for CLAUDE execution. Database claims
are durable, but startup copy-back reconciliation has no distributed lease/fencing and named
filesystem locks do not span Docker hosts. Active-active or multi-host CLAUDE execution is not
supported by this version.

If startup reports a **quarantined copy-back**, its journal or receipt could not be authenticated.
The runtime deliberately leaves that project blocked and provides no in-place “mark clean” API:
guessing whether files committed would violate the commit-wins boundary. Stop the server, back up
the database and the affected `pm-workbench-vol-<project-id>` plus `pm-exec-*` volumes, and inspect
the evidence with a read-only query such as:

```sql
SELECT id, project_id, claude_run_id, execution_id, execution_generation, error, created_at
FROM workbench_copybacks
WHERE state = 'quarantined';
```

The supported recovery is to retain that project/volume as evidence and create a replacement
project from the trusted `repoRef`. Reusing the same project ID requires a reviewed restore or data
migration that reconciles the run, mission, session, ledger, and execution volumes together. Never
clear only `workbench_copybacks.state`; that can falsely release unknown file state.

Automated typecheck/build is not UI acceptance. Before calling a deployment complete, manually
exercise the CLAUDE view in a browser: create both provider types; queue Plan and Execute; approve
and reject an edit; cancel an active turn; reload during streaming; page older events; inspect
transcript/tool/task/diff/usage tabs; and check keyboard focus, a narrow viewport, and reduced
motion. A local no-provider control smoke is recorded in
`docs/CLAUDE-CODE-IMPLEMENTATION.md`; the live interaction matrix remains pending until it is
actually run.

Without any provider keys, agents on the `mock` model still work — a scripted provider used
for demos and tests.

If you omit `DATABASE_URL` and `REDIS_URL`, the server falls back to an in-memory event bus
and an embedded PGlite database — handy for a quick look, but state doesn't persist across
restarts and cron triggers won't run (see the note at the end).

### 4. Build and run the server

Put the persistent service connections in the repository-root `.env`:

```dotenv
DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster
REDIS_URL=redis://127.0.0.1:6379
```

Then build and start the server:

```powershell
pnpm build
pnpm --filter @puppetmaster/server start
```

The server bootstrap loads the repository-root `.env` before importing the runtime; explicit shell
variables still take precedence. Set `PUPPETMASTER_ENV_FILE` to use a different file. Direct
`node apps/server/dist/main.js` invocations intentionally bypass this convenience for controlled
tests; use `node --env-file=.env apps/server/dist/main.js` when invoking that entry point manually.

Or for hot reload during development:

```powershell
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
