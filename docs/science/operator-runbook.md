# Science Operations operator runbook

## Runbook status

These procedures match the current control-plane behavior. A deterministic
cold PGlite/filesystem recovery verifier passes, but the disaster-recovery and
production-provider procedures are not demonstrated on target infrastructure;
execute and retain that drill before admitting writes. The current post-v11
aggregate/root reruns are also pending.

Never repair Science by manually changing a run state, generation, manifest
hash, artifact checksum, or render-session owner in the database. Those fields
are lifecycle fences and evidence.

## First response

1. If one workspace is affected, revoke that workspace first using the
   reasoned admin procedure below. If multiple workspaces or deployment
   dependencies are affected, set `SCIENCE_READ_ONLY=1` and restart every
   server instance. Both controls block new resource acquisition while
   preserving reads, cancellation, render close, accepted-upload completion,
   exact checksum purge, scheduler ticks, and reconciliation. Render renewal is
   blocked.
2. Capture:
   - UTC time and deployment version;
   - public `/api/health` liveness;
   - public detail-free `/api/readyz` status/code;
   - authenticated `/api/readiness` Science dependency status;
   - affected workspace/study/run/version/session IDs;
   - run generation and recent persisted events;
   - provider kind/version and queue mode from `/api/bootstrap`;
   - redacted server/provider logs.
3. Do not copy provider handles, signed URLs, tokens, storage keys, or raw
   scientific data into tickets or chat.
4. Decide whether the incident is metadata, artifact bytes, queue/scheduler,
   compute provider, renderer, quota, or scientific validation.

Read-only database diagnostics for a privileged operator:

```sql
SELECT id, study_id, state, execution_generation, heartbeat_at,
       lease_expires_at, updated_at, finished_at, error
FROM science_runs
WHERE state NOT IN ('succeeded', 'failed', 'cancelled')
ORDER BY updated_at;
```

Do not include `provider_handle` in ordinary incident output. Retrieve it only
inside the restricted provider-reconciliation procedure.

## Workspace pilot admission and revocation

1. Read the public/member projection:

   ```http
   GET /api/science/workspace-admission
   ```

   It contains only `workspaceId`, `admitted`, and `updatedAt`. A missing
   database row must appear as `admitted=false`; do not create blanket
   admission rows during an upgrade.
2. Only a workspace admin may change the decision. Supply a bounded,
   incident-specific reason:

   ```http
   PATCH /api/science/workspace-admission
   Content-Type: application/json

   {"admitted":false,"reason":"INC-1234 provider isolation under investigation"}
   ```

3. Verify the atomic audit record identifies the actor, action, workspace,
   reason, and resulting decision. The member-facing GET intentionally redacts
   row ID and updater.
4. Read the decision through another server instance. The database is
   authoritative at every new-work boundary; an instance must not require a
   restart or cache expiry to enforce the committed revoke.
5. Expect in-flight convergence, not force termination. A revoke blocks the
   next new study/artifact/upload intent/profile/run, approval into execution,
   reproduction, render start, or render renewal. It leaves reads,
   cancellation, scheduler reconciliation, render close, accepted-upload
   streaming/completion, and exact checksum purge available.
6. If an already accepted run must stop, cancel its exact generation and wait
   for provider terminal evidence. Do not infer that revocation cancelled it.
7. Re-admit only after the incident/provider gates are resolved, with a new
   reason and retained review evidence.

## Stuck run

A run is suspicious when its state/events stop changing beyond the selected
profile's expected provisioning/wall-time behavior. There is no accepted
global SLO yet, so do not use an invented fixed threshold.

1. Fetch `GET /api/science/runs/:runId` and record state, generation, resource
   request, recent event sequence, timestamps, and error.
