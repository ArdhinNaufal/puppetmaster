# WP2 — Workshop domain model & artifact store

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP2 · **Size:** M · **Needs:** WP1

Shared zod schemas (Project, ProjectArtifact, VerifyCheck, Evidence, `verify` node kind);
DB tables + `project-repo.ts` + migration + lifecycle rules (ADR immutability,
todo↔mission linkage, append-only learnings); `project.artifact.*` / `project.todo.*`
catalog tools; `/api/projects` REST + audit; golden eval with lifecycle DB-state predicates.
