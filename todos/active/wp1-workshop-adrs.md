# WP1 — Workshop decisions & ADRs

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP1 · **Size:** S · **Gates:** WP2–WP9

- [x] ADR-001 feature name (ruled: Workshop/project/workbench) + v1 scope boundary
- [x] ADR-002 hybrid executor (ruled) — decision recorded
- [ ] ADR-002 feasibility spike, container half — **run 1: 4/5, harness fixed, re-run
      pending.** Owner's Docker host passed the three isolation assertions (non-root,
      `--network none` egress block, resource caps) + toolchain; assertion 3 failed on a
      harness artifact (host bind mount read by the non-root user under VirtioFS — not an
      ADR-005 finding). Assertion 3 rewritten to create files inside the container as
      `bench` (the WP3 delivery path). **To close: re-run `./scripts/spike-adr002.sh
      --container`; expect `CONTAINER HALF PASS`, then record it.** WP3 stays gated on that.
- [x] ADR-003 project state representation
- [x] ADR-004 artifact storage
- [x] ADR-005 workbench isolation + egress/credential policy
- [x] Role × mode matrix formalized (in ADR-001; v1 tracks ruled B/C only)

**Acceptance:** five accepted ADRs in docs/adr/ with alternatives + "Reconsider when";
spike pass recorded; owner sign-off.
