# Science Operations evidence matrix

## Audit basis

Point-in-time audit: **2026-08-07**, against
`SCIENTIFIC-ENGINEERING-SUBSYSTEM-IMPLEMENTATION-PLAN.md` and the current
worktree.

Status meanings:

- **PROVEN**: current source plus a directly relevant deterministic verifier
  was observed passing in this worktree during implementation, or the required
  deliverable is the inspected document itself.
- **PENDING**: implementation/evidence is missing, partial, source-only, not
  executed after the relevant change, too narrow for the requirement, or not
  retained.
- **EXTERNAL**: proof needs unavailable target infrastructure, service,
  hardware, browser, domain reviewer, or operational drill.

Important limitations:

- Local console passes are development evidence, not retained CI/release
  artifacts. They must be re-run after final edits and retained for release.
- A verifier's title is not proof. Its assertions were inspected and are
  qualified below where their scope is narrower than the plan.
- No Docker image build/run, live PostgreSQL, live MinIO/S3, Jupyter Enterprise
  Gateway, trame, OCCT, target-hardware SLO, or target backup/restore evidence
  is claimed here. A Docker Compose configuration render is narrower evidence.

## Observed deterministic evidence

The following commands were reported passing in this worktree during
implementation and the current audit:

| Command | Observed result | Qualification |
|---|---|---|
| `pnpm --filter @puppetmaster/shared build` | pass | Build only |
| `pnpm --filter @puppetmaster/db build` | pass | Current source ledger is migrations 1-10: v7 finalizer fence, v8 persisted cleanup backoff, v9 renewable transfer/provider-reservation fence, and v10 atomic actor attribution; live PostgreSQL execution evidence is separate |
| `pnpm --filter @puppetmaster/kernel build` and focused type-check | pass | Current provider fences, output reservations, retention, comparison, and telemetry source |
| `pnpm --filter @puppetmaster/server build` | pass | Current periodic full-reconciliation scheduling source (DB-to-queue repair plus retention) |
| `pnpm --filter @puppetmaster/web build` and `typecheck` | pass | Current FUI/comparison source; production build emitted only its existing chunk-size warning. This is not browser/layout/accessibility/reconnect evidence |
| Focused Science static layout assertions | pass | Six source-CSS invariants, rail-before-center-before-dossier DOM order, and the corresponding built-CSS rules; live geometry still requires browser measurement |
| `node --no-warnings --experimental-strip-types scripts/verify-science-geometry.mjs` | pass | Retained bounded ASCII VTK/STL diagnostics, STEP topology, cap, invalid-topology, binary rejection, and explicit-fallback cases; this is diagnostic parsing, not OCCT/vtk.js fidelity evidence |
| Authenticated local browser layout at `1024x864` and `740x900` | pass | Document width equaled viewport width, rail/center/dossier pairs did not overlap, the analytical viewport remained opaque, and no console warning/error was observed; screenshots were visually inspected but are not retained release evidence |
| `node scripts/verify-science-contracts.mjs` | pass | Current shared/canonicalization cases and direct compute/render expected-instance probes |
| `node scripts/verify-science-lifecycle.mjs` | pass | Current PGlite coverage includes migrations 1-10, serialization/rollback, transfer/finalization leases, provider reservations through terminal commit, immutable tombstones, quota admission, cleanup fencing, and post-expiry resumption. No live PostgreSQL result is claimed |
| `node scripts/verify-science-audit-atomicity.mjs` | pass | Current PGlite verifier covers migration-10 upgrade/serialization/rollback, nine triggers, actor-attributed commit/rollback/context reset, system fallback, material audit, and operational-churn suppression |
| `node scripts/verify-science-scheduler.mjs` | pass | Current verifier covers deterministic run/generation job IDs, inline transient retry, fail-fast producer options, and bounded TCP-blackhole health/enqueue failure under three seconds; not live Redis/BullMQ durability/recovery |
| `node scripts/verify-science-artifacts.mjs` | pass | Current filesystem plus local S3 protocol mock includes total signed-request deadlines, stalled-DELETE abort, delete-marker/version-ID rejection, and required HEAD-404 absence proof; not live MinIO/S3 |
| `node scripts/verify-science-mcp-concurrency.mjs` | pass | Attribution, per-tool tiers, bounded/reference-only results |
| `node scripts/verify-science-service.mjs` | pass | Current verifier emitted 43 acceptance lines covering deterministic lifecycle/races/recovery/static render, operation and launch-attempt fences, run/render/storage quotas, reservations, bounded telemetry, comparison, tombstone retention/backoff, checksum-confirmed purge, semantic-audit sink failure, and bounded PostgreSQL TCP-blackhole readiness |
| `node scripts/verify-science-routes.mjs` | pass | Current Fastify injection coverage; not full browser UAT |
| `node scripts/verify-science-authz.mjs` | pass | Current 10-case real-login/RBAC suite includes builder-forbidden/admin checksum-confirmed purge, tombstone-response `storageKey` redaction, cross-workspace isolation, generic approval, audit, events, and rollback assertions |
| `node scripts/verify-science-recovery.mjs` | pass | Cold closed-PGlite/filesystem copy, byte/hash restore, read-only export/write refusal, and queued-run cancellation; not production backup infrastructure |
| `python scripts/generate-science-fixtures.py --check` | pass | Ten deterministic synthetic files; format/protocol corpus only, not scientific-validity or fidelity evidence |
| `python -m py_compile services/science-runtime/server.py scripts/generate-science-fixtures.py scripts/verify-science-runtime.py` | pass | Current runtime instance-persistence/operation-fence source |
| `python scripts/verify-science-runtime.py` | pass | Current 17/17 adversarial standard-library checks cover auth/no-go health, allowlists, input bounds, concurrent idempotency, redacted ledger, generation/cancel/restart and missing/stale-instance fencing, output checksum/tamper, and the built TypeScript adapter; the fixture still executes no notebook/container |
| `docker compose -f docker/docker-compose.yml --profile science config --quiet` | pass | Current render requires `POSTGRES_PASSWORD`, loopback-binds PostgreSQL/Redis, enables Redis AOF/volume, and healthchecks `/api/readyz`; no image build/inspect/run or live durability result is claimed |
| `node scripts/verify-science-golden.mjs` | PASS^3 in 180.8 s | Current post-v10 source passed eleven isolated deterministic suites and all eighteen required evidence classes on every repetition. The harness deliberately clears live PostgreSQL, Redis, runtime, and render target variables |
| `pnpm test` | pass in 245.4 s | Current repository-root command rebuilt the repo, passed architecture and broader deterministic checks, and repeated the current Science PASS^3. No retained external CI artifact is claimed |

