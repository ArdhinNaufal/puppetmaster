# WP3b — Workbench connector (containerized)

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP3 · **Size:** L · **Needs:** a
Docker-capable host for its golden evals (ADR-002 spike PASSED 2026-07-06, so the
substrate is validated). **The check-logic slice shipped as WP3a**
(todos/completed/wp3a-shell-checkrunner.md) — this is the container remainder.

Per-project containerized workbench (ADR-005): lifecycle (create clones `repoRef` into a
named volume, suspend/resume, destroy = destructive tier); `bench.git.*`, `bench.exec`
(allowlisted), `bench.read/write` (tiered, untrusted-data envelopes, Stage 9C compaction
on bulky output); `bench.delegate(task, budget)` per ADR-002 (headless CLI inside the
container — the pinned layer commented in `docker/workbench.Dockerfile`); egress allowlist
default-closed via proxy sidecar, resource caps, vault-only secrets, launched via a scoped
Docker socket proxy.

- [ ] `DockerCommandExecutor implements CommandExecutor` — `docker exec` into the
      project's workbench container (same interface as `LocalCommandExecutor`; WP3a's
      shell checks run unchanged through it). Wire it into the server's CheckRunner
      (replaces the executor-less refusal)
- [ ] Workbench lifecycle tools + volume/clone; `bench.*` tool namespace with tiers
- [ ] `bench.delegate` with hard token/time budgets, progress → mission trace
- [ ] Security: egress proxy allowlist, resource caps, socket-proxy launch, vault secrets
- [ ] `refactor-gate` (git `--diff-filter=M` on test paths) and `load` (k6/locust,
      skip-without-SLOs) checks — need git-diff / a running system
- [ ] Golden evals **(run on a Docker host)**: clone a fixture repo → `bench.exec` runs
      its suite, exit-code propagation; injection→`bench.git.push` gated; egress refusal
      audited

**Largest security surface in the plan — the ADR-005 posture is spike-confirmed
(non-root, `--network none`, resource caps); review ADR-005 before starting.**
