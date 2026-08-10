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
deterministic verifier proves a stalled DELETE aborts, but real S3-compatible
behavior remains an external gate.

S3 removal rejects a successful response that carries either
`x-amz-delete-marker: true` or `x-amz-version-id`, then performs a signed HEAD
and requires 404 absence proof. Automatic purge therefore requires a dedicated
unversioned bucket. The adapter does not enumerate or delete prior object
versions; version-aware general retention remains pending.

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

### Jupyter Enterprise Gateway admission

Status: **NO-GO**.

Do not add/register the adapter until a live suite proves:

- authenticated kernel start, channels, interrupt, and shutdown;
- immutable kernel image/provisioner identity;
- scoped artifact access with no ambient credentials;
- exact idempotency and generation correlation;
- reconnect and server restart behavior;
- orphan discovery and cleanup;
- non-root/resource/network isolation;
- bounded logs/events and secret redaction.

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
  authenticated artifact content route.
- `HttpRenderSessionProvider`: remote HTTP control contract. It restricts
  launcher and upstream to the configured origin.

The HTTP render adapter uses the same bounded-response and redirect/origin
boundary as the compute adapter. Registration requires
`SCIENCE_RENDER_ADMISSION=approved`; production additionally requires a bearer
token. No current trame deployment has passed the separate admission gate.

The durable private render handle binds provider kind, immutable launcher
instance ID, and opaque handle. Health and start must agree. Every remote
start/status/renew/close request carries `X-Science-Provider-Instance` with the
expected identity; reconciliation uses the same fence. A replacement launcher
therefore rejects the request before receiving authority over an unowned
session. Renew first proves that the owner-bound local session is still `ready`
and unexpired; only then may it extend the remote session.

Session admission is serialized per workspace and limited by
`SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` (default 2, maximum 64). Starting,
ready, and any row retaining a provider/launch-attempt handle consume a slot.
Before remote `start`, Puppetmaster persists a bounded launch-attempt handle.
It compare-and-set replaces that marker with the actual provider handle before
trusting the remaining response; an ambiguous launch remains a conservative
slot/provenance hold and is not renewed or closed as though it were a real
handle.

After provider close succeeds, Puppetmaster transitions the session terminal
and deletes its durable row. That removes the render reference as an artifact
provenance hold. A failed close leaves the row/handle discoverable for retry and
continues to block administrative version purge.

The browser receives only a same-origin Puppetmaster gateway URL. It never
receives the provider handle, launcher bearer token, gateway token, artifact
storage key, or internal upstream URL.

The HTTP gateway double-decodes and canonicalizes suffix paths, rejects empty,
dot, backslash, NUL, query, and fragment components, and confines the result to
the exact upstream base-path prefix and origin. Proxied active content receives
`connect-src 'self'`; redirects remain forbidden. These HTTP controls do not
provide the still-missing trame WebSocket proxy.

### trame admission

Status: **NO-GO**.

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
- Manifest comparison considers numerical evidence from the candidate/right
  manifest only. Kind plus a boolean is insufficient: a bounded non-empty
  metric and tolerance are mandatory, otherwise both numerical fields are
  `null`.
