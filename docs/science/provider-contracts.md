# Science provider contracts

Provider interfaces are internal trust boundaries. They do not grant a service
Puppetmaster identity or permission to invent scientific claims.

## ArtifactStore

Authoritative interface:
`packages/kernel/src/science/artifact-store.ts`.

| Operation | Required behavior |
|---|---|
| `createQuarantine(key)` | Create a new empty, private upload target; reject traversal and reuse. |
| `writeQuarantine(key, body, {maxBytes})` | Stream without whole-file buffering, enforce the cap, return observed size and lowercase SHA-256. |
| `openQuarantine(key, range?)` | Read only the bounded sample/range needed for pre-promotion format validation. |
| `discardQuarantine(key)` | Idempotently remove incomplete bytes. |
| `promote(quarantineKey, storageKey, expected)` | Publish only exact size/hash; never overwrite different bytes; make crash retry idempotent. |
| `open(storageKey, range?)` | Stream full or inclusive byte-range content and report full object size. |
| `remove(storageKey)` | Remove the exact internal object; callers own retention policy and retain metadata/quota until this succeeds. |
| `cleanupQuarantine(olderThan, protectedKeys?)` | Remove old orphan quarantine content within the configured root while preserving every protected database key. |
| `reference(...)` | Return a short-lived, audience-bound same-origin GET capability containing no host path. |
| `verifyReference(...)` | Verify expiry and HMAC in constant time. |
| `health()` | Report adapter reachability without returning credentials. |

Rules:

- Only `ready` versions can be run inputs.
- Run creation validates the complete canonical input set and writes the
  mission, run, minimum trace step, and every input link in one database
  transaction. An idempotent replay must present the exact same input set.
- Storage and quarantine keys never cross public REST/tool DTO boundaries.
- A signed reference is a capability, not a session. It is bound to version ID,
  audience, expiry, checksum, and size.
- Provider bytes are streamed separately from provider control JSON.
- Retained-byte admission is serialized on the workspace row. Every artifact
  version and every upload reservation whose quarantine deletion is unproven is
  charged against `SCIENCE_MAX_WORKSPACE_STORAGE_BYTES`; an exact deduplicated
  version is returned before any additional charge.
- Manual and provider-output streams claim and renew a transfer lease while
  bytes are moving. Provider-output reservations keep that lease through
  pending-version promotion and the ready/output-link commit or quarantined
  terminal handoff; cleanup cannot reclaim a live transfer.
- External manual uploads are bounded independently of the upload-intent TTL:
  `SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS` defaults to 3600000 (one hour,
  maximum 86400000), while `SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS` defaults
  to 60000 (one minute, maximum 3600000) and must not exceed the absolute
  deadline. The absolute clock never resets; the idle clock resets only when a
  body chunk advances. `SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS`
  defaults to 4 and accepts 1-128 per workspace.
- The external-stream cap is a database-authoritative, cross-instance fence,
  not a process-local counter. Claiming an upload locks the workspace row and
  atomically counts only external `uploading` reservations with a live transfer
  lease before opening the object-store writer. Rejected, foreign, already
  claimed, and completed-replay requests do not leave their incoming body
  running.
- When either stream deadline fires, Puppetmaster aborts the storage writer,
  destroys/returns the incoming iterator best-effort, stops renewing the
  transfer lease, and waits for the writer to settle before committing the
  quarantine transition. That transition clears the transfer identity and
  cross-instance slot and makes a timed-out partial object immediately cleanup
  eligible. Reconciliation must still discard the exact quarantine object
  before deleting the terminal reservation; until discard succeeds, the
  reservation remains visible and quota-charged. Size, checksum, or parsed
  format failures are quarantined for evidence under the normal upload TTL,
  rather than receiving the timeout-only immediate-cleanup flag.
- Upload finalization claims a renewable lease before validation/promotion.
  Concurrent finalizers cannot both proceed, and cleanup cannot expire a live
  finalizer until its lease is lost.
