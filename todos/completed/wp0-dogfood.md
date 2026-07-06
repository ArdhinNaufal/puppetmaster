# WP0 — Dogfood: adopt the workflow for developing Puppetmaster itself

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP0 · **Completed:** 2026-07-06 (this
session, branch `claude/ai-workflow-integration-plan-dmhuo9`)

- [x] `todos/{active,backlog,completed}/` + `learnings.md` seeded
- [x] `docs/adr/` + ADR-000 + retroactive ADR-006 (TypeScript monorepo) and ADR-007
      (the Bridge), both marked retroactive
- [x] `.claude/commands/{spec,plan,next,loop,review,refactor}.md` translated for this
      repo (pnpm gate: typecheck && build && test && verify-arch, eval when kernel-facing)
- [x] `scripts/verify-arch.sh` — dependency-cruiser matrix + ratchet baseline
      (`arch-baseline` = 0; repo started clean). Acceptance verified: deliberate
      kernel→apps import exits 1 with instruction; clean tree exits 0.
- [x] HANDOFF.md §0 points at the session-resume ritual
- [x] Hooks: deliberately none (earned policy — install test-gate only after the failure
      bites; see plan WP0.5)