2. Check authenticated `/api/readiness`:
   - database must be healthy even when Science is disabled;
   - storage must be healthy;
   - the attached queue must be healthy;
   - at least one compute provider must be healthy when submissions are enabled;
   - inspect render-provider status, while remembering that render health is
     reported but does not currently gate the top-level readiness result.
   Readiness is cached for up to five seconds. It includes database and queue adapter/state,
   pending, and active counts. Confirm the expected adapter (`bullmq` in a
   Redis-backed deployment) in authenticated `/api/bootstrap`; public
   `/api/health` is process liveness only, while public `/api/readyz` exposes no
   dependency detail and returns 503 when the cached dependency result fails.
   PostgreSQL uses a dedicated health pool with two-second acquisition, query,
   and statement bounds. Redis producer/health disables offline queuing and
   automatic resend, permits one retry, uses 1.5-second connect/command bounds,
   and deduplicates a two-second ready wait; the BullMQ blocking worker remains
   retry-unbounded. Local TCP-blackhole checks prove bounded DB and Redis probe
   failure, but the target deployment still requires a failure drill.
3. Check the latest lease read-only:

   ```sql
   SELECT id, state, execution_generation, heartbeat_at, lease_expires_at,
          updated_at
   FROM science_runs
   WHERE id = '<run-uuid>';
   ```

4. If the provider and database are healthy, restart one server instance.
   Startup reconciliation leaves `draft` and `awaiting_approval` unchanged,
   and re-enqueues `queued`, `provisioning`, `running`, `finalizing`, and
   `cancelling` using persisted generation/handle identity. It must not
   resubmit a persisted provider handle or duplicate already committed
   finalization outputs. Do not delete the queue job or clear the handle. This
   seven-state deterministic matrix exists in source assertions, but its
   current post-v11 aggregate/root rerun remains pending; live Redis/provider
   interruption is still a separate gate.
5. If cancellation is required, use the authenticated cancel API with the
   observed generation:

   ```json
   { "generation": 3 }
   ```

   The public REST field is `generation`; the service maps it to its internal
   expected-generation fence. A stale generation returns conflict.
   `cancelling` is expected until the provider proves the exact execution
   terminal.
6. If provider calls remain unreachable, keep the run `cancelling`, isolate the
   provider, and use the orphan procedure. Do not force `cancelled`.

Escalate when a healthy provider reports a different generation, output
receipts change across identical status calls, or a terminal run still has a
live provider execution.

## Orphan compute handle

An orphan is either:

- a provider execution with no matching run/idempotency receipt; or
- a live provider execution whose run is already terminal.

The control plane also uses the orphan path when repeated provider failures or
pending cancellation require intervention. The run dossier retains bounded
`science.run.log`/lifecycle events with `adminActionRequired=true`; the audit
log records `science.run.orphaned`. A persisted handle binds provider kind,
instance ID, and opaque handle. Every operation carries that expected instance
ID, so a conforming provider rejects an old execution request before acting
through a replacement instance.

1. Enter read-only mode.
2. In a restricted terminal, correlate:
   - run ID;
   - idempotency key hash/receipt;
   - persisted generation;
   - provider handle;
   - provider-reported generation and state.
3. If the database run is non-terminal and identities match, restore provider
   reachability and restart Puppetmaster so reconciliation resumes it.
4. If the database run is terminal but the exact same provider execution is
   still live, terminate that exact handle/generation through the provider's
   administrative control, retain its response, and verify no newer execution
   shares the handle.
5. If no database run exists, stop the external execution through the provider,
   retain provider audit/idempotency evidence, and open an incident. Do not
   create a fabricated run row after the fact.
6. Keep any produced bytes quarantined until their run/generation/checksum can
   be proven. Do not attach orphan output to another run.

The current UI has no aggregated admin orphan queue. Use the run dossier and
restricted audit log to identify known cases, then provider-side discovery to
find executions that never obtained a database row. A retained cleanup drill
is required before production admission.

## Interrupted or corrupt artifact

### Upload is pending/uploading/expired

