# WP2 — Workshop domain model & artifact store

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP2 · **Size:** M · **Completed:** 2026-07-06

- [x] Shared zod schemas: `Project`, `ProjectArtifact` (+ kind/status enums),
      `VerifyCheck`, `Evidence`; `WorkflowNodeKind` extended with `verify`
      (linter flags verify nodes as not-executable until WP4)
- [x] DB: `projects`, `project_artifacts`, `verify_checks`, `evidence` tables +
      idempotent DDL + indexes (`projects(workspace_id)`,
      `project_artifacts(project_id, kind, status)`)
- [x] Lifecycle rules in `project-repo.ts` (enforced by code, not convention):
      learnings append-only; accepted ADRs immutable (supersede only via
      `supersedeAdr`); todo completion requires the completing mission id;
      spec/plan re-writes are new versions chained via `supersedesId`
- [x] Kernel tools on the shared catalog: `project.list`, `project.artifact.
      {list,read,write}`, `project.todo.{next,complete}` — reads read_auto,
      writes write_approved; workspace-scoping guard on every call
- [x] Executor: ToolContext now carries `missionId` for workflow action nodes
      (bridge nesting + the todo audit link)
- [x] REST: `/api/projects` CRUD + `/:id/artifacts` (+ `/:artifactId/complete`),
      builder+ mutations (auth.ts rule), audit entries on create/update/write/complete
- [x] Golden eval `workshop-artifact-lifecycle` (pass^3, trajectory-asserted):
      spec artifact v1 → todo completed with mission link → spec v2 supersedes
      v1 → accepted-ADR edit refused → mission-less completion refused

**Deviation (logged):** evidence lives only in its own step/approval-scoped table,
not as an artifact kind — one home per concept (plan §5.1 listed both).
