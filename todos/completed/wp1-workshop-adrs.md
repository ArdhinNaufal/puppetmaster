# WP1 — Workshop decisions & ADRs

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP1 · **Size:** S · **Completed:** 2026-07-06

- [x] ADR-001 feature name (ruled: Workshop/project/workbench) + v1 scope boundary
- [x] ADR-002 hybrid executor (ruled) — decision recorded
- [x] ADR-002 feasibility spike — **both halves PASS.** Host half (headless-CLI contract:
      stream, budget, clean exit, scope) passed 2026-07-06. Container half passed 5/5 on
      the owner's Docker host after an assertion-3 harness fix (host bind mount →
      in-container file creation as `bench`): toolchain / non-root / in-container check
      exec / `--network none` egress block / resource caps. Evidence in
      `docs/adr/spike-002-record.md`. **WP3 unblocked.**
- [x] ADR-003 project state representation
- [x] ADR-004 artifact storage
- [x] ADR-005 workbench isolation + egress/credential policy — isolation posture confirmed
      by the container spike
- [x] Role × mode matrix formalized (in ADR-001; v1 tracks ruled B/C only)

**Acceptance met:** eight ADRs in docs/adr/ (000, 001–005, 006–007 retroactive) with
alternatives + "Reconsider when"; spike pass recorded; owner ran and confirmed the spike.
