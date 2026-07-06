# WP4 — Verification gate machinery

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP4 · **Size:** M · **Needs:** WP2 + WP3

`verify` node handler (check in workbench → Evidence record → exit code gates the edge);
bounded agent↔verify retry loop with escalation-to-approval (default 8); check library
(test / todo-sync / refactor-gate / arch-ratchet / load-skip-without-SLOs — all earned,
off by default); linter rules (gated-without-verify = error; verifier-edit flagged);
evidence rendered in the approval inbox. Golden evals per plan.
