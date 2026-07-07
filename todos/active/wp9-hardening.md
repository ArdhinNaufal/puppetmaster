# WP9 — Evals, failure-mode hardening, docs

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP9 · **Size:** M
· **Status:** in progress — WP9.1 (mapping ledger) landed 2026-07-06

## Done

- [x] **Failure-mode mapping ledger** (`docs/WORKSHOP-FAILURE-MODES.md`): all 50 rows
      from the corpus's six failure-mode tables → 37 unique modes, each with an
      explicit disposition (4 EVAL / 1 LINTER / 6 DESIGN / 11 REVIEW / 3 EARNED /
      12 DEFERRED with named interim mitigations). Zero unmapped. Upgrading DEFERRED
      rows is now part of each future WP's acceptance.

## Remaining

- [x] Priority evals landed with WP3b.6: **refactor-gate M-vs-A** (modified test file
      blocks, added-only passes — P14) and **invented load thresholds** (load refuses
      without declared SLOs — S2). Golden tasks at pass^3.
- [ ] Remaining priority evals that need WP3/WP5 machinery: verifier-edit flag,
      wholesale-rewrite detection; interview-anchoring needs real-model sessions
- [x] **ARCHITECTURE.md §3.11** (The Workshop): documents the shipped mechanisms —
      domain model, verify gates + check library (incl. refactor-gate/load), workbench
      executor, bench.* tools, KB mirror, UI surfaces; §4 tables + §5 views updated.
- [ ] `docs/WORKSHOP.md` operator guide + PRD/NEXUS updates — once the full phase flows
      (SPECIFY→RECORD, EXECUTE) exist; §3.11 covers the architecture reference in the
      meantime
- [ ] Self-hosting smoke test (run this repo's workflow through the product) + learnings
- [ ] Suite stays at k≥2 (currently k=3) as new evals land
