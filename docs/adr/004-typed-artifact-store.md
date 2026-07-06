# ADR-004: Typed project artifact store, mirrored to KB on acceptance

## Status

Accepted (WP1 decision, 2026-07-06)

## Context

The corpus's artifacts (spec, plan, todos, learnings, ADRs) need lifecycle semantics: todo
state transitions with mission linkage, ADR immutability with supersession, append-only
learnings, spec versioning. Puppetmaster has two candidate homes today: agent memories
(agent-scoped, decay/eviction — wrong lifetime) and the KB (`documents` +
`document_chunks` — retrieval-shaped, no typed state).

## Alternatives considered

- **KB reuse** (artifacts as documents with a `kind` tag) — rejected as the primary store:
  no typed status columns means lifecycle rules become convention; chunking/embedding is
  overhead on task-state files that change constantly; deletion semantics conflict with
  audit-trail needs.
- **Filesystem in the workbench** (corpus-literal `todos/` in the repo) — rejected as the
  primary store: artifacts must survive workbench destruction, feed the UI, and be
  workspace-queryable; but specs/ADRs *may additionally* be committed into the target repo
  by RECORD so the repo remains self-describing (the corpus's own convention) — the DB
  row stays canonical.

## Decision

`project_artifacts` table: `projectId, kind (spec|plan|todo|learning|adr|evidence),
status, title, body, version, supersedesId, missionId, createdAt`. Lifecycle enforced in
the repo layer (not by convention): accepted ADRs immutable (supersede only), todo
completion requires `missionId`, learnings append-only. On acceptance, spec and learning
artifacts are **mirrored into the KB** (existing ingest path) so `kb.search` retrieval and
citations work over them; the artifact row remains the source of truth and re-mirrors on
version change.

## Consequences

- Positive: lifecycle rules are verifier-enforced (WP2 golden eval asserts them);
  retrieval comes free via the existing hybrid-RAG path; evidence artifacts give WP4's
  gates a typed home.
- Negative: two representations of specs/learnings (row + KB mirror) need a sync rule —
  mirror-on-accept, delete-mirror-on-supersede, covered by a WP2 eval predicate.

## Reconsider when

If artifact bodies outgrow row storage (large specs with embedded assets) move bodies to
object storage behind the same table; if the KB gains typed collections natively, the
mirror can collapse into it.
