# Science Operations rollout and rollback

## Rule

Rollout is gate-driven, not feature-presence-driven. An interface, environment
variable, Dockerfile, liveness response, or dependency-readiness response does
not admit an external provider.

## Stage 0: disabled baseline

Configuration:

```dotenv
SCIENCE_ENABLED=0
```

Required evidence:

- existing non-Science deterministic suite remains green;
- additive migrations do not change existing application behavior;
- dependency boundaries remain valid;
- backup includes the new state even while unused: migration-11 admission,
  migrations 12-13 validation rows/heads and audit, migration-14
  `workflow_waits`, and migration-15 render replay/source fields.

`SCIENCE_ENABLED=0` makes Science routes unreadable as well as unwritable. It is
appropriate before any Science data exists, not the preferred rollback after a
pilot has data.

## Stage 1: deterministic development

Scope:

- PGlite;
- filesystem artifact store;
- inline scheduler;
- deterministic TypeScript provider;
- static/table/client diagnostic views;
- exact-source static PNG session and built-in durable reviewed workflow;
- synthetic, non-regulated fixtures only.

Admission:

- shared, database, kernel, server, and web build/typecheck pass;
- deterministic Science contract, lifecycle, artifact, service, route, authz,
  and MCP scripts pass;
- no raw paths, handles, tokens, or binary payloads appear in public results;
- an admin records a bounded reason to admit only the deterministic development
  workspace, and another service instance observes the committed database row;
- a builder completes the approval-to-manifest flow;
- manifest gaps are displayed honestly; provenance can be complete only when a
  linked immutable `ready` input parsed as `ipynb` and carries the `code`,
  `notebook`, or `solver` role. Raw `parameters.sourceRevision` is informational,
  top-level `sourceRevision` remains `null`, and no VCS resolver exists.

This stage is development evidence only. The current deterministic result is
`SCIENCE GOLDEN PASS^3: 18 isolated deterministic suites; 34 evidence classes verified on every pass`.
Fresh recursive typecheck/build and the installed-browser Science gate (4/4)
also pass. The built-in workflow now waits durably for terminal Science state,
selects one bounded checksummed PNG, requests human approval of that exact
visible source, opens a replay-safe static session, and reads the complete
manifest. The deterministic provider labels the data-derived image
`fixturePreview=true` and `productionCompute=false`; none of this proves
notebook execution or scientific validity.

The focused scheduler verifier proves deterministic run/generation job IDs and
inline transient retry. A separate loopback Redis/BullMQ lane passes, including
a sentinel that survived `WAITAOF` and an exact Redis process restart. Target
replication/failover/latency remains external.

That BullMQ result applies to scheduler jobs, not event replay. Redis stream
publication is advisory and bounded to 1,500 ms with no writer offline queue;
Science database state is authoritative. Subscribers start from the latest
stream ID and keep no durable replay cursor, so reconnect/restart recovery must
reread the database rather than replay the event bus.

## Stage 2: deployment-shaped read-only

Configuration:

```dotenv
SCIENCE_ENABLED=1
SCIENCE_READ_ONLY=1
```

Scope:

- target PostgreSQL;
- Redis/BullMQ;
- target S3-compatible store and durable quarantine volume;
- production secret injection;
- health/read/export only;
- no new compute or render sessions;
- every workspace remains unadmitted even if a stale deployment backup omitted
  the migration-11 row.

Admission:

- production preflight and rendered-Compose parity are retained: enabled
  production refuses PGlite, inline Redis, and filesystem storage; read-only
  may omit compute; writable mode requires runtime URL/token/public base and
  explicit admission;
- the deployment verifier passes fail-closed preflight, same-origin web
  delivery, and Compose parity;
- the production nginx image runs as UID/GID 101 with a read-only root,
  dropped capabilities, bounded resources/tmpfs, no privilege escalation, and
  no secrets or Docker socket; loopback HTTP and installed-Chrome same-origin
  WebSocket probes pass;
- fresh installation through migration 16 passes on a dedicated loopback
  PostgreSQL instance with exact marker `science lifecycle (pg): ok`;
- the loopback Redis/AOF and dedicated unversioned MinIO/S3 lanes pass;
- external upload controls use exact defaults of 3,600,000 ms absolute timeout,
  60,000 ms idle timeout, and 4 concurrent external streams per workspace;
  allowed ranges are 1-86,400,000 ms, 1-3,600,000 ms (idle must not exceed
  absolute), and 1-128 streams respectively;
- target object store passes checksum, range, conditional-write, cleanup, and
  failure tests;
