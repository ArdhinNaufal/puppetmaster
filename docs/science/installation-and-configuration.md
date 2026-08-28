# Science Operations installation and configuration

For repository cloning, dependency installation, and the non-Science local
paths, start with the [general installation guide](../INSTALL.md). This guide
adds the Science-specific storage, provider, admission, and release fences.

## Prerequisites

- Node.js 22 or newer.
- pnpm 10.33.0 through Corepack.
- A supported Puppetmaster database:
  - PGlite for deterministic development; or
  - PostgreSQL for deployment. A dedicated loopback instance has passed the
    complete 1-16 ledger and fresh lifecycle gate; target HA, load, backup, and
    restore are still separate release gates.
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
There is no separate Science-only migration command. Migrations are additive,
recorded in `schema_migrations`, and currently run from version 1 through 16.

- Versions 1-10 establish the Science domain, atomic mutation audit, cleanup,
  transfer/finalization leases, storage reservations, and initiating-actor
  attribution.
- Version 11 adds unique, persisted, default-deny workspace admission.
- Version 12 adds append-only, session-attributed
  `science_domain_validations` as the eleventh audited Science-domain table.
- Version 13 adds monotonic, SHA-256-bound
  `science_domain_validation_heads` as the twelfth audited Science-domain
  table. A corrupt or mismatched head fails closed rather than selecting an
  older favorable review.
- Version 14 adds durable `workflow_waits` claims, leases, wake/recovery, and
  cancellation. This is shared workflow infrastructure and is not a thirteenth
  audited Science-domain table.
- Version 15 extends render sessions with the scoped request-key hash,
  canonical intent fingerprint, provider/mode, exact source snapshot, launch
  lease, replay expiry, and terminal close tombstone fields.
- Version 16 adds external-upload classification and transfer-lease expiry,
  indexed by workspace/external/state/expiry. This supports a
  database-authoritative cross-instance external-stream cap and lets a crashed
  transfer's lease expire without adding another table.

A dedicated loopback PostgreSQL lifecycle run applied all 16 versions and
returned `science lifecycle (pg): ok`. That is local driver/migration evidence,
not target HA, load, backup, or disaster-recovery evidence.

## Minimal deterministic development setup

Use the repository's ignored `.pmdata` tree for disposable local persistence,
or replace these paths with absolute directories outside the repository. Use a
random signing secret of at least 16 bytes:

```powershell
$env:SCIENCE_ENABLED = "1"
$env:SCIENCE_SIGNING_SECRET = "<random-secret-from-your-secret-manager>"
$env:PGLITE_DATA_DIR = ".pmdata/science-pglite"
$env:SCIENCE_ARTIFACT_ROOT = ".pmdata/science-artifacts"
pnpm dev
```

The placeholder above is not an instruction to paste a real secret into a
shared terminal. Inject it from a secret manager or a non-echoing prompt so it
is not retained in shell history. After stopping the local server, clear it:

```powershell
Remove-Item Env:SCIENCE_SIGNING_SECRET -ErrorAction SilentlyContinue
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
SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS=3600000
SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS=60000
SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS=4

# Set these only for an executor that passed the deployment's admission gate.
# The bundled deterministic runtime fixture does not qualify.
# SCIENCE_RUNTIME_URL=https://admitted-runtime.internal.example
# SCIENCE_RUNTIME_TOKEN=...
# SCIENCE_RUNTIME_ADMISSION=approved
#
# Set in that runtime using the exact origin of SCIENCE_PUBLIC_BASE_URL:
# SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS=https://puppetmaster.example
```

This block shows variable names, not a file to commit or commands to paste with
real values. Inject database, signing, object-store, and provider credentials
from the deployment secret manager. Do not put them in shell history, tickets,
logs, or rendered Compose output. Use `docker compose config --quiet` for
interpolation validation; unqualified `docker compose config` can print
resolved secrets.

Start in read-only mode. The admission PATCH remains available while read-only,
but profile, study, upload-intent, run, reproduction, and render creation do
not. Record the intended pilot workspace's reasoned admission, then keep
`SCIENCE_READ_ONLY=1` until the exact database, object-store, queue, runtime,
backup, and target-hardware gates in the evidence matrix pass. Moving to writes
is a controlled configuration transition, not a live toggle:

