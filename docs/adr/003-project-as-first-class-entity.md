# ADR-003: Projects are a first-class entity, not a long-lived workflow

## Status

Accepted (WP1 decision, 2026-07-06)

## Context

The Workshop's loop (specify→plan→execute→verify→record) spans many missions over days or
weeks; the corpus is explicit that the loop's state must live in durable artifacts, not in
any single run. Missions in Puppetmaster are single executions; something must own the
phase state, the artifact set, and the workbench across runs.

## Alternatives considered

- **Long-lived workflow + conventions** — a never-terminating workflow whose graph encodes
  the phases, with artifacts as node IO snapshots. Rejected: mission traces are
  execution-scoped (retry/replay semantics would fight multi-week state); pausing between
  phases means a permanently `running` mission distorting every dashboard; artifacts as IO
  snapshots are not queryable or versionable.
- **Workspace-level singletons** (one implicit project per workspace) — rejected: teams
  run several repos/features concurrently; PRD's workspace is a team container, not a task.

## Decision

New `projects` table (workspace-scoped): `name, repoRef, mode (supervised|gated), phase,
workbenchId, status`. Each phase execution is an ordinary mission that carries
`projectId`; traces, retries, replay, budgets, and approvals all keep their existing
semantics. The project owns the artifact set (ADR-004) and the verify-check config.

## Consequences

- Positive: missions stay simple; the Workshop view is a query over projects + their
  missions; audit trail "which mission completed this todo" is a foreign key.
- Negative: a new top-level entity to teach in RBAC, REST, NEXUS registry, and seeds.

## Reconsider when

If per-phase mission wiring turns out to duplicate the workflow engine (e.g., we find
ourselves re-implementing DAG semantics in the project orchestrator), collapse phases into
workflow graphs and keep `projects` as a thin grouping row only.
