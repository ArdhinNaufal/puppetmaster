# Science Operations known limitations

These are release boundaries, not hidden backlog. The UI, marketing, agents,
and operators must not imply the corresponding capability exists.

## Data and tenancy

- Only `non_regulated` data is accepted.
- There is no per-study external collaborator ACL, consent model, legal hold,
  data-residency policy, or regulated-data incident workflow.
- The current server instantiates Science for the deployment workspace. Tests
  prove repository workspace scoping, but multi-workspace production behavior
  and active-active multi-host execution are not established.

## Compute

- `DeterministicComputeProvider` generates fixture JSON/VTK. It is not a
  notebook executor.
- `services/science-runtime` is a deterministic HTTP contract fixture. Its
  allowlisted image/kernel fields are validation inputs; it does not pull or
  run those images, fetch submitted inputs, or execute user code. It reports
  `contract_fixture`/`executesUserCode=false`, and the production adapter
  rejects it because production requires an admitted `isolated_oci` executor.
- A production isolated local-container/notebook provider is missing.
- Jupyter Enterprise Gateway is **NO-GO**. No live authenticated
  start/channels/interrupt/shutdown/reconnect/orphan-cleanup gate exists.
- Kubernetes, commercial solvers, GPU scheduling, license brokering, and
  multi-host compute are deferred.
- Provider cost is `null` when unknown. No billing integration exists.
- Migration 11 adds persisted per-workspace pilot admission, but admission is
  only an operator policy decision. It does not prove that a compute or render
  provider passed isolation, lifecycle, performance, or scientific-validity
  gates.
- A missing admission row is deliberately denied. New resource-bearing service
  boundaries reread the committed database decision, so a cross-instance revoke
  does not require restart. Revocation is not a force-kill: accepted runs and
  uploads may converge, and reads/cancel/close/reconciliation remain available.
- Cancellation can remain `cancelling` indefinitely when the provider cannot
  prove terminal state. This is intentional evidence preservation but needs
  operator resolution.
- Before the first external submit, the control plane persists the provider
  kind, immutable instance ID, and idempotency key. A lost response is retried
  only against that same instance. Cancellation after an ambiguous submit must
  recover the same handle before it can prove terminal state; it is not safe to
  declare the run locally cancelled.
- Every submit/status/cancel/output-list/output-read operation carries the
  expected immutable provider instance ID. The HTTP runtime must reject a
  missing or stale fence before touching an execution; a health check alone is
  not an operation fence.

## Artifacts and storage

- Uploads use explicit full-restart semantics; multipart/resumable append is
  not implemented.
- Upload completion now rejects active media types, inconsistent media/format
  claims, malformed notebook/JSON structure within its parse cap, and missing
  signatures/envelopes for the admitted pilot formats. It is still not an
  antivirus scanner, notebook sanitizer, full parser, or domain-validity
  validator.
- The S3 adapter has deterministic mock coverage, not retained live
  MinIO/S3/TLS/bucket-policy/versioning evidence.
- Every signed S3 PUT/HEAD/GET/DELETE has a total deadline configured by
  `SCIENCE_S3_REQUEST_TIMEOUT_MS` (300000 ms default, 3600000 ms maximum),
  including response streaming. Health retains a separate five-second bound.
  A deterministic stalled-DELETE check passes; live object-store timeout and
  recovery behavior remains unproven.
- S3 removal accepts success only when DELETE does not report a delete marker
  or version ID and a following HEAD proves the key is absent with 404. This
  makes automatic purge suitable only for a dedicated/unversioned bucket.
  Version-aware deletion and retention for a versioned bucket are not
  implemented.
- S3 uploads require local quarantine capacity equal to in-flight data.
- `SCIENCE_MAX_WORKSPACE_STORAGE_BYTES` serializes retained-byte admission per
  workspace and charges artifact versions whose bytes are still retained plus
  every upload reservation whose quarantine deletion has not been proven.
  Expired artifact tombstones whose bytes were proven absent remain as
  metadata but no longer consume quota. Deduplicated versions are not charged
  twice.
