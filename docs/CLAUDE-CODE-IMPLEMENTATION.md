# Claude Code control plane — implementation and evidence record

This is the implementation record for the prospective scope in
[`CLAUDE-CODE-PLAN.md`](CLAUDE-CODE-PLAN.md). The two documents are deliberately separate: the plan
captures decisions made before implementation; this file records what exists and what has actually
been verified.

## 1. Implemented stages

| Stage | Implemented surface | Primary files |
|---|---|---|
| A — contracts, catalog, persistence | Immutable provider/backend/model and execution-generation snapshots, session/run/event storage, exact-attempt project claims, guarded terminal transitions, `workbench_copybacks` recovery ledger, current Claude catalog and provenance metadata | `packages/shared/src/claude-code.ts`, `packages/db/src/claude-repo.ts`, `packages/db/src/workbench-copyback-repo.ts`, `packages/db/src/schema.ts`, `apps/server/src/claude-code-catalog.ts` |
| B — isolated streaming runtime | Claude stream-json and Aider plain-output parsing, owner-level exact-attempt cancellation, disposable provider containers, names-only secret transport, read-only Plan isolation, scratch execution for both providers, holder-before-volume cleanup convergence, signed v3 commit-wins copy-back, tamper quarantine, per-project shared/exclusive locks | `packages/kernel/src/claude-stream.ts`, `packages/kernel/src/claude-runtime.ts`, `packages/kernel/src/coding-cli.ts`, `packages/kernel/src/workbench.ts`, `docker/workbench-sync.mjs` |
| C — API, approvals, readiness, audit, lifecycle | Builder-gated session APIs, immutable continuation provider, queue-failure terminalization, outer Execute approval, provider-scoped readiness, root `.env` bootstrap, provider-labelled audit evidence, pre-runner ledger and orphan-claim reconciliation, queue shutdown, provider termination proof, runtime drain | `apps/server/src/claude-code-routes.ts`, `apps/server/src/bootstrap.ts`, `apps/server/src/main.ts`, `apps/server/src/audit.ts`, `packages/kernel/src/queue.ts` |
| D — CLAUDE UI | Additive provider/session composer, provider-specific model and readiness controls, Plan/Execute controls, transcript/tool/task/raw-event/usage/diff surfaces, paged event recovery, polling fallback, narrow CLAUDE-stage layout | `apps/web/src/claude/ClaudeCodeView.tsx`, `apps/web/src/claude/claude-code.css`, `apps/web/src/fui.css`, `apps/web/src/api.ts`, `apps/web/src/App.tsx` |
| E — verification and operator docs | Fresh-build deterministic aggregate covering compatibility, secret transport, cancellation races, signed copy-back recovery, tamper quarantine and runner lifecycle; separate no-cost Docker aggregate; paid live opt-in; source-fingerprinted image preflight; installation/runtime boundary documentation | `package.json`, `scripts/verify-*.mjs`, `scripts/docker-image-preflight.mjs`, `docs/INSTALL.md`, `docs/ARCHITECTURE.md` |

## 2. OpenAI extension and compatibility

Anthropic/Claude remains the default when `provider` is omitted. OpenAI sessions persist
`openai` / `aider`, normalize models to `openai/<model>`, reject provider switching on continuation,
and never inherit Claude configuration. Anthropic Plan mounts the durable project read-only;
OpenAI Plan uses and discards a sanitized scratch copy. Approved Execute runs for **both** providers
use isolated scratch volumes and the same HMAC-authenticated copy-back protocol.

Every writable attempt has an immutable run ID plus generation. Before apply, the runtime persists
an intent and pending terminal result; the signed helper then records durable `prepared`, `swapping`,
and `committed` phases. A committed file receipt and the run/session/mission terminal result move to
`db_committed` in one database transaction, after which acknowledgement cleans the scratch and
trusted state volumes. Startup recovery rolls back only pre-commit attempts, treats a durable
committed marker as success even if cancellation arrived later, resumes post-DB cleanup, and
quarantines malformed or tampered evidence. New project mutations remain blocked while recovery is
unresolved. A `running` Plan/provider attempt that crashed before creating any ledger is also
enumerated before runner startup: the exact generation holder is terminated (including the legacy
generation-zero fallback), disposable artifacts are cleaned, and the run/mission is failed or
cancelled with a generation-guarded transition instead of remaining wedged on queue redelivery.