- Cleanup of eligible rows is row-driven and retry-safe. Terminal upload
  reservations are deleted only after exact quarantine discard succeeds.
  Version quarantine cleanup is fenced while any unexpired `pending`,
  `uploading`, or `finalizing` reservation matches both its artifact ID and
  SHA-256, and becomes eligible again only after that reservation expires.
  Artifact-version bytes are discarded first, but their immutable metadata row
  is retained as an `expired`, `cleanupEligible=false` tombstone so its ID,
  ordinal, and checksum can never be reused. Persisted cleanup-attempt counts
  and `cleanup_not_before` backoff rotate failures behind later candidates.
- The age-based orphan sweep receives the complete database-referenced
  quarantine-key set across workspaces and must never remove a protected key.
- The administrative version-purge path accepts only an exact SHA-256
  confirmation for a `ready`, workspace-owned version. Under artifact/study and
  version locks it rejects run links, retained descendants, any render-session
  row, and active finalization. Only then may it mark cleanup eligibility,
  remove bytes, and release quota by sealing the retained tombstone.

Current adapters:

- `FilesystemArtifactStore`
- `S3CompatibleArtifactStore` with local quarantine and path-style SigV4

All signed S3 PUT/HEAD/GET/DELETE requests use one total deadline, including
body streaming. `SCIENCE_S3_REQUEST_TIMEOUT_MS` defaults to 300000 and is capped
at 3600000; health combines it with a tighter five-second signal. The
deterministic verifier proves a stalled DELETE aborts. A dedicated,
unversioned loopback MinIO bucket also passed health, immutable promotion,
full/range reads, receipt checks, duplicate refusal, and exact deletion. Target
TLS, IAM, network, versioning, capacity, and recovery remain external gates.

S3 removal rejects a successful response that carries either
`x-amz-delete-marker: true` or `x-amz-version-id`, then performs a signed HEAD
and requires 404 absence proof. Automatic purge therefore requires a dedicated
unversioned bucket. The adapter does not enumerate or delete prior object
versions; version-aware general retention remains pending.

## Event notification and queue boundary

Science lifecycle mutations and run events commit to the database before an
event-bus notification is attempted. The database and normal read APIs are the
authoritative state; a Redis notification is only a bounded hint to connected
processes and clients. The production event-bus writer appends to the
approximately capped 10000-entry `puppetmaster:bus` Redis Stream, disables an
unbounded offline command queue, and settles success, transport failure, or
timeout within the current 1500 ms publish bound. Notification failure does
not roll back or strand already committed Science work.

The reader starts at Redis ID `$` and retains its position only in that running
process. There is no persisted replay cursor, consumer group, or `Last-Event-ID`
recovery contract. A disconnected or newly started subscriber can miss
notifications and must refresh authoritative database-backed endpoints; it
must not infer lifecycle state from the stream alone.

This event stream is separate from BullMQ. BullMQ carries deterministic
run/generation scheduler jobs and has its own producer, worker, recovery, and
readiness behavior. Redis/AOF evidence for one path does not turn the advisory
event stream into a durable queue, nor does an event publish prove that a
BullMQ job was enqueued.

## ComputeProvider

Authoritative interface:
`packages/kernel/src/science/providers.ts`.

### Resource request

```json
{
  "cpuMillicores": 1000,
  "memoryMb": 2048,
  "gpuCount": 0,
  "wallTimeSeconds": 300
}
```

The request is distinct from the compute profile's ceilings. Every dimension
must be at or below the captured profile bounds.

### Quote

A quote returns:

- `available`;
- provider name;
- `source`: `declared` or `measured`;
- nullable queue and wall-time estimates;
- nullable cost;
- provider limits;
- an optional bounded reason.

Unknown cost is `null`, never zero. A declared estimate must not be displayed as
measured telemetry.

### Submit

`submit` receives:

