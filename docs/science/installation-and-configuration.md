# Science Operations installation and configuration

## Prerequisites

- Node.js 22 or newer.
- pnpm 10.33.0 through Corepack.
- A supported Puppetmaster database:
  - PGlite for deterministic development; or
  - PostgreSQL for deployment, subject to the still-pending live Science
    migration/lifecycle gate.
- Redis for durable BullMQ scheduling in deployment. Without `REDIS_URL`,
  Science uses the in-process scheduler and is single-process development
  behavior.
- Writable artifact/quarantine storage.
- Python 3.13 and Docker only when exercising the optional runtime fixture.

The subsystem is off by default.

## Install and build

From the repository root:

```powershell
corepack enable
pnpm install
pnpm -r build
```

The server calls the ordered database migration runner during normal startup.
There is no separate Science-only migration command. Migrations are additive
and recorded in `schema_migrations`. The current ledger is versions 1 through
11: version 5 installs database-atomic Science mutation audit, version 6 adds
provider-output cleanup eligibility, version 7 adds the upload-finalizer lease
fence, version 8 persists cleanup retry/backoff, version 9 adds renewable
upload-transfer ownership and durable provider-output reservations through
promotion/terminal commit, version 10 adds transaction-local initiating
actor/action attribution, and version 11 adds unique persisted default-deny
workspace admission with its atomic audit trigger.

## Minimal deterministic development setup

Use persistent directories outside source-controlled paths and a random signing
secret of at least 16 bytes:

```powershell
$env:SCIENCE_ENABLED = "1"
$env:SCIENCE_SIGNING_SECRET = "<random-secret-from-your-secret-manager>"
$env:PGLITE_DATA_DIR = ".local/puppetmaster-pglite"
$env:SCIENCE_ARTIFACT_ROOT = ".local/science-artifacts"
pnpm dev
```

`SCIENCE_ENABLED=1` enables the subsystem but does not admit the workspace.
Migration 11 deliberately treats an absent admission row as `admitted=false`.
After sign-in, use the admin-only reasoned admission procedure under
“First-run application setup” before creating a profile, study, upload intent,
run, reproduction, or render session.

When `NODE_ENV` is not `production` and `SCIENCE_RUNTIME_URL` is unset, the
server registers the restart-stable deterministic provider under the
`local_container` profile kind. It generates fixture JSON and legacy ASCII VTK;
it does not execute a notebook or container.

Do not use the built-in development signing key outside a disposable local
environment. Production startup requires either `SCIENCE_SIGNING_SECRET` or
`PUPPETMASTER_MASTER_KEY`, but an explicit dedicated Science signing secret is
preferred for rotation and blast-radius control.

## Deployment-shaped configuration

A deployment-shaped read-only control plane needs PostgreSQL, Redis, and
S3-compatible storage. Set `NODE_ENV=production` explicitly: any other value
is a development mode and may register the deterministic TypeScript fixture.
An admitted compute provider is additionally required before writes can be
enabled.

```dotenv
NODE_ENV=production
DATABASE_URL=postgres://...
REDIS_URL=redis://...

SCIENCE_ENABLED=1
SCIENCE_READ_ONLY=1
SCIENCE_SIGNING_SECRET=...
SCIENCE_PUBLIC_BASE_URL=https://puppetmaster.example/
SCIENCE_STORAGE_DRIVER=s3
SCIENCE_S3_ENDPOINT=https://object-store.example
SCIENCE_S3_REGION=us-east-1
SCIENCE_S3_BUCKET=puppetmaster-science
SCIENCE_S3_ACCESS_KEY_ID=...
SCIENCE_S3_SECRET_ACCESS_KEY=...
SCIENCE_S3_REQUEST_TIMEOUT_MS=300000
SCIENCE_QUARANTINE_ROOT=/var/lib/puppetmaster/science-quarantine

# Set these only for an executor that passed the deployment's admission gate.
# The bundled deterministic runtime fixture does not qualify.
# SCIENCE_RUNTIME_URL=https://admitted-runtime.internal.example
# SCIENCE_RUNTIME_TOKEN=...
# SCIENCE_RUNTIME_ADMISSION=approved
#
# Set in that runtime using the exact origin of SCIENCE_PUBLIC_BASE_URL:
# SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS=https://puppetmaster.example
```

Start in read-only mode. Record the intended pilot workspace's reasoned
admission while still read-only, then remove `SCIENCE_READ_ONLY=1` only after
the exact database, object store, queue, runtime, backup, and target-hardware
gates in the evidence matrix pass. Admission and global read-only are
independent gates; neither one overrides the other.