- Do not resume by appending to the quarantine object. Current semantics require
  a new upload intent and a full restart.
- Upload transfer first claims and renews an ownership-fenced transfer lease.
  Do not expire/discard an `uploading` row while that lease is live. Provider
  output keeps its reservation/lease through pending-version promotion and the
  ready/output-link commit or quarantined terminal handoff; only that terminal
  database transition permits reservation deletion.
- Upload finalization first claims a renewable lease. Do not expire or delete a
  `finalizing` row whose lease remains live.
- Do not manually discard a cleanup-eligible version while an unexpired upload
  reservation with the same artifact ID and expected SHA-256 remains in
  `pending`, `uploading`, or `finalizing`. Repository cleanup fences all three
  states and resumes after the matching reservation's `expiresAt`.
- Startup and the periodic bounded single-flight full reconciliation pass
  expire stale rows and re-enqueue recoverable database runs. Retention retries
  exact quarantine discard first and deletes the
  terminal reservation only after discard succeeds. Until then the row remains
  visible and workspace-quota charged. Migration 8 persists retry attempts and
  exponential `cleanup_not_before` deferral so one failed object cannot occupy
  every bounded pass.
- The separate old-orphan sweep excludes every quarantine key still referenced
  by the database across all workspaces. Do not use a broad age-only filesystem
  deletion as a substitute.
- Retry with the original expected size and SHA-256 only if the source bytes
  are unchanged.

### Upload/version is quarantined

1. Read the bounded upload/version error and compare declared versus observed
   receipt.
2. Preserve the quarantine metadata for incident evidence.
3. Validate the source out of band.
4. Create a new upload intent. Never flip the quarantined version to `ready`.

Unlinked provider-output versions carry an internal cleanup-eligibility fence.
After the configured age, retention retries removing their exact object before
sealing the retained version as an expired, non-cleanup-eligible tombstone and
releasing its quota charge. Its ID, ordinal, and checksum row are never deleted
or reused. A live matching upload reservation blocks this transition as
described above. A quarantined user-upload version is not automatically given
the eligibility flag; preserve it for investigation or an approved retention
workflow.

### Admin checksum-confirmed version purge

This is an object-specific maintenance action, not a general retention or legal
hold workflow. It is convergence/cleanup, so it remains available after
workspace revocation and in global read-only mode. Only an authenticated
workspace admin may call it, and every provenance and checksum fence still
applies.

1. Confirm the target version is `ready`, belongs to the workspace, and the
   exact stored lowercase SHA-256 is known from trusted metadata.
2. Verify that no run input/output link, child artifact version, render-session
   row, or active upload finalization retains it. A live or unsuccessfully
   closed render session is a provenance hold. Do not remove those references
   manually.
3. Send:

   ```http
   DELETE /api/science/artifact-versions/<version-uuid>
   Content-Type: application/json

   {"confirmSha256":"<exact-64-lowercase-hex>"}
   ```

4. A checksum mismatch, non-`ready` state, retained descendant/reference, or
   active finalization must return conflict. A builder must receive forbidden.
5. On success, the service removes the exact immutable object before releasing
   its workspace quota charge. It retains an `expired`,
   `cleanupEligible=false` tombstone preserving version ID, ordinal, checksum,
   and completed-upload evidence. The DELETE response is an `expired` receipt;
   metadata reads may return that tombstone, while content reads are refused
   because only `ready` bytes are readable.
6. Retain the database-atomic initiating-user/action mutation record, any
   secondary semantic-sink entry, and the administrative approval/incident
   record that authorized the purge. The semantic sink is best-effort; its
   absence does not imply that the atomic actor-attributed row is absent.

If storage deletion times out or fails, do not delete metadata to “finish” the
operation. The expired cleanup-eligible row remains quota-charged so an exact
admin retry or the next full reconciliation pass can converge safely.

### A `ready` object is missing or fails its stored checksum