- run ID, science mission ID, and execution generation;
- stable idempotency key and submission timestamp;
- immutable image digest and kernel;
- normalized parameters and exact resource request;
- input receipts and signed references.

The provider must map an idempotency key to one external execution. Replaying
the same semantic request after a timeout must return the same handle. Stable
identity includes the run/mission/generation, image/kernel, parameters,
resources, and immutable input receipts. Ephemeral signed-reference URLs may
be refreshed and must not create a different execution or idempotency conflict.
The provider must copy/fetch inputs before acknowledging a new submit; on a
replay for an already accepted execution it returns the existing handle. The
handle is opaque, bounded, and never public.

Before claiming or resuming work, Puppetmaster obtains a bounded provider
instance identity. The persisted private handle binds provider kind, instance
ID, and opaque handle. Every submit/status/cancel/collect/open operation also
receives an `expectedInstanceId` fence. A replacement runtime with a different
instance ID must reject the operation before touching an execution; the run
remains evidence-safe and raises the orphan/admin-action path.

Puppetmaster also appends exactly one durable `science.run.submit_attempted`
event containing provider kind, immutable instance ID, and idempotency key
before the first external submit request. If the response is lost, only that
recorded provider instance/key may be retried. If cancellation arrives while the handle
is ambiguous, the same replay must recover the handle before exact-generation
cancellation; local cancellation would risk orphaning accepted compute.

### Status and cancellation

Every `status` and `cancel` call includes the exact persisted generation.

- `cancel.accepted=true` means termination was accepted, not that it completed.
- Puppetmaster remains `cancelling` until `status` proves `cancelled`, `failed`,
  or another safe terminal condition.
- A provider must reject or safely ignore a generation mismatch.
- An optional 1-1000 character cancellation reason is control-plane provenance,
  retained in the run event and audit context (including awaiting-approval
  cancellation). It is not authority to cancel a different generation and need
  not be disclosed to the provider.
- Logs are bounded to 32 entries of 2000 characters per response.
- Metrics are bounded to 64 finite measurements with names, units, and
  timestamps.

### Outputs

`collectOutputs` returns no more than 200 receipts. The complete encoded output
list must be no larger than 64 KiB. Each receipt includes:

- same-origin reference, never an inline `data:` URL;
- logical name, kind, format, and media type;
- lowercase SHA-256 and exact byte size;
- JSON metadata no larger than 32 KiB.

`openOutput` streams the referenced bytes. Puppetmaster independently enforces
the declared byte ceiling while streaming, verifies size and SHA-256, and
promotes the immutable object. Database readiness and the exact-generation
output link then commit together under the live worker lease. If that commit
loses a cancellation/generation/lease race, the version is quarantined and its
promoted object is removed best-effort; it cannot expose an unlinked `ready`
output or permit `succeeded`.

Before `openOutput` is called, Puppetmaster durably reserves the receipt's
declared size under the serialized workspace quota. The provider is not opened
when reservation admission fails. Streaming still enforces the declared size
at the first excess byte. Version creation accepts only an observed size at or
below that reservation and excludes only that exact reservation during
admission. The reservation and renewable transfer lease remain through pending
version promotion and the atomic ready/output-link commit (or quarantined
terminal handoff), then the reservation is deleted. A failed transfer,
validation, or promotion leaves it charged until discard-before-delete cleanup
succeeds, preventing a failed deletion from making quota capacity fictitiously
available.

### Manifest provenance boundary

Provider completion is not enough for a provenance-complete manifest. The run
must link an immutable, `ready`, successfully parsed notebook artifact whose
kind is `notebook`, normalized format is `ipynb`, and semantic role is exactly
`code`, `notebook`, or `solver`. The selected input version becomes
`codeArtifactVersionId`; database finalization rechecks that it is a ready,
same-study run input before accepting the manifest.