The current golden harness covers geometry, contracts, lifecycle, atomic audit,
scheduler, artifacts, MCP, service, routes, authz, and cold recovery. It
requires all eighteen evidence classes, including geometry preview,
malformed/unsafe inputs, DB predicates, scheduler durability, artifact
boundaries, tool selection/no raw data, approval, manifests, authorization,
backup/rollback, atomic audit, provider fencing, storage quota, and honest
comparison. The current post-v10 PASS^3 completed in 180.8 seconds with eleven
suites and all eighteen classes on every pass. The repository-root `pnpm test`
completed in 245.4 seconds and repeated that PASS^3 after rebuilding and running
the broader deterministic/architecture checks.

This is deterministic PGlite/filesystem/in-process evidence, not retained CI,
domain-review, browser, production-infrastructure, or target-hardware evidence.

## WP0 - Evidence, ADRs, and risk spikes

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| ADR: subsystem boundary | PROVEN | `docs/adr/009-science-operations-subsystem-boundary.md`; current boundary in `packages/kernel/src/science/service.ts` and `apps/server/src/main.ts` |
| ADR: artifact storage/provenance | PROVEN | `docs/adr/010-science-artifact-storage-and-provenance.md`; implementation in `artifact-store.ts` and `manifest.ts` |
| ADR: compute provider | PROVEN | `docs/adr/011-science-compute-provider-and-lifecycle.md`; external executor admission remains no-go |
| ADR: render session/auth | PROVEN | `docs/adr/012-science-render-session-authentication.md`; trame admission remains no-go |
| Representative notebook/tabular/array/STEP/VTK/malformed/interruption corpus or reproducible generator | PROVEN | Observed generator `--check` pass for ten deterministic synthetic files under `services/science-runtime/fixtures/`; this is protocol/format coverage, not solver or geometry fidelity |
| Measured SLOs for upload, queue/provision, events, render, recovery, storage, sessions | EXTERNAL | No accepted target hardware or retained baseline report |
| JEG Docker provisioner start/channels/interrupt/shutdown/auth/orphan spike | EXTERNAL | Adapter not registered; no live verifier; **NO-GO** |
| trame local/hybrid/remote proxy, isolation, expiry, origin, heartbeat, disconnect spike | EXTERNAL | HTTP interface exists but gateway lacks proven WebSocket behavior; no live verifier; **NO-GO** |
| OCCT WASM license/format/worker/disposal/memory/time/fidelity comparison | EXTERNAL | No OCCT dependency, corpus result, or worker; **NO-GO** |
| Concurrent MCP attribution or refactor | PROVEN | `packages/kernel/src/mcp.ts`; observed pass from `verify-science-mcp-concurrency.mjs` |
| Threat model for notebooks/uploads/render/provider callbacks/SSRF/secrets/IDs/exhaustion/MCP drift | PROVEN | `docs/science/security-and-threat-model.md` documents threats and marks unresolved controls; not all controls are verified |
| WP0 exit: accepted ADRs, corpus/generator, measured baseline, threat model, external go/no-go decisions | PENDING | ADRs, threat model, reproducible synthetic corpus, and no-go decisions exist; measured target baseline is missing |