- Before the provider output stream is opened, the control plane creates a
  durable reservation for its declared size under the workspace storage quota.
  A renewable transfer lease and the reservation remain durable through the
  stream, pending-version creation, promotion, and ready/output-link commit (or
  quarantined terminal handoff). Only then is the reservation deleted. On
  stream/validation/promotion failure it remains charged until quarantine
  discard and terminal reservation-row deletion are durably proven.
- Startup and the bounded single-flight periodic task run full reconciliation:
  they re-enqueue recoverable database runs and perform retention cleanup.
  Cleanup retries discard-before-delete for terminal upload reservations and
  for unlinked provider-output versions explicitly marked cleanup-eligible.
  A matching upload reservation for the same artifact and SHA-256 fences
  version quarantine cleanup while it is unexpired and in `pending`,
  `uploading`, or `finalizing`; cleanup becomes eligible again after that
  reservation's `expiresAt`.
  Its age-based orphan-quarantine sweep first protects every database-referenced
  quarantine key across all workspaces. Migration 8 persists retry counts and
  exponential `cleanup_not_before` backoff so a failing object does not starve
  the bounded batch.
- An admin-only REST delete can purge a `ready` version only when
  `confirmSha256` exactly matches and no run link, child version, render-session
  row, or active finalization retains it. Bytes are removed before the terminal
  version becomes an expired, non-cleanup-eligible tombstone and its quota
  charge is released. The row, ordinal, ID, and checksum remain immutable and
  cannot be reused. A successful render close removes its terminal session
  row, while a failed/unclosed render remains a provenance hold.
- Because exact checksum purge is cleanup, it remains available after workspace
  revocation and in global read-only mode; all checksum/provenance holds still
  apply.
- This narrow confirmed purge is not an automated lifecycle policy. General
  retention schedules, legal hold, last-copy policy across external archives,
  and an admin quarantine/retention UI are not complete.
- Deterministic cold PGlite/filesystem backup and byte/hash restore is covered.
  PostgreSQL/S3 recovery, accepted RPO/RTO, object-version restore, and
  target-deployment drills remain pending.
- Federated cloud drives and WaterButler are deferred.

## Provenance and scientific validity

- A canonical manifest and hash are stored in the terminal run row; a separate
  signed release artifact/publication package is not produced.
- `manifest.complete=true` means required provenance fields exist. It does not
  prove that the notebook is scientifically correct, deterministic, bitwise
  reproducible, or numerically equivalent.
- The automatic validation proves output SHA-256 receipt integrity only.
- Run comparison reports exact input, parameter, environment, and output
  identity separately. Numerical equivalence remains unknown unless a named
  validation records at least a non-empty metric and tolerance with its boolean
  result; observed value and units are retained when supplied.
- Domain-specific mesh quality, boundary conditions, convergence, uncertainty,
  tolerance, and publication readiness require external named review.
- Source revisions are syntactically checked hexadecimal identifiers; the
  service does not fetch a VCS to prove repository reachability.
- Reproduction refuses changed profile snapshots or adapter versions rather
  than silently approximating them. Active provider handles also bind a
  provider instance ID; instance drift enters orphan-safe cancellation instead
  of polling or cancelling the replacement.
- A run history beyond the bounded manifest event fetch becomes an explicit
  completeness gap.
- DOI/ORCID/ROR, preregistration, executable publication, and archival release
  workflows are deferred.

## Geometry and visualization

- OCCT WASM is **NO-GO**. There is no selected/licensed build, measured corpus,
  Web Worker integration, explicit kernel disposal test, or tessellation
  fidelity baseline.
- Current STEP support is a bounded text diagnostic that extracts raw
  `CARTESIAN_POINT`, `VERTEX_POINT`, and `EDGE_CURVE` endpoint relationships.
  It does not resolve surfaces, trims, assemblies, placements, units,
  tolerances, curves, or tessellation.