`parameters.sourceRevision` is raw, user-controlled informational input. The
current release has no VCS/repository resolver that can bind such a string to
immutable bytes, so the verified top-level `sourceRevision` is always `null`.
A declared revision neither substitutes for the linked parsed notebook nor
becomes verified because it resembles a commit hash. Without the qualifying
input the manifest is incomplete with
`manifest.codeArtifactVersionId`; when a raw revision was also declared it
additionally records `manifest.sourceRevision.unverified`. A run may therefore
reach provider success while its provenance assessment remains incomplete.

## HTTP compute runtime v1

Authoritative adapter:
`HttpComputeProvider`.

```text
POST /v1/quote
POST /v1/runs                         Idempotency-Key required
GET  /v1/runs/{handle}?generation=N
POST /v1/runs/{handle}/cancel
GET  /v1/runs/{handle}/outputs?generation=N
GET  /v1/outputs/{opaque-output}
GET  /health
```

Enabled production Science first requires durable PostgreSQL, Redis, and S3
configuration. Read-only production may omit compute. Writable production
additionally requires runtime URL/token, `SCIENCE_PUBLIC_BASE_URL`, and
`SCIENCE_RUNTIME_ADMISSION=approved`; the preflight runs before database or
provider construction.

All control requests use JSON. When configured, Puppetmaster sends
`Authorization: Bearer <SCIENCE_RUNTIME_TOKEN>`. Production configuration
requires that token and `SCIENCE_RUNTIME_ADMISSION=approved`. The admission
value alone is insufficient: before submit the production adapter also
requires runtime health to declare `executionMode="isolated_oci"`,
`executesUserCode=true`, and a bounded instance ID.

Every execution-scoped request, including submit and output byte reads, sends
`X-Science-Provider-Instance` with the expected immutable instance ID. The
runtime must fail closed on a missing/mismatched value before reading or
mutating the referenced execution. `/health` discovers identity; it does not
replace the operation-level fence.

Additional adapter constraints:

- base URL must be HTTP(S);
- configuring an external compute/render adapter requires
  `SCIENCE_PUBLIC_BASE_URL`, so signed artifact references are absolute and
  provider-reachable;
- the runtime must allowlist that base's exact origin through
  `SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS`;
- every constructed control/output URL must remain on the configured origin;
- output paths must begin `/v1/outputs/`;
- requests use a bounded timeout;
- Puppetmaster request logging strips the entire query string; runtime,
  reverse-proxy, and provider logs must do the same because input capabilities
  remain secrets until expiry;
- fetch uses manual redirect handling; every redirect, 3xx response, or
  response-origin change is rejected before its body is trusted;
- control and error bodies are streamed through a 64 KiB ceiling, including
  when `Content-Length` is absent or false, and displayed error detail is
  truncated further;
- response schemas reject unknown or malformed shapes before lifecycle state is
  changed;
- output responses must remain same-origin, use identity content encoding, and
  match a declared content length when one is present.

The included Python implementation is a contract fixture:
`services/science-runtime/server.py`. It persists idempotency receipts and
fixture outputs, but it never fetches submitted inputs, launches an OCI image,
or executes user code. Its health response explicitly reports
`executionMode="contract_fixture"` and `executesUserCode=false`, so a
production adapter rejects it before submission.

The non-production deterministic TypeScript provider emits a small
data-derived PNG for the released static workflow. Its metadata deliberately
states `fixturePreview=true` and `productionCompute=false`. That output proves
control-plane selection, approval, replay, and display behavior only; it is not
the result of executing the submitted notebook.

### Jupyter Enterprise Gateway admission

Status: **NO-GO**.

Authoritative prerequisite:
`packages/kernel/src/science/jupyter-enterprise-gateway.ts`.

The prerequisite implements only the safe subset of the official Jupyter
Enterprise Gateway REST contract: `GET /api`, `GET /api/kernelspecs`,
`GET /api/kernels`, `GET /api/kernels/{kernel_id}`, and exact-handle
`DELETE /api/kernels/{kernel_id}`. It requires `gateway_version >= 3.3.0`.
This is a compatibility floor, not a security approval for a particular JEG
release or deployment.

