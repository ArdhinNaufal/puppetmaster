# WP1 — Workshop decisions & ADRs

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP1 · **Size:** S · **Gates:** WP2–WP9

- [x] ADR-001 feature name (ruled: Workshop/project/workbench) + v1 scope boundary
- [x] ADR-002 hybrid executor (ruled) — decision recorded
- [ ] ADR-002 feasibility spike, container half — **blocked: no Docker daemon in this
      environment.** The headless-CLI half is proven (see ADR-002 §Spike); rerun
      `scripts/spike-adr002.sh` on a docker-capable host to close.
- [x] ADR-003 project state representation
- [x] ADR-004 artifact storage
- [x] ADR-005 workbench isolation + egress/credential policy
- [x] Role × mode matrix formalized (in ADR-001; v1 tracks ruled B/C only)

**Acceptance:** five accepted ADRs in docs/adr/ with alternatives + "Reconsider when";
spike pass recorded; owner sign-off.