The included Python HTTP runtime is a non-executing contract fixture. Its
health response declares `executionMode="contract_fixture"` and
`executesUserCode=false`; the production HTTP adapter requires
`executionMode="isolated_oci"` and `executesUserCode=true` before submit, so it
rejects this fixture even if someone incorrectly sets the admission variable.
Pointing production at the fixture proves neither per-job container isolation
nor notebook execution.

## Configuration reference

### Core feature and limits

| Variable | Default | Constraint / effect |
|---|---:|---|
| `NODE_ENV` | environment-owned | Set exactly `production` for a deployment. Production disables the implicit deterministic provider and activates signing-secret, provider-token, provider-admission, and execution-mode fail-closed checks. |
| `SCIENCE_ENABLED` | false | Enables Science reads and lifecycle ownership. Accepted true values include `1`, `true`, `yes`, `on`, and `enabled`. |
| `SCIENCE_READ_ONLY` | false | When true, rejects new studies/artifacts/upload intents/profiles/runs, approval into execution, reproductions, render starts, and render renewals. It preserves reads, cancellation, render close, scheduler ticks/reconciliation, accepted-upload streaming/completion, and exact checksum purge. This is the deployment-wide rollback switch. |
| `SCIENCE_SUBMISSIONS_DISABLED` | unset | Exact value `1` also disables writes. Prefer `SCIENCE_READ_ONLY=1` because its intent is clearer. |
| `SCIENCE_SIGNING_SECRET` | falls back to `PUPPETMASTER_MASTER_KEY`; fixed development fallback outside production | HMAC key for artifact capabilities and render-gateway tokens. Underlying adapters require at least 16 bytes. |
| `SCIENCE_MAX_UPLOAD_BYTES` | 2147483648 | Integer, 1 through 17179869184. Per-upload hard cap. |
| `SCIENCE_MAX_WORKSPACE_STORAGE_BYTES` | 8589934592 | Integer, 1 through 1099511627776. Aggregate per-workspace cap across retained artifact versions and upload reservations. Admission is serialized per workspace; `pending`, `uploading`, `finalizing`, `quarantined`, and `expired` reservations remain charged until completion transfers the charge to a version or deletion is proven. |
| `SCIENCE_UPLOAD_TTL_SECONDS` | 3600 | Integer, 1 through 604800. Bounds abandoned upload/provider-output cleanup age. Active transfers and finalization use renewable ownership fences; provider-output reservations remain through promotion/terminal commit. An unexpired `pending`, `uploading`, or `finalizing` reservation fences matching version cleanup; cleanup resumes only after expiry/lost lease. |
| `SCIENCE_RENDER_TTL_SECONDS` | 900 | Integer, 1 through 86400. |
| `SCIENCE_MAX_CONCURRENT_RUNS` | 2 | Integer, 1 through 128. Enforced atomically at approval. |
| `SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` | 2 | Integer, 1 through 64. Serialized per workspace. Starting/ready rows and terminal or ambiguous rows that still retain a provider/launch-attempt handle consume a slot. |
| `SCIENCE_POLL_INTERVAL_MS` | 1000 | Integer, 1 through 60000. |
| `SCIENCE_RATE_LIMIT_READS_PER_MINUTE` | 600 | In-memory, per authenticated user/IP and process; maximum 100000. |
| `SCIENCE_RATE_LIMIT_WRITES_PER_MINUTE` | 120 | In-memory, per authenticated user/IP and process; maximum 100000. |
| `SCIENCE_AUTOMATION_USER_ID` | unset | Required for write tools without a human initiating mission. The user must be a builder in the workspace. |
| `SCIENCE_PUBLIC_BASE_URL` | unset | Required when `SCIENCE_RUNTIME_URL` or `SCIENCE_RENDER_URL` is configured. HTTP(S) Puppetmaster base visible to providers; credentials, query, and fragment are forbidden. The artifact content path is appended automatically. |

Startup performs full Science reconciliation before queue consumption. While
Science is enabled, an unref'd bounded single-flight interval repeats the full
operation: recoverable database runs are re-enqueued and retention cleanup is
attempted. It is not a retention-only timer.

### Filesystem artifact storage

| Variable | Default | Effect |
|---|---|---|
| `SCIENCE_STORAGE_DRIVER` | `filesystem` | Selects the filesystem adapter. |
| `SCIENCE_ARTIFACT_ROOT` | `apps/server/.science-data` | Root containing quarantine and immutable objects. Use a durable, backed-up volume outside the application image. |

