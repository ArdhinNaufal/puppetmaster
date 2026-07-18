# Claude Code control plane — planning record

Status: implementation approved by the user request and started after the repository/source audit.

Implementation state and test evidence are recorded separately in
[`CLAUDE-CODE-IMPLEMENTATION.md`](CLAUDE-CODE-IMPLEMENTATION.md). Keeping that record separate
preserves this document as the prospective scope/decision artifact.

This document deliberately separates the planning evidence from the implementation work. It is
the scope contract for the Claude Code version of Puppetmaster.

## 1. Outcome

Add Claude Code as a first-class, durable execution surface inside Puppetmaster while retaining
the existing workflow engine, native agent runtime, Workshop lifecycle, approvals, audit trail,
MCP catalog, model router, and FUI shell.

The result is not a byte-for-byte clone of Anthropic's proprietary product. It is a local-first
Claude Code control plane that can plan and execute in isolated project workbenches, stream and
persist Claude Code events, resume sessions, expose current Claude model metadata, and make the
source/provenance boundary visible in the UI.

## 2. Evidence and constraints

### Existing, proven project capabilities

- Missions, steps, approvals, cancellation, retry, audit, WebSocket events, and role-based access
  are implemented and should be reused.
- Docker workbenches provide the intended non-root isolation boundary and a named project volume.
- `bench.delegate` already proves a narrow Claude Code CLI adapter seam and parses terminal result
  events, but it buffers the whole process and treats the session as one opaque tool call.
- The React shell already supplies role-aware views, live signals, mission tracking, command
  palette actions, responsive FUI styling, and reduced-motion behavior.

### Gaps that block a real Claude Code UI

- No durable Claude session, turn, or event model.
- No incremental process transport; `CommandExecutor.run()` returns only after exit.
- No session resume, model/effort/budget controls, transcript, tool trace, or workbench diff UI.
- No current model catalog or capability metadata.
- The existing whole-process approval cannot surface every internal Claude permission request.

### Source boundary

The requested GitHub repository describes itself as a leak collection and mixes historical Claude
Code captures with general Claude product prompts. Its collector-level GPL declaration does not
establish redistribution rights for third-party prompt text. Its contents are therefore used only
as a versioned provenance index and behavioral taxonomy.

Current behavior, model IDs, limits, aliases, tools, permission modes, and extension semantics are
derived from Anthropic's official Claude Code and Claude Platform documentation. Raw leaked system
prompts are not copied into the application and are never presented as authoritative instructions.

## 3. Architecture decision

Build a parallel Claude Code runtime rather than replacing `AgentRuntime` or `ModelRouter`.

```text
Claude UI
  -> authenticated Claude routes (builder for mutating runs)
  -> Claude session + run records
  -> mission / approval / audit infrastructure
  -> Claude runtime dispatcher
  -> Docker workbench (non-root, named project volume)
  -> provider process (Claude stream-json or Aider plain output)
  -> signed scratch copy-back for approved Execute
  -> persisted events + WebSocket projection
  -> transcript / tools / tasks / files / usage UI
```

Planning runs can start without a write approval: Anthropic uses Claude Code's read-only `plan`
permission mode and OpenAI uses Aider `ask` against a disposable copy. Execution runs use Claude
`acceptEdits` or Aider `code`, must pass Puppetmaster's outer write approval, and write only to an
attempt-owned scratch volume before signed copy-back. This is intentionally conservative: the
current CLI transports cannot pause an individual internal tool call and wait for a Puppetmaster
decision.

## 4. Implementation stages

### Stage A — contracts, catalog, and persistence

Deliverables:

- Shared Claude session/run/event/model contracts.
- `claude_sessions`, `claude_runs`, `claude_events`, and `workbench_copybacks` tables with
  workspace/project and exact execution-generation ownership.
- Repository functions for create/list/get/update/append operations.
- A curated current model/alias/tool/extension catalog with official source links.
- A provenance catalog for the requested GitHub snapshot, including file SHA and capture size.

Acceptance:

- PGlite and PostgreSQL startup DDL remain idempotent.
- Session data is workspace-scoped and events have stable per-session ordering.
- No proprietary prompt body is stored in source.

### Stage B — isolated streaming runtime

Deliverables:

- A streaming Docker command execution seam with UTF-8-safe chunk decoding and cancellation.
- Claude CLI command options for model, effort, permission mode, turn cap, dollar cap, session ID,
  resume, and persistent `CLAUDE_CONFIG_DIR` inside a companion named configuration volume.
- Incremental stream-json parsing with bounded raw event persistence, normalized live events, terminal
  result parsing, token/cost accounting, stderr capture, timeout, and process cancellation.