- Current VTK support is legacy ASCII `POINTS` plus limited line/polygon/strip
  wire topology. It does not parse binary/XML VTK, scalar fields, cells,
  normals, transforms, or volume rendering.
- Current STL support is ASCII only and does not validate normals,
  watertightness, orientation, units, or mesh quality.
- Client parsing runs in a disposable module Web Worker after an explicit,
  bounded fetch. The fetch and worker lifecycle are coordinated on the main
  thread; there is no OCCT kernel or solver-grade tessellation.
- The diagnostic cap is 8 MiB of text, 5000 points, and 10000 edges.
- The retained geometry verifier proves bounded ASCII VTK/STL diagnostics,
  STEP topology, caps, invalid-topology/binary rejection, and explicit fallback.
  It does not prove Web Worker disposal, browser rendering, or fidelity.
- The client diagnostic uses SVG wire geometry, not vtk.js/WebGL.
- trame is **NO-GO**. The HTTP adapter/control contract exists, but the gateway
  has no proven WebSocket path, live session isolation, validated CSP/origin
  behavior, memory quota, disconnect behavior, or cleanup tolerance.
- Durable render handles bind provider kind, immutable launcher instance ID,
  and opaque handle. Start/status/renew/close carry the expected launcher
  instance ID, so health/start drift and later operation drift are rejected
  before the replacement provider receives the old handle.
- `SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` is enforced under the workspace
  lock (default 2, maximum 64). A durable launch-attempt handle is written
  before remote start and replaced by compare-and-set only after the actual
  handle is returned; an ambiguous attempt remains a conservative quota and
  provenance hold requiring administrator action.
- Remote close accepts only HTTP 200, 204, or idempotent 404. Render cleanup is
  retried by startup and periodic full reconciliation. That local retry
  mechanism is not evidence that a real trame launcher releases processes or
  memory correctly.
- Gateway suffixes are decoded and canonicalized without empty/dot/backslash,
  query, fragment, or NUL segments, then confined to the upstream base-path
  prefix and origin. Active content receives `connect-src 'self'` and the FUI
  iframe remains sandboxed. This still does not prove trame WebSockets.
- Static image and structured table are the only admitted universal fallbacks.

## FUI and accessibility

- The Science FUI, paginated/virtualized rail, persisted layout, hold
  ceremonies, reduced-motion hooks, structured fallback, NEXUS entries, and
  analytical isolation styles exist in source.
- The FUI includes a member-visible redacted admission instrument and
  reason-required admin hold controls. It disables new resource-bearing
  controls while admission is denied, unknown, loading, or mutating, but keeps
  read/cancel/close and cleanup actions visible.
- Cross-browser-session display may lag a committed admission change until the
  30-second poll, focus/visibility refresh, reconnect, or a rejected new-work
  request triggers refetch. This is a UX limitation, not an authorization gap:
  unknown UI state fails closed and the service rereads the database at the
  action boundary.
- Authenticated local checks at 1024x864 and 740x900 passed after a
  medium-width overlap defect was fixed: no horizontal overflow or panel
  overlap, an opaque viewport, and no console warning/error were observed.
- No retained Playwright journey, axe report, keyboard-only UAT, contrast
  report, viewport screenshot set, WebGL-failure test, or scientific-pixel
  comparison proves the complete WP4 exit gate.
- Browser memory recovery after repeated geometry/render open/close is
  unmeasured.

## Security and operations

- Science API rate limiting is per-process in memory, not distributed. A
  production reverse proxy must enforce deployment-wide policy.
- Migration 5 installs a database trigger on the original nine Science domain
  tables, so every material audited mutation and its bounded record commit or roll
  back together. Migration 10 lets short database-only service mutations pass
  transaction-local initiating actor/action context to that trigger; recovery
  and direct repository work retain the explicit `system/science-db` fallback.
  Append-only run events and lease/heartbeat/backoff-only updates suppress
  duplicate audit churn. The secondary semantic audit sink remains
  best-effort, but its outage neither loses the atomic actor-attributed record
  nor turns a committed mutation into a retryable API error.
