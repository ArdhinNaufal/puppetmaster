# Science Operations security and threat model

## Scope and assumptions

This model covers the current MVP control-plane implementation. It assumes:

- one trusted Puppetmaster deployment boundary;
- authenticated workspace users with `member`, `builder`, or `admin` roles;
- non-regulated research data only;
- scientific uploads, notebooks, provider messages, and rendered content are
  untrusted;
- providers may fail, retry, return malformed data, or outlive Puppetmaster;
- administrators and deployment secret managers are trusted but fallible.

It does not authorize human-subject, health, export-controlled, defense, or
other regulated data.

## Assets

- workspace membership and user sessions;
- immutable scientific artifact bytes and checksums;
- study, run, approval, event, and manifest records;
- compute-provider and render-provider credentials;
- signing secrets and storage credentials;
- provider capacity and licensed resources;
- per-workspace admission decisions, reasons, and actor-attributed audit;
- scientific interpretation: units, parameters, validation results,
  limitations, and reproducibility claims.

## Trust boundaries

```text
Browser/session
  -> Fastify auth + Science REST gateway
  -> ScienceService + RBAC/audit/mission/admission control
  -> PostgreSQL/PGlite metadata (authoritative admission decision)
  -> ArtifactStore (filesystem or S3-compatible)
  -> ComputeProvider (deterministic or HTTP)
  -> RenderSessionProvider (static or gated remote)
  -> MCP servers (bounded command/reference plane)
```

The browser, provider, renderer, and MCP server do not receive database
credentials. The browser does not receive storage keys, provider handles,
server-to-provider bearer tokens, or raw signing tokens.

## Role and autonomy model

| Action | Minimum workspace role | Additional control |
|---|---|---|
| List/read studies, artifacts, runs, manifests, content, render results, admission | member | Workspace/child ownership check; admission projection is only `workspaceId`, `admitted`, `updatedAt` |
| Create/update study, create artifact/upload intent, submit/reproduce run, start/renew render | builder | Committed workspace admission required at every new-work boundary; run submit creates durable `write_approved` approval |
| Cancel run, close render, complete an accepted upload | builder | Remains available after revocation/read-only; destructive tool cancellation is `destructive_confirmed` |
| Create/update compute profiles | admin | Committed workspace admission plus immutable image digest and resource ceilings |
| Change workspace admission | admin | Boolean decision plus bounded reason; actor/action/decision audited atomically |
| Purge one artifact version | admin | Cleanup remains available after revocation/read-only; exact lowercase `confirmSha256`; only `ready` and unreferenced content; immutable expired tombstone retained |
| `science.*` read tools | tool grant + member context | `read_auto` |
| `science.run.submit`, `science.render.open` | tool grant + builder actor | `write_approved` |
| `science.run.cancel` | tool grant + builder actor | `destructive_confirmed`, exact generation |

REST mutations are role-gated by `apps/server/src/auth.ts`; the domain service
also resolves every child through the configured workspace. An unknown or
foreign child returns not-found rather than revealing its existence.

An automated write tool must resolve to a real initiating user or to
`SCIENCE_AUTOMATION_USER_ID`, which must be a workspace builder. Do not assign a
shared owner identity to unattended automation.

## Threat/control matrix

