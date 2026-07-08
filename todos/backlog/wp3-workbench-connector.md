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
- [x] **WP3b.3** `bench.*` tool namespace (`packages/kernel/src/bench-tools.ts`):
      `bench.read` (read_auto), `bench.exec`/`bench.write`/`bench.git.commit`
      (write_approved), `bench.git.status`/`bench.git.diff` (read_auto),
      `bench.git.push` (destructive_confirmed — the injection→push gate). Thin,
      tiered surface on the existing `CommandExecutor.run()` seam (no new boundary);
      workspace-scoped like `project.*`; path guard confines read/write to the
      workbench. Untrusted-data envelope + Stage 9C compaction are inherited from
      agent-runtime (every non-runtime tool result is wrapped + compacted) — nothing
      bench-specific needed. No executor wired ⇒ honest refusal by name. Wired in
      `main.ts` behind the same `WORKBENCH_MODE` executor. 4 golden tasks (write/read
      round-trip, exec+git.status, write-gated, push-gated) → suite 14→18 at pass^3.
      **exec allowlist deferred** (approval tier is the gate) — see below.
- [ ] **WP3b.4** `bench.delegate` — headless coding CLI inside the workbench (ADR-002).
      **Cleared to start 2026-07-07** — WP3b.5's egress path + secret injection are
      host-verified, so delegate has the model-API route + API-key delivery it needs.
      **This is the recommended next task; not yet authored.** Two things are the
      operator's call before/while building, flagged here so a fresh session doesn't
      have to re-derive them:

      1. **Pinned CLI version** (ADR-002: "pinned in the image, upgraded deliberately").
         The commented layer in `docker/workbench.Dockerfile` is
         `RUN npm install -g @anthropic-ai/claude-code@<PINNED_VERSION>`. The ADR-002
         spike ran `2.1.202` successfully (see `docs/adr/spike-002-record.md` row 1) —
         that is the suggested default if no other version is specified, wired as a
         Docker build ARG (`CLAUDE_CODE_VERSION`, default `2.1.202`) so it's overridable
         without editing the Dockerfile.
      2. **Verifying it costs real money and needs a live key.** Every prior WP3b
         increment (.1, .3, .5, .6) was verified for free — local execs, git plumbing, a
         proxy allowlist. `bench.delegate` runs the actual CLI making real model calls,
         so its host acceptance needs `ANTHROPIC_API_KEY` injected via the now-verified
         `secrets` path and will spend tokens on the operator's account. No amount of
         authoring in a keyless/Docker-less session can verify this one — budget for it.

      **Suggested scope** (mirrors the WP3b.1/.5 author-here/verify-on-host split):
      - `docker/workbench.Dockerfile`: uncomment the CLI layer, gated on
        `ARG CLAUDE_CODE_VERSION=2.1.202`.
      - `bench.delegate(projectId, task, { maxTurns?, timeoutMs? })` in
        `packages/kernel/src/bench-tools.ts`, tier `write_approved` (an agent calling it
        pauses for approval, same as `bench.exec`/`bench.write`): runs
        `claude -p <task> --output-format stream-json --verbose --max-turns <N>
        --permission-mode acceptEdits` in the workbench via the existing
        `CommandExecutor.run()` (wall-clock via `timeoutMs`, already supported); parses
        the stream-json result into `{ ok, numTurns, usage, result }`. Hard budgets =
        turn cap (`--max-turns`) + wall-clock (`timeoutMs`) — the CLI's enforceable knobs
        via a buffered exec; true *mid-run* token caps and live progress→mission-trace
        streaming need a streaming exec API `CommandExecutor.run()` doesn't have today —
        note as follow-up rather than silently downgrading them.
      - Push/git-write stays outside the CLI's own `--allowedTools` — it goes through
        `bench.git.push` (already destructive-tier) per the ADR-002 notes in
        `docs/adr/spike-002-record.md`.
      - `scripts/verify-delegate.mjs` (Docker host, needs `ANTHROPIC_API_KEY`): a trivial
        delegate task (e.g. "add a comment to add.mjs") completes within budget, exit 0,
        the CLI's real stream-json events parse cleanly, and `numTurns`/`usage` land in
        the parsed result.
      - The stream-json **parsing logic** (not the live CLI call) is unit-testable
        without Docker or a key — a canned stream-json transcript fed through the parser
        is a reasonable thing to author + verify in a keyless session before the host run.