## WP1 - Shared contracts and persistence

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| Zod contracts for studies/artifacts/versions/uploads/runs/events/profiles/manifests/render sessions | PROVEN | `packages/shared/src/science.ts`; observed `verify-science-contracts.mjs` pass |
| PostgreSQL/PGlite-compatible DDL, indexes, constraints, repositories | PENDING | Source exists in `packages/db/src/schema.ts`, `client.ts`, and `science-repo.ts`; PGlite path passed, live PostgreSQL path is unproven |
| Ordered migration ledger/runner | PROVEN | `schema_migrations` versions 1-10: v5 atomic audit, v6 cleanup eligibility, v7 finalizer fencing, v8 cleanup retry/backoff, v9 renewable transfer/provider-reservation fencing, and v10 atomic actor attribution. Current lifecycle/atomic-audit passes cover PGlite upgrade, concurrent callers, rollback, and final-ledger behavior; PostgreSQL advisory locking remains live-unproven |
| Fresh install and pre-Science upgrade on PostgreSQL | EXTERNAL | Requires disposable live PostgreSQL via `SCIENCE_TEST_DATABASE_URL`; no result retained |
| Legal state transitions and stale-generation rejection | PROVEN | Shared transition table plus repository guards; observed lifecycle/service passes |
| Workspace ownership/isolation | PROVEN | Repository/service tests in lifecycle/service; full real-session server test remains separately pending |
| Immutable versions/events, idempotency, generation fencing | PROVEN | Repository constraints and observed lifecycle/service passes; run creation locks the study and atomically writes mission/run/trace/exact input links, while concurrent different-input reuse has one winner and one conflict |
| `science` mission kind, exactly one mission/run, minimum science trace step | PROVEN | `packages/shared/src/types.ts`, `packages/db/src/science-repo.ts`, `apps/web/src/Trace.tsx`; observed contracts/lifecycle passes |
| WP1 exit: every legal/illegal/stale transition on PGlite and PostgreSQL | PENDING | PGlite coverage exists but no proof that every transition pair is enumerated, and no live PostgreSQL result |

