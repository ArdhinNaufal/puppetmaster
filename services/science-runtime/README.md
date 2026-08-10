# Science runtime fixture provider

This service implements the bounded `HttpComputeProvider` wire contract used by
Puppetmaster Science Operations. It is a deterministic contract fixture, not a
notebook executor:

- it never launches the submitted image and never executes user code;
- image digests, kernel names, and input-reference origins are explicit allowlists;
- JSON control responses are capped at 64 KiB and request bodies at 1 MiB;
- output bytes are exposed only through authenticated, checksummed, same-origin
  `/v1/outputs/*` references;
- the idempotency ledger and provider handles persist in
  `SCIENCE_RUNTIME_STATE_DIR`;
- signed input URLs are validated and then discarded, so query credentials do not
  enter the durable ledger;
- exact-generation status, cancellation, and output collection reject stale callers;
- an acknowledged cancellation wins a racing output commit.

Jupyter Enterprise Gateway (JEG), trame, and OCCT are disabled. `/health` reports all
three as `no-go`; this service must not be described as evidence that those
integrations work.

## HTTP contract

```text
POST /v1/quote
POST /v1/runs                         Idempotency-Key required
GET  /v1/runs/{handle}?generation=N
POST /v1/runs/{handle}/cancel
GET  /v1/runs/{handle}/outputs?generation=N
GET  /v1/outputs/{handle}/result.json
GET  /health                         public, contains no job data
```

Every route except `/health` requires `Authorization: Bearer ...`.
`SCIENCE_RUNTIME_ALLOW_ANONYMOUS=1` exists only for isolated local verification.
Normal startup fails closed when no token is configured, and an accepted token must
contain at least 32 characters.

The default accepted fixture identifiers are:

```text
imageDigest = sha256:1445edcf2ab7a2400b0851810d78bf572ad104afc8518f5cd207d88c528b72d6
kernel      = python-fixture-v1
```

`SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS` has no implicit application origin. An input
submission is refused unless its absolute HTTP(S) reference matches an explicitly
configured origin. The Compose profile defaults this to `http://server:4000`, and
the Puppetmaster server must set `SCIENCE_PUBLIC_BASE_URL=http://server:4000` so the
generated provider reference is reachable on the control network.

Important: this fixture validates input receipts but does not download their bytes.
A production executor must copy each scoped input and verify its SHA-256 and size
before acknowledging submission.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `SCIENCE_RUNTIME_TOKEN` | none | Required bearer credential |
| `SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS` | empty | Comma-separated exact HTTP(S) origins |
| `SCIENCE_RUNTIME_ALLOWED_IMAGE_DIGESTS` | fixture digest above | Comma-separated immutable OCI digests |
| `SCIENCE_RUNTIME_ALLOWED_KERNELS` | `python-fixture-v1` | Comma-separated logical kernel allowlist |
| `SCIENCE_RUNTIME_STATE_DIR` | `/var/lib/science-runtime` | Durable ledger and output root |
| `SCIENCE_RUNTIME_MAX_CONCURRENCY` | `2` | Concurrent fixture workers, maximum 64; Compose uses `1` |
| `SCIENCE_RUNTIME_FIXTURE_DELAY_MS` | `100` | Test-only deterministic delay, maximum 30 seconds |
| `SCIENCE_RUNTIME_MAX_CPU_MILLICORES` | `1000` | Quote/admission ceiling |
| `SCIENCE_RUNTIME_MAX_MEMORY_MB` | `512` | Quote/admission ceiling |
| `SCIENCE_RUNTIME_MAX_GPU_COUNT` | `0` | Quote/admission ceiling |
| `SCIENCE_RUNTIME_MAX_WALL_SECONDS` | `300` | Quote/admission ceiling |

The ledger is deliberately bounded to 256 jobs and 64 MiB. There is no garbage
collection API in this fixture; it fails with `capacity_exhausted` rather than
silently deleting idempotency history.

## Compose isolation profile

Set a unique token rather than copying the placeholder below:

```powershell
$env:SCIENCE_RUNTIME_TOKEN="<random-value-with-at-least-32-characters>"
$env:SCIENCE_ENABLED="1"
$env:SCIENCE_RUNTIME_URL="http://science-runtime:8090"
$env:SCIENCE_PUBLIC_BASE_URL="http://server:4000"
docker compose -f docker/docker-compose.yml --profile science up --build
```

The runtime has no published host port and is attached only to the internal
`science_control` network. The profile:

- runs as UID/GID `10001:10001`;
- uses a read-only root filesystem and one named writable state volume;
- drops all Linux capabilities and denies privilege escalation;
- applies CPU, memory, PID, file-descriptor, and process limits;
- mounts no host path and no Docker socket;
- caps container log retention.

These limits contain the fixture service itself. They are not proof of per-notebook
isolation because this service executes no notebooks.

## Deterministic verification

Use the bundled Python runtime when running inside Codex:

```powershell
& "C:\Users\Teknis & Pemrograman\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" scripts/generate-science-fixtures.py --check
& "C:\Users\Teknis & Pemrograman\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" scripts/verify-science-runtime.py
docker compose -f docker/docker-compose.yml --profile science config
```

The verifier starts real HTTP processes and exercises the built TypeScript
`HttpComputeProvider`. It covers authentication, strict schemas and bounds, input
origin/image/kernel allowlists, secret-field rejection, concurrent idempotency,
refreshed signed references, generation fencing, cancellation races, restart
reconciliation, output checksums, and tamper detection.

The reproducible corpus under `fixtures/` includes a notebook structure, CSV and NPY
data, a small STEP preview asset, legacy ASCII VTK, malformed/truncated samples, and
the exact provider submission/result bytes. It is synthetic and non-regulated. None
of it establishes CAD fidelity, mesh validity, solver convergence, or scientific
accuracy.

## Known limitations

- One runtime instance owns one JSON ledger volume; multi-replica coordination is not
  implemented.
- Active fixture runs do not resume after an unclean restart. They become an explicit
  `failed` state; a persisted cancellation becomes `cancelled`.
- The Docker base uses a versioned Python tag, not a repository digest. Deployment
  owners must pin an approved digest in a controlled release pipeline.
- JEG, trame, OCCT, GPU execution, arbitrary notebook execution, input transfer,
  network callbacks, and per-job OCI isolation remain explicit no-go capabilities.
