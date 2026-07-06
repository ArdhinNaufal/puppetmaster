# Puppetmaster — Session Handoff

**Date:** 2026-07-05 · **Branch:** `claude/kickoff-prompt-continuation-cy021r` · **Milestone:** M5 + audit log + OIDC/webhook-signing/demo-seed complete

This document lets a fresh Claude Code session (on any account) continue exactly where the
previous session left off. Read it together with `docs/PRD.md`, `docs/ARCHITECTURE.md`,
and `docs/DESIGN-LANGUAGE.md` — those are the source of truth for product and technical
decisions; this file only captures state and next steps.

## 0. Session-resume ritual (start here — supersedes the state snapshots below)

As of 2026-07-06 this repo uses persistent task artifacts instead of a hand-maintained
state snapshot (docs/AI-SDLC-INTEGRATION-PLAN.md, WP0). Begin every fresh session with:

> Read docs/AI-SDLC-INTEGRATION-PLAN.md §7, todos/active/, todos/backlog/, learnings.md,
> and docs/adr/. Tell me the current state of the project and what the next undone task
> is. Do NOT start work yet — confirm your understanding with me first.

If that prompt cannot reconstruct where the last session stopped, the artifacts are too
thin — fix them at the end of each session rather than growing this file. Decisions live
in `docs/adr/` (ADR-000 for the convention); gotchas live in `learnings.md`; task state
lives in `todos/`. The sections below remain accurate as of their date but are historical
context, no longer the live handoff mechanism.

## 1. Current state

