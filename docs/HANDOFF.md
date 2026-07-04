# Puppetmaster — Session Handoff

**Date:** 2026-07-04 · **Branch:** `claude/kickoff-prompt-continuation-cy021r` · **Milestone:** M1 complete

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

1. Owner review of M1 on `claude/kickoff-prompt-continuation-cy021r` (manual review pending).
2. **M2 — agent runtime** (see ARCHITECTURE.md §3.1): agent definitions + persistent state,
   the agentic tick loop (LLM ↔ tools) resumable to an approval gate, agent memory
   (short-term window + pgvector long-term — the `vector` extension is already enabled),
   schedules/event subscriptions, and the Command (chat) view. The model router (§3.5) and
   policy/approval engine (§3.6, already partially present via approval nodes) land here too.
3. M3 bridge (agent↔workflow, `agent` node is currently a passthrough stub) → M4 FUI shell →
   M5 ecosystem (see ARCHITECTURE.md §8).

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
