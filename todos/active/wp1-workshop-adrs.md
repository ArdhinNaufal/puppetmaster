# WP1 — Workshop decisions & ADRs

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP1 · **Size:** S · **Gates:** WP2–WP9

- [x] ADR-001 feature name (ruled: Workshop/project/workbench) + v1 scope boundary
- [x] ADR-002 hybrid executor (ruled) — decision recorded
- [ ] ADR-002 feasibility spike, container half — **script now real, awaiting a run.**
      The `--container` branch (`scripts/spike-adr002.sh` + `docker/workbench.Dockerfile`)
      validates toolchain / non-root / in-container check exec / `--network none` egress
      block / resource caps. This session has a Docker *client* but no daemon, so it was
      authored not run. **To close: `./scripts/spike-adr002.sh --container` on a
      Docker-capable host, then record PASS in docs/adr/spike-002-record.md.** WP3 stays
      gated on that PASS.
- [x] ADR-003 project state representation
- [x] ADR-004 artifact storage
- [x] ADR-005 workbench isolation + egress/credential policy
- [x] Role × mode matrix formalized (in ADR-001; v1 tracks ruled B/C only)

**Acceptance:** five accepted ADRs in docs/adr/ with alternatives + "Reconsider when";
spike pass recorded; owner sign-off.
