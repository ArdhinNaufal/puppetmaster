# Science OCI executor (production-intent, not yet admitted)

This directory is a separate execution service for the Science Operations
`HttpComputeProvider` contract. It does not change
`services/science-runtime`, which remains a deterministic, non-executing
fixture.

**Current decision: OCI execution is PENDING / NO-GO.** The implementation and
fake-engine verifier are repository-local evidence only. No real Docker or
Podman job was launched by the retained verifier, and no target deployment has
passed the live admission gate described below.

## What is implemented

- The existing HTTP v1 operations: quote, submit, status, cancel, output list,
  and checksummed output streaming.
- Mandatory bearer authentication on every control/output route. `/health`
  discloses only bounded provider state.
- Mandatory `X-Science-Provider-Instance` on every execution-scoped operation.
- A persisted provider instance bound to an operator-pinned rootless engine
  identity. The pin proves endpoint continuity; it does **not** prove that no
  other principal can reach that endpoint.
  An engine replacement rotates the provider instance; an old fence cannot
  inspect, start, kill, or remove old jobs through the replacement.
- A persisted idempotency ledger. A deterministic container name plus immutable
  instance, handle, generation, and payload-digest labels recover a lost create
  response without creating a second execution.
- A nonblocking OS-level exclusive writer lease on the private state directory.
  A second executor process sharing the ledger fails startup; the lock file is
  retained so deleting/recreating it cannot split ownership across inodes.
- A durable `startRequestedAt` boundary written before every start attempt.
  Lost start responses and restarts inspect the exact labeled container and
  continue wall time from the first attempt rather than granting a new budget.
- Autonomous startup reconciliation for queued/provisioning/running rows,
  including verified `created` containers and fully flushed staged inputs.
  Health and execution calls remain fail-closed until the first complete
  reconciliation pass succeeds; raw operational failures are normalized and
  retried instead of terminating the recovery worker.
- A durable terminal intent written before exact container removal. Receipts
  become terminal only after removal/absence is proved; a restart completes a
  lost-remove response without discarding already-checksummed outputs.
- Input download before submit acknowledgement, with exact origin, no redirect,
  identity encoding, expiry, byte-count, and SHA-256 checks. Signed URLs are
  discarded after staging and never enter the ledger, control file, engine
  arguments, labels, or logs.
- Different handles stage concurrently up to the admitted concurrency bound;
  network transfer is outside the short idempotency-ledger lock. Cancellation
  is persisted and acknowledged without waiting behind staging/create/start,
  and staging checks that flag before and during bounded downloads.
- One container per run using an immutable `registry/repository@sha256:...`
  reference. The engine is called with an argument vector and `shell=False`.
- Requested and post-create verified isolation: non-root UID/GID,
  `network=none`, private PID/IPC/UTS namespaces, read-only root filesystem,
  capability drop `ALL` with an empty effective `CapAdd`,
  `no-new-privileges`, an explicit immutable-at-start JSON seccomp profile
  whose default action denies unlisted syscalls, PID/CPU/memory/swap
  limits, no devices/GPU, and only two admitted read-only bind mounts.
- Read-only input and control mounts plus bounded `noexec,nosuid,nodev` tmpfs
  mounts for `/tmp`, `/run`, and `/science/output`. After exit, the CLI copies
  output into a private temporary host directory; validation completes before
  an atomic rename exposes it to the receipt layer. No engine socket or
  host-output directory is mounted into the workload.
- Wall-time termination, exact-container cancellation, exact removal proof,
  and success only after bounded regular output files are checksummed and the
  container is removed.
- Bounded output count, per-file bytes, total bytes, metadata, response bodies,
  and streaming. Symlinks, special files, unexpected mounts, empty output sets,
  and output receipt drift fail closed.
- Engine-side workload logging is disabled (`--log-driver none`) and verified
  after create, so unbounded notebook stdout/stderr cannot fill the engine log
  store. Workloads must emit admitted bounded output files instead.
- Docker/Podman inspect failures are not treated as absence by exit status
  alone. A second successful bounded all-container query must prove that the
  exact ID/name is absent; transport ambiguity remains non-terminal.
