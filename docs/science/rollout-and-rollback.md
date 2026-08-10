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
- backup includes the new tables even while unused, including migration-11
  workspace admission rows and audit.

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
- synthetic, non-regulated fixtures only.

Admission:

- shared, database, kernel, server, and web build/typecheck pass;
- deterministic Science contract, lifecycle, artifact, service, route, authz,
  and MCP scripts pass;
- no raw paths, handles, tokens, or binary payloads appear in public results;
- an admin records a bounded reason to admit only the deterministic development
  workspace, and another service instance observes the committed database row;
- a builder completes the approval-to-manifest flow;
- manifest gaps are displayed honestly.

This stage is development evidence only. Current post-v11 aggregate/root reruns
are pending; historical pre-v11 passes do not satisfy this stage.

The focused scheduler verifier proves deterministic run/generation job IDs and
inline transient retry. It is not Redis/BullMQ durability evidence.

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

- fresh install and upgrade from pre-Science schema pass on PostgreSQL;
- target object store passes checksum, range, conditional-write, cleanup, and
  failure tests;
- backup and restore are demonstrated under one recovery-point ID;
- operator can inventory and export existing manifests/artifacts;
- rate limits, logs, and secret redaction are reviewed behind the intended
  reverse proxy.

Public `/api/health` proves only that the HTTP process is live. Use an
authenticated `/api/readiness` request for the cached Science dependency
snapshot and authenticated `/api/bootstrap` for queue kind. Ensure the reverse
proxy omits signed query strings from its own access logs; the application
serializer already removes them.

This stage must remain read-only if there is no previously admitted compute
provider.

## Stage 3: limited write pilot

Prerequisites:

- a real isolated notebook/container provider has passed its security and
  lifecycle suite;
- target-hardware upload, queue, provision, event freshness, run, recovery,
  storage, and concurrency SLOs are measured and accepted;
- browser accessibility/fallback gates pass;
- the rollback drill preserves manifests and artifacts;
- pilot workspace, users, corpus, quotas, and on-call owner are named.

Initial policy:

- one opt-in workspace admitted by an admin-only PATCH with a bounded rollout
  reason; member GET exposes only `workspaceId`, `admitted`, and `updatedAt`;
- the committed decision is observed through every server instance before
  enabling writes;
- non-regulated corpus only;
- one allowlisted immutable image/kernel;
- low concurrency and upload caps;
- no trame, JEG, or OCCT unless each has separately passed Stage 4;
- daily orphan/quarantine review;
- retained run, audit, provider, and storage evidence.

Persisted default-deny workspace admission is implemented, but the current
post-v11 rerun is pending and there is no admitted real notebook executor.
Stage 3 therefore remains blocked.

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

Current decision: **NO-GO**.

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
   - cancel the exact generation and wait for provider terminal state.
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

No retained rollback drill is currently available, and current post-v11
aggregate/root results remain pending. The MVP definition of done therefore
remains **NOT MET**.