It is deliberately not registered by `createComputeProvidersFromEnv`.
`quote.available` is false, `submit` rejects before a network request, no
WebSocket is opened, and `collectOutputs`/`openOutput` reject before fetching.
`health.ok` remains false even when the prerequisite probe succeeds. Therefore
setting the prerequisite variables cannot make a JEG compute profile runnable.

The bounded operator-only configuration parser accepts:

| Variable | Required prerequisite value |
|---|---|
| `SCIENCE_JEG_URL` | HTTPS URL with no credentials, query, or fragment; a path prefix is allowed |
| `SCIENCE_JEG_TOKEN` | 16-4096 character non-whitespace ASCII token, sent only as `Authorization: token ...` |
| `SCIENCE_JEG_ADMISSION` | Exactly `prerequisite-only`; `approved` is rejected |
| `SCIENCE_JEG_INSTANCE_ID` | 1-100 character operator-pinned immutable deployment identity |
| `SCIENCE_JEG_KERNEL_IMAGES_JSON` | JSON object mapping 1-32 exact kernelspec names to immutable `repository@sha256:...` OCI references |
| `SCIENCE_JEG_TIMEOUT_MS` | Optional bounded REST timeout, default 15000 and maximum 600000 |

Stock JEG does not return an immutable server instance identity. A trusted
deployment proxy must add `X-Science-Gateway-Instance` with the pinned value to
every response and must reject a mismatched
`X-Science-Expected-Gateway-Instance` before proxying an operation. The
prerequisite rejects a missing/drifted response header. This extension and its
proxy enforcement require live proof; hashing a URL is not an instance fence.

For every allowlisted kernelspec the probe reads
`spec.metadata.process_proxy.config.image_name` and requires exact equality to
the configured immutable OCI reference. Tags and client-selected
`KERNEL_IMAGE` overrides are not accepted as identity evidence. The adapter
never sends artifact capabilities, storage credentials, cookies, or proxy
credentials. REST redirects, origin/base-path escapes, non-JSON control
responses, response bodies over 64 KiB, and identity drift fail closed.

Recovery operations accept only a compact binary/base64url private `jg1.`
handle that binds the JEG kernel UUID, Puppetmaster run, generation,
idempotency-key hash, and kernelspec. The normal outer `science-compute:` handle
binds the exact gateway instance, and the configured kernelspec allowlist binds
the immutable image digest. Omitting those duplicate values from the inner
token keeps the worst-case composed handle below the durable 500-character
limit even with a 100-character instance ID and kernelspec name. A generation
or outer instance mismatch is rejected before fetch. `idle` and `busy` map only to `running`:
kernel idleness is not evidence that a particular execution succeeded. A
missing persisted kernel maps to failed/operator reconciliation. Exact-handle
DELETE first GETs and correlates the kernel UUID and kernelspec, and is
idempotent when the kernel is already absent. This preflight does not eliminate
a malicious UUID-reuse race, so cancellation remains operator-only until a
dedicated authenticated gateway and ownership isolation pass the live gate. A
list operation separates known handles, missing known handles, and
visible-but-unowned kernels; the last group is never automatically cancelled
because a JEG list can span other tenants. The prerequisite probe also requires
kernel listing to be enabled; a 403 is a failed recovery prerequisite.

The recovery-handle factory is only for an externally established, already
durable kernel identity. It must not be used to invent ownership after an
ambiguous submit. Stock `POST /api/kernels` has no durable idempotency receipt,
and the list model does not prove the launch environment that supplied a
generation or idempotency key.

Execution remains blocked for five source-level reasons:

1. `ComputeSubmission` has no immutable executable entrypoint or signed runner
   descriptor that a kernel can consume.
2. Stock JEG does not provide the required durable idempotency/generation
   receipt for kernel start.