1. Drain user traffic and keep every API/scheduler instance read-only.
2. Confirm the committed workspace admission from a second instance and retain
   the external gate evidence and approval.
3. In the secret-managed deployment configuration, set
   `SCIENCE_READ_ONLY=0` and configure only the provider that earned admission.
   Validate interpolation with `docker compose config --quiet` or the
   orchestrator's non-rendering equivalent.
4. Recreate/restart **every** API and scheduler instance from that same
   configuration. Science environment is read at process startup; do not leave
   a mixed read-only/writable replica set serving traffic.

   For the shipped single-server Compose topology, the transition command is:

   ```powershell
   docker compose -f docker/docker-compose.yml config --quiet
   docker compose -f docker/docker-compose.yml up -d --build --force-recreate server
   ```

   Include the same override files and profiles used by the running deployment.
   A replicated orchestrator must perform the equivalent drained replacement of
   every instance, not just restart one replica.
5. Before creating the first profile or any other resource, confirm public
   `/api/readyz` returns HTTP 200; authenticated `/api/readiness` reports
   `science.ok=true`, `science.submissionsEnabled=true`, healthy database,
   storage, queue, and at least one healthy admitted compute provider; and
   authenticated `/api/bootstrap` reports `science.enabled=true`,
   `science.submissionsEnabled=true`, the expected queue, storage adapter, and
   provider list. Re-read `/api/science/workspace-admission` and require
   `admitted=true`.
6. If any check fails, restore `SCIENCE_READ_ONLY=1`, recreate/restart every
   instance again, and investigate without creating resources.

Admission and global read-only are independent gates; neither overrides the
other. Passing these transition checks is necessary but is not production
proof.

The shipped server image and base Compose service run as UID/GID 1000 with a
read-only root filesystem, all Linux capabilities dropped, bounded process and
file-descriptor limits, and `no-new-privileges`. A one-shot initializer owns
only the two named artifact/quarantine volumes and grants that UID access before
the server starts. Do not remove that dependency or run the API container as
root to work around volume permissions.

The base Compose stack also builds `apps/web` and serves it through a dedicated
UID/GID 101 static gateway. Browser traffic enters at
`http://127.0.0.1:4000` by default; the API container has no host-published
port, and browser ingress reaches it only through the isolated `web_gateway`
network. The gateway proxies all `/api` traffic without body buffering,
including `/api/events` upgrades and Science render-session gateway suffixes,
so cookies, UI assets, REST, and WebSockets share one browser origin. Hashed
Vite assets are immutable for one year; `index.html` is never cached and unknown
client routes receive the SPA shell. The gateway is non-root, read-only,
capability-free, resource-bounded, and has neither application secrets nor a
Docker-socket mount.

