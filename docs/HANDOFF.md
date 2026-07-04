# Puppetmaster — Session Handoff

**Date:** 2026-07-04 · **Branch:** `claude/ai-agent-automation-platform-e7nwzf` · **PR:** [#1](https://github.com/ArdhinNaufal/puppetmaster/pull/1)

This document lets a fresh Claude Code session (on any account) continue exactly where the
previous session left off. Read it together with `docs/PRD.md`, `docs/ARCHITECTURE.md`,
and `docs/DESIGN-LANGUAGE.md` — those are the source of truth for product and technical
decisions; this file only captures state and next steps.

## 1. Current state

- **PR #1 is open** against `main`, containing two commits: the full spec (PRD, architecture,
  design language) and the **M0 monorepo skeleton**. Checks green, mergeable, awaiting the
  owner's manual review. Nothing else exists on `main` beyond the initial README.
- **M0 skeleton (verified working):** `pnpm install && pnpm build` is green;
  `node apps/server/dist/main.js` serves `/api/health` and a WebSocket event stream at `/api/events`.
  - `apps/server` — Fastify 5 + @fastify/websocket, port 4000.
  - `apps/web` — Vite + React 19 shell with FUI CSS tokens (proxying `/api` → :4000, port 3000).
  - `packages/kernel` — `EventBus` interface + `InMemoryEventBus` (Redis streams planned for M1).
  - `packages/shared` — zod schemas: `AgentDefinition`, `WorkflowDefinition` (nodes/edges),
    `Mission`, `MissionStatus`, `AutonomyTier`.
  - `docker/` — Compose stack (pgvector Postgres 17, Redis 7, server) + `server.Dockerfile`.

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

## 3. Next steps (roadmap M1, in order)

1. Merge PR #1 (owner review pending).
2. **M1 — workflow engine + canvas:**
   - DAG executor on BullMQ (queue: workflow steps; per-node IO snapshots for traces).
   - Node types: trigger (cron/webhook/manual), action (MCP tool call), logic (branch/wait),
     code (sandboxed JS worker), approval. Agent node comes in M3.
   - Persist workflows/missions in Postgres (see schema list in ARCHITECTURE.md §4); add drizzle or prisma.
   - Canvas: React Flow editor in `apps/web`, node skins per DESIGN-LANGUAGE.md.
   - Replace `InMemoryEventBus` with Redis-streams implementation behind the same interface.
3. M2 agent runtime → M3 bridge → M4 FUI shell → M5 ecosystem (see ARCHITECTURE.md §8).

## 4. Conventions

- pnpm workspace; `pnpm build` / `pnpm typecheck` must stay green before every push.
- Commits pushed to the designated `claude/*` branch; no pushes to `main`.
- Zod schemas in `@puppetmaster/shared` are the single source of type truth across apps.

## 5. Kick-off prompt for the new session

See `docs/KICKOFF-PROMPT.md` — paste its contents as the first message in the new session.