## WP2 - Artifact store and provenance core

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| Filesystem and S3-compatible `ArtifactStore` adapters | PROVEN | `packages/kernel/src/science/artifact-store.ts`; observed artifact verifier pass against filesystem/local S3 mock |
| Stream to quarantine and hash during transfer | PROVEN | `writeQuarantine`; observed artifact/service passes |
| Bounded media/format validation before readiness | PROVEN | `ScienceService.validateArtifactFormat`; malformed-contract/unsafe-input evidence passed on every golden repetition |
| Promote only after declared size/hash checks; crash-safe idempotency | PROVEN | filesystem/S3 `promote`; observed promotion-retry and mismatch service cases |
| Interrupted upload never becomes `ready`; explicit restart semantics | PROVEN | non-empty quarantine write is rejected; mismatch/failed streams stay non-ready in artifact/service tests |
| Range reads and paginated metadata | PROVEN | artifact/range implementation and observed artifact/route/service passes |
| Immutable versions and checksum-aware deduplication | PROVEN | DB uniqueness/repository guards plus observed lifecycle/artifact/service passes; ready bytes are never overwritten. Output readiness/link commit together. Admin purge can remove only checksum-confirmed, unreferenced bytes and retains an immutable expired tombstone preserving ID, ordinal, and checksum |
| Admin checksum-confirmed artifact-version purge | PROVEN | Current 43-case service and 10-case authz passes cover exact SHA confirmation, byte-before-quota-release, admin-only REST access, and builder refusal. Repository locks retain run-linked, parent-of-child, render-referenced, and actively finalizing versions; successful cleanup sets `cleanupEligible=false` rather than deleting the version row |
| Cleanup abandoned uploads/quarantine | PROVEN | Current lifecycle coverage proves renewable transfer/finalization ownership, provider-output reservations retained through promotion/terminal commit, same-artifact/SHA live-reservation cleanup fencing, and resumption after expiry. Terminal upload reservations may be deleted after exact discard; cleanup-eligible version bytes leave immutable expired tombstones. Live object-store retention remains separate |
| Signed/scoped provider references rather than JSON/MCP bytes | PROVEN | HMAC references in `artifact-store.ts`; observed artifact/MCP/service passes |
| Audit create/upload/finalize/quarantine/expire without secrets | PROVEN | Current atomic-audit/service passes verify nine triggers, atomic initiating-user/action attribution for wrapped database-only mutations, transaction-local rollback/reset, system fallback, and operational-churn suppression. The secondary semantic sink remains best-effort; its deliberate failure does not lose the atomic actor-attributed row or make the commit retryable |
| Cross-workspace content access returns not-found | PROVEN | Repository/service/route ownership assertions plus the current 10-case real-session authz pass |
| Retention cleanup including material object retention policy | PENDING | Retry-safe cleanup covers terminal reservations, cleanup-eligible provider outputs, terminal render sessions, protected orphan sweeping, and persisted backoff. The admin can purge one confirmed unreferenced `ready` version to a tombstone, but general schedules, legal hold, external last-copy proof, and live object-store gates remain incomplete |
| Deployment S3/MinIO profile | EXTERNAL | DELETE rejects delete-marker/version-ID responses and requires HEAD 404, so automatic purge requires a dedicated unversioned bucket. No live MinIO/S3/TLS/bucket-policy/versioning test exists; version-aware retention is unimplemented |
| WP2 exit gate as a whole | PENDING | Core deterministic bytes, atomic audit, quota, timeout, and narrow purge paths have focused local evidence; live object-store evidence and complete user-version retention/legal-hold policy remain incomplete |

## WP3 - Durable scientific job runtime

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| `ComputeProvider` interface | PROVEN | `providers.ts` requires an expected-instance fence on every execution operation; current contracts/service passes exercise it |
| Deterministic fake provider | PROVEN | `DeterministicComputeProvider` enforces the same fence; current service pass covers submit-to-output behavior |
| HTTP adapter against deterministic Python runtime contract | PROVEN | Current 17/17 runtime pass covers the built `HttpComputeProvider`, bounded control responses, redirect/origin refusal, restart state, output/tamper checks, missing/stale operation-instance refusal, and production refusal of fixture mode |
| Isolated local-container/notebook provider | PENDING | `HttpComputeProvider`, provider-visible absolute artifact capabilities, and Python fixture contract exist, but the fixture fetches no inputs and executes no user code or OCI images. Production requires explicit admission plus `isolated_oci`/user-code health and rejects the fixture |
| Jupyter Enterprise Gateway after WP0 gate | EXTERNAL | No adapter/live gate; intentionally **NO-GO** |
| Persist generation, handle, heartbeat, progress, bounded logs, output collection | PROVEN | Current lifecycle/service/runtime passes bind provider kind, instance ID, and opaque handle, persist a pre-submit attempt marker, carry expected instance on submit/status/cancel/collect/open, and bound persisted telemetry |
| Delayed queue/polling instead of long HTTP/MCP request | PROVEN | `packages/kernel/src/science/scheduler.ts`; observed scheduler check proves deterministic run/generation job IDs and inline transient retry. Live Redis/BullMQ durability remains unproven |
| Approval before submission and retry idempotency | PROVEN | Atomic repository approval plus exact-input run-intent transaction; observed lifecycle/service/route passes |
| Exact-generation cancellation | PROVEN | Current service/runtime coverage includes queued, in-flight submit, lost-response recovery, rejected-cancel, generation races, and per-operation instance fencing |
| Startup/shutdown reconciliation | PENDING | Current source runs full reconciliation at startup and periodically: retention plus recoverable DB-run re-enqueue. Existing deterministic evidence covers persisted handles, read-only recovery, orphan-safe cancellation, and instance drift, but every non-terminal restart and live Redis/provider interruption remain unproven |
| Same service for bounded `science.*` tools and events | PROVEN | `science-tools.ts`, `bridge.ts`, `main.ts`; observed MCP/service passes |
| Duplicate delivery creates no second provider execution | PROVEN | service verifier idempotency/lease cases |
| Stale completion cannot win; cancellation cannot kill newer generation | PROVEN | lifecycle/service fencing assertions |
| WP3 exit gate as a whole | PENDING | The current deterministic vertical slice, instance fences, and full reconcile/cleanup paths pass locally; production isolated executor, every-phase restart, live Redis, Docker image execution, and JEG evidence are absent |