`PUPPETMASTER_WEB_BIND_ADDRESS` changes the host bind address and defaults to
`127.0.0.1`; `PUPPETMASTER_WEB_PORT` changes the published port and defaults to
`4000`. Keep the loopback default behind a host TLS terminator. Any external
TLS proxy must preserve WebSocket upgrades on `/api/events` and the complete
`/api/science/render-sessions/.../gateway` path. The shipped browser policy
permits same-origin frames/workers and the existing inline React style
attributes; it does not permit third-party scripts or cross-origin renderer
frames.

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
| `SCIENCE_ENABLED` | false | Enables Science reads and lifecycle ownership. All active Science booleans accept only `1`/`0`, `true`/`false`, `yes`/`no`, `on`/`off`, or `enabled`/`disabled` (case-insensitive). An unrecognized value is a startup error, not a false value. |
| `SCIENCE_READ_ONLY` | false | When true, rejects new studies/artifacts/upload intents/profiles/runs, approval into execution, reproductions, render starts, and render renewals. It preserves reads, cancellation, render close, scheduler ticks/reconciliation, accepted-upload streaming/completion, and exact checksum purge. This is the deployment-wide rollback switch. |
| `SCIENCE_SUBMISSIONS_DISABLED` | false | A second strict boolean that disables new submissions. Prefer `SCIENCE_READ_ONLY=1` because its broader rollback intent is clearer. It is deliberately inert while Science is disabled or already read-only. |
| `SCIENCE_SIGNING_SECRET` | falls back to `PUPPETMASTER_MASTER_KEY`; fixed development fallback outside production | HMAC key for artifact capabilities and render-gateway tokens. Underlying adapters require at least 16 bytes. |
| `SCIENCE_MAX_UPLOAD_BYTES` | 2147483648 | Integer, 1 through 17179869184. Per-upload hard cap. |
| `SCIENCE_MAX_WORKSPACE_STORAGE_BYTES` | 8589934592 | Integer, 1 through 1099511627776. Aggregate per-workspace cap across retained artifact versions and upload reservations. Admission is serialized per workspace; `pending`, `uploading`, `finalizing`, `quarantined`, and `expired` reservations remain charged until completion transfers the charge to a version or deletion is proven. |
| `SCIENCE_UPLOAD_TTL_SECONDS` | 3600 | Integer, 1 through 604800. Bounds abandoned upload/provider-output cleanup age. Active transfers and finalization use renewable ownership fences; provider-output reservations remain through promotion/terminal commit. An unexpired `pending`, `uploading`, or `finalizing` reservation fences matching version cleanup; cleanup resumes only after expiry/lost lease. |
| `SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS` | 3600000 | Integer, 1 through 86400000. Whole external transfer deadline, including artifact-store settlement; reaching it aborts and quarantines the reservation. |
| `SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS` | 60000 | Integer, 1 through 3600000 and not greater than the absolute deadline. Restarts after each received body chunk; reaching it aborts and quarantines the reservation. |
| `SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS` | 4 | Integer, 1 through 128. Database-authoritative per-workspace cap shared across server instances. Internal provider-output ingestion does not consume this external-client allowance. |
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
deterministic mock verifier includes a stalled DELETE. A dedicated,
unversioned loopback MinIO bucket also passed health, immutable promotion,
full/range reads, receipt checks, duplicate refusal, and exact deletion. Target
TLS, IAM, network, versioning, retention, timeout recovery, and restore must
still be verified before production write admission.

Deletion additionally rejects DELETE responses containing a delete marker or
version ID and requires a follow-up signed HEAD to return 404. Use a dedicated
bucket with object versioning disabled for automatic cleanup/purge. The current
adapter cannot enumerate or remove older object versions, so a versioned bucket
requires a separate version-aware retention design and remains a release gate.

For a single-host, deployment-shaped MinIO lane, use the opt-in override rather
than changing the safe base defaults. It pins the MinIO image by digest, starts
the service as UID/GID 1000 with a read-only root filesystem and no Linux
capabilities, creates only the named private bucket, and fails if that bucket is
versioned:

```powershell
# Inject real values from a secret manager or non-echoing prompt; do not paste
# them into shell history.
$env:POSTGRES_PASSWORD = "<from-secret-manager>"
$env:SCIENCE_S3_ACCESS_KEY_ID = "<dedicated-access-key>"
$env:SCIENCE_S3_SECRET_ACCESS_KEY = "<dedicated-secret-key>"
$env:SCIENCE_S3_BUCKET = "puppetmaster-science"
docker compose `
  -f docker/docker-compose.yml `
  -f docker/docker-compose.science-minio.yml `
  --profile science-minio config --quiet

# After validation, or after the later stack run has stopped:
Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_S3_ACCESS_KEY_ID -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_S3_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
```

Only start that profile after replacing every placeholder secret and reviewing
the selected non-secret settings. Re-inject credentials through the same safe
mechanism for the actual start. The retained verifier proves the Compose wiring
and unversioned-bucket guard without contacting a daemon. A live start of this
new override has not yet been retained; the separate loopback MinIO adapter run
below remains the current live object-store evidence.

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

No environment variable admits Jupyter Enterprise Gateway as an executable
provider. `SCIENCE_JEG_*` variables configure only the fail-closed
`prerequisite-only` probe described in the provider contracts. The JEG adapter
is not registered; submit, channels, and output collection remain unavailable.

The OCI executor implementation is likewise a deterministic candidate. Its
policy verifier passes, but live rootless execution and a notebook corpus have
not run. The observed host Docker daemon advertised `seccomp` and `cgroupns`,
not rootless mode; do not set production admission on that basis.

The HTTP adapter sends the admitted runtime's immutable instance ID in
`X-Science-Provider-Instance` on every submit/status/cancel/output-list/output
read. An admitted runtime must reject missing or stale values before operating
on an execution.

### Render adapter

The static provider is always registered. The released request mode is
`static` only and requires one exact ready, run-linked `image/png` version up to
8 MiB. Its version ID, checksum, media type, size, and logical name are stored
with the replay intent. `client` and `remote` requests are refused rather than
silently downgraded.

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
docker compose -f docker/docker-compose.yml --profile science config --quiet
```