- [~] **WP3b.5** Security. **Egress proxy allowlist + secret injection host-verified
      2026-07-07** (`EGRESS PROXY PASS`, all 6 checks on a real Docker host — the run
      also caught a network-ordering bug + a DNS-sinkhole test artifact, both fixed):
      `docker/egress-proxy.mjs` (dependency-free allowlist
      proxy: HTTPS via CONNECT, plain HTTP forward) + `docker/egress-proxy.Dockerfile`;
      `DockerCommandExecutor` gains an egress path (`egressAllow` non-empty ⇒ workbench
      joins an `--internal` network with the proxy sidecar, routed via HTTP(S)_PROXY;
      the proxy is also on `bridge` for its own outbound, so the workbench's only route
      out is the allowlist) and `secrets` (vault-resolved env injected at spawn, ADR-005).
      The no-egress path (`--network none`) is byte-identical to the WP3b.1-verified
      behaviour. Proxy allow/deny/tunnel logic unit-verified locally; the container
      orchestration needs a Docker host — see `scripts/verify-egress.mjs` (RESUME POINT).
      **Remaining under .5:** socket-proxy launch (scoped Docker socket — a deployment/
      DOCKER_HOST concern, not executor code) and the server-side vault wiring (resolve
      `{{credential:NAME}}` → `executor.secrets`; needs a per-project/workspace secret
      declaration). **Also still here:** the deferred `bench.exec` command allowlist.
- [x] **WP3b.6** `refactor-gate` + `load` checks (`packages/kernel/src/verify.ts`):
      refactor-gate runs `git diff --diff-filter=M --name-only HEAD` and blocks when a
      *modified* (not added) file matches the test-path patterns (default set,
      overridable via the check's `command` as a JSON regex array) — closes P14.
      `load` config is `{slos:[…],run:"…"}`: no declared SLOs ⇒ refuse (throw,
      fail-closed) — closes S2; with SLOs it runs the declared command in the
      workbench and gates on exit 0. Both refuse by name without an executor.
      4 golden tasks (refactor-gate blocks-edit / passes-added-test; load
      refuses-without-SLOs / passes-with-SLOs) → suite 18→22 at pass^3.
- [ ] **WP3b.7** Golden evals **(Docker host)**: clone a fixture repo → `bench.exec` runs
      its suite, exit-code propagation; injection→`bench.git.push` gated; egress refusal
      audited

---

## ▶ RESUME POINT — WP3b.5 host-verified 2026-07-07 ✅ (WP3b.4 is next, not yet authored)

**Done:** `EGRESS PROXY PASS` on a real Docker host (secret-inject / proxy-env /
allowlisted-ok / denied-refused / direct-blocked / destroy). The egress path + vault
secret injection are proven; WP3b.4 (`bench.delegate`) can build on them.

**The recommended next task is WP3b.4** (`bench.delegate`) — full suggested scope, the
CLI-pin-version decision, and the cost/live-key caveat are written out under its checklist
item above. Unlike every prior increment in this file, its host acceptance needs a live
`ANTHROPIC_API_KEY` and will spend real tokens — budget for that before starting.

**The egress verify ritual (Docker-capable host) — build both images first:**

```
docker build -t puppetmaster-workbench:spike    -f docker/workbench.Dockerfile .
docker build -t puppetmaster-egress-proxy:spike -f docker/egress-proxy.Dockerfile docker
pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-egress.mjs
```

Exit 3 = no daemon. The egress-proxy build context is `docker/` (the script is COPYed
from there). Needs outbound internet on the host. The allowlisted probe host must be one
the network resolves *truthfully* — the default is `one.one.one.one`; override with
`EGRESS_ALLOW_HOST=<host>` if the network filters it (example.com is sinkholed on some
networks — that's why it's not the default). Re-run after any change to `workbench.ts`,
`docker/egress-proxy.*`, or `docker/workbench.Dockerfile`.

The no-egress path stayed byte-identical to WP3b.1, so `node scripts/verify-workbench.mjs`
should still pass; re-run it too if you touched `workbench.ts`/`workbench.Dockerfile`.

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