## WP4 - FUI Science Operations shell

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| Science view, typed client, role navigation, command palette, NEXUS tasks | PENDING | Source and web build/typecheck pass; the authenticated Science shell loaded in a real browser, but command-palette/NEXUS reachability and a complete workflow journey were not exercised |
| Persisted layout, study/artifact rail, configurator, dossier, pipeline, manifest inspector | PENDING | Responsive non-overlap/no-horizontal-overflow passed at 1024x864 and 740x900 after fixing the observed medium-width collapse. The inspector now exposes candidate identity and numerical-validation fields, but that comparison flow, persistence, and the complete panel journey remain browser-unproven |
| Reusable primitives promoted without duplicate panel/chip system | PENDING | `packages/ui` HoldButton/a11y changes exist; design-system review not retained |
| Isolated analytical viewport and separate scientific palette | PROVEN | `.sci-viewport-isolation` and palette tokens exist; the opaque viewport was visually verified at desktop and narrow widths |
| Paginated/virtualized lists and explicit disconnect/reconnect | PENDING | Rail virtualization/paging and REST resync source exist; no load/reconnect browser test |
| Responsive, reduced motion, assistive hold, fallback, empty/error/loading states | PENDING | Responsive non-overlap/no-horizontal-overflow passed at 1024x864 and 740x900; keyboard, reduced-motion, assistive-hold, and fallback/state UAT remain missing |
| Admin compute-profile create/edit flow | PENDING | `ComputeProfileManager.tsx` exists; no authenticated browser test |
| WP4 exit: keyboard, reduced-motion, axe, contrast, pixel screenshots, NEXUS/palette reachability | PENDING | Two authenticated responsive layouts pass locally, but no retained Playwright/axe/contrast set or keyboard/reduced-motion/NEXUS UAT report exists |

## WP5 - Geometry and visualization providers

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| STEP parsing/tessellation in Web Worker with hierarchy/units/bounds/triangles/warnings/disposal | PENDING | A bounded disposable worker now handles limited ASCII VTK/STL plus lightweight STEP point/`EDGE_CURVE` topology diagnostics. It does not provide OCCT tessellation, CAD hierarchy/unit recovery, or solver-quality triangle fidelity; OCCT remains **NO-GO** |
| Size/capability policy chooses client/reduced/remote/static from measured data | PENDING | Explicit 8 MiB/point/edge caps and fallbacks exist, but no measured corpus policy or reduced-geometry provider |
| Bounded client VTK/STL/STEP diagnostic | PENDING | Bounded diagnostic source is present, but no retained focused parser verifier was found. Even the small ASCII VTK/STL, STEP point/edge, binary-refusal, size-cap, memory, and browser behaviors remain unverified |
| `RenderSessionProvider` contract and static fallback | PROVEN | `render.ts`; observed service/lifecycle/route static-session passes |
| Same-origin owner-bound gateway, token/TTL/renew/close/startup cleanup | PROVEN | Current service/routes/contracts evidence covers owner/expiry/cleanup/handle bounds for static/test providers. Source adds serialized per-workspace session quota, a pre-start launch-attempt barrier, strict HTTP close 200/204/404, gateway base-prefix/origin confinement, and `connect-src 'self'`; live trame remains the separate no-go row below |
| trame remote session through intended proxy | EXTERNAL | No WebSocket/live auth/isolation/quota/cleanup gate; **NO-GO** |
| Viewport state controls and sandboxed active content | PENDING | same-origin check, iframe sandbox, strict gateway path confinement, and `connect-src 'self'` source exist; no retained CSP/origin/browser security test |
| Two-user session isolation | PROVEN | Static/test provider owner isolation in observed service/route checks; does not prove trame isolation |
| WebGL failure fallback and memory recovery | PENDING | Table/static paths exist, but no WebGL failure or repeated open/close memory measurement |
| WP5 exit gate as a whole | PENDING | Static render control-plane evidence exists and bounded diagnostic-worker source is present but parser-unverified; required OCCT tessellation, measured corpus policy, trame, geometry-browser, and memory-recovery evidence is absent |

