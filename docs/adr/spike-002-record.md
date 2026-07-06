# ADR-002 spike record

Protocol: `scripts/spike-adr002.sh` (generates a fresh toy repo per run; nothing committed).

| Date | Half | Environment | Result | Evidence |
|---|---|---|---|---|
| 2026-07-06 | Headless-CLI contract (host) | Claude Code remote dev container, claude CLI 2.1.202, node 22 | **PASS** | `cli_exit=0`, 17 incremental stream-json events (progress-streaming claim), `num_turns=6` within `--max-turns 6` (budget enforcement), `is_error=false` (clean exit), toy test green after run, diff confined to the named file (scope) |
| 2026-07-06 | Container half (`--container`) | same | **NOT RUN — no Docker daemon** (script exits 3/SKIP) | Rerun on a docker-capable host with the candidate workbench image, `--network none` + egress proxy, resource caps. WP3 precondition; tracked in `todos/active/wp1-workshop-adrs.md` |

Notes for WP3: `--output-format stream-json --verbose` is the trace-feed contract;
`--max-turns` is the turn budget — the workbench must add wall-clock and token caps on
top (the CLI reports `usage`/cost in the terminal result event, usable for the ledger).
`--permission-mode acceptEdits` + an explicit `--allowedTools` list is the in-container
permission posture; push/git-write stays outside the CLI's allowed tools and goes through
`bench.git` gating instead.
