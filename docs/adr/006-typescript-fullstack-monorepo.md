# ADR-006: TypeScript full-stack pnpm monorepo — **Retroactive**

## Status

Accepted (decision locked ~2026-07-04 in the kickoff interview; recorded retroactively
2026-07-06 — context reconstructed from docs/HANDOFF.md §2 and docs/ARCHITECTURE.md §1)

## Context

Puppetmaster spans a Fastify server, a React web app, a kernel (agent runtime + workflow
engine), DB layer, connectors, and a UI kit — built primarily through AI-agent sessions,
where one language across the stack lets a single session cross every layer without
context-switching toolchains.

## Alternatives considered

(Reconstructed; the original interview did not record these exhaustively.)

- Python backend + TS frontend — rejected: two toolchains per session; weaker shared-types
  story (zod schemas are shared verbatim today).
- Go kernel for performance — rejected: the kernel is IO-bound orchestration, not compute;
  BullMQ/Redis and the MCP SDK are first-class in Node.

## Decision

TypeScript everywhere; pnpm workspace monorepo (`apps/*`, `packages/*`); zod schemas in
`@puppetmaster/shared` as the single type source; Node ≥22.

## Consequences

- Positive: one session edits schema→kernel→server→web coherently; shared zod types are
  the contract everywhere.
- Negative: CPU-heavy futures (local inference, heavy parsing) will live outside the
  monorepo behind MCP; dependency direction needs an explicit gate (now:
  `scripts/verify-arch.sh`).

## Reconsider when

A component demonstrably needs a runtime Node can't serve (measured, not feared) — add it
as a sidecar MCP server rather than rewriting the monorepo.
