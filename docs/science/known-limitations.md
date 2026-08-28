# Science Operations known limitations

These are release boundaries, not hidden backlog. The UI, marketing, agents,
and operators must not imply the corresponding capability exists.

**MVP definition of done: NOT MET. Production release: NOT MET.**

## Data and tenancy

- Only `non_regulated` data is accepted.
- There is no per-study external collaborator ACL, consent model, legal hold,
  data-residency policy, or regulated-data incident workflow.
- The current server instantiates Science for the deployment workspace. Tests
  prove repository workspace scoping, but multi-workspace production behavior
  and active-active multi-host execution are not established.

## Compute

- `DeterministicComputeProvider` generates fixture JSON/VTK plus a small
  data-derived PNG explicitly labelled as a non-production fixture preview.
  It is not a notebook executor.
- `services/science-runtime` is a deterministic HTTP contract fixture. Its
  allowlisted image/kernel fields are validation inputs; it does not pull or
  run those images, fetch submitted inputs, or execute user code. It reports
  `contract_fixture`/`executesUserCode=false`, and the production adapter
  rejects it because production requires an admitted `isolated_oci` executor.
- A production isolated local-container/notebook provider is missing.
- Jupyter Enterprise Gateway execution is **NO-GO**. A fail-closed
  prerequisite now proves authenticated HTTPS, a stable version floor, exact
  instance fencing, immutable kernelspec/image allowlisting, bounded control
  responses, recovery correlation, read-only orphan inventory, exact-handle
  cancellation, and secret redaction. It is deliberately unregistered:
  submit, channels, and output collection remain **NOT PROVEN**.
- The OCI executor passes a deterministic candidate verifier for rootless
  endpoint policy, state ownership, quotas, fencing, cancellation, recovery,
  bounded output/HTTP behavior, and exact cleanup. It is not live execution
  evidence. The observed host Docker daemon advertised only `seccomp` and
  `cgroupns`, not rootless mode, and no notebook corpus ran.
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
  operator resolution. An optional trimmed reason (1-1000 characters) is
  retained in the run event and semantic audit context, including cancellation
  while awaiting approval. Wrapped database mutation context also carries it to
  the atomic trigger record; the enriched semantic sink remains best-effort.
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
- The S3 adapter has deterministic mock coverage and a retained live loopback
  MinIO lane against a dedicated unversioned bucket. That lane proves local
  adapter behavior, not target TLS, IAM, network policy, versioning, capacity,
  backup, or restore.
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
  `confirmSha256` exactly matches and no run link, child version, active/held
  render session, or active finalization retains it. Provider-free terminal
  render replay tombstones do not retain artifact bytes. Bytes are removed before the terminal
  version becomes an expired, non-cleanup-eligible tombstone and its quota
  charge is released. The row, ordinal, ID, and checksum remain immutable and
  cannot be reused. A successful render close clears its provider handle but
  retains the owner/workspace-scoped request tombstone through the replay
  horizon; a failed/unclosed render handle remains a provenance hold.
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
- The manifest endpoint's top-level `complete=true` means its current
  structural and relational assessment found the required provenance. The
  nested manifest/hash remain immutable historical evidence, so the current
  verdict can become incomplete without rewriting those bytes. Neither verdict
  proves that the notebook is scientifically correct, deterministic, bitwise
  reproducible, or numerically equivalent.
- The automatic validation proves output SHA-256 receipt integrity only.
- Run comparison reports exact input, parameter, environment, and output
  identity separately. Migration 12 can retain a strict append-only
  baseline-to-candidate numerical record with metric, tolerance, observed
  value, units, method/protocol, decision, limitations, reviewer, manifest
  hashes, output checksums, and a record hash. Migration 13 adds one monotonic,
  actor-audited SHA-256 head per canonical candidate/kind/baseline scope.
  Comparison follows that exact pointer and uses it only while the head,
  pointed record, selectors, and all provenance bindings still match; it never
  edits a manifest or searches older records after a mismatch.
- The Science FUI now has a member-readable validation ledger and deliberate
  admin/owner append form. Corrections append a higher revision; history is not
  rewritten. This is an operating surface, not evidence that a named expert or
  accepted tolerance protocol has reviewed a real workload.
- Domain-specific mesh quality, boundary conditions, convergence, uncertainty,
  tolerance, and publication readiness still require a real named review. All
  retained software-verifier records are synthetic and explicitly non-release.
- A raw `parameters.sourceRevision` may be a syntactically valid hexadecimal
  identifier, but it remains unverified informational input. The service does
  not fetch a VCS, the manifest's top-level `sourceRevision` remains `null`,
  and completeness instead requires a linked immutable `ready` input parsed as
  `ipynb` under the `code`, `notebook`, or `solver` role.
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
- trame is **NO-GO**. The production web gateway has passed a same-origin
  application WebSocket check, but there is no trame-specific WebSocket
  protocol, live session isolation, renderer resource/lifecycle proof,
  disconnect behavior, or memory-recovery evidence. Public `remote` requests
  are refused.
- Durable render handles bind provider kind, immutable launcher instance ID,
  and opaque handle. Start/status/renew/close carry the expected launcher
  instance ID, so health/start drift and later operation drift are rejected
  before the replacement provider receives the old handle.
- `SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` is enforced under the workspace
  lock (default 2, maximum 64). Migration 15 persists a scoped request-key
  hash, canonical intent fingerprint, provider/mode, exact source snapshot,
  and a fenced launch lease. Identical static retries converge on one row and
  one start; changed intent conflicts. Provider-free terminal tombstones do
  not consume a slot or retain artifact bytes.
