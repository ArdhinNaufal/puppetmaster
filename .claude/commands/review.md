Fresh context — do not reuse conclusions from any implementation conversation. Review
the diff on this branch against its merge base as a skeptical senior engineer.

Attack specifically: $ARGUMENTS

Plus this repo's standing failure classes:
- security tiers bypassed (a write/destructive tool reachable without approval gating)
- untrusted-data envelope gaps (tool/webhook content entering context unwrapped)
- dependency-direction violations or edits to .dependency-cruiser.cjs / arch-baseline
  (a verifier edit inside a feature diff is a finding, regardless of intent)
- workspace scoping misses (queries not filtered by workspaceId)
- test expectations modified (not added) in refactor-tagged commits
- audit-log gaps for new side-effectful calls

Run `pnpm typecheck && pnpm build && pnpm test && ./scripts/verify-arch.sh` and include
the output as evidence, not assertion. List findings by severity with a proposed fix each.