The server process needs create/read/link/remove permission only within this
root. Do not share the directory directly with browsers or providers.

### S3-compatible artifact storage

Set `SCIENCE_STORAGE_DRIVER=s3`. All four named required variables must be
present or startup fails.

| Variable | Required | Effect |
|---|---|---|
| `SCIENCE_S3_ENDPOINT` | yes | HTTP(S) endpoint. The adapter uses path-style `<endpoint>/<bucket>/<key>` requests. |
| `SCIENCE_S3_BUCKET` | yes | Existing bucket. Bucket creation is not performed. |
| `SCIENCE_S3_ACCESS_KEY_ID` | yes | SigV4 access key; inject from a deployment secret manager. |
| `SCIENCE_S3_SECRET_ACCESS_KEY` | yes | SigV4 secret; never store in profile config or source control. |
| `SCIENCE_S3_REGION` | no | Defaults to `us-east-1`. |
| `SCIENCE_S3_REQUEST_TIMEOUT_MS` | no | Defaults to 300000; integer 1 through 3600000. Total bound for each signed S3 PUT/HEAD/GET/DELETE, including response streaming. Health probes retain their tighter five-second bound. |
| `SCIENCE_QUARANTINE_ROOT` | no | Defaults to `apps/server/.science-quarantine`; must be durable and have capacity for the largest in-flight uploads. |

The adapter does not upload partial data to S3. It verifies a local quarantine
file, then performs an immutable conditional PUT. Every object-store operation
has a configurable total deadline so a stalled endpoint cannot indefinitely
wedge upload completion, downloads, or cleanup inside full reconciliation. The
deterministic mock verifier includes a stalled DELETE, but a real MinIO/S3
endpoint, bucket policy, TLS, versioning, retention, timeout behavior, and
restore must be live-tested before write admission.

Deletion additionally rejects DELETE responses containing a delete marker or
version ID and requires a follow-up signed HEAD to return 404. Use a dedicated
bucket with object versioning disabled for automatic cleanup/purge. The current
adapter cannot enumerate or remove older object versions, so a versioned bucket
requires a separate version-aware retention design and remains a release gate.

No variable enables broad artifact deletion. The REST purge is admin-only and
requires the exact version SHA-256; run-linked, parent-of-child,
render-referenced, or actively finalizing versions remain protected.

### Compute adapter

| Variable | Default | Effect |
|---|---|---|
| `SCIENCE_RUNTIME_URL` | unset | Registers `HttpComputeProvider` as `local_container`. Must be HTTP(S). |
| `SCIENCE_RUNTIME_TOKEN` | unset | Bearer token sent only to the configured runtime origin. Required in production when a runtime URL is set. |
| `SCIENCE_RUNTIME_ADMISSION` | unset | In production, must be exactly `approved` before an HTTP runtime is registered. This is an operator assertion, not evidence by itself; submit still requires health to declare `isolated_oci` execution with user-code execution enabled. |
| `SCIENCE_RUNTIME_TIMEOUT_MS` | 15000 | Integer, 1000 through 600000, for each control/output request. |
| `SCIENCE_FIXTURE_PROVISIONING_MS` | 100 | Non-production deterministic provider only; maximum 60000. |
| `SCIENCE_FIXTURE_RUNNING_MS` | 300 | Non-production deterministic provider only; maximum 60000. |

No environment variable admits Jupyter Enterprise Gateway. Its shared enum
value is reserved for a future gated adapter.

The HTTP adapter sends the admitted runtime's immutable instance ID in
`X-Science-Provider-Instance` on every submit/status/cancel/output-list/output
read. An admitted runtime must reject missing or stale values before operating
on an execution.

### Render adapter

The static provider is always registered.

| Variable | Default | Effect |
|---|---|---|
| `SCIENCE_RENDER_URL` | unset | Registers the HTTP remote adapter under `trame`. Operationally forbidden until the trame gate passes. |
| `SCIENCE_RENDER_TOKEN` | unset | Server-to-render-launcher bearer token; required in production when a URL is set. |
| `SCIENCE_RENDER_ADMISSION` | unset | Must be exactly `approved` before any remote renderer is registered. No current trame deployment has earned this value. |
| `SCIENCE_RENDER_TIMEOUT_MS` | 15000 | Integer, 1000 through 600000. |

Do not set `SCIENCE_RENDER_URL` merely because an endpoint responds to
`/health`. The current same-origin gateway does not implement the validated
WebSocket behavior required by trame.

