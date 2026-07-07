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
      ensure/status/destroy lifecycle with ADR-005 caps. **Host-verified 2026-07-07:**
      `WORKBENCH EXECUTOR PASS` on a real Docker daemon (all 7 assertions incl. the
      in-container fail-before/pass-after check). Surfaced + fixed a real bug — the
      named volume mounted root-owned so the non-root `bench` user couldn't write
      (`docker/workbench.Dockerfile` now `chown`s `/workbench` to bench; commit e8c520f).
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

## ▶ RESUME POINT — WP3b.1 host-verified 2026-07-07 ✅ (WP3b.3 cleared to start)

**Done:** `WORKBENCH EXECUTOR PASS` on a real Docker host. The next builder starts WP3b.3
(`bench.*` tools) on a proven executor foundation. Keep the verify ritual below — re-run it
after any change to `workbench.ts` or `docker/workbench.Dockerfile`.

**The verify ritual (Docker-capable host), in order — the image must be built first:**

```
docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-workbench.mjs
```

The `docker build` is not optional: `DockerCommandExecutor` defaults to the
`puppetmaster-workbench:spike` **local** image tag (`workbench.ts` `DEFAULTS.image`). Skip
the build and `docker run` tries to *pull* it and fails with `pull access denied … may
require 'docker login'` (this bit the first host run — the earlier resume point omitted the
build step).

Build **kernel only** for the second command — the script imports just
`packages/kernel/dist/workbench.js`, so it does not need the web app. (`pnpm build` also
works but drags in the apps/web build, which needs a synced `pnpm install` for its
`@fontsource` imports — unrelated to the workbench.)

Expect `WORKBENCH EXECUTOR PASS: ensure/idempotent/non-root/exit-codes/in-container
check/destroy` (exit 3 = no daemon). This is WP3b.1's acceptance — it drives the built
`DockerCommandExecutor` against a real daemon.

**Aside — the apps/web build failure (`@fontsource/rajdhani/500.css` unresolved):** not a
repo bug — the lockfile pins it and it builds clean in CI/this repo. It's a stale local
install on the host. Fix separately with `pnpm install` (syncs node_modules to the
committed lockfile, incl. the WP0 dependency-cruiser addition). Does not block the
workbench verification above.

**Verified (2026-07-07):** the host run PASSed and, as designed, the acceptance caught a
real bug on the first attempt (root-owned named volume → non-root write denied), fixed in
commit e8c520f before WP3b.3 proceeds. This is the discipline working: verify the
foundation on real Docker, fix what the proof surfaces, *then* build `bench.*` on top —
exactly how the ADR-002 spike was handled. WP3b.3 is now cleared to start.

**Largest security surface in the plan — ADR-005 posture spike-confirmed (non-root,
`--network none`, resource caps); review ADR-005 before WP3b.3+.**