## WP6 - Golden workflow, agents, and reproducibility evaluation

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| Builtin ingest -> validate -> authorize -> execute -> collect -> visualize -> manifest workflow/template | PENDING | `apps/server/src/seeds.ts` has a Science workflow for inspect/quote/approve/submit; it does not explicitly execute the complete named output/visualize/verify chain |
| Constrained research assistant with read/quote/submit/status tools and human review rules | PENDING | Seeded `Science Research Assistant` exists with bounded grants/persona; no trajectory/eval evidence |
| Golden tasks for tool choice, no MCP bytes, approval, provenance, unsafe refusal | PROVEN | The current post-v10 PASS^3 required tool-tier/selection, no-raw-tool-data, approval-gate, manifest-completeness, unsafe-input, and authorization evidence on every repetition |
| Re-run comparison distinguishes identity from numerical equivalence | PROVEN | Current focused service and `honest-comparison` PASS^3 evidence verify exact input/parameter/environment/output identity separately from candidate-manifest numerical evidence. `numericallyEquivalent` and `numericalValidation` remain `null` unless a bounded non-empty metric and tolerance accompany the named boolean result. Browser flow evidence remains pending separately |
| System never labels incomplete manifest reproducible | PROVEN | Service refusal plus manifest-completeness evidence passed on every golden repetition; no browser claim is implied |
| WP6 exit: recorded/met pass^k plus domain-review lineage | PENDING | Current eleven-suite/eighteen-class PASS^3 is observed locally; named domain-review lineage and a retained external release/CI artifact are missing |

## WP7 - Security, operability, and staged rollout