| Threat | Current control | Residual risk / gate |
|---|---|---|
| Cross-workspace IDOR | Parent and child repository lookups include workspace; render sessions also require exact owner; public DTOs hide internal handles. | Live multi-workspace deployment evidence is still required. |
| Unadmitted workspace acquires resources | Migration 11 stores one decision per workspace and treats a missing row as denied. Every new-work service boundary waits for any local admission mutation and rereads the database, so another instance's committed revoke is authoritative without restart. Member GET is redacted; only admin PATCH with a bounded reason mutates the row. | Admission is policy, not proof of provider isolation or scientific safety. A browser may display a decision up to its refresh interval late, but unknown/stale UI state fails closed and the service boundary remains authoritative. |
| Revocation strands or falsely terminates in-flight work | Revocation denies the next resource-bearing boundary but deliberately preserves reads, cancellation, scheduler reconciliation, render close, accepted-upload completion, and exact checksum purge. Already accepted runs/uploads may converge. | A revoke is not a provider kill. Operators must cancel an exact run generation when termination is required and wait for provider evidence. |
| Session bypass | Science routes use existing session auth; only health/auth, public detail-free `/api/readyz`, and HMAC artifact capability paths bypass normal session loading. `/api/readiness` remains authenticated. | Reverse-proxy session/cookie policy remains deployment-owned. |
| Signed-reference replay | HMAC binds version ID, audience, expiry, checksum, and size; expiry is checked; comparison is timing-safe; TTL is capped. The Fastify request serializer drops the entire query string, and the fixture validates then discards signed input URLs rather than persisting them. | A capability can be replayed by its holder until expiry. Keep TTL short and configure the reverse proxy and external providers to omit query strings too. |
| Path traversal / arbitrary filesystem read | Artifact keys reject absolute paths, `.`/`..`, NUL, and resolved paths outside the configured root. | Filesystem permissions and mount scope must still be minimal. |
| Partial/corrupt upload becoming input | New empty quarantine target, streamed byte cap and SHA-256, expected size/hash comparison, basic format/media validation, immutable promotion, only `ready` inputs. Transfer and finalization use renewable ownership fences. Provider-output reservations remain through pending-version promotion and terminal ready/link or quarantine handoff. Matching live `pending`/`uploading`/`finalizing` reservations fence version cleanup. Run creation atomically validates and binds its complete input set. | No malware scanner, active notebook sanitizer, full domain parser, or scientific-validity check is present. |
| Object overwrite | Filesystem immutable promotion and S3 `If-None-Match: *`; an existing target is accepted only with identical receipt. | Real S3 consistency, versioning, and bucket policy are unverified. |
| Provenance destroyed by artifact purge | Only an admin may call the exact-version DELETE route, with a lowercase 64-hex `confirmSha256`. The repository locks ownership/version state and refuses anything except `ready`, unreferenced content; run links, retained descendants, any render-session row, and active finalization are holds. Bytes are removed before quota release, but the version remains an immutable `expired`, `cleanupEligible=false` tombstone preserving ID, ordinal, and checksum. | This is a narrow manual purge, not a general retention schedule, legal-hold system, or external last-copy proof. Those controls remain pending. |
| Stalled or versioned S3 delete wedges/masks cleanup | Every signed PUT/HEAD/GET/DELETE uses the configured total deadline, including streaming; health is independently capped at five seconds. DELETE rejects delete-marker/version-ID responses and requires a follow-up HEAD 404 absence proof. A mock stalled-DELETE check passes. | Automatic purge requires a dedicated unversioned bucket. Live MinIO/S3 timeout, versioning, retry, consistency, and capacity behavior remains an external gate; prior-version enumeration/deletion is not implemented. |
| Secret injection into manifests/logs | Nested secret-bearing field names are rejected in profile config, parameters, artifact/provider metadata; public DTOs redact config/handles/keys; bounded error redaction. Database-triggered audit, including transaction-local initiating actor/action for wrapped user mutations, commits atomically with the material mutation. | The secondary semantic sink is best-effort. Secret values under innocuous field names cannot be detected reliably. |
| Arbitrary notebook exfiltration or host escape | No production notebook executor is admitted. The Python runtime fixture runs non-root but executes no user code. | Default-deny egress, read-only root, scratch isolation, seccomp/capabilities, PID/CPU/memory/GPU limits, and no Docker socket must be live-proven before an executor is admitted. |
| SSRF through provider URLs | Runtime/render base URLs are admin configuration; every control/output request remains on that origin; fetch uses manual redirect handling; redirects, 3xx responses, and origin changes are rejected; compute output paths must begin `/v1/outputs/`. | Deployment must restrict admin configuration and egress. DNS rebinding/private-network policy is not independently implemented here. |
| Duplicate expensive compute | Study-scoped idempotency key, atomic exact-input intent, stable provider key, persisted kind/instance/handle identity, short queue ticks, generation fencing, same-generation leases/heartbeats. | Every real provider must prove the same semantics under timeout/restart. |
| Provider replacement receives an old handle | The private durable handle binds provider kind, immutable instance ID, and opaque handle. Every execution/session operation carries the expected instance ID; HTTP providers must reject a missing/stale `X-Science-Provider-Instance` before acting. Drift enters the orphan/admin-action path. | Provider-side enforcement and orphan termination still require live operational proof for every admitted executor/renderer. |
| Stale cancellation kills newer job | Cancel/status include exact generation; stale expected generation is rejected; terminal state waits for provider evidence. Repeated unreachable-provider or cancellation-pending events retain `adminActionRequired` evidence rather than forcing success. | An adapter that ignores generation cannot be admitted. |
| Provider response poisoning | Strict bounded Zod schemas; control/error bodies are streamed through a 64 KiB ceiling; logs/metrics/output lists are bounded; redirects/origin changes are rejected; no inline data; independent size/hash verification. A declared-size reservation and renewable transfer lease exist before output read, remain through promotion, and are released only after atomic ready/link or quarantined terminal state. | Provider scientific correctness is not inferred. |
| MCP schema/result poisoning | Tool-definition hashes, per-tool tiers, serialized mission attribution, structured-result preference, 64 KiB cap, binary/resource rejection. | Pins and drift review still depend on operator policy; untrusted text remains prompt-injection content. |
| Event/log memory exhaustion | Run event payload cap is 16 KiB; provider logs/metrics and public pages are bounded; persisted provider telemetry is capped per run and duplicate generic audit for event/lease churn is suppressed; large logs must be artifacts. | Lifecycle history remains append-only, and its long-run retention/load policy needs production evidence. |
| API/storage exhaustion | Upload byte cap, input/output count caps, profile ceilings, atomic active-run quota, serialized workspace retained-byte quota, durable pre-read provider-output reservations, persisted cleanup backoff, per-workspace render-session quota, and per-process read/write rate buckets. Failed discard remains quota-charged until row-driven cleanup proves deletion. | Rate limits are in-memory and not distributed; reverse proxy must enforce deployment-wide request limits, and target storage/renderer pressure still needs load/chaos evidence. |
| Active renderer escapes UI or ambiguous launch leaks capacity | Before start, a durable launch-attempt marker consumes a serialized workspace slot; compare-and-set installs the actual handle, while ambiguity remains an admin-action barrier. The owner-bound gateway canonicalizes suffixes and enforces the upstream base-path prefix plus origin, forbids redirects, keeps the token server-side, and sets `connect-src 'self'`; the iframe omits `allow-same-origin`. Remote close accepts only 200/204/404. Successful close removes terminal session metadata; failed/unclosed sessions remain discoverable and retain their artifact/provenance slot. | Live trame WebSocket, process/memory reclamation, origin behavior, and quota/load evidence are absent, so trame remains no-go. |
| Browser geometry memory exhaustion | No automatic content fetch; explicit load; 8 MiB text cap; 5000-point and 10000-edge caps; abort on selection change; parsing occurs in a disposable module Web Worker. | Browser peak-memory/repeated-disposal evidence is missing, and OCCT remains no-go. |
| Supply-chain/image drift | Profiles require lowercase immutable OCI digests; manifest captures profile and adapter version; reproduction refuses drift. | The deterministic/Python fixtures do not pull or verify an OCI image. A real executor needs registry signature/allowlist evidence. |
| False reproducibility or scientific claim | Manifest has explicit completeness/gaps/limitations; UI distinguishes provenance completeness; comparison leaves numerical equivalence `null` absent a named validation. | Domain review and workload-specific tolerances are outside the current deterministic fixture. |
| Audit loss/tampering | Migration 5 installs triggers for the original nine Science domain tables; migration 10 adds strict transaction-local initiating actor/action context for short user mutations, with `system/science-db` fallback for recovery/direct repository work. Migration 11 adds `science_workspace_admissions` as the tenth audited table and installs its trigger. Material mutations and their bounded records commit or roll back together; scope/lineage checks remain trigger-enforced. Append-only run-event inserts plus lease/heartbeat/cleanup-backoff-only updates suppress duplicate churn. The secondary semantic sink stays bounded, redacted, and best-effort. | A semantic-sink failure can omit only the secondary enriched entry; it cannot erase the atomic actor-attributed mutation record or turn an already-committed mutation into a retryable API failure. Current post-v11 aggregate/root reruns are pending. |
| False readiness during dependency failure | Database health always gates readiness; enabled Science also gates on storage/queue and on compute when submissions are enabled. Public `/api/readyz` is detail-free and returns 503; authenticated `/api/readiness` carries redacted diagnostics. PostgreSQL uses a dedicated pool with two-second acquisition/query/statement bounds. Redis producer/health disables offline queue/resend, permits one retry, applies 1.5-second connect/command bounds, and deduplicates a two-second ready wait; the BullMQ blocking worker remains retry-unbounded. Deterministic DB/Redis TCP-blackhole checks return within their outer bounds. | Retained target-network, load, failover, and availability evidence remains pending. |
| Metadata/artifact loss | Immutable receipts support detection. Compose requires an injected PostgreSQL password, loopback-binds PostgreSQL/Redis, enables Redis AOF on a named volume, and declares named volumes for metadata/queue data, artifacts, quarantine, and fixture state. | Named volumes/AOF are durability, not backup. PostgreSQL/S3 restore, RPO/RTO, object versioning, and target disaster-recovery drills are not yet demonstrated. |

