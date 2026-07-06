# ADR-001: The Workshop — feature naming and v1 scope boundary

## Status

Accepted (owner rulings 1/3/4, 2026-07-06 — see docs/AI-SDLC-INTEGRATION-PLAN.md §8)

## Context

The AI SDLC integration plan builds a dedicated feature for spec→plan→execute→verify→record
software development with verifiable gates. It needs a name that does not collide with the
existing vocabulary (agent, workflow, tool, mission, approval, workspace — PRD §4) and a
v1 scope boundary that prevents drift into a CI product.

## Alternatives considered

- **"Dev Pipeline" / `pipeline` entity** — rejected: a second process-noun beside
  *workflow* in a DAG product guarantees permanent "pipeline vs. workflow?" confusion.
- **"Forge" / "Foundry"** — rejected: heavy external trademark noise (SourceForge,
  Laravel Forge, Palantir Foundry); breaks the house metaphor.
- **`ws.*` tool prefix for the dev container** — rejected: reads as "workspace", a core
  entity (see learnings.md 2026-07-06).

## Decision

- **Feature/subsystem: the Workshop** — house grammar gives differentiating subsystems
  theatrical names (the Bridge, the Construct, NEXUS); in puppetry the workshop is where
  marionettes are built and strung before they take the stage. View name `WORKSHOP`.
- **Entity: `project`** — a repo plus its spec, todos, learnings, and ADR artifacts
  (`projects`, `project_artifacts`, `/api/projects`, `project.artifact.*` tools).
- **Dev container: `workbench`** — tools `bench.clone/git/exec/read/write/destroy/delegate`.

**v1 scope boundary (what the Workshop v1 will NOT do):** multi-repo projects;
CI-provider integrations (GitHub Actions etc. — verify runs in our workbench only);
Track A no-code operator flow (v2); dynamic-workflow rung 6 (agent-written harnesses);
Windows workbenches; marketplace sale of projects.

**Role × mode matrix (v1, Track B/C only):**

| Role | May do |
|---|---|
| member | run supervised projects; answer interviews; approve gates addressed to them |
| builder | all of member + start gated projects; edit project templates |
| admin | all of builder + verify-check config, workshop policies, workbench settings |
| owner | all of admin |

Gated mode additionally requires the project to have ≥1 enabled verify check — otherwise
it refuses to start (plan gap W8).

## Consequences

- Positive: zero glossary collisions; the naming teaches the model (workshop → workbench).
- Negative: "Workshop" is less self-describing to first-time users than "Dev Pipeline" —
  the Workshop view's empty state must say what it is in one sentence.

## Reconsider when

User testing shows operators fail to find or understand the Workshop by name; or v2's
Track A flow needs a friendlier consumer-facing framing.