| Plan requirement | Status | Authoritative evidence / gap |
|---|---|---|
| Non-root/read-only provider images | PENDING | Dockerfile and observed Compose render declare UID 10001, read-only root, dropped capabilities, no privilege escalation, bounded resources, named PG/Redis/artifact/quarantine/runtime volumes, and no host/Docker-socket mount; Docker daemon was unavailable, so image build/inspect/run remains unproven, and this is not a real notebook executor |
| Resource quotas and image-digest allowlist | PENDING | Current source covers profile/request/active-run controls, serialized workspace retained-byte quota, pre-read provider-output reservations, render-session concurrency, and fixture allowlists. Target-executor/render enforcement remains unproven |
| Default-deny network, scoped grants, no host Docker socket | EXTERNAL | Requires live container/compose inspection and egress test for the actual executor |
| Secret redaction, bounded logs, rate limits, workspace concurrency | PENDING | Runtime/authz/golden redaction and concurrency assertions pass; application request logs strip query strings and the fixture discards signed input URLs, but reverse-proxy logging and process-local rate limits still need deployment-wide evidence |
| Readiness for database/artifact/queue/compute/render | PENDING | Database always gates the cached result; enabled Science also gates on storage/queue and on compute when submissions are enabled, while render is reported but non-gating. Public detail-free `/api/readyz` returns 503 and drives the Compose healthcheck; authenticated `/api/readiness` exposes redacted detail. Current deterministic checks prove the PostgreSQL probe's dedicated two-second acquisition/query/statement bounds and both DB/Redis TCP-blackhole failure return within their outer limits. Live target availability, queue lag, and orphan evidence remain incomplete |
| Compose dependency durability/exposure | PENDING | Source loopback-binds PostgreSQL/Redis, requires `POSTGRES_PASSWORD`, enables Redis AOF on `redisdata`, and uses periodic DB-to-queue reconciliation. A rendered configuration is not a live restart/data-loss/blackhole result |
| OTel spans and measured usage | PENDING | Generic platform tracing exists; no Science-specific retained span/usage evidence |
| Admin-visible orphan/quarantine queues | PENDING | Repeated provider/cancellation failure records bounded `adminActionRequired` run evidence and `science.run.orphaned` audit entries, but there is no aggregated admin UI/API or provider-wide orphan discovery |
| Deterministic metadata/artifact backup and read-only rollback | PROVEN | Observed `verify-science-recovery.mjs` pass verifies cold closed-PGlite/filesystem copy, every linked byte, manifest hash, export/write refusal, and accepted queued-run cancellation |
| Target backup/restore and retention tests | EXTERNAL | No demonstrated PostgreSQL/S3 target drill, accepted RPO/RTO, or full retention test |
| Chaos/reconciliation for DB, Redis, provider, renderer | EXTERNAL | Deterministic restart cases are narrower than the required live matrix |
| `SCIENCE_ENABLED`, development fixtures, read-only rollback | PROVEN | `config.ts`, `main.ts`; production disables implicit fixtures, requires provider admission variables/tokens, and rejects the non-executing runtime fixture at submit. Read-only cancellation/reconciliation is observed in the service verifier |
| Opt-in pilot workspace | PENDING | Feature flag is deployment-wide; no persisted per-workspace admission flag |
| Rollback preserves read/export and existing resources | PROVEN | Observed deterministic recovery pass; target deployment rollback drill remains external |
| Operator runbook for stuck/orphan/corrupt/expired/quota/DR | PROVEN | `docs/science/operator-runbook.md` |
| WP7 exit: controls, target SLOs, backup/restore, rollback | EXTERNAL | No target-hardware/DR/rollback evidence |

## Verification-strategy coverage

| Required layer | Status | Evidence / missing proof |
|---|---|---|
| Shared/schema | PENDING | Zod and PGlite pass; PostgreSQL parity missing |
| Repository | PROVEN | Current lifecycle/service/atomic-audit passes cover workspace isolation, immutable tombstones, exact-input idempotency, atomic output readiness/link, migrations 1-10, transfer/finalization leases, storage reservations, atomic actor attribution, and retry-safe cleanup on PGlite. PostgreSQL parity remains pending |
| Artifact store | PENDING | Current filesystem/local-S3-mock evidence includes bounded signed requests and stalled DELETE. Source now rejects versioned delete markers/version IDs and requires HEAD 404; live unversioned MinIO/S3 and version-aware general retention remain missing |
| Runtime | PENDING | Deterministic state/race/instance-drift and focused scheduler passes; real Docker executor, live Redis/BullMQ recovery, and every-phase live restart are missing |
| Tools | PROVEN | MCP attribution/bounds plus authz, tool-tier/selection, no-raw-tool-data, approval, and unsafe-input evidence passed across the current deterministic PASS^3 |
| API | PENDING | Route injection and the current 10-case real-session authz pass include admin-only checksum purge; distributed rate/size policy and reconnect integration remain pending |
| UI | PENDING | Source/build include the FUI full-SHA hold-to-purge control, visible/copyable checksum, active-render block, and post-purge ready-version selection. No retained Playwright/axe/keyboard/contrast/reduced-motion/reconnect/fallback suite proves the interaction |
| Visualization | PENDING | Static owner/expiry pass; no corpus reference/fidelity, trame isolation, or memory cleanup |
| Evals | PENDING | Current PASS^3 covers eighteen required evidence classes across eleven suites; named domain review and retained external release evidence are missing |
| Operations | PENDING | Deterministic cold PGlite/filesystem recovery, read-only rollback, and orphan/admin-action signaling pass; no target load, chaos, provider-wide orphan discovery, PostgreSQL/S3 restore, or deployment rollback drill |

Planned script inventory:

| Planned script | Current state |
|---|---|
| `scripts/verify-science-contracts.mjs` | Present; current pass |
| `scripts/verify-science-artifacts.mjs` | Present; current filesystem/local-S3-mock pass including stalled and versioned-delete refusal |
| `scripts/verify-science-geometry.mjs` | Present; current bounded VTK/STL/STEP diagnostic/cap/fallback pass |
| `scripts/verify-science-lifecycle.mjs` | Present; current migration-10 PGlite pass including transfer/provider-reservation/version-cleanup fencing and post-expiry resumption |
| `scripts/verify-science-audit-atomicity.mjs` | Present; current PGlite pass |
| `scripts/verify-science-scheduler.mjs` | Present; current deterministic job-ID, inline retry, and bounded Redis TCP-blackhole producer/health pass |
| `scripts/verify-science-authz.mjs` | Present; current 10-case pass |
| `scripts/verify-science-recovery.mjs` | Present; observed deterministic PGlite/filesystem pass |
| `scripts/verify-science-mcp-concurrency.mjs` | Present; observed pass |
| `scripts/verify-science-render-session.mjs` | Missing; static/test-provider cases live in service/routes/lifecycle |
| `scripts/verify-science-jupyter-gateway.mjs` | Missing; JEG no-go |
| `scripts/verify-science-service.mjs` | Present; current 43-acceptance pass |
| `scripts/verify-science-routes.mjs` | Present; current pass |
| `scripts/verify-science-runtime.py` | Present; current 17/17 deterministic contract/adapter pass |
| `scripts/verify-science-golden.mjs` | Present; current post-v10 eleven-suite/eighteen-class PASS^3 in 180.8 s |

## MVP definition-of-done audit

| MVP DoD requirement | Status | Evidence / blocker |
|---|---|---|
| One non-admin researcher completes study-to-manifest inside Puppetmaster | PENDING | Service/route/real-login authz flow passes and FUI source exists; no end-to-end browser journey is retained |
| Every write/destructive action follows RBAC, autonomy, approval, append-only audit | PENDING | Current atomic-audit/service/authz evidence proves database-atomic initiating actor/action attribution for the deterministic user-write paths; browser and external-provider paths remain unproven |
| No scientific binary in MCP, mission output, audit detail, or event bus | PROVEN | MCP bounds, no-raw-tool-data, redaction, audit, and event assertions passed across the current deterministic PASS^3 |
| Artifact versions immutable/checksummed; every success has explicit links and manifest hash | PROVEN | Observed lifecycle/artifact/service/route passes; input intents are atomic and output readiness cannot commit without its exact-generation run link. The admin purge cannot remove run/child/render-retained content |
| Duplicate delivery, restart, timeout, cancellation converge without duplicate/stale compute | PENDING | Strong deterministic race cases pass; every non-terminal restart and real provider/Redis timeout matrix remains incomplete |
| Second user/workspace cannot access first user's artifacts/jobs/logs/render sessions | PROVEN | Repository/service/static-render isolation and real-session authz pass across the current admitted providers; remote trame remains no-go and is not included |
| FUI measured/calm/pixel-safe and passes keyboard/reduced-motion/axe/contrast/fallback | PENDING | Responsive geometry, opaque viewport, and clean console pass at two viewports; keyboard/reduced-motion/axe/contrast/fallback and retained screenshot evidence remain missing |
| Deterministic suite, pass^k, target SLO, backup/restore, rollback all retain evidence | EXTERNAL | Current local PASS^3/root and deterministic cold recovery pass exist; retained external CI, target SLO, and production PostgreSQL/S3 DR/rollback evidence are absent |
| Install/config, provider contracts, security, runbook, limitations, deferred list | PROVEN | `docs/science/` plus ADR-009 through ADR-012 |

## Current release decision

**MVP definition of done: NOT MET.**

The deterministic control-plane vertical slice is implemented and has
meaningful local evidence. Production admission remains blocked by:

1. real isolated notebook/container execution;
2. live PostgreSQL, Redis, and MinIO/S3 gates;
3. retained browser accessibility/fallback evidence;
4. complete restart/chaos and external-provider lifecycle coverage;
5. named domain-review evidence and retained release artifacts;
6. target-hardware SLOs;
7. demonstrated backup/restore and rollback.

JEG, trame, and OCCT remain explicit **NO-GO** dependencies.
