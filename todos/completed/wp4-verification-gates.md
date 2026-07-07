# WP4 — Verification gate machinery

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP4 · **Size:** M ·
**Completed:** 2026-07-06 (workbench-independent core; shell-backed checks ride WP3 —
see the note appended to todos/backlog/wp3-workbench-connector.md)

- [x] `verify` node handler in the DAG executor: runs a `VerifyCheck` via the
      injected `CheckRunner`, persists `Evidence` on the step, exit gates the edge
- [x] Bounded fix loop: check failure → fix agent invoked via the bridge as a
      nested child mission with the check's failure instruction; N check attempts,
      N−1 fix invocations; `retriesBeforeEscalate` default 8 (the corpus's
      8-block override as policy)
- [x] Escalation: exhausted gate raises a `write_approved` approval with the full
      run history as evidence; approve = override (recorded honestly as
      `passed: false, overridden: true` + `verify.override` audit); reject = mission fails
- [x] Fail-closed semantics: missing check / disabled check / no runner / unsupported
      check all fail the mission loudly — absence never passes
- [x] First working check: `todo-sync` (DB-native — newest spec version vs. latest
      todo touch; `project_artifacts.updated_at` added for the comparison)
- [x] Shell-backed checks (test / arch / refactor-gate / load / custom) refused by
      the builtin runner with an explicit WP3 pointer — **remaining, rides WP3**
- [x] Linter: `verify-invalid-config`; gated-mode rules (`gated-without-verify`,
      `gated-agent-without-verify`) behind a `projectMode` option (WP5 wires it)
- [x] Verify-check REST (`/api/projects/:id/checks`, mutations admin per ADR-001
      role matrix, audited) — checks are created disabled (earned policies)
- [x] Evidence in the approvals API + AUTHORIZATIONS panel render (check runs as
      a PASS/FAIL list under the prompt)
- [x] Golden evals (pass^3, all green): gate-pass with step evidence;
      gate-escalates with approval evidence and the gated action never running;
      fix-loop-bounded (2 attempts → 1 nested fix mission → escalation);
      disabled-check fails closed
