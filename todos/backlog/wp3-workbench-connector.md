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

- [x] **WP3b.1** `DockerCommandExecutor implements CommandExecutor`
      (`packages/kernel/src/workbench.ts`) — `docker exec` into the per-project container
      (same interface as `LocalCommandExecutor`; WP3a's shell checks run unchanged).
      ensure/status/destroy lifecycle with ADR-005 caps. Authored + typechecks + builds
      here; **container behavior pending a Docker-host run** (see resume point).
- [x] **WP3b.2** server wiring — `WORKBENCH_MODE=docker` constructs the executor and
      activates shell checks (default off = honest refusal). Boots both ways.
- [ ] **WP3b.3** `bench.*` tool namespace (git/exec/read/write) with tiers +
      untrusted-data envelopes + Stage 9C compaction — **do NOT start until WP3b.1 is
      host-verified** (don't build on an unverified executor)
- [ ] **WP3b.4** `bench.delegate` with hard token/time budgets, progress → mission trace;
      pinned CLI layer in the Dockerfile (ADR-002)
- [ ] **WP3b.5** Security: egress proxy allowlist (unblocks clone/install under
      `--network none`), socket-proxy launch, vault secrets
- [ ] **WP3b.6** `refactor-gate` (git `--diff-filter=M` on test paths) and `load`
      (k6/locust, skip-without-SLOs) checks
- [ ] **WP3b.7** Golden evals **(Docker host)**: clone a fixture repo → `bench.exec` runs
      its suite, exit-code propagation; injection→`bench.git.push` gated; egress refusal
      audited

---

## ▶ RESUME POINT (2026-07-06)

**The single next action is yours, on a Docker-capable host:**

```
pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-workbench.mjs
```

Build **kernel only** — the script imports just `packages/kernel/dist/workbench.js`, so it
does not need the web app. (`pnpm build` also works but drags in the apps/web build, which
needs a synced `pnpm install` for its `@fontsource` imports — unrelated to the workbench.)

Expect `WORKBENCH EXECUTOR PASS: ensure/idempotent/non-root/exit-codes/in-container
check/destroy` (exit 3 = no daemon). This is WP3b.1's acceptance — it drives the built
`DockerCommandExecutor` against a real daemon.

**Aside — the apps/web build failure (`@fontsource/rajdhani/500.css` unresolved):** not a
repo bug — the lockfile pins it and it builds clean in CI/this repo. It's a stale local
install on the host. Fix separately with `pnpm install` (syncs node_modules to the
committed lockfile, incl. the WP0 dependency-cruiser addition). Does not block the
workbench verification above.

- **If PASS:** record it in `docs/adr/spike-002-record.md` (a WP3b.1 row), then WP3b.3
  (`bench.*` tools) is cleared to start — the executor foundation is proven.
- **If FAIL:** paste the output. A failure is a real signal about the executor code or
  the ADR-005 image; fix before building `bench.*` on top.

**Why work stopped here (principled, not just usage):** WP3b.3+ build on the container
executor. Per the discipline that's governed this whole integration — verify a foundation
before building on it (exactly how the ADR-002 spike was handled) — the honest move is to
prove WP3b.1 on real Docker before writing the `bench.*` tools that depend on it. This
session has no Docker daemon, so that proof is the owner's to run.

**Largest security surface in the plan — ADR-005 posture spike-confirmed (non-root,
`--network none`, resource caps); review ADR-005 before WP3b.3+.**