- backup and restore are demonstrated under one recovery-point ID;
- operator can inventory and export existing manifests/artifacts;
- rate limits, logs, and secret redaction are reviewed behind the intended
  reverse proxy.

Public `/api/health` proves only that the HTTP process is live. Public
`/api/readyz` exposes a detail-free cached readiness result and returns 503 on a
required dependency failure. Use authenticated `/api/readiness` for the redacted
dependency snapshot and authenticated `/api/bootstrap` for queue kind. Ensure the reverse
proxy omits signed query strings from its own access logs; the application
serializer already removes them.

External-stream admission is database-authoritative across server instances: a
workspace-row lock serializes the count and claim of unexpired external transfer
leases before an artifact-store writer opens. On an absolute or idle deadline,
the service stops lease renewal, cancels the request transport and iterator,
waits for the store writer to settle after abort, and commits a quarantined row
eligible for immediate cleanup. Retention must delete the partial quarantine
object before deleting the reservation and releasing quota; discard failure
keeps the row charged and retries with persisted backoff.

This stage must remain read-only if there is no previously admitted compute
provider.

## Stage 3: limited write pilot

Prerequisites:

- a real isolated notebook/container provider has passed its security and
  lifecycle suite;
- target-hardware upload, queue, provision, event freshness, run, recovery,
  storage, and concurrency SLOs are measured and accepted;
- the fresh installed-browser Science journey passes 4/4;
- the usable FUI lets a nontechnical admin/owner inspect and append an immutable
  validation record while all members read its history. A named domain expert
  and accepted workload-specific tolerance protocol are still required;
- a fresh database has applied migrations 1-16, including durable workflow
  waits, exact render replay/source state, and the database-authoritative
  external-upload stream fence;
- the rollback drill preserves manifests and artifacts;
- pilot workspace, users, corpus, quotas, and on-call owner are named.

Initial policy:

- one opt-in workspace admitted by an admin-only PATCH with a bounded rollout
  reason; member GET exposes only `workspaceId`, `admitted`, and `updatedAt`;
- the committed decision is observed through every server instance before
  enabling writes;
- non-regulated corpus only;
- one allowlisted immutable image/kernel;
- low concurrency and upload caps, including an explicitly reviewed
  `SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS` value;
- no trame, JEG, or OCCT unless each has separately passed Stage 4;
- daily review of the admin-only, redacted
  `/api/science/admin/action-queue`, plus provider-side discovery for executions
  that never obtained a database row;
- retained run, audit, provider, and storage evidence.

Persisted default-deny workspace admission, the reviewer FUI, durable static
workflow, and local browser gate are implemented, but there is no admitted real
notebook executor and no target operational/scientific acceptance. Stage 3
therefore remains blocked.

For a future admitted HTTP executor, production also requires
`SCIENCE_RUNTIME_ADMISSION=approved`, a bearer token, and health declaring
`executionMode="isolated_oci"`, `executesUserCode=true`, and a bounded immutable
instance ID. The bundled contract fixture declares the opposite and is rejected
before production submit.

## Stage 4: external capability admission

Admit each capability independently.

### Jupyter Enterprise Gateway

Requires authenticated start/channels/interrupt/shutdown, generation and
idempotency fencing, reconnect/restart, image/provisioner identity, scoped
storage, default-deny network, and orphan-cleanup evidence.

The current prerequisite verifies authenticated HTTPS, version floor, exact
instance fence, immutable kernelspec/image allowlist, bounded control responses,
recovery correlation, read-only orphan inventory, exact-handle cancellation,
and secret redaction. It is deliberately not registered as a
`ComputeProvider`; submit, channels, and output collection remain **NOT
PROVEN**.

Current decision: **NO-GO**.

### OCI executor

The deterministic candidate gate passes for rootless endpoint policy, state
ownership, seccomp, argv, quotas, idempotency, fencing, recovery, cancellation,
bounded output/HTTP, tombstones, and cleanup. The observed host daemon exposed
`seccomp` and `cgroupns`, not rootless mode, and no real notebook corpus ran.

Current decision: **NO-GO for live admission; deterministic candidate only**.

### trame

Requires same-origin HTTP/WebSocket gateway, CSP/origin enforcement,
two-user/workspace isolation, token expiry/replay, quota/load, disconnect,
server restart, process cleanup, memory recovery, and static fallback evidence.

Current decision: **NO-GO**.

### OCCT WASM

Requires selected build/license, representative STEP corpus, Web Worker parse,
explicit disposal, peak memory/parse time, hierarchy/units/bounds/triangle
metadata, fidelity tolerance, malformed-input behavior, and fallback policy.

