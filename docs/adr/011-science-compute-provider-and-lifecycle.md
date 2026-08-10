# ADR-011: Durable generation-fenced compute-provider contract

## Status

Accepted for the deterministic and HTTP control contracts (2026-07-29).

Production notebook/container execution and Jupyter Enterprise Gateway remain
no-go until their live isolation and lifecycle gates pass.

## Context

A scientific run may outlive an HTTP request, browser session, queue delivery,
or server process. Duplicate delivery can create expensive duplicate compute;
a stale worker can otherwise overwrite a newer execution; and cancellation can
otherwise terminate the wrong provider job.

The control plane must also avoid assuming that a provider's successful process
exit proves output integrity or scientific validity.

## Decision

All compute adapters implement `ComputeProvider`:

- `quote(resources)`
- `submit(submission, instanceFence)`
- `status(handle, generation, instanceFence)`
- `cancel(handle, generation, instanceFence)`
- `collectOutputs(handle, generation, instanceFence)`
- `openOutput(output, instanceFence)`
- `health()`

The contract requires:

- exact CPU millicores, memory MiB, GPU count, and wall-time seconds;
- an immutable image digest and explicit kernel name;
- a stable idempotency key for submission;
- exactly one durable pre-submit attempt event binding provider kind, immutable
  instance ID, and idempotency key before the first external submit request;
- a bounded provider handle persisted against an execution generation;
- an expected immutable provider-instance fence on every execution-scoped
  operation; HTTP runtimes reject missing/stale fences before acting;
- truthful quote provenance (`declared` or `measured`) and nullable cost;
- bounded status logs/metrics;
- no inline `data:` output;
- at most 200 output receipts, each with size, SHA-256, media type, and bounded
  metadata;
- same-origin output references under `/v1/outputs/` for the HTTP adapter;
- streaming output collection followed by independent size/SHA-256 verification
  before an output is linked or the run succeeds;
- serialized workspace storage admission with a durable declared-size output
  reservation before the provider stream is opened; the version atomically
  assumes that charge, or discard-before-delete cleanup retains the charge
  until deletion is proven.

Lifecycle ownership remains in Puppetmaster:

- Draft creation, approval into execution, submission, reproduction, and any
  other new resource-bearing boundary require the workspace's committed
  admission decision. The database is read at each boundary so a revoke made
  by another server instance is observed without a restart.
- Submit first creates a durable run, science mission, immutable input links,
  and human approval request.
- Approval atomically enforces the per-workspace active-run limit before queueing.
- Queue work is a short poll/tick, not a request held for the run lifetime.
- The first dispatch claim increments `execution_generation`.
- A same-generation worker lease and heartbeat fence concurrent ticks.
- Provider status, output collection, and cancellation are correlated with the
  exact generation.
- Cancellation is terminal only after provider state proves that exact
  execution stopped. A rejected or unreachable cancellation remains
  `cancelling`.
- Startup reconciliation re-enqueues persisted non-terminal runs. Read-only
  rollback and workspace revocation still permit reconciliation and
  cancellation. Revocation is not a force-kill: work accepted before the
  decision may converge, while the next new-work boundary is denied.
- Startup and an unref'd bounded single-flight interval execute full
  reconciliation: they re-enqueue recoverable database runs and retry terminal
  upload/provider-output/render cleanup. Persisted attempt/backoff state keeps
  a repeatedly failing cleanup candidate from starving the fixed batch.
- Manual and provider-output byte streams hold a renewable, ownership-fenced
  transfer lease. Provider-output reservations remain linked through promotion
  and the atomic ready/output-link commit (or quarantined terminal handoff);
  cleanup cannot release quota while either a live transfer or its quarantine
  bytes remain.
- Provider-output/version quarantine cleanup is barred while a matching
  artifact-ID/SHA upload reservation is unexpired in `pending`, `uploading`, or
  `finalizing`; the candidate can re-enter cleanup after that reservation
  expires.