- Remote close accepts only HTTP 200, 204, or idempotent 404. Render cleanup is
  retried by startup and periodic full reconciliation. That local retry
  mechanism is not evidence that a real trame launcher releases processes or
  memory correctly.
- Gateway suffixes are decoded and canonicalized without empty/dot/backslash,
  query, fragment, or NUL segments, then confined to the upstream base-path
  prefix and origin. Active content receives `connect-src 'self'` and the FUI
  iframe remains sandboxed. This still does not prove trame WebSockets.
- The released render workflow is exact-source static PNG only (maximum 8 MiB).
  JSON, VTK, STEP, client, and remote requests are refused rather than
  downgraded. Static image and structured table remain the universal fallbacks.

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
- The source verifier covers fail-closed admission controls, bounded hold
  behavior, reviewer authoring/history, exact static source/replay, the admin
  action queue, comparison navigation, and accessibility/layout invariants.
  Fresh recursive typecheck/build and the installed-browser Science gate also
  pass; the browser result is 4/4. See
  [`browser-release-evidence.md`](./browser-release-evidence.md) for exact cases
  and artifacts.
- This retained local browser gate is not a substitute for every target device,
  assistive-technology combination, performance profile, or scientific-pixel
  corpus a production release may require.
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
  the tenth audited Science table; migration 12 adds guarded append-only
  `science_domain_validations` as the eleventh; and migration 13 adds guarded,
  monotonic `science_domain_validation_heads` as the twelfth. Migration 14 adds
  durable `workflow_waits` claim/lease/wake/recovery state; it is workflow
  infrastructure, not a thirteenth audited Science-domain table. Migration 15
  adds exact render request/source replay fields and close tombstones without
  increasing that table count. Migration 16 adds external-upload transfer
  expiry/classification columns and an indexed cross-instance stream fence,
  also without adding a table. The ordered ledger runs through version 16.
  Fresh PGlite checks and a dedicated loopback PostgreSQL lifecycle run pass all
  16 versions with marker `science lifecycle (pg): ok`. Target HA, load,
  backup, and restore remain pending.
- Validation list reads are capped at 100 bounded summaries and omit output
  checksum arrays; one exact scoped detail endpoint exposes those bindings.
  Corrections append a higher hash-bound revision and atomically advance the
  exact-scope head. Comparison returns unknown on corrupt head/record linkage
  instead of falling back. The FUI supports deliberate admin/owner authoring
  and member reading, but synthetic fixtures are not named domain-review
  evidence.
- An admin-only, workspace-scoped, paginated, redacted
  `GET /api/science/admin/action-queue` aggregates known run-reconciliation,
  upload-reservation, artifact-version, and render-cleanup actions. It exposes
  bounded reasons and safe links, not provider handles, storage/quarantine
  keys, raw errors, event payloads, or cross-workspace rows. An admin-only FUI
  queue renders those bounded items and navigates typed safe links; its source
  checks and fresh installed-browser journey pass. Offset pagination
  is not snapshot-stable while actions converge: inserts and removals between
  page requests can shift items, so operators must refresh and reconcile by
  typed item ID. There is still no provider-wide discovery for executions that
  never obtained a database row. Current route and authorization checks pass in
  the deterministic golden harness.
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
- Enabled production startup now fails closed unless PostgreSQL, Redis, and S3
  configuration are present. Read-only production may omit compute; writable
  production additionally requires runtime URL/token/public base plus explicit
  runtime admission, and the adapter still rejects the non-executing fixture
  before mutation. The deployment verifier passes production preflight,
  Compose parity, and same-origin delivery. A real UID/GID 101 nginx container
  also passed read-only/capability/resource checks plus loopback HTTP and
  installed-Chrome same-origin WebSocket probes. This does not prove target
  TLS, load, HA, CVE posture, or runtime isolation.
- The fixture Compose configuration declares an internal network, separate
  named volumes for PostgreSQL, Redis AOF data, the server artifact root, a
  reserved S3/local-quarantine mount, and fixture state. PostgreSQL and Redis
  publish only on loopback, Compose requires `POSTGRES_PASSWORD`, and the server
  healthcheck calls detail-free `/api/readyz`. The fixture still has no
  Docker-socket/host mount, runs with non-root UID/read-only root, drops
  capabilities, denies privilege escalation, and has bounded resources. Named
  volumes and Redis AOF are durability controls, not backup. The web gateway
  image was built and exercised, but per-job sandboxing remains unproved
  because the fixture executes no jobs and the observed Docker daemon did not
  advertise rootless mode.
- The deterministic service verifier now encodes all seven non-terminal restart
  states: `draft` and `awaiting_approval` remain unchanged, while `queued`,
  `provisioning`, `running`, `finalizing`, and `cancelling` reconcile with
  persisted identity. It also asserts no duplicate submit/output, stale
  cancelling-tick rejection, exact cancellation identity, and partial-finalize
  convergence. Exact static render replay and immutable review behavior are
  also covered by the current service gate.
- A dedicated loopback PostgreSQL 16/16 lifecycle lane, Redis/BullMQ live lane,
  Redis `WAITAOF`/process-restart sentinel, and MinIO/S3 live adapter lane pass.
  External-provider interruption, target failover/load, renderer interruption,
  and disaster-recovery chaos remain pending.
- The current deterministic result is
  `SCIENCE GOLDEN PASS^3: 18 isolated deterministic suites; 34 evidence classes verified on every pass`.
  Fresh typecheck/build and installed-browser 4/4 also pass. This local evidence
  cannot prove rootless notebook execution, executable JEG, trame/OCCT, named
  scientific review, target performance, CVE posture, or production disaster
  recovery, and it does not change the MVP/production **NOT MET** decision.

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