1. Set read-only mode immediately.
2. Identify affected runs without modifying them:

   ```sql
   SELECT ra.run_id, ra.direction, ra.semantic_role, r.state
   FROM science_run_artifacts ra
   JOIN science_runs r ON r.id = ra.run_id
   WHERE ra.artifact_version_id = '<version-uuid>';
   ```

3. Isolate the storage object and preserve logs/versioning evidence.
4. If an exact backup copy matches the existing stored SHA-256 and size,
   restore those exact bytes to the same immutable object key under a controlled
   recovery.
5. If exact bytes cannot be restored, leave the existing version and manifests
   unchanged. Upload recovered/different bytes as a new version and require new
   runs. Never rewrite historical checksums.
6. Verify a full or representative hash inventory before leaving read-only
   mode.

## Expired or leaked render session

### User-visible expiry

- Expiry is intentional. Open a new render session; do not reuse a stale
  gateway URL or token.
- Renew is valid only for an owner-bound live session.
- A static session can be recreated without exposing object storage.

### Provider process remains after expiry/close

1. Set read-only if leaks are accumulating.
2. Confirm the exact session ID, owner/workspace, encoded provider kind, and
   provider handle in a restricted context.
3. Startup and periodic full reconciliation retry `close` for expired,
   failed, and revoked sessions that retain handles. Restarting Puppetmaster
   also triggers that reconciliation.
4. If cleanup still fails, terminate the exact provider handle through the
   provider administration plane and retain evidence.
5. Do not reactivate a terminal session row. The user must create a new one.

Cleanup retry is bounded and single-flight inside startup/periodic full
reconciliation. trame remains no-go because this does not prove
remote process/memory cleanup or WebSocket behavior.

After an exact provider close succeeds, Puppetmaster deletes the terminal
render-session row. That closed session no longer blocks an otherwise eligible
artifact-version purge. If close fails, the row/handle remains discoverable and
continues to protect the artifact until cleanup is proven.

If the stored provider handle is a launch-attempt marker, do not send it to the
renderer as though it were an actual handle. The marker was persisted before
remote start and means the launch outcome is ambiguous. It consumes the
workspace render quota and preserves the artifact hold until an administrator
correlates the provider-side idempotency/session record and either installs the
actual handle through supported recovery or proves no process exists.

If a proxied nested resource returns not-found, verify that the renderer
advertised the correct upstream base path. Do not relax the gateway's rejection
of encoded dot/backslash/query/fragment paths or its exact base-prefix/origin
check. CSP intentionally limits `connect-src` to self; a renderer requiring a
direct external WebSocket is not admitted through this HTTP gateway.

### Stalled S3 operation

- Signed S3 PUT/HEAD/GET/DELETE operations have one total
  `SCIENCE_S3_REQUEST_TIMEOUT_MS` deadline, including response streaming. The
  default is 300000 ms and the maximum is 3600000 ms.
- Storage health remains capped at five seconds, so readiness can fail well
  before a legitimate large object transfer reaches its total deadline.
- A timed-out purge/retention DELETE must leave metadata and quota retained.
  Restore object-store reachability and retry the exact operation; never bypass
  the reference fences or delete the database row manually.
- A DELETE response carrying `x-amz-delete-marker: true` or any
  `x-amz-version-id` is rejected, and cleanup also requires a follow-up HEAD
  404. Automatic purge therefore requires a dedicated unversioned bucket. Do
  not enable versioning and assume a delete marker proves bytes were removed;
  version-aware deletion/retention is not implemented.
- Raising the deadline may mask an unhealthy store. Change it only from
  measured object-size/latency evidence and keep it within the configured cap.

## Quota exhaustion

The active-run limit is enforced atomically when approval resolves. Profile
ceilings separately bound each request. A second, serialized workspace storage
quota counts all artifact-version bytes plus `pending`, `uploading`,
`finalizing`, `quarantined`, and `expired` upload reservations. Provider output
reserves its declared size before the provider stream is opened.