## Provider credential rules

- Inject `SCIENCE_SIGNING_SECRET`, S3 credentials, runtime token, and render
  token through the deployment secret manager.
- Set `NODE_ENV=production` and leave `SCIENCE_RUNTIME_ADMISSION` /
  `SCIENCE_RENDER_ADMISSION` unset until the exact external provider has passed
  its gate. An `approved` string is an operator assertion, not proof.
- Never place credentials in compute-profile `config`, run `parameters`,
  artifact metadata, provider output metadata, mission input, or workflow
  literals.
- Do not log signed capability query strings.
- Runtime and render bearer tokens are server-to-provider credentials. They
  must not be returned by provider status or health responses.
- Rotate secrets in read-only mode. Rotation invalidates outstanding artifact
  capabilities and render gateway tokens; close/recreate render sessions and
  ensure active compute no longer depends on old references.

## Scientific-integrity rules

- Checksums prove byte identity, not model validity.
- A STEP point/topology diagnostic is not tessellation, repair, meshing, or
  solver associativity.
- Provider success does not prove convergence.
- A declared quote is not measured resource use or cost.
- A complete manifest is provenance-complete and re-runnable under the captured
  contract; it is not automatically bitwise-identical.
- Numerical equivalence requires candidate-manifest validation with a bounded
  non-empty metric and tolerance; units, observed value, and review method must
  be retained when applicable.
- Agents may draft parameters, but named humans retain domain-critical boundary
  condition, approval, and release decisions.

## Mandatory no-go decisions

As of 2026-07-29:

- **Jupyter Enterprise Gateway: NO-GO.**
- **trame remote rendering: NO-GO.**
- **OCCT WASM STEP tessellation: NO-GO.**
- **Production notebook/container execution: NO-GO.**
- **Regulated/sensitive data: NO-GO.**

The exact exit evidence is listed in
[`evidence-matrix.md`](./evidence-matrix.md). Configuration availability does
not override these decisions.
