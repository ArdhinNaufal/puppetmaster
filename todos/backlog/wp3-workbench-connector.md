# WP3 — Workbench connector

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP3 · **Size:** L · **Needs:** WP1 (ADR-005) · parallel with WP2

Per-project containerized workbench MCP server: lifecycle (create/suspend/destroy,
destructive tier on destroy); `bench.git.*`, `bench.exec` (allowlisted), `bench.read/write`
(tiered, untrusted-data envelopes, Stage 9C compaction on bulky output);
`bench.delegate(task, budget)` per ADR-002; egress allowlist default-closed, resource caps,
vault-only secrets. Golden evals: exit-code propagation; injection→push gated; egress
refusal audited. **Largest security surface in the plan — review ADR-005 before starting.**

**Added from WP4 (2026-07-06):** the workbench must also ship the shell-backed
`CheckRunner` (test / arch / refactor-gate / load / custom) replacing the kernel's
builtin runner refusals — the verify-node machinery, evidence, bounded fix loop, and
escalation are already live (WP4) and only need the runner swapped in.