Current decision: **NO-GO**.

## Observability during pilot

Monitor:

- health of storage, queue, compute, and render dependencies;
- active runs by state and generation;
- queue/provision/run/finalize duration;
- lease heartbeat age;
- cancelling runs and provider reachability;
- upload quarantine count/age and checksum failures;
- external-upload deadline failures and live database transfer-lease counts;
- Redis advisory event-bus disconnects separately from BullMQ job health;
- render sessions by state/expiry and failed cleanup;
- artifact bytes/object count;
- API 4xx/5xx/429 rates;
- measured CPU/memory/GPU/cost only when the provider reports them.

Unknown telemetry must remain `N/A`, not zero.

## Preservation-first rollback

### Scoped workspace revocation

1. As a workspace admin, PATCH
   `/api/science/workspace-admission` to `admitted=false` with the incident or
   rollback reason.
2. Confirm member GET returns the redacted denied decision and a second server
   instance enforces it at the next new-work boundary.
3. Keep reads, cancellation, render close, accepted-upload completion, exact
   checksum purge, and reconciliation available.
4. Allow accepted work to converge or cancel the exact run generation and wait
   for provider terminal evidence. Revocation itself is not a force-kill.
5. Re-admit only through a new reasoned admin decision after review.

### Normal deployment-wide rollback

1. Set `SCIENCE_READ_ONLY=1` and restart all server instances.
2. Confirm authenticated `/api/readiness` reports `science.enabled=true` and
   `submissionsEnabled=false`.
3. Resolve active work:
   - allow safe runs to finish; or
   - cancel the exact generation with a bounded incident reason and wait for
     provider terminal state. For an active or draft run, the reason is retained
     in the run event plus atomic and semantic audit. For an awaiting-approval
     run, the authoritative reason is retained in atomic and semantic audit
     only; its approval event carries `approvalId` and `decision`.
4. Close render sessions and reconcile leaked provider handles.
5. Capture a database plus artifact recovery point and verify checksums.
6. Keep Science readable for manifest/artifact export and incident review.
7. Roll back application code only if the older version safely ignores the
   additive Science schema. Do not downgrade/drop migrations or tables.
8. Run authenticated read/export smoke tests and the deterministic suite.

Read-only mode deliberately keeps scheduler ticks and cancellation authority so
accepted external work is not stranded.

### Emergency disable

Use `SCIENCE_ENABLED=0` only after:

- all provider executions are proven stopped;
- render sessions are closed;
- no operator depends on REST export;
- a verified metadata/artifact backup exists.

Disabling the feature also disables Science reads and cancellation through the
normal service. It is not a substitute for provider cleanup.

### Storage or database rollback

- Never point restored metadata at a different object's bytes.
- Restore exact objects whose size/SHA-256 match their version rows.
- Never rewrite a historical version or manifest to match available bytes.
- If exact bytes are unavailable, retain the broken evidence, upload a new
  version, and require a new run.
- Restore the signing secret only through the secret manager; otherwise
  outstanding capabilities will fail and render sessions must be recreated.

## Rollback triggers

Enter read-only mode immediately for:

- cross-workspace or cross-owner access;
- secret/internal-path leakage;
- duplicate external execution for one idempotency key;
- stale-generation completion or cancellation;
- ready artifact checksum mismatch;
- manifest/hash mutation;
- uncontrolled provider egress or privilege;
- accumulating orphan compute/render resources;
- inability to restore metadata and artifact bytes consistently;
- serious/critical accessibility failure that blocks the only safe operation
  path.

## Required retained rollback evidence

- deployment/application/schema versions;
- feature-flag and workspace-admission changes, bounded reasons, actors, and UTC
  timestamps;
- cross-instance observation of the committed admission/revocation decision;
- active-run/session inventory before and after;
- exact-generation provider cleanup receipts;
- database/object recovery-point ID;
- artifact and manifest hash verification;
- authenticated read/export result;
- deterministic suite result;
- reviewer and go/no-go decision.

No retained coordinated target rollback drill is currently available. Local
evidence is current: golden PASS^3 covers 18 isolated deterministic suites and
34 evidence classes; build/typecheck and the installed-browser 4/4 pass; and
dedicated loopback PostgreSQL 16/16, Redis/AOF restart, MinIO/S3, and hardened
nginx lanes pass. These results do not replace target rollback, TLS/load/HA/SLO,
CVE, real rootless/notebook or executable-JEG, trame/OCCT, or named domain
review gates. The original MVP and production release decisions remain **NOT
MET**.
