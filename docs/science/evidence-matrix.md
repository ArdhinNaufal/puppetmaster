# Science Operations evidence matrix

## Audit basis

This matrix separates four kinds of evidence:

- **Deterministic**: isolated repository verifiers that are repeatable and do
  not contact configured live infrastructure.
- **Browser**: an installed-browser journey against the built web application.
- **Loopback integration**: real PostgreSQL, Redis, MinIO, Docker, or browser
  processes on the verification host.
- **External/target**: the actual production topology, executor, scientific
  corpus, security operations, and named reviewers.

One class does not substitute for another. In particular, a deterministic
candidate does not prove live execution, and loopback success does not prove
target TLS, HA, load, SLO, or disaster recovery.

## Frozen local results

| Gate | Disposition | Evidence and boundary |
|---|---|---|
| Monorepo typecheck | PROVEN | Fresh recursive typecheck passed |
| Monorepo build | PROVEN | Fresh recursive production build passed; the existing large web chunks remain a performance item, not a correctness failure |
| Deterministic aggregate | PROVEN | `SCIENCE GOLDEN PASS^3: 18 isolated deterministic suites; 34 evidence classes verified on every pass` |
| Database ledger | PROVEN LOCALLY | Ordered migrations 1-16 pass; 12 Science-domain tables have atomic audit triggers; `workflow_waits` belongs to workflow infrastructure |
| PostgreSQL lifecycle | PROVEN ON LOOPBACK | 16/16 ledger and fresh `science lifecycle (pg): ok`; target PostgreSQL/HA/backup remains external |
| Redis/BullMQ | PROVEN ON LOOPBACK | Live lane passed; AOF `WAITAOF`/process-restart sentinel survived; target failover/latency remains external |
| S3-compatible artifact store | PROVEN ON LOOPBACK | Dedicated unversioned MinIO bucket passed the live S3 lane; target TLS/IAM/versioning/DR remains external |
| Same-origin web gateway | PROVEN LOCALLY | Deterministic configuration plus real non-root/read-only nginx container, HTTP proxy, and installed-Chrome same-origin WebSocket proof |
| Science browser journey | PROVEN LOCALLY | Fresh installed-browser gate passed 4/4; exact artifacts and covered cases are recorded in [`browser-release-evidence.md`](./browser-release-evidence.md) |
| Named scientific-domain review | EXTERNAL | The FUI and immutable ledger exist, but no named expert/tolerance protocol has been accepted |
| Production release | NOT MET | Required target execution, security, availability, recovery, and scientific gates remain open |

## Deterministic aggregate inventory

The golden harness runs these 18 isolated suites three consecutive times and
requires all listed positive and explicit nonproof markers:

| Suite | Main claim | Deliberate boundary |
|---|---|---|
| `verify-science-geometry.mjs` | Bounded ASCII VTK/STL and STEP topology diagnostics | Not OCCT, CAD tessellation, or browser-fidelity proof |
| `verify-science-contracts.mjs` | Strict shared/config contracts | Not deployment admission |
| `verify-science-deployment.mjs` | Fail-closed production preflight and same-origin Compose shape | Target ingress/load/HA remain external |
| `verify-science-lifecycle.mjs` | Transactional lifecycle, migrations 1-16, quota, render replay, and database-authoritative external-upload stream fencing | Golden uses isolated PGlite; PostgreSQL is a separate lane |
| `verify-science-audit-atomicity.mjs` | Atomic audit on 12 Science-domain tables, append-only reviews, monotonic scope heads | Workflow wait table is not counted as a Science-domain table |
| `verify-science-scheduler.mjs` | Deterministic job IDs, retries, bounded queue failure | Redis process durability is separate |
| `verify-science-artifacts.mjs` | Quarantine, checksum, immutability, range, bounded S3 behavior | Target object store is separate |
| `verify-science-mcp-concurrency.mjs` | Tool tiering, attribution, reference-only bounded results | No bulk scientific data through MCP |
| `verify-science-workflow.mjs` | Reviewed run intent through exact static PNG and complete manifest | Static fixture workflow only; no notebook-execution claim |
| `verify-workflow-deferred-resume.mjs` | Migration-14 durable terminal wait/recovery | No external executor proof |
| `verify-workflow-workspace-isolation.mjs` | Workspace-scoped recovery, dispatch, queue/cron identity, routes, and template ownership | Does not prove target multi-host queue failover or load |
| `verify-science-jupyter-gateway.mjs` | Authenticated HTTPS/version/identity/allowlist/recovery prerequisite | `LIVE JEG EXECUTION: NOT PROVEN`; adapter is not registered |
| `run-science-oci-executor-verifier.mjs` | Rootless-policy OCI executor candidate and fail-closed lifecycle | `LIVE OCI EXECUTION: NOT PROVEN` without a real rootless engine/corpus |
| `verify-science-service.mjs` | Service lifecycle, approval, fencing, exact static replay, comparison | Deterministic providers only |
| `verify-science-routes.mjs` | Strict HTTP validation, public projection, isolation, rate bounds | Not distributed ingress policy |
| `verify-science-authz.mjs` | Real-session role/workspace/admission/review controls | Not target identity-provider evidence |
| `verify-science-ui.mjs` | FUI admission, reviewer, static source/replay, accessibility source invariants | Browser behavior is a separate lane |
| `verify-science-recovery.mjs` | Cold PGlite/filesystem backup, byte/hash restore, read-only rollback | Not target PostgreSQL/S3 DR |