The remote render contract uses the same operation-level
`X-Science-Provider-Instance` fence on start/status/renew/close. A health check
alone is not sufficient identity fencing. Before remote start, the control
plane persists a launch-attempt marker and compare-and-set replaces it with the
actual handle. An ambiguous marker remains a quota/provenance barrier for
administrator action. HTTP close succeeds only on 200, 204, or idempotent 404.
Gateway suffix paths are confined to their upstream base-path prefix and
origin, and proxied active content is restricted to `connect-src 'self'`.

### Python runtime fixture

The runtime fixture accepts:

| Variable | Default |
|---|---|
| `SCIENCE_RUNTIME_HOST` | `127.0.0.1` (`0.0.0.0` in its image) |
| `SCIENCE_RUNTIME_PORT` | `8090` |
| `SCIENCE_RUNTIME_TOKEN` | required; 32-4096 characters with no NUL/CR/LF |
| `SCIENCE_RUNTIME_ALLOW_ANONYMOUS` | false; use `1` only in an isolated verifier |
| `SCIENCE_RUNTIME_STATE_DIR` | `/var/lib/science-runtime` |
| `SCIENCE_RUNTIME_MAX_CONCURRENCY` | 2 |
| `SCIENCE_RUNTIME_FIXTURE_DELAY_MS` | 100 |
| `SCIENCE_RUNTIME_MAX_CPU_MILLICORES` | 1000 |
| `SCIENCE_RUNTIME_MAX_MEMORY_MB` | 512 |
| `SCIENCE_RUNTIME_MAX_GPU_COUNT` | 0 |
| `SCIENCE_RUNTIME_MAX_WALL_SECONDS` | 300 |
| `SCIENCE_RUNTIME_ALLOWED_IMAGE_DIGESTS` | the fixture digest documented in `services/science-runtime/README.md` |
| `SCIENCE_RUNTIME_ALLOWED_KERNELS` | `python-fixture-v1` |
| `SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS` | empty; comma-separated exact Puppetmaster origins required before submit |

Anonymous mode is only for a loopback test. The fixture still does not execute
the allowlisted image. With an empty input-origin allowlist, every submission
that contains an artifact reference is rejected; include only the exact
Puppetmaster origin(s), without paths. It must match the origin of
`SCIENCE_PUBLIC_BASE_URL`.

To validate the optional Compose profile without starting it:

```powershell
$env:POSTGRES_PASSWORD = "<random-postgres-password>"
docker compose -f docker/docker-compose.yml --profile science config
```

To start only the fixture container for inspection, use a unique token of at
least 32 characters:

```powershell
$env:POSTGRES_PASSWORD = "<random-postgres-password>"
$env:SCIENCE_RUNTIME_TOKEN = "<random-value-with-at-least-32-characters>"
docker compose -f docker/docker-compose.yml --profile science up --build science-runtime
```

The runtime has no published host port. It runs as UID/GID `10001:10001` on the
internal `science_control` network with a read-only root filesystem, all Linux
capabilities dropped, no host or Docker-socket mount, and bounded CPU, memory,
PID, file-descriptor, process, and log resources. These are fixture-container
controls; because the fixture executes no notebook or image, they are not
per-job isolation evidence.

The Compose server's default filesystem store keeps both quarantine and
immutable objects under the named `science_artifacts` volume. Compose also
declares a separate `science_quarantine` mount for an S3/local-quarantine
override, and the fixture ledger/output state uses `science_runtime_data`.
PostgreSQL uses `pgdata`; Redis enables AOF with `appendfsync everysec` and uses
`redisdata`. PostgreSQL and Redis publish to host loopback only. Compose refuses
to render without `POSTGRES_PASSWORD`; do not replace it with a checked-in
default. The server healthcheck calls public, detail-free `/api/readyz`, so a
dependency failure produces HTTP 503 instead of a superficially healthy
container.
These volumes survive container replacement, but durability is not a backup:
every volume actually used by the selected profile still needs an external
snapshot and restore policy. Do not set `SCIENCE_RUNTIME_URL` on the production
Compose server to this fixture.

## First-run application setup

1. Confirm the unauthenticated `GET /api/health` liveness probe returns
   `ok=true`. It intentionally performs no dependency work. Then confirm public
   `GET /api/readyz` returns only `ok` and service identity, with HTTP 503 when
   dependencies are not ready; it intentionally exposes no dependency detail.