- **M0 skeleton** (spec + monorepo) shipped on branch `claude/ai-agent-automation-platform-e7nwzf`
  (PR #1). **M1 — workflow engine + canvas — is now built on branch
  `claude/kickoff-prompt-continuation-cy021r`.**
- **M1 (verified end-to-end):** `pnpm install && pnpm build && pnpm typecheck` all green. A sample
  workflow (trigger → sandboxed code → branch → approval gate → action) was run through the
  browser UI and the REST API: it halted at the approval gate (`awaiting_approval`), resumed on
  approval, routed the branch correctly (false path skipped), and finished `succeeded` with the
  expected output. Verified against **real Redis (BullMQ + streams bus)** and **PGlite** persistence.
  - `packages/shared` — zod schemas extended: `WorkflowGraph`, `WorkflowNode` (+ position/retries/
    timeoutMs), per-kind configs (`TriggerConfig`/`ActionConfig`/`LogicConfig`/`CodeConfig`/
    `ApprovalConfig`), `MissionStep`, `StepStatus`, `Approval`.
  - `packages/db` **(new)** — Drizzle schema for `workspaces`, `workflows`, `workflow_versions`,
    `missions`, `mission_steps`, `approvals`; idempotent `migrate()` with `CREATE EXTENSION vector`
    (pgvector-ready). Dual driver: **node-postgres** when `DATABASE_URL` is set, else embedded
    **PGlite** (local/desktop/e2e). Repository functions in `repo.ts`.
  - `packages/kernel` — `RedisEventBus` (Redis streams) behind the existing `EventBus` interface;
    resumable **DAG executor** (topo order, per-node IO snapshots, retries + timeouts, edge-condition
    branching, approval gates with a persisted resume cursor); node handlers for trigger/action/
    logic/code/approval; worker-thread JS **sandbox** for code nodes; `BuiltinToolRegistry`
    (MCP-shaped `callTool`); **BullMQ** `QueueRunner` (+ cron job scheduler) and an `InlineRunner`
    fallback for Redis-free dev; `startWorkflow` orchestrator helper.
  - `apps/server` — wires DB+migrate, bus, executor, runner; REST for workflow CRUD, run, webhook
    trigger (`/api/hooks/:id`), missions + traces, approvals inbox/resolve, tools list, bootstrap;
    WS event stream. Chooses Redis/BullMQ when `REDIS_URL` is set, else in-memory + inline.
  - `apps/web` — React Flow (`@xyflow/react`) canvas with FUI node skins (corner brackets, kind
    glyphs, live status rings), node/edge inspector, add-node palette, save/run, workflow list,
    live mission trace, and approvals inbox — all wired to the WebSocket bus.
  - `docker/` — Compose stack (pgvector Postgres 17, Redis 7, server) + `server.Dockerfile` (M0).

## 2. Product decisions locked in interview (do not re-ask)

- **Audience:** small teams / SMBs, multi-user with RBAC.
- **UX:** chat Command view + visual canvas as equal citizens; FUI command-center design
  language (references: Spectre 007 MI6 UI by Rushes; "Patient" by Jan Gryc — hudsandguis.com);
  role-based dashboards, user-arrangeable panels, AI-adaptive UI, white-label branding.
- **Local scope:** local-first, cloud LLM APIs allowed, Ollama/vLLM supported.
- **Use cases:** personal assistant, business/ops automation, dev automation, knowledge/RAG.
- **Stack:** TypeScript full-stack (Fastify, React + React Flow, Postgres+pgvector, Redis/BullMQ).
- **Deploy:** Docker Compose first, Tauri desktop later.
- **Extensibility:** MCP as tool standard + built-in connectors + custom code nodes + template marketplace.
- **Autonomy:** human-in-the-loop by default; tiers read=auto / write=approved / destructive=confirmed.
- **Name:** Puppetmaster (final).

## 3. Next steps (roadmap)

1. Owner review of M1–M5 on `claude/kickoff-prompt-continuation-cy021r` (manual review
   pending).
2. **Research-driven roadmap**: `docs/RESEARCH-ROADMAP.md` (new) — literature + industry
   survey, gap analysis (G1–G12), and an 8-stage plan (security hardening → durable
   execution → knowledge/RAG → memory v2 → evals/observability → workflow copilot →
   MCP 2026 → router polish). Each stage executes only on the owner's explicit go-ahead.
3. **Remaining from the original roadmap**: Tauri desktop client (Phase 2 packaging —
   needs the desktop toolchain, not present in this env; the server core it wraps is ready).

### Hardening batch — OIDC, webhook signing, demo seed (verified)

- **OIDC login** (ARCHITECTURE.md §6): `oidc.ts` implements the authorization-code flow
  with `jose` — discovery (`.well-known/openid-configuration`), token exchange, and
  id_token **signature verification via the provider JWKS** (issuer + audience checked).
  Routes in `auth.ts`: `GET /api/auth/oidc/login` (state cookie → redirect to the IdP) and
  `/callback` (state check, code exchange, user provisioning, session). Enabled only when
  `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_REDIRECT_URI` are set;
  `GET /api/auth/status` advertises `oidcEnabled` and the Login screen shows an SSO button.
  First SSO user of an empty instance is provisioned owner; others get `OIDC_DEFAULT_ROLE`
  (member). Verified end-to-end against a mock IdP (RS256/JWKS round trip, state mismatch
  rejected, owner provisioning, session minted).
- **Signed webhooks**: `workflows.webhook_secret` column; a webhook-trigger workflow gets an
  HMAC secret on create/save. `/api/hooks/:id` enforces `X-Puppetmaster-Signature:
  sha256=HMAC_SHA256(secret, rawBody)` (constant-time; raw body captured by a content-type
  parser). Reveal (`GET /api/workflows/:id/webhook`, builder+) and rotate
  (`POST …/webhook/rotate`) endpoints; Canvas shows a ⚿ WEBHOOK reveal box with the URL,
  secret, signing scheme, and rotate. Verified: unsigned/bad-sig → 401, valid → 202,
  member → 403 on reveal.
- **Demo seed** (`seed-demo.ts`, `pnpm --filter @puppetmaster/server seed:demo`): drives the
  **real kernel** (mock model, inline dispatch) to populate a lived-in workspace — "ACME OPS"
  branding, 4 users across all roles (password `demodemo123`), 3 agents + 3 workflows from
  templates, 12 missions across succeeded/awaiting_approval, 2 pending approvals, embedded
  memories, and the full audit trail. `PGLITE_DATA_DIR` (new, in `createDb`) lets the seeder
  and server share one on-disk PGlite store. Verified: seed → start server on the same store
  → owner logs in, all views populated.

### Audit log — Policy & Approval Engine §3.6 (verified in the browser)

- **DB**: `audit_log` table (`workspaceId`, `actorKind` user|agent|system, `actorId`,
  `actorLabel`, `missionId`, `action`, `target`, `detail` jsonb) + `audit-repo.ts`
  (`appendAudit` / `listAudit`). Append-only by contract — no update/delete surface.
- **Kernel**: an `AuditSink` (`audit-sink.ts`) is injected into the `WorkflowExecutor` and
  `AgentRuntime`. The runtime records every `llm.call` (per model step, with usage) and
  `tool.call` (including gated ones, with approved/ok flags); the executor records action
  nodes as `tool.call`. All best-effort — a logging failure never breaks execution.
- **Server**: `audit.ts` binds the sink to the table and runs a bus **projector** that adds
  `mission.started` / `mission.finished` / `approval.requested` (actor resolved from the
  mission, cached). `approval.decision` is written at the resolve endpoint with the deciding
  **user's** identity; `auth.login`, `workspace.setup`, `member.create` / `.role` / `.remove`
  are written in `auth.ts` with the acting user. `GET /api/audit` (admin+; RBAC rule added,
  optional `action`/`limit` filters).
- **Web**: an AUDIT LOG panel in the Admin view — time / actor (color-coded user·agent·system
  badge) / action / target, with an action filter and refresh.
- **Verified** (API + Playwright, real Redis + PGlite): a run producing llm.call ×4,
  tool.call ×2, approval.requested + approval.decision (by the deciding user), member.create,
  workspace.setup, mission start/finish — all with correct actors; member gets 403 on
  `/api/audit`; the Admin filter isolates a single action.

### M5 — ecosystem: templates, RAG, adaptive UI (verified in the browser)

- **Templates / marketplace** (PRD §6): new `templates` table (`kind` workflow|agent,
  `spec` jsonb, `builtin`, nullable `workspace_id` — null = first-party catalog, set =
  workspace-published) + `template-repo.ts`. Five first-party templates seeded idempotently
  on boot (`apps/server/src/seeds.ts`: three workflows, two agents). REST: `GET
  /api/templates`, `POST /api/templates/:id/instantiate` (clone → live workflow/agent),
  `POST /api/templates` (publish an existing workflow/agent), `DELETE /api/templates/:id`
  (published only; builtins protected). Browsing is member-open; instantiate/publish/delete
  are builder+ (RBAC rule added). **Web**: TEMPLATES view — cards grouped by kind with
  category + first-party/published tags, "USE THIS" (routes to canvas/command), a publish
  picker, and delete for published.
- **RAG semantic memory** (PRD §5, ARCHITECTURE.md §3.1): `packages/kernel/src/embeddings.ts`
  — `EmbeddingProvider` with a keyless deterministic `MockEmbeddingProvider` (stopword-filtered
  bag-of-words hashing, default) and `OpenAICompatEmbeddingProvider` (`/v1/embeddings`,
  requests `dimensions:1024`); every vector is `resizeTo(1024)` to fit the column. Memories
  are embedded on `memory__save` and recalled by pgvector cosine (`<=>`) — `saveMemory` +
  new `setMemoryEmbedding` / `searchMemoriesByVector` in the db package; the runtime's
  `recall()` prefers vector search and falls back to keyword. Config: `EMBEDDING_PROVIDER`
  (`mock`|`openai`|`none`), `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`/`_API_KEY`. **Web**: a
  ranked memory **SEARCH** box in the agent inspector (scores shown), backed by
  `GET /api/agents/:id/memory-search`.
- **Adaptive UI** (PRD §5 "surface frequently used"): `GET /api/suggestions` derives the
  most-run agents/workflows from mission counts (`missionUsage` repo). **Web**: a SUGGESTED
  sidebar panel (arrangeable like the others; per-role preset placement) that jumps to the
  agent/workflow on click, refreshed on every mission start/finish.
- **Deferred**: Tauri desktop (Phase 2 packaging).
- **Verified** (API + Playwright, real Redis + PGlite): 5 builtin templates seeded;
  instantiate starter workflow → runs green (`HELLO, PUPPET`); publish → appears as a
  workspace template; member gets 403 on instantiate but can browse; instantiate Research
  Scout agent → teach 3 facts → semantic search ranks the DB fact top with a cosine score;
  SUGGESTED lists the used agent/workflow with run counts.

### M4b — auth, members & RBAC (verified in the browser)

- **DB**: `users`, `sessions`, `memberships(role)`, `ui_preferences` tables + repos
  (`packages/db/src/auth-repo.ts`). Roles locked from PRD: **owner / admin / builder /
  member** (`Role` + `ROLE_RANK` in `@puppetmaster/shared`).
- **Session auth** (`apps/server/src/auth.ts`): scrypt password hashes (node:crypto, no new
  deps), opaque tokens in an HttpOnly `pm_session` cookie (30-day TTL), login/logout/me.
  First-run flow: `GET /api/auth/status` → `POST /api/auth/setup` creates the founding
  **owner** (only while zero users exist; 409 afterwards).
- **RBAC at the gateway** (ARCHITECTURE.md §6): one `onRequest` hook resolves the session
  and enforces a central method+path policy for every `/api` route including the WS
  upgrade. Public allowlist: health, auth handshake, `/api/hooks/:id` (webhooks).
  member = read + agent chat · builder = + workflow/agent mutations + approvals ·
  admin = + members + workspace branding · owner = fixed at setup (cannot be demoted,
  removed, or re-granted). Members CRUD: `GET/POST /api/members`, `PUT/DELETE
  /api/members/:userId` (self-role-change and owner-change rejected).
- **Web**: FUI login/setup gate (`Login.tsx`), auth-gated shell, user chip + sign-out in
  the rail. **Role dashboards**: nav filtered per role (member has no CANVAS/ADMIN) and a
  per-role home view (member→Command, builder→Canvas, admin/owner→Missions); mutating
  controls (new agent/workflow, approve/reject, agent inspector) hidden or read-only below
  builder. **Admin view** gained the members roster: add member (email/password/role),
  inline role select, remove.
- **Arrangeable panels**: sidebar sections (agents/workflows list, approvals) reorder via
  ▲▼ and collapse via −/＋; mission-trace panel collapses. Layout persists per user in
  `ui_preferences` (debounced `PUT /api/me/preferences`), with per-role presets as the
  default (e.g. member starts with approvals collapsed).
- **Verified** (API + Playwright, real Redis + PGlite): full matrix — first-run owner
  setup; 401 unauthenticated; member 403 on workflow create/workspace PUT/members;
  builder creates+runs the gated sample workflow and approves it; admin adds/re-roles/
  removes members; owner immutability; logout revokes the session; panel rearrangement
  survives reload; webhook stays public.

### M4 — FUI shell core (verified in the browser)

- **`packages/ui` (new)**: the design system package (ARCHITECTURE.md §7) — `Panel`
  (corner brackets + small-caps title rail), `Stat` telemetry tile, `StatusDot`/`StatusText`
  (shared mission palette), `Chip`, `TierBadge`; tokens + component styles ship as
  `@puppetmaster/ui/styles.css` (imported once in `apps/web/src/main.tsx`).
- **Missions view**: stat tiles (total/running/gated/failed), mission log table (kind,
  status, duration, nested `↳ parent` linkage), row click loads the trace panel; the trace
  shows **token cost** summed from the tick's model-call steps.
- **Agents view**: roster cards (status ring, model, tier badge) + inspector — edit persona,
  model, autonomy, cron schedule, and tool grants inline; scratchpad and long-term memory
  displayed; "open channel" jumps to Command chat.
- **Tools view**: the shared catalog grouped by server/namespace with autonomy tier badges —
  built-ins, bridge workflow tools, and MCP connector tools all visible.
- **Admin view**: workspace-scoped white-label branding (brand name + accent hue) persisted
  in `workspaces.branding` (jsonb, server-side merge) and applied to the shell on load.
  Verified: rename to "ACME OPS" with an amber accent survives reload.
- Nav rail: COMMAND · CANVAS · MISSIONS · AGENTS · TOOLS · ADMIN.

### M3 — the bridge (verified end-to-end)

- **Workflow → agent** (`packages/kernel/src/bridge-tools.ts` + executor): the `agent` node
  is real — `AgentNodeConfig {agentId, message}` with `{{input}}` templating; the executor's
  injected `AgentInvoker` runs the agent tick as a child mission (`parent_mission_id` set)
  and awaits its result, polling through approval pauses until the node's `timeoutMs`
  (sync-with-timeout mode from §3.3).
- **Agent → workflow**: `workflow.list` / `workflow.run` / `workflow.create_draft` join the
  shared tool catalog. `workflow.run` accepts id or exact name, runs the child workflow
  mission with the agent's mission as parent, and returns `{missionId, status, output}`.
  `create_draft` is write-tier (pauses for approval); `run` is read-tier — gating lives on
  the workflow's own approval nodes.
- **MCP tool layer** (`packages/kernel/src/mcp.ts` + `packages/mcp-connectors`, new):
  `connectMcpServer` speaks MCP over stdio (official `@modelcontextprotocol/sdk`), merging
  server tools into the same catalog (`<name>.<tool>`, per-server autonomy tier). A bundled
  first-party connector (`puppetmaster-mcp-utils`: upper/word_count/uuid) is registered by
  default; configure more via `MCP_SERVERS` JSON env (disable bundled with
  `MCP_DISABLE_BUNDLED=1`).
- **Shared tool grants**: `agents.tool_grants` (e.g. `["util.echo","workflow.*"]`) filters
  the tools advertised to the model **and** is enforced at execution. Empty = full catalog.
- **Web**: agent node default config on the canvas; mission trace shows a "view parent
  mission" chip on nested missions.
- **Verified** (API + browser, real Redis + PGlite): agent called `mcputil.upper` via MCP;
  agent ran the "Doubler" workflow via `workflow.run` (child mission nested, output
  propagated); a workflow with an agent node ran green from the canvas (child agent mission
  nested); a grants-restricted agent was refused an ungranted tool at execution.

### M2 — agent runtime (verified end-to-end)

- **Model router** (`packages/kernel/src/model-router.ts`, ARCHITECTURE.md §3.5): one
  `ModelProvider` abstraction with `AnthropicProvider` (official `@anthropic-ai/sdk`),
  `OpenAICompatProvider` (OpenAI/Ollama/vLLM via chat/completions), and a scripted
  `MockProvider` for keyless dev/e2e. Routing by model prefix (`claude-*`, `openai/*`,
  `ollama/*`, `mock*`); token usage accumulated per call. Env: `ANTHROPIC_API_KEY`,
  `OPENAI_BASE_URL`/`OPENAI_API_KEY`, `OLLAMA_BASE_URL`.
- **Agent runtime** (`agent-runtime.ts`, §3.1): each mission is one resumable **tick** —
  an LLM↔tools loop persisting every model call and tool call as mission steps. Tool calls
  are gated by autonomy tier (read = auto; write/destructive = approval pauses the tick with
  a resume cursor, exactly like workflow approval gates). Memory: short-term window from
  `agent_messages`, long-term `agent_memories` (keyword recall now; `embedding vector(1024)`
  column ready for pgvector similarity), and a structured `scratchpad` jsonb on the agent.
  Runtime tools: `memory__save`, `memory__search`, `scratchpad__set`; registry tools exposed
  as `server__tool` with tier annotations (`email.send` is the write-tier demo connector).
- **Queue**: `QueueRunner`/`InlineRunner` now take a `MissionDispatcher`; the server routes
  by mission kind (workflow → executor, agent → runtime). Cron schedulers support both
  workflows and agents (`agents.schedule`, re-armed on boot).
- **Server**: agent CRUD (`/api/agents`), chat (`POST /api/agents/:id/chat` → queued tick),
  history (`/messages`), memories (`/memories`). Approval resolution resumes agent ticks
  through the same dispatcher.
- **Web**: COMMAND/CANVAS view switcher in the rail; Command view = agent roster + chat
  (tool calls/results rendered inline) wired to `agent.message` bus events; approvals inbox
  shared across views. Canvas regression-tested after the refactor.
- **Verified** (browser + API against real Redis + PGlite): plain chat, `remember:` →
  `memory__save` → fact persisted, `use email.send {...}` → tick paused `awaiting_approval`
  → APPROVE → tool executed → mission `succeeded`; canvas sample workflow still green.

### M1 runtime notes for the next session

- Run locally: `pnpm build`, then `REDIS_URL=redis://127.0.0.1:6379 node apps/server/dist/main.js`
  (PGlite is in-memory unless a `dataDir` is wired; set `DATABASE_URL` to use Postgres). Web:
  `pnpm --filter @puppetmaster/web dev` (proxies `/api` → :4000). Without `REDIS_URL` the server
  falls back to the in-memory bus + inline runner (no cron).
- Built-in tools for action nodes live in `BuiltinToolRegistry` (`util.echo/now/merge`, `math.sum`,
  `http.get`); real MCP servers replace these in M3 behind the same `callTool` surface.
- Code-node sandbox is a worker thread + `node:vm` with a termination deadline; upgrade to
  `isolated-vm` if stronger isolation is needed.

## 4. Conventions

- pnpm workspace; `pnpm build` / `pnpm typecheck` must stay green before every push.
- Commits pushed to the designated `claude/*` branch; no pushes to `main`.
- Zod schemas in `@puppetmaster/shared` are the single source of type truth across apps.

## 5. Kick-off prompt for the new session

See `docs/KICKOFF-PROMPT.md` — paste its contents as the first message in the new session.