The 34 required evidence classes are:

1. `malformed-contract-refusal`
2. `deployment-preflight`
3. `unsafe-input-refusal`
4. `database-predicates`
5. `scheduler-durability`
6. `artifact-boundary`
7. `tool-tier-selection`
8. `no-raw-data-through-tools`
9. `approval-gate`
10. `manifest-completeness`
11. `verified-code-provenance`
12. `service-lifecycle`
13. `authorization`
14. `cold-backup-restore`
15. `rollback-safety`
16. `atomic-audit`
17. `submit-attempt-fencing`
18. `workspace-storage-quota`
19. `honest-comparison`
20. `geometry-preview`
21. `workspace-admission`
22. `workspace-admission-ui`
23. `admin-action-queue`
24. `member-comparison`
25. `fui-local-release`
26. `domain-validation-head-integrity`
27. `domain-review-ui`
28. `workflow-reviewed-submission`
29. `durable-workflow-wait`
30. `workflow-workspace-isolation`
31. `jupyter-gateway-prerequisite`
32. `oci-executor-candidate`
33. `exact-static-render-replay-source`
34. `same-origin-web-delivery`

## Work-package disposition

| Work package | Disposition | Current evidence | Remaining gate |
|---|---|---|---|
| WP0 evidence/ADRs | PARTIAL | Core ADRs, risk boundaries, JEG prerequisite, OCI candidate, and explicit no-go decisions exist | Target corpus/SLOs, legal/CVE review, and named owners |
| WP1 contracts/persistence | LOCAL ACCEPTANCE MET | Strict contracts; migrations 1-16; PostgreSQL loopback 16/16; 12 atomic-audited Science tables; migration-14 workflow waits; migration-15 render replay fields; migration-16 external-upload lease fencing | Target database HA/backup/load |
| WP2 artifacts/provenance | LOCAL ACCEPTANCE MET | Immutable receipts, whole-transfer absolute/idle deadlines, cross-instance external-stream cap, quota reservations, parsed-notebook provenance, current relational manifest assessment, local filesystem and loopback MinIO/S3 | Target TLS/IAM/versioning/retention/DR and cross-instance target load/chaos |
| WP3 durable runtime | PARTIAL | Run lifecycle, fencing, reconciliation, Redis/AOF loopback, durable workflow terminal wait | Real admitted rootless notebook executor or executable JEG path |
| WP4 FUI | LOCAL ACCEPTANCE MET | Science FUI, reviewer authoring/ledger, source/build checks, and fresh browser 4/4 | Broader target-device UAT if required by release policy |
| WP5 visualization | PARTIAL | Exact-source static PNG replay and bounded client diagnostics | trame and OCCT remain NO-GO; corpus fidelity/memory absent |
| WP6 workflow/evals | LOCAL STATIC ACCEPTANCE MET | Built-in reviewed submission waits durably, selects one checksummed PNG, requires exact visible approval, opens exact static source, and reads a complete manifest; golden PASS^3 | Real scientific execution and named domain review |
| WP7 operations/release | PARTIAL | Same-origin hardened gateway, loopback PG/Redis/MinIO, read-only rollback and local recovery | Target TLS/load/HA/SLO/DR, CVE scan, retained target incident/rollback drills |