- Migration 6 adds the cleanup-eligibility fence for unlinked provider outputs
  and upgrades existing databases to that retention/audit behavior. Migration
  7 adds the upload finalizer lease fence; migration 8 adds persisted cleanup
  attempts/backoff for versions, uploads, and render sessions; migration 9 adds
  the renewable transfer fence and keeps provider-output reservations through
  promotion/terminal commit; migration 10 adds atomic actor attribution; and
  migration 11 adds the default-deny `science_workspace_admissions` table as
  the tenth audited Science table. The ordered ledger now runs through version
  11.
- There is no aggregated admin orphan compute queue or quarantine dashboard.
  Repeated provider/cancellation failures do produce bounded
  `adminActionRequired` run evidence and `science.run.orphaned` audit entries,
  but operators must inspect dossiers/audit and reconcile against the provider.
- Public `/api/health` is liveness only. Database-gated readiness is cached for
  five seconds: authenticated `/api/readiness` returns dependency detail, while
  public `/api/readyz` returns only service/boolean state and HTTP 503 when not
  ready. Database failure always fails readiness; when Science is enabled,
  storage and queue also gate it, and compute gates it when submissions are
  enabled. Render health is reported but non-gating. PostgreSQL readiness uses
  a dedicated one-connection pool with two-second acquisition, query, and
  statement limits. The Redis producer/health client disables the offline
  queue and automatic resend, permits one retry, uses 1.5-second connect/command
  timeouts, and deduplicates a two-second readiness wait; BullMQ's blocking
  worker remains retry-unbounded by contract. Deterministic local TCP-blackhole
  checks return DB and Redis failures within their outer bounds, but target
  network/load behavior is still unproven. Authenticated `/api/bootstrap` also
  reports queue kind. No retained target availability SLO or complete queue
  lag/orphan telemetry exists.
- Science-specific OTel spans and measured resource/cost accounting are not
  established.
- The fixture Compose configuration declares an internal network, separate
  named volumes for PostgreSQL, Redis AOF data, the server artifact root, a
  reserved S3/local-quarantine mount, and fixture state. PostgreSQL and Redis
  publish only on loopback, Compose requires `POSTGRES_PASSWORD`, and the server
  healthcheck calls detail-free `/api/readyz`. The fixture still has no
  Docker-socket/host mount, runs with non-root UID/read-only root, drops
  capabilities, denies privilege escalation, and has bounded resources. Named
  volumes and Redis AOF are durability controls, not backup. The Docker daemon
  was unavailable, so image build/inspect/run and effective runtime enforcement
  remain unproven. Per-job sandboxing does not exist because the fixture
  executes no jobs.
- The deterministic service verifier now encodes all seven non-terminal restart
  states: `draft` and `awaiting_approval` remain unchanged, while `queued`,
  `provisioning`, `running`, `finalizing`, and `cancelling` reconcile with
  persisted identity. It also asserts no duplicate submit/output, stale
  cancelling-tick rejection, exact cancellation identity, and partial-finalize
  convergence. Its current post-v11 aggregate/root rerun is pending.
- PostgreSQL, live Redis failure, external-provider interruption, renderer
  interruption, target-hardware load, and disaster-recovery chaos evidence is
  pending.
- The root deterministic `pnpm test` command invokes the Science pass^3
  harness, but both the current post-v11 aggregate harness and repository-root
  result are **PENDING rerun**. Historical pre-v11 timings are not current
  release evidence. No retained external green CI artifact exists.
  Deterministic evidence cannot prove optional/live providers, browser
  behavior, target-hardware performance, or production disaster recovery.

## Deferred advanced tracks

- storage federation;
- production CAD repair/meshing and persistent topology naming;
- commercial solver integrations;
- ADIOS2/SST, Catalyst, in-situ rendering, RDMA/WAN tuning;
- physics-informed surrogate training/inference;
- sensors/edge ingestion;
- human-subject recruitment/fraud analysis;
- regulated-data collaboration;
- active-active multi-host execution.