An isolated provider holder owns its `AbortSignal` directly rather than relying solely on the local
`docker exec` client's lifetime. Normal cleanup converges exact labelled holders before attempting
scratch/state-volume removal, and bounded retries accept only Docker's transient mount-detach
responses while still proving final absence. Ambiguous copy-back evidence is not discarded by this
path.

Provider values are supplied only in the Docker CLI child environment and referenced by
`docker exec -e NAME`; values and provider commands are absent from persistent holder
`Config.Env`/`Config.Cmd`. The recovery HMAC key lives in a separate trusted state volume that is
never mounted into a provider container.

The server package's `dev` and `start` entry points load the repository-root `.env`; direct
`dist/main.js` test invocations intentionally bypass that convenience. The current Compose API
container is not a workbench host, so CLAUDE execution uses the host-run server documented in
[`INSTALL.md`](INSTALL.md).

## 3. Verification status

Status below is evidence, not intent.

| Check | Status | Evidence / limitation |
|---|---|---|
| Deterministic build + persistence/routes/stream/parser/runtime/cancellation/server/provider-readiness/env-bootstrap/secret-transport/copy-back-recovery/runner-lifecycle suite (`pnpm test`) | **PASS — 2026-07-17** | Fresh build completed first; architecture, both-provider dispatch, cancellation races, commit-wins/rollback/DB-ack recovery, pre-intent generation/legacy-orphan recovery, quarantine, secret transport, and runner lifecycle all passed. |
| Repository-wide TypeScript typecheck | **PASS — 2026-07-17** | `pnpm -r typecheck` passed after the final runtime, UI, and lifecycle edits. |
| Final Docker boundary aggregate (`pnpm verify:docker`) | **PASS — 2026-07-17** | Fresh build passed the real workbench lifecycle/resource/network/secret/lock/copy-back checks, concurrent abort holder-and-volume teardown, egress proxy boundary, hostile OpenAI Plan isolation, and dummy-key Anthropic control-plane terminalization. No provider token was consumed. |
| Paid OpenAI live Plan (`pnpm verify:openai-live`) | **NOT RUN** | Explicitly opt-in because it consumes provider tokens. |
| Paid Anthropic live success | **NOT RUN** | The control-plane verifier can prove terminalization with a dummy key; that is not provider-success evidence. |
| Local CLAUDE browser control smoke | **PASS — 2026-07-17** | With an ephemeral PGlite server and Docker disabled, the rendered UI preserved Anthropic as default, switched additively to OpenAI/Aider and `openai/gpt-5.6`, changed Plan to gated Execute controls, disclosed runtime unavailability, and produced no console warnings/errors. No provider request was sent. |
| Full interactive browser UAT | **PENDING** | The local smoke does not prove live streaming, approval/rejection, cancellation, reconnect recovery, event pagination, all detail tabs, keyboard-only use, or reduced motion. A post-fix 390x844 measurement was attempted, but the isolated browser worker exposed no browser backend, so narrow-layout overflow remains unverified rather than inferred from the passing build. |

## 4. Remaining acceptance commands

The no-cost Docker aggregate passed on 2026-07-17. Re-run it after Docker/workbench changes; it
uses offline/dummy provider paths and does not consume provider tokens:

```powershell
pnpm verify:docker
```

When OpenAI token consumption is authorized and a valid key is present in `.env` or the shell:

```powershell
pnpm verify:openai-live
```

Manual browser UAT must cover both providers, Plan and Execute, approval/rejection, active
cancellation, reload/reconnect, older-event pagination, every session detail tab, keyboard-only
operation, a narrow viewport, and reduced-motion mode. Until those pending rows pass, the code is
implemented but deployment acceptance is not complete.

## 5. Deployment boundary

The recovery protocol is proven for one active Puppetmaster server controlling one Docker daemon.
Database claims prevent duplicate active turns, and the named `flock` volume serializes reads and
mutations on that daemon, but startup reconciliation has no distributed recovery lease/fencing and
filesystem locks do not span Docker hosts. Active-active CLAUDE execution across multiple servers
or workbench hosts is therefore unsupported and unproven in this version.
