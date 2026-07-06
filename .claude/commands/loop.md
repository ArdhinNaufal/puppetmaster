Read todos/active/, PLAN.md (if present), learnings.md, and the spec the active todos
reference. Then work through todos/active/ in order WITHOUT stopping between tasks,
except:
- STOP at any task tagged [review] and present the branch diff.
- STOP if any check below fails twice on the same task and report what it said.

For each task: write the tests that define done FIRST, run them, confirm they fail for
the right reason, then implement until green. After each task run the full gate:
`pnpm typecheck && pnpm build && pnpm test && ./scripts/verify-arch.sh`
(plus `pnpm eval` when kernel behavior or golden tasks changed). Move finished tasks to
todos/completed/, log gotchas to learnings.md as you hit them. Commit after each task so
work is rewindable. When you reach a [review] tag or run out of tasks, stop and present
the evidence for everything done.