Inject the password from a secret manager or non-echoing prompt rather than
pasting a real value into shell history. After the quiet interpolation check,
start the base stack and open the single browser origin (replace the URL only
if you changed the bind port):

```powershell
docker compose -f docker/docker-compose.yml up --build
# Open http://127.0.0.1:4000/

# After the stack has stopped:
Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue
```

The API remains available through that origin, for example
`http://127.0.0.1:4000/api/health`; it is not published as a second host port.
Manual development is unchanged: Vite listens on port 3000 and proxies `/api`
to `PUPPETMASTER_API_TARGET` or `http://localhost:4000`.

The supplied Compose environment intentionally defaults to
`SCIENCE_ENABLED=0`, `SCIENCE_READ_ONLY=1`, and
`SCIENCE_STORAGE_DRIVER=filesystem`. Enabling Science in this production
Compose stack without changing the storage driver to `s3` and supplying
`SCIENCE_S3_ENDPOINT`, `SCIENCE_S3_BUCKET`, `SCIENCE_S3_ACCESS_KEY_ID`, and
`SCIENCE_S3_SECRET_ACCESS_KEY` fails the deployment preflight before the
database or providers are constructed. Keep `SCIENCE_READ_ONLY=1` for the
initial production stage. Read-only still requires the deployment database,
Redis, signing key, and S3 storage, but it does not require optional compute or
remote-render settings. A previously admitted, still-valid provider is retained
for cancellation/close convergence; malformed stale optional provider settings
are omitted instead of defeating the rollback. When `SCIENCE_ENABLED=0`, every
other Science setting is inert so the emergency kill switch cannot be blocked
by stale adapter configuration.
Rendering the Compose configuration proves interpolation only, not live
PostgreSQL, Redis, S3, or runtime admission.

To start only the fixture container for inspection, use a unique token of at
least 32 characters:

```powershell
# Inject both values without placing real secrets in shell history.
$env:POSTGRES_PASSWORD = "<random-postgres-password>"
$env:SCIENCE_RUNTIME_TOKEN = "<random-value-with-at-least-32-characters>"
docker compose -f docker/docker-compose.yml --profile science up --build science-runtime

# After the fixture has stopped:
Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_RUNTIME_TOKEN -ErrorAction SilentlyContinue
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
   decision from the same database. In production, do not proceed to step 5
   until the controlled read-only-to-write transition above has recreated every
   API/scheduler instance and all post-restart `/api/readyz`, authenticated
   `/api/readiness`, `/api/bootstrap`, and workspace-admission checks pass.
5. Create a compute profile through Science Operations:
   - provider kind `local_container` for the current deterministic/HTTP adapter;
   - an immutable `sha256:<64 lowercase hex>` image digest;
   - an explicit kernel;
   - resource ceilings;
   - a non-empty `config.dependencyLock` object.
6. Sign in as a builder.
7. Create a `non_regulated` study and upload an artifact with declared byte
   count and SHA-256.
8. Upload a notebook whose bytes successfully parse as `ipynb`, wait for its
   immutable version to become `ready`, and link that exact version under the
   semantic role `code`, `notebook`, or `solver`. A hexadecimal
   `parameters.sourceRevision` is only informational user input: no VCS resolver
   verifies it, the manifest's top-level `sourceRevision` remains `null`, and it
   cannot replace the parsed notebook artifact.
9. Submit a run with a unique idempotency key and a request within profile
   ceilings. Resolve its durable approval.
10. Inspect the run dossier and manifest. Use the endpoint/FUI's top-level
    current assessment; do not call it provenance-complete unless
    `complete=true` and `gaps=[]`. The nested manifest and its hash are the
    immutable historical record, not a substitute for the current relational
    verdict.
11. For the released deterministic fixture path, confirm the successful run has
    a ready, run-linked PNG whose metadata says `fixturePreview=true` and
    `productionCompute=false`.
12. As an admin or owner, use the `DOMAIN VALIDATION LEDGER` form to append a
    bounded review. This is an immutable human record; it does not turn the
    fixture into scientific evidence.
13. Run the built-in **Science: reproducible notebook run** workflow. Its
    mission waits durably for terminal Science state, selects one bounded
    checksummed PNG, pauses for approval of that exact visible source, opens a
    static render with a stable replay key, and reads the complete manifest.
14. Close the static session when finished. A network-error retry must keep the
    same request key and source intent.

## Verification commands

Build before running JavaScript verifiers:

```powershell
pnpm -r typecheck
pnpm -r build
node scripts/verify-science-contracts.mjs
node --no-warnings --experimental-strip-types scripts/verify-science-geometry.mjs
node scripts/verify-science-deployment.mjs
node scripts/verify-science-lifecycle.mjs
node scripts/verify-science-audit-atomicity.mjs
node scripts/verify-science-scheduler.mjs
node scripts/verify-science-artifacts.mjs
node scripts/verify-science-service.mjs
node scripts/verify-science-routes.mjs
node scripts/verify-science-authz.mjs
node scripts/verify-science-ui.mjs
node scripts/verify-science-mcp-concurrency.mjs
node scripts/verify-science-workflow.mjs
node scripts/verify-workflow-deferred-resume.mjs
node scripts/verify-science-jupyter-gateway.mjs
node scripts/run-science-oci-executor-verifier.mjs
node scripts/verify-science-recovery.mjs
node scripts/verify-science-golden.mjs
pnpm run verify:science
pnpm run verify:science:browser
pnpm exec depcruise apps/server/src apps/web/src packages/db/src packages/kernel/src packages/mcp-connectors/src packages/shared/src packages/ui/src --config .dependency-cruiser.cjs --output-type err
python scripts/generate-science-fixtures.py --check
python -m py_compile services/science-runtime/server.py scripts/generate-science-fixtures.py scripts/verify-science-runtime.py
python scripts/verify-science-runtime.py
docker compose -f docker/docker-compose.yml --profile science config --quiet
```

Set `POSTGRES_PASSWORD` in the environment before the Compose command; the file
uses required-variable interpolation and intentionally has no default. Inject
it without putting the value in shell history, and clear it after validation.
Never replace `--quiet` with rendered output in logs or CI artifacts that may
contain resolved secrets.

```powershell
Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue
```

`verify-science-lifecycle.mjs` defaults to PGlite. Set
`SCIENCE_TEST_DATABASE_URL` to an isolated disposable PostgreSQL database to
exercise that driver. Inject credential-bearing URLs without putting them in
shell history, then clear `SCIENCE_TEST_DATABASE_URL` after the lane. A PGlite
pass is not PostgreSQL evidence.

```powershell
Remove-Item Env:SCIENCE_TEST_DATABASE_URL -ErrorAction SilentlyContinue
```

The live Redis/BullMQ lane is deliberately opt-in and is not part of the
deterministic golden aggregate. Point it only at a dedicated test Redis
instance or database with AOF enabled. If its URL contains credentials, inject
it from the test secret store rather than pasting it into the command line:

```powershell
$env:SCIENCE_TEST_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:SCIENCE_TEST_REDIS_ALLOW_SCOPED_DELETE = "1"
pnpm run verify:science:redis-live