- Run input/output links are permanent provenance holds against administrative
  version purge. Only a checksum-confirmed `ready` version with no run link,
  descendant, render row, or active finalization may enter discard-before-
  tombstone cleanup. Successful byte deletion releases quota but preserves the
  expired version ID, ordinal, and checksum row.
- Redis is a delivery dependency, not lifecycle authority. The queue producer
  and health probe use their own client with offline queuing/resend disabled,
  one command retry, 1.5-second connect/command limits, and a deduplicated
  two-second readiness wait; BullMQ's worker connection retains its required
  retry-unbounded behavior.

Two implementations currently exist:

- `DeterministicComputeProvider`: restart-stable, non-production fixture used by
  deterministic tests and local demonstrations.
- `HttpComputeProvider`: bounded adapter for the
  `services/science-runtime` HTTP contract.

`services/science-runtime` is itself a deterministic contract fixture. It
persists idempotency receipts and outputs, validates allowlisted image/kernel
identifiers, and does not execute notebooks, user code, or OCI images.

Jupyter Enterprise Gateway is named in shared profile contracts but is not
registered by configuration. A URL alone must never admit it.

## Alternatives considered

- **Execute notebooks in the server process**: rejected because arbitrary code
  needs a non-root, resource-bounded, default-deny isolation boundary.
- **Synchronous provider request for the whole run**: rejected because restarts
  and network timeouts would lose lifecycle ownership.
- **Queue delivery as the source of truth**: rejected. Queue delivery is
  at-least-once; persisted state and provider idempotency are authoritative.
- **Cancel by provider handle only**: rejected because a stale handle could
  terminate a newer execution.
- **Treat the deterministic fixture as a local executor**: rejected. It proves
  the control contract only.
- **Reuse the coding workbench container**: rejected because its mutable source
  and copy-back contract does not match immutable inputs/outputs.

## Consequences

Positive:

- Duplicate delivery and worker overlap are fenced.
- A provider restart/replacement cannot pass merely because a prior health
  check succeeded; the expected instance is enforced on the operation itself.
- Provider replacement does not change the public run schema.
- Output integrity is checked independently of provider claims.
- Referenced scientific inputs/outputs cannot be reclaimed merely to satisfy a
  storage quota.
- Read-only rollback does not strand accepted compute automatically.

Negative:

- Provider idempotency and generation behavior are mandatory integration work.
- Provider instance identity must be stable across an accepted execution and
  enforced server-side on every operation.
- An unreachable provider can leave a run honestly stuck in `cancelling`; an
  operator must reconcile the external execution rather than force a false
  terminal state.
- The current deterministic/Python fixtures do not satisfy the production
  notebook-execution requirement.
- PostgreSQL, Redis/BullMQ, Docker isolation, target hardware, and JEG lifecycle
  evidence remain external. Deterministic TCP-blackhole checks bound producer
  health/enqueue failure, but do not establish live Redis durability or
  recovery under load.

## Verification

Deterministic lifecycle evidence is represented by:

- `scripts/verify-science-service.mjs`
- `scripts/verify-science-lifecycle.mjs`
- `scripts/verify-science-routes.mjs`
- `scripts/verify-science-mcp-concurrency.mjs`

`verify-science-service.mjs` encodes the exhaustive non-terminal restart
matrix: `draft` and `awaiting_approval` remain unchanged; `queued`,
`provisioning`, `running`, `finalizing`, and `cancelling` are recovered. It
also asserts no duplicate submit for persisted handles, generation/handle
preservation, stale cancelling-tick rejection, exact cancellation identity,
and idempotent completion of a partially committed finalization. The current
post-migration-11 aggregate/root rerun of that matrix remains pending, and live
Redis/provider/process-interruption evidence remains a separate release gate.

The Python runtime's own verifier and live Docker profile are tracked separately
in `docs/science/evidence-matrix.md`; their existence must not be inferred from
the TypeScript adapter.

## Reconsider when

- A provider cannot offer stable idempotency or exact-generation cancellation.
- Queue throughput measurements require partitioning beyond the single-host
  pilot.
- A chosen notebook runtime needs authenticated callbacks rather than polling.
