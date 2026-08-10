# ADR-009: Science Operations is a decoupled Puppetmaster subsystem

## Status

Accepted for the implemented control-plane boundary (2026-07-29).

This decision does not admit Jupyter Enterprise Gateway, trame, OCCT, or a
production notebook executor. Their separate evidence gates remain no-go.

## Context

The scientific-platform source material spans storage federation, notebooks,
CAD/mesh processing, solvers, visualization, provenance, publishing, AI, and
governance. Treating that catalogue as one product would create an unbounded
second platform. Copying its example Django, RabbitMQ, AngularJS, and separate
identity stack would also conflict with Puppetmaster's TypeScript/Fastify/React,
mission, approval, audit, and workspace model.

Scientific workloads do need a different execution boundary. Python and C++
libraries, untrusted notebooks, large arrays, meshes, and stateful renderers
must not run inside the web process or travel as JSON/MCP text.

## Decision

Science Operations is a workspace-scoped subsystem inside Puppetmaster's
existing control plane:

- Puppetmaster owns identity, workspace RBAC, studies, artifact metadata,
  approvals, missions, run state, audit, render-session intent, and provenance.
- `ScienceService` is the common domain boundary for REST routes, bounded
  `science.*` tools, scheduler ticks, and startup reconciliation.
- Each science run has exactly one `science` mission. Run events carry
  workspace, study, run, and mission correlation; database state remains
  authoritative after a WebSocket disconnect or process restart.
- Artifact bytes remain behind `ArtifactStore`; compute and rendering remain
  behind `ComputeProvider` and `RenderSessionProvider`.
- Administrative artifact purge remains inside the same RBAC/service/repository
  boundary: exact checksum confirmation is mandatory, bytes are removed before
  quota release, the immutable version remains as an expired tombstone, and run
  links, descendants, render rows, and active finalization are provenance
  holds.
- Pilot admission is durable workspace policy, not process configuration. A
  missing `science_workspace_admissions` row means denied. Every new-work
  boundary reads the committed database decision after waiting for any local
  admission mutation; no instance-local cache may authorize work.
- Workspace members may read only the redacted admission projection
  (`workspaceId`, `admitted`, `updatedAt`). Only workspace admins may change
  it, and every change requires a bounded reason retained with actor/action
  audit context.
- Revocation is a boundary for new resource acquisition, not a force-kill.
  Already accepted runs/uploads may converge, scheduler reconciliation and
  cancellation continue, exact checksum purge remains available, and render
  close continues. New studies/artifacts/upload intents/profiles/runs,
  approvals into execution, reproductions, render starts, and render renewals
  are denied at their next service boundary.
- MCP is a bounded command/reference plane. Scientific binary payloads do not
  travel through MCP, mission output, audit detail, or the event bus.
- Database triggers make a bounded audit row part of each material audited
  Science mutation transaction. Migration 10 adds strict transaction-local
  initiating actor/action context for short user mutations; recovery retains
  the `system/science-db` fallback. Append-only events and operational-only
  updates suppress duplicate churn. The secondary semantic sink remains
  best-effort and cannot make a committed mutation retryable. Migration 11 adds
  the default-deny workspace-admission row and its atomic audit trigger. The
  ordered ledger therefore runs through migration 11, including finalizer
  fencing, cleanup backoff, renewable transfer leases, provider reservations
  through commit, and persisted pilot admission.
- Startup and the periodic bounded single-flight task run the same full
  reconciliation: cleanup plus database-to-queue recovery for non-terminal
  runs. Database state remains authoritative over Redis delivery.
- Readiness is database-gated. Public `/api/readyz` exposes only service/boolean
  state and 503, while authenticated `/api/readiness` may expose redacted
  dependency detail.
- External services receive scoped artifact references and execution metadata,
  not database credentials, ambient workspace authority, or host paths.
- The web app imports shared contracts and UI primitives only. It never imports
  database, kernel, or Python runtime code.

The current implementation is in:

- `packages/shared/src/science.ts`
- `packages/db/src/science-repo.ts`
- `packages/kernel/src/science/`
- `packages/kernel/src/science-tools.ts`
- `apps/server/src/science-routes.ts`
- `apps/web/src/science/`
- `services/science-runtime/`

## Alternatives considered

- **Standalone scientific product**: rejected. It would duplicate identity,
  workspace membership, approvals, audit, missions, and UI navigation.
- **A second application stack inside Puppetmaster**: rejected. A parallel
  Django/RabbitMQ/AngularJS/PostgreSQL stack would create conflicting sources
  of truth and a larger attack surface.
- **Run notebooks in the Fastify process**: rejected. Arbitrary code and
  native scientific libraries require resource and privilege isolation.
- **Reuse the coding workbench as-is**: rejected. Its mutable repository and
  copy-back contract is not an immutable scientific-artifact contract.
- **Send arrays and geometry through MCP**: rejected. It breaks bounded
  control-plane behavior and makes attribution, auditing, and memory use unsafe.

## Consequences

Positive:

- Science reuses the platform's proven authorization and operational concepts.
- Provider interfaces can evolve without leaking vendor details into the
  schema or web app.
- Durable intent and provenance survive provider or browser failure.
- The data plane can use streaming/range requests without inflating MCP or JSON.
- Successfully closed render sessions release their transient metadata hold;
  failed/unclosed sessions remain durable and retryable.

Negative:

- Operators must manage metadata, artifact, queue, compute, and render
  dependencies as one coordinated service.
- A provider being configured does not prove it is safe or scientifically
  valid; workspace admission is an operator decision, not proof that any
  provider passed its separate live gate.
- Recovery/direct-repository mutations deliberately use system attribution.
  A semantic-sink outage can lose only its secondary entry; the trigger's
  initiating actor/action for wrapped user mutations remains atomic.
- Trigger/audit/event retention still needs target-load evidence; database
  atomicity does not itself prove an operational retention policy.
- The exact-version admin purge does not implement retention schedules, legal
  hold, external last-copy verification, or archival disposition.

## Verification

Boundary and concurrency checks are represented by:

- `scripts/verify-science-contracts.mjs`
- `scripts/verify-science-lifecycle.mjs`
- `scripts/verify-science-audit-atomicity.mjs`
- `scripts/verify-science-service.mjs`
- `scripts/verify-science-routes.mjs`
- `scripts/verify-science-mcp-concurrency.mjs`
- `scripts/verify-science-authz.mjs`
- `.dependency-cruiser.cjs`

The source verifiers cover migration 11, default deny, redacted/member GET,
admin-only reasoned PATCH, database-authoritative cross-instance decisions,
and the accepted-work convergence boundary. Their current post-v11 aggregate
and root reruns are explicitly pending; no pass is inferred here. Release
status and missing external evidence are tracked in
`docs/science/evidence-matrix.md`.

## Reconsider when

- A second independently deployed control plane is required for legal or
  tenancy reasons, not merely for implementation convenience.
- Science needs relationships that cannot be represented by run input/output
  links plus an immutable manifest.
- Multi-host active-active execution is approved and the current single
  workspace/service instantiation no longer provides the required isolation.