- Aider plain-output normalization with backend-specific telemetry kept distinct from Claude events.
- Signed snapshot/apply/status/ack receipts, durable commit phases, and a trusted recovery-key volume.

Acceptance:

- Malformed/noisy lines are recorded without crashing the session.
- A terminal result updates the Claude run, session, and mission in one database transaction.
- Cancellation terminates the managed in-container process group, including after server recovery,
  and finishes the mission as cancelled.
- Cancellation and completion are fenced by run ID plus generation; a durable committed marker wins
  over a late cancel, while an interrupted pre-commit attempt is rolled back.
- Startup recovery either restores the pending terminal result, resumes post-DB cleanup, proves
  rollback, or quarantines tampered evidence before accepting new project mutations.
- A running attempt with no ledger is enumerated before queue startup, its exact generation holder
  (or generation-zero legacy container) is terminated, disposable artifacts are removed, and the
  guarded run/mission is terminalized instead of returning `running` forever on redelivery.
- No host subprocess executes project code.

### Stage C — API, approvals, audit, and resume

Deliverables:

- Builder-gated create/continue/cancel APIs and member-readable session/catalog APIs.
- Mission dispatch for `kind = claude`.
- Read-only planning runs start directly; execution runs pause behind a write approval.
- Session continuation reads the external Claude session ID from the durable database while Claude
  state/configuration remains in the companion configuration volume.
- An empty workbench is cloned once from the project's declared `repoRef`; a non-empty non-Git
  volume is rejected instead of overwritten.
- Workbench status, git status, and git diff inspection endpoints.
- Audit events for session creation, run start/finish, model selection, approval, and cancellation.
- Readiness gating for Docker mode, provider authentication, and allowlisted network egress.

Acceptance:

- Cross-workspace project/session access returns 404.
- Rejected execution never launches Claude.
- Existing mission approval resolution resumes Claude missions through the same runner.
- Existing workflow and native-agent dispatch behavior is unchanged.
- Approval, mission, and live-event access is workspace-scoped even when Redis is shared.
- Session turn creation, active-run claiming, approval creation, event sequencing, completion, and
  retry are serialized in the database. Filesystem recovery remains a single-server/single-Docker-
  daemon deployment boundary because it has no distributed recovery lease.
- Only one Claude turn may own a project workbench at a time, even across different sessions; a
  failed queue handoff terminalizes the run instead of leaving the project locked indefinitely.
- Retrying execution invalidates the previous gate and requires a fresh write approval.

### Stage D — dedicated FUI

Deliverables:

- A first-class `CLAUDE` view available to all members, with mutation controls limited to builders.
- Session rail, new-session composer, Plan/Execute mode, project/model/effort/budget controls.
- Transcript, tool activity, tasks/subagents, raw event diagnostics, usage, and workbench diff tabs.
- Models, aliases, tools, extensions, permissions, and source-provenance reference tabs.
- Live WebSocket updates and mission handoff into the existing operation dossier.
- A bounded recent-event window with explicit backward pagination, incremental live refresh, and
  polling recovery when a WebSocket event is missed.

Acceptance:

- The primary viewport is the Claude session workbench, not generic dashboard chrome.
- Keyboard focus, labels, narrow-screen layout, and reduced motion remain usable.
- Unavailable runtime prerequisites are stated; the UI does not pretend a run is possible.

### Stage E — verification and deployment follow-up

Deliverables in this change:

- Repository-wide typecheck and build.
- Keyless parser/runtime, provider-separation, secret-transport, cancellation-race, signed-copy-back,
  tamper-quarantine, recovery, and runner-lifecycle fixture checks.
- Architecture dependency verification.

Host-only acceptance that remains environment-dependent:

- Build the workbench and egress-proxy images and run the no-cost Docker aggregate for workbench
  lifecycle, exact-attempt cancellation, lock behavior, metadata secrecy, both-provider scratch
  copy-back, offline Aider Plan isolation, and dummy-key Claude control-plane terminalization.
- Separately, and only with explicit token-spend authorization, run provider-success checks. These
  prove a real provider response; the no-cost Docker aggregate does not.
- Manually confirm approval/rejection, live streaming, resume, cancellation, diff, reconnect, and
  older-event pagination in the rendered browser UI.

Production web packaging is a separate deployment stage because the current Compose stack contains
the database, Redis, and API server but not a production web image or reverse proxy.

## 5. OpenAI provider extension plan

This extension is additive. It must not rename, remove, or silently reroute existing Anthropic
sessions.

Stages:

1. Add immutable `provider` (`anthropic` / `openai`) and `backend` (`claude` / `aider`) snapshots
   to sessions and runs. Database defaults preserve all existing rows as `anthropic` / `claude`.