1. List active runs and owners:

   ```sql
   SELECT id, study_id, created_by, state, created_at, updated_at
   FROM science_runs
   WHERE state IN ('queued', 'provisioning', 'running', 'finalizing', 'cancelling')
   ORDER BY created_at;
   ```

2. Let valid work complete or have an authorized builder cancel the exact run
   generation.
3. Do not bypass the limit by editing state or generation.
4. If capacity evidence justifies a larger limit, change
   `SCIENCE_MAX_CONCURRENT_RUNS`, restart, and record the approval. The current
   allowed range is 1-128.
5. For a per-run ceiling, an admin may update the compute profile after
   provider capacity and image policy review. Existing runs keep their captured
   snapshot.
6. Treat HTTP 429 separately: the built-in rate limiter is per process and
   resets each minute. Fix abusive retry loops before raising it.

Render capacity is separate: `SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` defaults
to 2 and permits 1-64 per workspace. Starting/ready rows and any terminal or
ambiguous row still carrying a handle consume a slot. Resolve the exact remote
handle; never clear the database field to manufacture capacity. Remote close
is successful only on 200, 204, or idempotent 404.

For a storage-quota conflict, inspect retained/reserved bytes read-only:

```sql
SELECT coalesce(sum(v.size_bytes), 0) AS artifact_version_bytes
FROM science_artifact_versions v
JOIN science_artifacts a ON a.id = v.artifact_id
JOIN science_studies s ON s.id = a.study_id
WHERE s.workspace_id = '<workspace-uuid>'
  AND (v.status <> 'expired' OR v.cleanup_eligible = true);

SELECT state, count(*) AS reservations,
       coalesce(sum(expected_size_bytes), 0) AS reserved_bytes
FROM science_uploads
WHERE workspace_id = '<workspace-uuid>'
  AND state IN ('pending', 'uploading', 'finalizing', 'quarantined', 'expired')
GROUP BY state
ORDER BY state;
```

Do not delete rows to reclaim capacity. Let retention prove byte deletion, or
perform an approved object-specific cleanup and retain evidence. Raise
`SCIENCE_MAX_WORKSPACE_STORAGE_BYTES` only after verifying actual storage and
backup capacity; the allowed range is 1 byte through 1 TiB.

## Provider or queue outage

- Revoke the affected workspace for a scoped provider incident; enter global
  read-only mode for a broad outage. Neither action force-terminates accepted
  work.
- Redis loss does not make the database state disappear. Restore Redis and
  restart the server; startup reconciliation re-enqueues recoverable runs, and
  the same DB-to-queue repair repeats on the periodic full reconciliation
  interval.
- Producer enqueue and readiness should fail within the configured bounded
  Redis path; the worker connection deliberately keeps retrying for BullMQ
  blocking semantics. If HTTP readiness hangs beyond the five-second cache
  fill rather than returning 503, treat that as a defect and retain a network
  trace.
- Queue jobs use deterministic run/generation IDs, and the focused scheduler
  verifier proves deterministic IDs plus transient retry for the inline path.
  This is not live Redis durability evidence.
- Do not replay submit with a new idempotency key. The persisted run and its
  original provider identity are authoritative.
- A provider health failure while submissions are enabled makes Science health
  fail when no compute provider remains healthy.
- If the provider has lost state, do not claim success from output files alone.
  Reconcile receipts, generation, checksums, and run events; otherwise fail the
  incident honestly and retain the orphan data.

## Unexpected reproduction comparison

Compare two runs only after both manifests exist by posting the candidate run
ID to `/api/science/runs/:runId/reproduce`. Treat the returned dimensions
independently: input, parameter, environment, and output identity are exact
canonical comparisons. They do not establish numerical equivalence.

