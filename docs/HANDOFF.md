# Puppetmaster — Session Handoff

**Date:** 2026-07-04 · **Branch:** `claude/kickoff-prompt-continuation-cy021r` · **Milestone:** M4 core complete

This document lets a fresh Claude Code session (on any account) continue exactly where the
previous session left off. Read it together with `docs/PRD.md`, `docs/ARCHITECTURE.md`,
and `docs/DESIGN-LANGUAGE.md` — those are the source of truth for product and technical
decisions; this file only captures state and next steps.

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

1. Owner review of M1–M4 on `claude/kickoff-prompt-continuation-cy021r` (manual review
   pending).
2. **Remaining M4 items (deferred, need auth first)**: session auth + users/memberships +
   RBAC at the gateway (ARCHITECTURE.md §6), then role-based dashboards and per-user
   arrangeable panel layouts (`ui_preferences`). Branding is done; the layout engine and
   role presets should build on the `packages/ui` Panel primitives.
3. **M5 — ecosystem**: templates/marketplace, RAG pipeline (pgvector column is ready),
   adaptive UI, Tauri desktop.

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
