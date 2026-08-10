# ADR-010: Immutable artifact versions and canonical run provenance

## Status

Accepted for filesystem and S3-compatible adapter contracts (2026-07-29).

Live MinIO/S3 durability, retention, and backup/restore evidence is still
pending and is not implied by this ADR.

## Context

Scientific inputs and outputs are too large and too security-sensitive for
database blobs, MCP text, mission output, or audit records. A run must still be
traceable to exact bytes after filenames, storage providers, or working copies
change. Interrupted or malicious uploads must never become eligible inputs.

The first release also needs lineage, but a general provenance graph would add
schema and query complexity before a broader relationship model is required.

## Decision

Artifacts have two layers:

1. `science_artifacts` is the logical identity within a study.
2. `science_artifact_versions` is an immutable receipt for exact bytes,
   including SHA-256, size, media type, metadata, parent version, and storage
   state.

Bytes are managed by `ArtifactStore`:

- Creating an artifact or upload intent is new resource-bearing work and
  requires a committed workspace admission. Once an upload intent has been
  accepted, streaming and completion may converge after revocation so that
  quarantined bytes and reservations are not stranded.
- Upload intent creates a one-use opaque token and an empty quarantine object.
- Upload streams are bounded and hashed while being written.
- Completion compares declared and observed size/SHA-256, rejects active or
  inconsistent media types, and performs bounded structure/signature checks for
  admitted pilot formats before promotion.
- Checksum or size mismatch produces a quarantined state, never `ready`.
- Promotion is idempotent across a crash after the immutable object was
  committed but before metadata reached `ready`.
- The filesystem adapter uses link/rename-style immutable promotion inside a
  configured root. Path validation rejects absolute paths and traversal.
- The S3-compatible adapter keeps incomplete bytes in a local quarantine and
  performs a SigV4, `If-None-Match: *` PUT only after verification. An existing
  key is accepted only when its size and checksum metadata match.
- Reads support byte ranges. Public and provider-facing references point to the
  authenticated Puppetmaster content route, never to a host path.
- Signed references bind artifact-version ID, audience, expiry, checksum, and
  size with HMAC. Their TTL is capped at one hour by the adapter.
- Storage keys, quarantine keys, upload-token hashes, and object credentials are
  internal and are removed from REST/tool DTOs.
- Exact checksum-confirmed admin purge is cleanup, not new resource admission.
  It remains available after workspace revocation or global read-only mode,
  subject to all provenance holds and delete-before-tombstone checks.

Run lineage uses real foreign keys in `science_run_artifacts`, with an explicit
direction and semantic role. A successful run stores:

- a canonical JSON manifest in its terminal run record;
- a SHA-256 of that canonical serialization;
- exact input/output version receipts;
- the immutable compute-profile snapshot and requested resources;
- actor, approval, provider adapter version, event history, validation results,
  and declared limitations.

Manifest completeness is an explicit assessment. Success alone is insufficient.
At minimum, a complete manifest needs exact inputs and outputs, an approved
execution, a non-empty dependency lock, checksummed validation, and either a
code/notebook/solver artifact role or a verified source revision. Reproduction
is refused if the current compute-profile snapshot or provider adapter version
differs from the captured manifest.

No general provenance graph is introduced in v1. The run input/output relation
and manifest are the source of truth for the MVP lineage questions.

## Alternatives considered

- **Database blobs**: rejected because large streaming/range I/O would burden
  the control database and backups.
- **MCP or JSON payloads**: rejected because binary data would be unbounded and
  could leak into prompts, mission output, or audit.
- **Mutable object keys**: rejected because a later upload could silently change
  the scientific meaning of an existing run.
- **Provider-native presigned URLs exposed to clients**: rejected for v1.
  Same-origin capability URLs keep authorization and audience checks in one
  control boundary.
- **Global checksum-only deduplication**: rejected. Deduplication is scoped to a
  logical artifact so tenancy and retention semantics remain explicit.
- **General provenance graph**: deferred until relationships outside a run are
  required.

## Consequences

Positive:

- A run names exact, storage-independent bytes.
- Interrupted and corrupt uploads remain distinguishable and ineligible.
- Storage backends can change without changing public contracts or manifests.
- Re-run comparison can distinguish input, parameter, environment, and output
  identity without claiming numerical equivalence.

Negative:

- S3 upload quarantine requires local durable scratch space.
- Object bytes and metadata need a coordinated backup/restore procedure.
- There is no resumable append protocol; an interrupted upload starts a new
  intent.
- Retention deletion, object-versioning policy, live MinIO/S3 validation, and a
  demonstrated disaster-recovery drill remain pending.

## Verification

Contract and deterministic adapter behavior are represented by:

- `scripts/verify-science-artifacts.mjs`
- `scripts/verify-science-service.mjs`
- `scripts/verify-science-routes.mjs`
- `scripts/verify-science-lifecycle.mjs`
- `packages/kernel/src/science/manifest.ts`

The S3 verifier uses a bounded local mock. It is not evidence for a real
MinIO/S3 deployment, bucket policy, object versioning, or restore.
The current post-migration-11 aggregate/root rerun is pending; this ADR records
the intended and source-asserted boundary, not a fresh release pass.

## Reconsider when

- Multipart/resumable upload is required by measured corpus behavior.
- A second storage provider has materially different checksum or consistency
  semantics.
- Lineage questions require relationships outside one run's inputs and outputs.
- Regulatory retention or legal-hold rules are introduced.
