# WP3a — Shell-backed CheckRunner + local command executor

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP3 (verifiable-here slice) ·
**Completed:** 2026-07-06

The workbench-free slice of WP3 — the shell-check machinery WP4 stubbed as refusals,
verified against the host toolchain (no Docker needed). The container executor + `bench.*`
tools + `bench.delegate` are WP3b (todos/backlog/wp3-workbench-connector.md), host-verified.

- [x] `CommandExecutor` seam (`packages/kernel/src/command-runner.ts`): the boundary
      between *what* a check runs (CheckRunner) and *where* it runs (executor) — exactly
      where the container boundary lives
- [x] `LocalCommandExecutor` — runs a check's command via `sh -c` in the project's
      host workspace (`WORKBENCH_LOCAL_ROOT/<projectId>`), captures stdout/stderr/exit +
      timeout; rejects only when the workspace is unreachable (fail closed)
- [x] Generic shell check in `createBuiltinCheckRunner` (now takes an optional
      `executor`): `test`/`arch`/`custom` run `check.command`, exit 0 = pass, else gate;
      command output is the evidence (`test-output`). No command configured → fail closed.
      No executor wired → honest refusal (unchanged for the server, which has no workbench
      until WP3b)
- [x] Golden evals (pass^3): `workshop-test-check-pass-local` (real `node --test` passes →
      gate opens, evidence captured, gated action runs) and `workshop-test-check-blocks-local`
      (failing `node --test` → escalation with command output as evidence, gated action
      never runs)

**Note:** the server's runner stays executor-less (shell checks refuse) — wiring
`LocalCommandExecutor` into the server would run host commands, which is NOT the ADR-005
container model. The server gets the Docker executor in WP3b. The local executor is for
the eval harness and a future trusted-local deployment mode (would need an owner ruling).