2. Preserve Claude CLI command/event semantics while dispatching OpenAI sessions to the already
   pinned Aider CLI. Use Aider `ask` for read-only Plan and `code` after the existing Execute
   approval, and normalize models to `openai/<model>`.
3. Supply `OPENAI_API_KEY` and the optional `OPENAI_API_BASE` / `OPENAI_BASE_URL` from the server
   environment only to the selected Aider process. Readiness is provider-specific, requires a safe
   transport, and must verify the effective OpenAI endpoint host is present in
   `WORKBENCH_EGRESS_ALLOW`.
4. Add a provider selector only when creating a session. Continuations keep the persisted provider;
   the UI shows provider-specific model choices, readiness, transport, and capability limitations.
5. Prove both compatibility and separation with persistence, route, command-assembly, runtime,
   build, and typecheck verification. No paid credential is required for the deterministic runtime
   fixture.
6. Harden the execution boundary after adversarial review: use disposable provider-profile
   containers, mount the Claude configuration volume only for Claude, give both approved Execute
   providers an attempt-owned scratch repository, sanitize Aider copies, disable repository Claude
   hooks/settings/MCP, atomically guard cancellation/approval transitions, and probe pinned CLI
   availability in the configured image.
7. Transport configured secrets as Docker CLI child-environment values with names-only
   `docker exec -e NAME`; keep holder metadata secret- and command-free. Sign full execution identity
   and copy-back receipts with a key stored only in a trusted state volume. Persist intent/files/DB
   commit phases, reconcile them before starting the runner, serialize project reads/writes with a
   named `flock` volume, and drain active provider work before closing database/event dependencies.

Acceptance:

- Omitting `provider` behaves exactly as the original Anthropic path.
- An OpenAI session reaches Aider with the selected OpenAI model and server-side `.env` credential.
- Plan cannot edit either the durable repository or Aider metadata; Execute still requires
  Puppetmaster approval.
- Provider switching on continuation is rejected.
- Anthropic and OpenAI runs share project locking, durable events, cancellation, audit, and diff
  inspection while their backend-specific telemetry remains honestly distinct.

## 6. Explicit non-goals for this implementation

- Reproducing or executing leaked system prompts.
- Claiming undocumented Anthropic behavior as verified.
- Offering Claude subscription-login pass-through to third-party users.
- Host-level project execution outside the Docker workbench.
- `bypassPermissions` mode.
- Granular per-tool approval inside a running Claude process. That requires the Claude Agent SDK
  permission callback (or a permission-prompt MCP bridge) and a durable deferred-approval protocol;
  it is the next security stage, not something this version will fake.
- Active-active CLAUDE execution across multiple Puppetmaster servers or Docker hosts. Database run
  claims are durable, but recovery leasing/fencing and cross-host filesystem locking are not present.

## 7. Risks and mitigations

- CLI schema drift: retain bounded raw events, normalize defensively, and pin the workbench image's
  default CLI version.
- Session history loss: set `CLAUDE_CONFIG_DIR` under a companion named configuration volume,
  separate from the repository mounted at `/workbench`.
- Unbounded logs: cap process-line, payload, raw-event, and live-projection sizes; page the event API.
- Duplicate queued work: lock the session row, enforce one active turn with a partial unique index,
  atomically claim queue work, and keep an in-process guard only as a fast path.
- Cross-workspace live data: resolve every mission event to its owning workspace before socket
  delivery and attach workspace ownership to audit summaries.
- Terminal evidence loss: persist a pending result before apply, use signed commit-wins receipts,
  atomically commit run/session/mission plus the copy-back ledger, reconcile before queue startup,
  quarantine tampering, and treat WebSocket delivery as a recoverable projection.
- Secret exposure: place values only in the Docker CLI child environment, pass names (not values) on
  `docker exec`, keep persistent holder metadata and trusted helper commands secret-free, never mount
  Claude configuration into OpenAI runs, scrub ambient Aider variables, and never return secret
  values from status APIs.
- Repository-controlled execution: remove Aider dotenv/config/model controls from the disposable
  copy, use an isolated HOME and `env -i`, and force Claude to ignore project/local settings while
  disabling hooks and non-declared MCP servers.
- Destructive edits inside `acceptEdits`: require an outer write approval, isolate the volume, keep
  network deny/allowlisting, expose diffs, and retain destructive confirmation for push/deploy flows.
- Shutdown and concurrent mutation: stop HTTP/queue intake, abort exact provider attempts, await
  termination proof and runtime drain while persistence is alive, and hold a shared/exclusive named
  project lock around every workbench read or mutation. Deploy one active server per Docker daemon
  until distributed recovery ownership is implemented.