- Ledger, identity, staging, export, and terminal-intent replaces flush files
  and parent directories where the host exposes directory `fsync`. Windows
  directory-flush durability still requires retained target crash evidence.
- Aggregate durable-state reservations cover retained input bytes, the maximum
  possible output set, and metadata before a job is admitted. Exact abandoned
  staging/ledger/identity temporary names are swept only while holding the
  writer lease; unrelated operator files are preserved.

The executor does not pass a shell command or notebook source in process
arguments. An admitted image owns its fixed entrypoint and reads one control
document from `/science/control/submission.json`.

## Trust boundary

Puppetmaster's server must never receive the Docker/Podman endpoint and must
never mount a Docker or Podman socket. Run this service as a dedicated,
unprivileged OS user on the engine host (or behind an authenticated TLS proxy)
and give only this service access to a dedicated rootless engine endpoint.

The service canonicalizes local socket aliases and rejects the default host Docker endpoints, including
`/var/run/docker.sock` and the default Windows `docker_engine` named pipe. It
also rejects TCP engine endpoints. A non-default endpoint string is not enough:
the live engine `info` response must report rootless operation and exactly match
`SCIENCE_OCI_EXPECTED_ENGINE_ID` before `/health` can return:

```json
{
  "ok": true,
  "executionMode": "isolated_oci",
  "executesUserCode": true,
  "instanceId": "science-oci-..."
}
```

Without every admission condition, or while startup reconciliation has not yet
completed successfully, health reports
`isolated_oci_candidate`, `executesUserCode=false`, and HTTP 503. The current
production `HttpComputeProvider` consequently refuses submission.

`SCIENCE_OCI_ENGINE_BOUNDARY=dedicated-rootless` is an explicit operator
declaration, not a fact inferred by the CLI. The ID pin detects endpoint drift,
while endpoint ACL/exclusivity remains a live external admission gate. The
health result must not be used as evidence that exclusivity was tested.
Docker must report its daemon `ID`; Podman must report `host.id`. A Podman
hostname is deliberately not accepted as an engine/storage identity.

## Image execution contract

Every map value must be an immutable reference ending in the map key:

```json
{
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
    "registry.example/science/python-notebook@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

An admitted image must:

1. have a fixed entrypoint; the executor does not append a command;
2. run correctly as the configured non-root UID/GID;
3. read `SCIENCE_EXECUTION_SPEC=/science/control/submission.json`;
4. read staged inputs only from the paths named by that document;
5. write one or more regular files below `SCIENCE_OUTPUT_DIR=/science/output`;
6. require no network, host devices, ambient credentials, or extra mounts;
7. exit zero only after every output file is closed and durable from the
   process's perspective.

Declared image volumes or other automatic mounts cause post-create isolation
verification to fail before start. Digest pinning prevents tag drift but does
not establish image authorship; signature/provenance verification remains a
live admission prerequisite.

## Required configuration

There are no permissive production defaults for the engine, images, kernels,
input origins, state path, or credential.

| Variable | Requirement |
|---|---|
| `SCIENCE_OCI_STATE_DIR` | Private durable directory, dedicated to exactly one executor process; a portable nonblocking writer lease enforces this |
| `SCIENCE_OCI_ENGINE` | `docker` or `podman` |
| `SCIENCE_OCI_ENGINE_BINARY` | Absolute CLI path; PATH lookup is refused |
| `SCIENCE_OCI_ENGINE_ENDPOINT` | Canonical dedicated local Unix/named-pipe endpoint; lexical/symlink aliases of the default host Docker endpoint and TCP are refused |
| `SCIENCE_OCI_EXPECTED_ENGINE_ID` | Exact printable-ASCII engine ID retained from the reviewed target; mismatch fails admission rather than rotating silently |
| `SCIENCE_OCI_ENGINE_BOUNDARY` | Exact value `dedicated-rootless` |
| `SCIENCE_OCI_SECCOMP_PROFILE` | Absolute, regular, non-symbolic JSON profile (maximum 1 MiB) with a deny/kill/trap default action and explicit syscall rule list; its startup SHA-256 is rechecked before every create |
| `SCIENCE_OCI_IMAGE_MAP_JSON` | Non-empty digest-to-immutable-reference object |
| `SCIENCE_OCI_ALLOWED_KERNELS` | Comma-separated exact kernel allowlist |
| `SCIENCE_OCI_ALLOWED_INPUT_ORIGINS` | Comma-separated exact HTTP(S) origins used by scoped artifact references |
| `SCIENCE_OCI_RUNTIME_TOKEN` | 32-4096 printable ASCII characters; map this secret to the control plane's `SCIENCE_RUNTIME_TOKEN` |
| `SCIENCE_OCI_EXECUTOR_ADMISSION` | Exact value `approved`, only after the live gate passes |
| `SCIENCE_OCI_HOST` / `SCIENCE_OCI_PORT` | Defaults `127.0.0.1:8091` |
| `SCIENCE_OCI_TRUSTED_TLS_PROXY` | Exact value `approved` before any non-loopback bind; the Python server itself does not terminate TLS |

Optional ceilings are
`SCIENCE_OCI_MAX_CPU_MILLICORES`, `SCIENCE_OCI_MAX_MEMORY_MB`,
`SCIENCE_OCI_MAX_WALL_SECONDS`, `SCIENCE_OCI_MAX_PIDS`,
`SCIENCE_OCI_MAX_CONCURRENCY` (default 4, maximum 64),
`SCIENCE_OCI_MAX_INPUT_BYTES`, `SCIENCE_OCI_MAX_OUTPUT_FILE_BYTES`,
`SCIENCE_OCI_MAX_OUTPUT_TOTAL_BYTES`, and `SCIENCE_OCI_MAX_STATE_BYTES`
(default 16 GiB, including a fixed metadata reserve). The configured container identity is
controlled by `SCIENCE_OCI_CONTAINER_UID` and `SCIENCE_OCI_CONTAINER_GID`; both
must be at least 10000. GPU requests are rejected in this release slice.

Provider-local terminal output/receipt caching is bounded by
`SCIENCE_OCI_TERMINAL_RETENTION_SECONDS` (default 7 days; 1 hour to 1 year) and
`SCIENCE_OCI_MAX_TOMBSTONES` (default 4096; 64 to 65536). After exact container
removal and the retention window, a cleanup-pending tombstone is persisted,
the private job directory is atomically renamed and deleted, and a compact
tombstone rejects semantic idempotency drift for one more retention window.
This is not a legal-hold or authoritative artifact-retention mechanism; the
control plane must ingest and retain required artifacts before this cache TTL.

When the pinned engine identity changes, active rows fenced to the old instance
are compacted into non-terminal `orphaned` inventory without any inspect, kill,
remove, or directory deletion through the replacement endpoint. Those records
do not consume current-instance concurrency/job slots and never expire
automatically; they count against `SCIENCE_OCI_MAX_TOMBSTONES` until an operator
reconciles the old engine, and their retained directories continue to consume
the aggregate state-byte reservation. Hitting either bound refuses new work
instead of hiding a potentially live allocation.

The HTTP wrapper caps headers at 16 KiB/64 fields, JSON request bodies at 1
MiB, control responses at 64 KiB, concurrent requests at 32, and applies
bounded header/body/write socket deadlines. Health admission is single-flight
and cached for two seconds to prevent probe amplification.

Signed input downloads explicitly disable ambient proxy variables and reject
redirects or origin changes. The current URL-origin check does not pin DNS
answers across resolution/connect and does not by itself prevent a compromised
resolver or DNS rebinding from selecting another address. Production remains
NO-GO until the target proves trusted DNS/resolver behavior, TLS hostname
validation, and default-deny egress/IP policy for every allowed artifact host.

After this service is independently admitted, point the existing control plane
adapter at its TLS/same-host endpoint:

```text
SCIENCE_RUNTIME_URL=https://science-executor.internal
SCIENCE_RUNTIME_TOKEN=<same secret delivered to SCIENCE_OCI_RUNTIME_TOKEN>
SCIENCE_RUNTIME_ADMISSION=approved
```

Do not add the engine endpoint or its credentials to the Puppetmaster server
environment. Do not place this service in the existing Compose file merely to
mount a host engine socket; that would erase the intended boundary.

## Focused deterministic verification

Run the portable launcher (it tries `PUPPETMASTER_PYTHON`, the optional Codex
runtime on Windows, then the platform Python 3 launcher/PATH):

```powershell
pnpm run verify:science:oci-executor
```

Or use the bundled Python runtime directly on hosts where `python` resolves to
the Windows Store shim:

```powershell
& "C:\Users\Teknis & Pemrograman\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" scripts/verify-science-oci-executor.py
```

The verifier uses a deterministic fake engine and an in-process HTTP server. It
asserts:

- admission refusal for a default host socket, missing approval, and a rootful
  engine;
- lexical/symlink endpoint canonicalization, syscall-permissive seccomp refusal,
  and nonempty effective `CapAdd` refusal;
- pinned engine-ID mismatch and transient-inspect-versus-proved-absence cases;
- the complete create argument policy and absence of engine-socket mounts or
  signed URLs;
- post-create isolation verification before start;
- immutable input staging and capability disposal;
- exclusive state ownership, exact crash-temporary sweep, aggregate byte
  reservation, parallel per-handle staging, and prompt persisted cancellation;
- same-key replay and restart recovery without duplicate create/start;
- lost-create-response recovery by exact labels;
- lost-start response, created-container startup reconcile, durable wall-time,
  and queued/provisioning/in-flight-start cancellation races;
- foreign same-name container refusal without kill/removal;
- instance and generation fencing before engine access;
- bounded output checksums/streaming and exact cleanup;
- cancellation and wall-time kill/removal;
- lost-remove restart convergence, receipt-before-removal ordering, bounded
  tombstone pruning, and old-instance quota isolation;
- explicit seccomp/logging post-inspect counterexamples, subprocess error
  normalization, proxy suppression, strict ASCII token handling, fail-closed
  reconciliation readiness/retry, health single-flight/cache, and HTTP
  header/concurrency bounds;
- bearer, fence, quote, submit, status, output-list, and output-byte HTTP paths.

Expected final markers:

```text
SCIENCE OCI EXECUTOR CANDIDATE PASS: canonical pinned rootless endpoint policy, exclusive state ownership, restrictive seccomp, secure argv, aggregate state quota, parallel cancellable staging, idempotency, fencing, fail-closed recovery, bounded outputs, timeout, tombstones, HTTP bounds, and exact cleanup
LIVE OCI EXECUTION: NOT PROVEN (no real rootless engine or notebook corpus in this lane)
```

## Live admission gate still required

Do not set either admission variable to `approved` for production until retained
target evidence proves all of the following:

- the dedicated endpoint is rootless and inaccessible to the Puppetmaster
  server and ordinary workload containers;
- a signed/allowlisted digest is already present or pulled under an accepted
  registry/signature policy, and the effective container image ID matches it;
- post-create inspect on the target engine proves every namespace, mount,
  privilege, seccomp, resource, and device invariant;
- a representative notebook corpus succeeds and malformed/adversarial images,
  path escapes, symlinks, fork bombs, memory pressure, oversized outputs, and
  network exfiltration fail within the declared bounds;
- duplicate submit, lost response, executor restart, engine restart, timeout,
  cancel race, orphan discovery, and cleanup converge without stale or duplicate
  compute;
- signed input fetch works through the deployment's real TLS/public-base path
  without redirect, DNS/origin drift, credential logging, or expiry bypass;
- output bytes and receipts survive the required retention window while the
  private ledger/state directory passes backup and restore;
- target concurrency/load evidence meets an explicitly accepted SLO;
- the HTTP service is supervised, the TLS/auth network boundary is reviewed,
  and operational logs/metrics preserve the no-secret/no-binary rule.

Until then, this service is a coherent executable candidate, not proof that the
literal isolated-OCI MVP gate is met. Jupyter Enterprise Gateway is a separate
adapter and live-security gate; nothing in this directory admits JEG.