3. The Jupyter channels transcript is not durably owned by Puppetmaster, so a
   control-plane restart cannot prove which request completed. Future channel
   handling must enforce the reserved 15-second connection timeout, 1 MiB
   message ceiling, 10000-message execution ceiling, and provider-status log
   ceiling of 32 lines by 2000 characters.
4. Stock JEG does not expose checksummed artifact receipts or a scoped,
   same-origin byte endpoint compatible with `collectOutputs`/`openOutput`.
5. Stock JEG does not expose the immutable instance fence required by active-run
   recovery; the proxy-header prerequisite is not yet live-proven.

Before registration, a live suite must additionally prove authenticated start,
channels, interrupt, exact shutdown, reconnect/server restart, owned-orphan
recovery, non-root resource/network isolation, immutable provisioner/image
identity, bounded channel/log behavior, scoped artifact access without ambient
credentials, and secret redaction against a real isolated JEG >=3.3.0
deployment. Official protocol references are the
[JEG REST API](https://jupyter-enterprise-gateway.readthedocs.io/en/latest/developers/rest-api.html),
[authentication guidance](https://jupyter-enterprise-gateway.readthedocs.io/en/latest/users/connecting-to-eg.html),
and [custom-image kernelspec contract](https://jupyter-enterprise-gateway.readthedocs.io/en/latest/developers/custom-images.html).

### OCI executor candidate

Status: **deterministic candidate; live execution NOT PROVEN**.

Authoritative implementation and operating contract:
`services/science-oci-executor/`.

The candidate implements the HTTP compute contract with a dedicated-rootless
endpoint policy, exclusive durable state ownership, immutable image and engine
identity, restrictive seccomp/namespace/mount/resource rules, secure argument
vectors, bounded staging and output, aggregate state quota, idempotency,
generation/instance fencing, cancellation, crash recovery, tombstones, HTTP
bounds, and exact cleanup. Its deterministic fake-engine gate passes and ends
with both a positive candidate marker and:

```text
LIVE OCI EXECUTION: NOT PROVEN (no real rootless engine or notebook corpus in this lane)
```

The observed host Docker daemon advertised `seccomp` and `cgroupns`, not
rootless mode. Therefore neither `SCIENCE_OCI_EXECUTOR_ADMISSION=approved` nor
`SCIENCE_RUNTIME_ADMISSION=approved` is justified by the retained evidence.
Production admission still requires a dedicated inaccessible rootless endpoint,
image provenance/signature policy, target isolation inspection, adversarial and
representative notebook corpus, restart/cancel/orphan/cleanup convergence,
trusted TLS/DNS/egress, target load/HA/SLO, target backup/restore/DR, CVE
review, and supervision. See
[`services/science-oci-executor/README.md`](../../services/science-oci-executor/README.md)
for the full candidate contract.

## RenderSessionProvider

Authoritative interface:
`packages/kernel/src/science/render.ts`.

| Operation | Required behavior |
|---|---|
| `start` | Idempotently launch for session/workspace/owner, accept an expiry, gateway token, and scoped source receipt, and return the immutable launcher instance ID observed by health admission. |
| `status` | Return `starting`, `ready`, `failed`, or `closed`, a mode, and an internal upstream URL only. |
| `renew` | Extend the exact provider session expiry. |
| `close` | Idempotently release the exact provider handle; the HTTP adapter accepts only 200, 204, or already-absent 404. |
| `health` | Report bounded provider/version status plus a bounded immutable launcher instance ID. |

Current providers:

- `StaticRenderSessionProvider`: always available; resolves to the normal
  authenticated artifact content route. The service admits only an explicitly
  selected ready run-linked PNG up to 8 MiB; it never creates an object-store
  reference for this static path.
- `HttpRenderSessionProvider`: remote HTTP control contract. It restricts
  launcher and upstream to the configured origin.

The HTTP render adapter uses the same bounded-response and redirect/origin
boundary as the compute adapter. Registration requires
`SCIENCE_RENDER_ADMISSION=approved`; production additionally requires a bearer
token. No current trame deployment has passed the separate admission gate.

Migration 15 binds an owner/workspace-scoped request-key hash to a canonical
intent fingerprint, provider kind/mode, and exact source ID/checksum/media/
size/name snapshot. The durable private render handle binds provider kind, immutable launcher
instance ID, and opaque handle. Health and start must agree. Every remote
start/status/renew/close request carries `X-Science-Provider-Instance` with the
expected identity; reconciliation uses the same fence. A replacement launcher
therefore rejects the request before receiving authority over an unowned
session. Renewal calls the provider first and commits the owner-locked local
heartbeat second, so a failed provider renewal cannot leave a live gateway.
The gateway remains locally denied if the local commit loses a close race.

Session admission is serialized per workspace and limited by
`SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` (default 2, maximum 64). Starting,
ready, and any row retaining a provider/launch-attempt handle consume a slot.
Before remote `start`, Puppetmaster persists a bounded launch-attempt handle.
It compare-and-set replaces that marker with the actual provider handle before
trusting the remaining response; an ambiguous launch remains a conservative
slot/provenance hold and is not renewed or closed as though it were a real
handle.

After provider close succeeds, Puppetmaster transitions the session terminal,
clears the handle/launch lease, and retains a replay tombstone through the
bounded horizon. That tombstone does not consume renderer quota or retain
artifact bytes. A failed close leaves the row/handle discoverable for retry and
continues to block administrative version purge.

The browser receives only a same-origin Puppetmaster gateway URL. It never
receives the provider handle, launcher bearer token, gateway token, artifact
storage key, or internal upstream URL.

The public released mode is `static` only. Its request contains the exact
`artifactVersionId`, `mode="static"`, and a 1-200 character idempotency key.
The owner/workspace-scoped request-key hash is bound to one canonical intent;
an identical replay returns the same session, while changed source or mode
conflicts. The public response repeats the exact immutable source snapshot so
the selector, caption, metadata, and displayed image can be checked against the
same version and SHA-256. Lost-response retry must reuse the key. Successful
close is idempotent and retains the replay tombstone through its horizon.

The HTTP gateway double-decodes and canonicalizes suffix paths, rejects empty,
dot, backslash, NUL, query, and fragment components, and confines the result to
the exact upstream base-path prefix and origin. Proxied active content receives
`connect-src 'self'`; redirects remain forbidden. These HTTP controls do not
provide the still-missing trame WebSocket proxy.

### trame admission

Status: **NO-GO**.

Public `client` and `remote` render requests are currently refused; neither is
silently downgraded to static.

The current HTTP gateway does not implement a proven trame WebSocket path.
Admission requires live proof of:

- same-origin HTTP and WebSocket routing;
- CSP and `Origin` enforcement;
- two-user/workspace isolation;
- audience-bound expiry and replay rejection;
- heartbeat, browser disconnect, close, server restart, and orphan cleanup;
- CPU, memory, process, and concurrent-session quotas;
- memory returning within a corpus-derived tolerance;
- static/table fallback on failure.

## Provider error semantics

- Invalid or oversized provider JSON is an adapter error, never trusted state.
- A transient provider failure is recorded as a bounded run event and retried
  under the same idempotency/generation identity.
- Repeated failures may move a non-cancelling run to `failed`; cancellation does
  not become `cancelled` without provider evidence.
- Checksum mismatch quarantines the output and prevents run success.
- Domain validity is outside the provider completion contract. Mesh quality,
  solver convergence, numerical equivalence, and publication readiness require
  named validation evidence.
- Manifest comparison never treats manifest-embedded review data as a later
  human decision. Numerical evidence comes only from a separate append-only
  baseline-to-candidate record with named metric, finite tolerance and observed
  value, units, method/protocol, decision, limitations, session-derived
  reviewer, both manifest hashes, both output-checksum snapshots, and a stable
  record hash. If any binding no longer matches, both numerical fields are
  `null`.
