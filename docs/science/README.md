# Science Operations

Science Operations is Puppetmaster's workspace-scoped control plane for
versioned scientific artifacts, approved asynchronous compute, exact-source
static result review, and explicit provenance.

## Current release posture

The local control-plane and deterministic static-workflow acceptance slice is
implemented and verified. The original MVP also requires production-isolated
scientific execution, admitted Jupyter Enterprise Gateway execution, remote
visualization, CAD tessellation, target operations evidence, and named
scientific review. Those gates are not complete.

**Original MVP definition of done: NOT MET. Production release: NOT MET.**

| Capability | Current posture |
|---|---|
| Study, immutable artifact, run, approval, manifest, and comparison control plane | Implemented and covered by deterministic verification |
| Persisted workspace admission | Default-deny migration-11 policy with member-readable status and reasoned admin/owner controls |
| Append-only scientific review | Migrations 12-13 provide immutable reviews plus monotonic, hash-bound scope heads; the reviewer FUI is implemented for admin/owner authoring and member reading |
| Durable workflow continuation | Migration 14 adds `workflow_waits`; terminal Science state wakes the exact waiting mission with claim, lease, heartbeat, restart, cancellation, and split-brain protections |
| Exact static result workflow | Implemented: a human reviews one bounded, checksummed, run-linked PNG; the workflow opens that exact source with a stable replay key and reads the complete manifest |
| Static fixture output | Data-derived PNG with `fixturePreview=true` and `productionCompute=false`; useful for local acceptance, not evidence of notebook execution |
| Render replay and source binding | Migration 15 stores scoped replay identity, provider/mode, exact source snapshot, launch lease, replay expiry, and close tombstone fields |
| Filesystem and S3-compatible artifacts | Filesystem deterministic coverage plus a successful dedicated loopback MinIO/S3 adapter lane; target TLS/IAM/versioning/DR remain unproved |
| External upload safety | Whole-store absolute/idle deadlines and migration-16 database-authoritative per-workspace stream fencing pass deterministic tests; target proxy/body/load chaos remains unproved |
| Same-origin browser delivery | Deterministic deployment checks plus a real hardened non-root/read-only nginx container and installed-Chrome same-origin HTTP/WebSocket proof |
| Browser release journey | Fresh installed-browser suite passed 4/4; see the dedicated evidence page for exact retained artifacts and scope |
| Jupyter Enterprise Gateway | Prerequisite parser/probe/recovery/cancellation checks pass, but it is unregistered; submit/channels/output collection and live execution are **NOT PROVEN** |
| OCI executor | Deterministic candidate checks pass; live rootless execution and a notebook corpus are **NOT PROVEN**. The observed host Docker daemon advertised `seccomp` and `cgroupns`, not rootless mode |
| trame remote rendering | **NO-GO**: public `remote` requests are refused |
| OCCT/STEP tessellation | **NO-GO**: no admitted licensed build or corpus fidelity/memory result |
| Regulated or sensitive data | Refused; this slice accepts `non_regulated` only |

The current deterministic aggregate result is:

```text
SCIENCE GOLDEN PASS^3: 18 isolated deterministic suites; 34 evidence classes verified on every pass
```

Fresh monorepo build and typecheck also pass. The database migration ledger is
1-16. Twelve Science-domain tables have atomic audit triggers; migration 14's
`workflow_waits` is workflow infrastructure rather than a thirteenth Science
domain table, migration 15 extends render replay/source state, and migration 16
adds the database-authoritative external-upload stream fence without adding a
table.

Separate loopback integration evidence currently includes:

- PostgreSQL with a 16/16 ledger and a fresh lifecycle result of
  `science lifecycle (pg): ok`;
- Redis/BullMQ with AOF, scoped live verification, and a sentinel surviving
  `WAITAOF` plus a Redis process restart; and
- a dedicated unversioned MinIO bucket passing the live S3 adapter lane.

These results do not prove target TLS/load/HA/SLO/DR, a CVE scan, a real
rootless executor or notebook corpus, executable JEG integration, trame/OCCT,
or scientific validity. No named domain expert has accepted a workload and
tolerance protocol.

## Documentation map

- [`user-guide.md`](./user-guide.md): plain-language static workflow,
  troubleshooting, review instructions, and beginner REST examples.
- [`installation-and-configuration.md`](./installation-and-configuration.md):
  installation, migration ledger, configuration, and verification lanes.
- [`provider-contracts.md`](./provider-contracts.md): artifact, compute, JEG
  prerequisite, OCI candidate, and render contracts.
- [`security-and-threat-model.md`](./security-and-threat-model.md): trust
  boundaries, controls, and unresolved release gates.
- [`operator-runbook.md`](./operator-runbook.md): run/wait/session recovery,
  storage incidents, rollback, and disaster recovery.
- [`known-limitations.md`](./known-limitations.md): unsupported and deferred
  behavior that must not be inferred from local checks.
- [`rollout-and-rollback.md`](./rollout-and-rollback.md): gated admission and
  preservation-first rollback.
- [`evidence-matrix.md`](./evidence-matrix.md): current deterministic, browser,
  loopback integration, and external evidence disposition.
- [`browser-release-evidence.md`](./browser-release-evidence.md): exact
  installed-browser journey and retained artifacts.

Architecture decisions:

- [`ADR-009`](../adr/009-science-operations-subsystem-boundary.md)
- [`ADR-010`](../adr/010-science-artifact-storage-and-provenance.md)
- [`ADR-011`](../adr/011-science-compute-provider-and-lifecycle.md)
- [`ADR-012`](../adr/012-science-render-session-authentication.md)

## Non-negotiable interpretation

- `succeeded` means provider completion, output promotion, checksum
  verification, and manifest finalization completed.
- The manifest endpoint's top-level `complete`/`gaps` is the current structural
  and relational verdict. The nested manifest and its hash remain immutable
  historical bytes. Completeness requires a linked immutable `ready` input
  parsed as `ipynb` under a `code`, `notebook`, or `solver` role; a raw
  `parameters.sourceRevision` is not proof. No completeness verdict proves
  scientific correctness or numerical reproducibility.
- A validation `pass` is credible only for its exact named metric, tolerance,
  protocol, source/baseline bindings, reviewer, and limitations.
- The deterministic provider's PNG is a fixture preview, not the output of a
  notebook or OCI workload.
- A STEP client diagnostic is not CAD tessellation or an analysis mesh.
- `SCIENCE_ENABLED=1` exposes the subsystem; it does not admit a workspace or
  an external provider.
- Workspace revocation blocks new work but preserves reads, cancellation,
  render close, accepted-upload completion, exact purge, and reconciliation.
- Public `/api/health` is process liveness. Authenticated `/api/readiness` is a
  bounded dependency snapshot, not provider admission.
- `SCIENCE_RUNTIME_ADMISSION=approved` and
  `SCIENCE_RENDER_ADMISSION=approved` are operator assertions, never proof by
  themselves.