2. Sign in as an admin and confirm authenticated `GET /api/readiness` reports:
   - a healthy database;
   - `science.enabled=true`;
   - healthy artifact storage;
   - a healthy attached queue (`inline` for single-process development or
     `bullmq` for the Redis-backed deployment scheduler);
   - at least one healthy compute provider when submissions are enabled;
   - the expected render provider list.
   Readiness is cached for up to five seconds. Database health always gates
   `ok`; storage and queue gate it when Science is enabled, and at least one
   compute provider gates it when submissions are enabled. Render health is
   reported but non-gating. PostgreSQL probes use a dedicated one-connection
   pool with two-second connection acquisition, query, and statement limits;
   deterministic local TCP-blackhole coverage proves a bounded failure. The
   Redis producer/health client disables offline queuing and automatic resend,
   permits one retry, applies 1.5-second connect/command timeouts, and
   deduplicates a two-second readiness wait. BullMQ's blocking worker keeps its
   required retry-unbounded connection. A local TCP-blackhole verifier bounds
   health/enqueue failure below three seconds, but neither result replaces
   target-network/load evidence. Readiness does not replace provider admission
   or a workload probe. Authenticated `GET /api/bootstrap` also reports whether
   the configured queue is `bullmq` or `inline`.
3. As any workspace member, call
   `GET /api/science/workspace-admission`. A fresh or upgraded workspace with
   no row must return `admitted=false`; the response is limited to
   `workspaceId`, `admitted`, and `updatedAt`.
4. As a workspace admin, record the pilot decision with a specific reason:

   ```http
   PATCH /api/science/workspace-admission
   Content-Type: application/json

   {"admitted":true,"reason":"approved deterministic development workspace"}
   ```

   Builders must receive forbidden for this PATCH. The bounded reason and
   initiating actor belong in atomic audit context; neither is returned by the
   public projection. Confirm a second server instance reads the committed
   decision from the same database before removing global read-only mode.
5. Create a compute profile through Science Operations:
   - provider kind `local_container` for the current deterministic/HTTP adapter;
   - an immutable `sha256:<64 lowercase hex>` image digest;
   - an explicit kernel;
   - resource ceilings;
   - a non-empty `config.dependencyLock` object.
6. Sign in as a builder.
7. Create a `non_regulated` study and upload an artifact with declared byte
   count and SHA-256.
8. Use semantic role `code`, `notebook`, or `solver` for the executable input,
   or supply a verified hexadecimal `sourceRevision`.
9. Submit a run with a unique idempotency key and a request within profile
   ceilings. Resolve its durable approval.
10. Inspect the run dossier and manifest. Do not call it provenance-complete
    unless `complete=true` and `gaps=[]`.

## Verification commands

Build before running JavaScript verifiers:

```powershell
pnpm -r build
node scripts/verify-science-contracts.mjs
node scripts/verify-science-lifecycle.mjs
node scripts/verify-science-audit-atomicity.mjs
node scripts/verify-science-scheduler.mjs
node scripts/verify-science-artifacts.mjs
node scripts/verify-science-service.mjs
node scripts/verify-science-routes.mjs
node scripts/verify-science-authz.mjs
node scripts/verify-science-mcp-concurrency.mjs
node scripts/verify-science-recovery.mjs
node scripts/verify-science-golden.mjs
pnpm run verify:science
pnpm exec depcruise apps/server/src apps/web/src packages/db/src packages/kernel/src packages/mcp-connectors/src packages/shared/src packages/ui/src --config .dependency-cruiser.cjs --output-type err
python scripts/generate-science-fixtures.py --check
python -m py_compile services/science-runtime/server.py scripts/generate-science-fixtures.py scripts/verify-science-runtime.py
python scripts/verify-science-runtime.py
docker compose -f docker/docker-compose.yml --profile science config
```

Set `POSTGRES_PASSWORD` in the environment before the Compose command; the file
uses required-variable interpolation and intentionally has no default.

`verify-science-lifecycle.mjs` defaults to PGlite. Set
`SCIENCE_TEST_DATABASE_URL` to an isolated disposable PostgreSQL database to
exercise that driver. A PGlite pass is not PostgreSQL evidence.

The Python checks require only the standard library. Run any Docker command
named in `services/science-runtime/README.md` only after confirming the current
Compose profile validates. Missing Docker, PostgreSQL, MinIO, JEG, trame, OCCT,
browser, or target-hardware infrastructure must remain a visible
pending/external result.

All aggregate and repository-root results after migration 11 are currently
**PENDING rerun**. Do not promote historical pre-v11 console output to current
release evidence.