# After the dedicated test lane finishes:
Remove-Item Env:SCIENCE_TEST_REDIS_URL -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_TEST_REDIS_ALLOW_SCOPED_DELETE -ErrorAction SilentlyContinue
```

The verifier rebuilds the kernel, creates a cryptographically unique BullMQ
queue name and key prefix, and never flushes a Redis database. It proves live
duplicate suppression plus delayed-poll and transient-retry recovery across
scheduler teardown/recreation. Cleanup obliterates only that unique queue,
checks that a sentinel outside the queue survived, and then removes the exact
sentinel. Its success marker is:

```text
SCIENCE REDIS LIVE PASS: AOF-backed BullMQ duplicate suppression and delayed/retry recovery across scheduler restart with scoped cleanup
```

The retained loopback verification also used `WAITAOF`, restarted the exact
Redis process, and confirmed its sentinel survived. That establishes local AOF
restart durability; it does not prove target replication, failover, latency,
capacity, or DR. The golden harness explicitly removes all
`SCIENCE_TEST_REDIS_*` and
`SCIENCE_TEST_S3_*` variables from child environments so a normal deterministic
run cannot contact or mutate live test infrastructure.

The S3-compatible artifact lane is also opt-in. Use only a dedicated,
disposable, **unversioned** bucket whose contents the verifier may delete.
Inject the access key and secret key from the test secret store or a non-echoing
prompt; do not paste real values into shell history:

```powershell
$env:SCIENCE_TEST_S3_ENDPOINT = "http://127.0.0.1:9000"
$env:SCIENCE_TEST_S3_REGION = "us-east-1"
$env:SCIENCE_TEST_S3_BUCKET = "science-verifier"
$env:SCIENCE_TEST_S3_ACCESS_KEY_ID = "<dedicated-test-access-key>"
$env:SCIENCE_TEST_S3_SECRET_ACCESS_KEY = "<dedicated-test-secret-key>"
$env:SCIENCE_TEST_S3_ALLOW_DELETE = "1"
node scripts/verify-science-artifacts.mjs

# After the dedicated test lane finishes:
Remove-Item Env:SCIENCE_TEST_S3_ENDPOINT -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_TEST_S3_REGION -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_TEST_S3_BUCKET -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_TEST_S3_ACCESS_KEY_ID -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_TEST_S3_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
Remove-Item Env:SCIENCE_TEST_S3_ALLOW_DELETE -ErrorAction SilentlyContinue
```

The verifier uses random object keys and proves health, immutable promotion,
full and byte-range reads, checksum/size receipts, duplicate refusal, and exact
deletion through the production S3-compatible adapter. A successful live lane
adds this line before the normal artifact marker:

```text
science live S3 (dedicated unversioned bucket): ok
```

The retained loopback run used MinIO
`RELEASE.2025-06-13T11-33-47Z` pinned to image digest
`sha256:064117214caceaa8d8a90ef7caa58f2b2aeb316b5156afe9ee8da5b4d83e12c8`.
That is adapter evidence, not target TLS, IAM, network, versioning-policy,
backup/restore, or production object-store certification.

The Python checks require only the standard library. Run any Docker command
named in `services/science-runtime/README.md` only after confirming the current
Compose profile validates. Missing target infrastructure must remain a visible
pending/external result.

The frozen local result set is:

- fresh recursive typecheck and production build: PASS;
- deterministic aggregate:
  `SCIENCE GOLDEN PASS^3: 18 isolated deterministic suites; 34 evidence classes verified on every pass`;
- loopback PostgreSQL: migrations 1-16 and
  `science lifecycle (pg): ok`;
- loopback Redis/BullMQ: live PASS plus a sentinel surviving `WAITAOF` and an
  exact Redis process restart;
- loopback MinIO/S3: live adapter PASS in a dedicated unversioned bucket;
- same-origin delivery: deterministic preflight plus a real hardened nginx
  container and installed-Chrome HTTP/WebSocket proof; and
- fresh Science installed-browser journey: 4/4 PASS. See
  [`browser-release-evidence.md`](./browser-release-evidence.md) for its exact
  artifacts and scope.

The JEG check is a prerequisite only and prints an explicit live-execution
`NOT PROVEN` marker. The OCI check is a deterministic candidate only and also
prints `LIVE OCI EXECUTION: NOT PROVEN`; the observed host Docker daemon was
not rootless. trame and OCCT remain NO-GO. No local result replaces target TLS,
load, HA, SLO, CVE, backup/restore, or rollback evidence, and no named domain
expert has accepted a workload-specific review protocol. The original MVP and
production release therefore remain **NOT MET**.