## Migration and audit reconciliation

| Version | Relevant release state |
|---:|---|
| 1-10 | Science base domain, lifecycle, audit, cleanup, lease, reservation, and actor-attribution foundations |
| 11 | Default-deny workspace admission |
| 12 | Append-only, session-attributed domain/numerical validation |
| 13 | Monotonic hash-bound validation scope heads |
| 14 | Durable `workflow_waits` claims, leases, wake and recovery; workflow infrastructure, not an audited Science-domain table |
| 15 | Render request replay identity, exact source snapshot, provider/mode, launch lease, replay expiry, and close tombstone fields |
| 16 | External-upload transfer expiry and external/internal classification, indexed for a database-authoritative per-workspace stream fence and crash-expired lease release |

The atomic-audit count remains **12 Science-domain tables** after migrations 14
through 16. Do not report 13 or 14 Science-domain tables by counting
`workflow_waits` or new columns as tables.

## Capability-specific decisions

### Released local static workflow

The local path is accepted only for one exact ready, run-linked PNG within the
configured bound. The human-visible approval includes that source. A stable
request key binds replays to the same intent. The session response and FUI
retain the same artifact-version ID, SHA-256, media type, size, and logical
name. `client` and `remote` requests are refused instead of silently falling
back.

The deterministic provider's PNG is data-derived and explicitly carries
`fixturePreview=true` and `productionCompute=false`. It proves the workflow and
source/replay boundaries, not notebook or OCI execution.

### Jupyter Enterprise Gateway

**NO-GO for execution.** The prerequisite verifies authenticated HTTPS,
version floor, exact instance fence, immutable kernelspec/image allowlist,
bounded control responses, recovery correlation, read-only orphan inventory,
exact-handle cancellation, and secret redaction. It is not registered as a
`ComputeProvider`; submit, channels, and output collection remain fail-closed.

### OCI executor

**Deterministic candidate only.** Policy, idempotency, fencing, cancellation,
state ownership, quotas, cleanup, and bounded HTTP behavior pass. The observed
host Docker security options were `seccomp` and `cgroupns` only, so the required
live rootless engine and notebook corpus were not available.

### trame and OCCT

- trame remote mode: **NO-GO**. No admitted WebSocket/session/isolation/resource
  lifecycle exists, and public remote requests are refused.
- OCCT WASM: **NO-GO**. No selected licensed/pinned build, representative STEP
  corpus, fidelity tolerance, or memory/disposal proof exists.

## MVP definition-of-done audit

| Original criterion | Result |
|---|---|
| Non-admin user can complete study-to-manifest in Puppetmaster | MET for the deterministic static fixture path; NOT MET for production scientific execution |
| RBAC, approvals, audit, workspace isolation | PROVEN in deterministic and fresh local browser lanes |
| No bulk scientific payload through MCP/mission/audit/event bus | PROVEN deterministically |
| Immutable artifacts, checksums, run links, manifest hash | PROVEN deterministically and with loopback MinIO adapter evidence |
| Duplicate/restart/timeout/cancel convergence | PROVEN for deterministic control plane and loopback Redis/AOF; real executor interruption remains open |
| Second user/workspace isolation | PROVEN for tested REST/static paths; trame path does not exist |
| FUI keyboard/reduced-motion/accessibility/fallback journey | Fresh local browser gate passed 4/4; see dedicated evidence page for scope |
| Production-isolated local/container execution | NOT PROVEN; host daemon was not rootless and no notebook corpus ran |
| JEG execution | NOT PROVEN; prerequisite only, unregistered |
| Remote rendering and OCCT fidelity | NO-GO |
| Named scientific-domain validation | NOT PROVEN |
| Target TLS/load/HA/SLO/DR and CVE gate | NOT PROVEN |

## Current release decision

The local control-plane/static workflow acceptance subset is met. That is a
useful development and review milestone, but it is narrower than the original
MVP definition.

**Original MVP definition of done: NOT MET.**

**Production release: NOT MET.**

No documentation, UI state, provider environment variable, fixture output, or
loopback pass may be used to imply production scientific execution or
scientific correctness.