`numericallyEquivalent=null` and `numericalValidation=null` mean no named
candidate numerical assessment with a bounded non-empty metric and tolerance
was recorded. The comparison never borrows numerical evidence from the
source/left run. Review the returned observed value and units when supplied,
plus the corresponding domain-review method. Never infer convergence or
publication readiness from matching hashes alone.

## Signing-secret rotation

1. Enter read-only mode.
2. Stop or wait for compute using outstanding signed input references.
3. Close render sessions.
4. Rotate `SCIENCE_SIGNING_SECRET` through the deployment secret manager and
   restart all server instances together.
5. Confirm old signed artifact URLs and render tokens fail.
6. Confirm authenticated artifact reads and newly created capabilities work.
7. Resume writes only after provider and storage health pass.

Rotation does not change artifact bytes or manifests. It invalidates
outstanding capabilities.

## Disaster recovery

Status: **deterministic cold PGlite/filesystem drill passes; target drill
pending**. No production RPO/RTO is accepted yet.

### Backup set

Back up as one named recovery point:

- PostgreSQL database or persistent PGlite directory;
- filesystem artifact root, or S3 bucket with object versions/checksum metadata;
- local S3 quarantine root if in-flight upload recovery is required;
- Redis is not the source of truth, but its loss affects queue latency. The
  Compose AOF/`redisdata` volume improves restart durability but is not a
  backup;
- admitted runtime provider state/idempotency receipts;
- deployment configuration and provider/image allowlists;
- secret-manager versions for Science signing, storage, runtime, and renderer.

Do not put plaintext secrets into the backup manifest.

### Create a consistent recovery point

1. Set `SCIENCE_READ_ONLY=1`.
2. Wait for active work to finish or cancel it and wait for exact provider
   terminal state.
3. Stop Puppetmaster schedulers/server and any admitted provider.
4. Snapshot database and artifact objects under one recovery-point ID.
5. Record schema migration versions, object count/bytes, and a checksum
   inventory or sampled inventory with an explicit sampling method.
6. Back up provider state required for idempotency and orphan correlation.
7. Restart in read-only mode and verify health.

### Restore

1. Restore into an isolated environment with external egress and submissions
   disabled.
2. Restore database, immutable artifact objects, provider state, configuration,
   and the correct secret versions.
3. Build/run the same application version and confirm `schema_migrations`.
   The current expected Science-capable ledger runs through version 11
   (`science-workspace-pilot-admission`), including version 5
   (`science-domain-atomic-audit`), version 6
   (`science-quarantine-retention`), version 7
   (`science-upload-finalization-fence`), version 8
   (`science-cleanup-retry-backoff`), version 9
   (`science-upload-transfer-fence`), and version 10
   (`science-actor-attributed-atomic-audit`). Version 11 adds the unique
   default-deny workspace-admission row and its atomic audit trigger.
   Each unapplied migration's DDL and ledger entry commit in one transaction;
   a failed statement must leave neither the earlier DDL nor its ledger row.
   PostgreSQL also uses a transaction-scoped advisory lock, while PGlite
   serializes migrators only within the process.
4. Verify object existence, sizes, and SHA-256 against artifact-version rows.
5. Confirm manifest hashes by canonical serialization.
6. Start Puppetmaster in read-only mode and let reconciliation enumerate, but
   do not admit new work.
7. Check non-terminal runs and render handles individually. Terminate or
   recover exact provider generations; do not bulk-force terminal states.
8. Run the deterministic Science contract/service/authz suite.
9. Perform an authenticated read/export smoke test and confirm a missing
   admission row remains denied.
10. Only after review, record an explicit admin admission with a bounded restore
    reason, verify it from a second instance, and then remove global read-only
    mode. Do not bulk-admit restored workspaces.

Retain timestamps, commands, versions, counts, hash results, and reviewer
approval. Until this procedure is demonstrated on the target deployment, WP7
and the MVP definition of done remain pending.
