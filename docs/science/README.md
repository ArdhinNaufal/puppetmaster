# Science Operations

Science Operations is Puppetmaster's workspace-scoped control plane for
versioned scientific artifacts, approved asynchronous compute, bounded
visualization sessions, and explicit provenance.

## Current release posture

The implemented control-plane slice is suitable for deterministic development
and contract testing. It is not yet a production scientific-compute release.

| Capability | Current posture |
|---|---|
| Study, artifact, run, approval, manifest, and render-session metadata | Implemented |
| Persisted per-workspace pilot admission | Migration 11; absent row denies; member-visible redacted GET and admin-only reasoned PATCH; current post-v11 rerun pending |
| Filesystem artifact adapter | Implemented; deterministic coverage |
| S3-compatible adapter | Implemented; local mock coverage only |
| Deterministic TypeScript compute provider | Implemented; non-production |
| Python HTTP runtime | Deterministic non-executing contract fixture; production adapter rejects its declared execution mode |
| Jupyter Enterprise Gateway | **NO-GO** until a live authenticated lifecycle gate passes |
| Static/table/client diagnostic visualization | Implemented with bounded fallbacks |
| trame remote rendering | **NO-GO** until WebSocket, auth, isolation, quota, expiry, and cleanup gates pass |
| OCCT/STEP tessellation | **NO-GO** until a licensed Web Worker build passes corpus fidelity and memory gates |
| Regulated or sensitive data | Refused; v1 accepts `non_regulated` only |

The authoritative acceptance status is
[`evidence-matrix.md`](./evidence-matrix.md). A configured adapter is not the
same thing as an admitted adapter.

## Documentation map

- [`installation-and-configuration.md`](./installation-and-configuration.md):
  install, environment variables, first-run setup, and verification commands.
- [`provider-contracts.md`](./provider-contracts.md): artifact, compute,
  runtime HTTP, and render contracts.
- [`security-and-threat-model.md`](./security-and-threat-model.md): trust
  boundaries, threats, controls, and unresolved release gates.
- [`operator-runbook.md`](./operator-runbook.md): stuck jobs, orphan handles,
  corrupt artifacts, expired sessions, quota exhaustion, rollback, and
  disaster recovery.
- [`known-limitations.md`](./known-limitations.md): unsupported/deferred
  behavior that must not be inferred from the UI or interfaces.
- [`rollout-and-rollback.md`](./rollout-and-rollback.md): staged admission and
  preservation-first rollback.
- [`evidence-matrix.md`](./evidence-matrix.md): WP0-WP7 and MVP definition-of-
  done audit.

Architecture decisions:

- [`ADR-009`](../adr/009-science-operations-subsystem-boundary.md)
- [`ADR-010`](../adr/010-science-artifact-storage-and-provenance.md)
- [`ADR-011`](../adr/011-science-compute-provider-and-lifecycle.md)
- [`ADR-012`](../adr/012-science-render-session-authentication.md)

## Non-negotiable interpretation

- `succeeded` means provider completion, output promotion, checksum
  verification, and manifest finalization completed.
- `manifest.complete=true` means required provenance fields are present. It
  does not prove bitwise or numerical reproducibility.
- A STEP client diagnostic is not CAD tessellation or an analysis mesh.
- A provider quote with `source="declared"` is not measured capacity or cost.
- `SCIENCE_ENABLED=1` exposes the subsystem; it does not admit any workspace or
  waive an external-provider gate. A missing migration-11 admission row is
  denied; an admin must record a reasoned workspace admission before new
  resource-bearing work.
- Revocation applies at the next new-work boundary and is not a force-kill:
  reads, cancellation, render close, accepted-upload completion, exact checksum
  purge, and scheduler reconciliation remain available.
- Public `/api/health` is process liveness. Authenticated `/api/readiness` is a
  five-second cached dependency snapshot, not proof that an external executor
  passed admission.
- `SCIENCE_RUNTIME_ADMISSION=approved` and
  `SCIENCE_RENDER_ADMISSION=approved` are operator assertions. They must never
  be set for the bundled fixture or any provider that lacks the required
  retained evidence.
