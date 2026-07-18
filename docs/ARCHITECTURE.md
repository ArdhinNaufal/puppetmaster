# Puppetmaster — Architecture

**Version:** 0.1 (draft)

## 1. Stack

- **TypeScript full-stack**, pnpm monorepo.
- **Server:** Node.js (Fastify) + WebSocket for live mission/trace streaming.
- **Web app:** React + Vite; **React Flow** for the canvas; repository CSS for the FUI design system.
- **Persistence:** PostgreSQL (+ pgvector for RAG). SQLite adapter later for single-user/desktop mode.
- **Queue/scheduler:** BullMQ on Redis (workflow steps, agent ticks, cron triggers).
- **Model providers:** one abstraction over Anthropic, OpenAI, and local runtimes (Ollama, vLLM).
- **Tools:** MCP client in the runtime; connectors ship as bundled MCP servers.
- **Current deploy substrate:** Docker Compose packages the API, Postgres, and Redis. The Vite web
  app runs separately, and Docker workbenches currently require the API server to run on the host
  with Docker access. A production web image/reverse proxy and a deliberately privileged remote
  workbench executor remain deployment work; Tauri is a later client target.

## 2. System overview

```
┌─────────────────────────── Web app (React) ────────────────────────────┐
│  Command view (chat)   Canvas (React Flow)   Missions   Admin/Branding │
└──────────────────────────────┬─────────────────────────────────────────┘
                        HTTP + WebSocket
┌──────────────────────────────┴─────────────────────────────────────────┐
│                          API Gateway (Fastify)                          │
│   auth · RBAC · workspaces · REST/WS · approval inbox                   │
├─────────────────────────────────────────────────────────────────────────┤
│                            PUPPETMASTER KERNEL                          │
│  ┌───────────────┐  ┌────────────────┐  ┌───────────────────────────┐  │
│  │ Agent Runtime  │←→│  Bridge/Event  │←→│     Workflow Engine       │  │
│  │ loops, memory, │  │  bus: agents ↔ │  │ DAG executor, triggers,   │  │
│  │ schedules      │  │  workflows     │  │ retries, code sandbox     │  │
│  └───────┬───────┘  └────────────────┘  └────────────┬──────────────┘  │
│          └───────────────┬─────────────┬─────────────┘                 │
│                  ┌───────┴──────┐ ┌────┴─────────┐ ┌────────────────┐  │
│                  │ Tool Layer   │ │ Model Router │ │ Policy/Approval│  │
│                  │ (MCP client) │ │ (LLM providers)│ engine + audit │  │
│                  └──────────────┘ └──────────────┘ └────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│        PostgreSQL (+pgvector)      Redis/BullMQ      MCP servers        │
└─────────────────────────────────────────────────────────────────────────┘
```

## 3. Kernel components

### 3.1 Agent Runtime
- Each agent = definition (persona, goals, model, tool grants, memory config, autonomy tier) + persistent state.
- Execution as **ticks**: an agentic loop (LLM ↔ tools) run to completion or to an approval gate, resumable.
- Activation: cron schedule, event subscription (webhook, workflow completion, another agent), or direct chat.
- Memory: short-term (conversation window), long-term (pgvector semantic memory), and structured scratchpad per agent.
- **Memory v2 (Stage 4, §1.1)**: tiered long-term memory — `fact` (agent-saved), `episodic`
  (model-written one-line summary of every successful tick, linked to its mission), and
  `procedural` (LEGOMem-style "task → tool steps that worked"). Writes pass **admission
  control**: a near-duplicate of a same-kind memory (cosine > 0.92) merges into it (importance
  bump + recency touch) instead of inserting; per-agent cap (`MEMORY_CAP`, default 200) enforced
  by evicting the lowest `importance × exp(-age/30d)` unpinned rows. Recall is **hybrid**
  (pgvector + keyword, reciprocal-rank fused via the Stage 3 machinery) and touches returned
  rows so useful memories survive decay. Governance per SSGM: pin/unpin, edit, delete in the
  agent inspector (`PUT/DELETE /api/agents/:id/memories/:memId`, builder+); pinned memories are
  never evicted.
- **Context compaction (Stage 9C, docs/9ROUTER-ADOPTION.md)**: per-agent opt-in
  (`agents.context_compaction`, default off, toggle in the inspector). Catalog-tool results
  above `COMPACTION_MIN_CHARS` (default 800) pass deterministic, model-free compactors —
  pretty-JSON→compact, whitespace collapse, consecutive-duplicate-line dedup (`[×N]`),
  head/tail truncate above `COMPACTION_MAX_CHARS` (default 4000, explicit elision marker) —
  before entering model context (inside the untrusted-data envelope). **Provenance**: the
  mission step always stores the raw result byte-identical; the `tool.call` audit entry
  records `{rawBytes, sentBytes, compactors}`; runtime memory/scratchpad tools and error
  results are exempt. Savings aggregate at `GET /api/usage` (`compaction.tokensAvoided`,
  EVALS stat tile); the golden suite pins the behaviour (`agent-compaction-provenance`:
  compacted context + raw step, trajectory unchanged).

### 3.2 Workflow Engine
- Workflows are DAGs stored as JSON; nodes: trigger, action (MCP tool call), logic (branch/loop/wait), code (sandboxed JS via isolated worker), **agent node**, human-approval node.
- Deterministic executor on BullMQ with retries, timeouts, and per-node IO snapshots for the trace view.
- **Durable execution (Stage 2)**: side-effectful calls are journaled in `node_executions` —
  a ledger row is written *before* the call and committed with the output after, so a retried
  mission reuses committed outputs instead of repeating side effects (at-most-once for committed
  work). Missions support cooperative **cancellation** (`POST /api/missions/:id/cancel`; flag
  checked between nodes/agent iterations), **retry-from-cursor** (`POST /api/missions/:id/retry`,
  builder+; preserves the step log and ledger), a **dead-letter list**
  (`GET /api/missions/dead-letter`: retried ≥1× and still failed), and **deterministic replay**
  (`GET /api/missions/:id/replay`: re-walks the DAG over recorded outputs with no side effects,
  flagging divergence between expected and recorded activation).

### 3.3 The Bridge (differentiator)
- Internal event bus (Redis streams) with typed events: `mission.*`, `agent.*`, `workflow.*`, `approval.*`.
- **Agent → workflow:** workflows are exposed to agents as MCP tools (`workflow.run`, `workflow.create_draft`), so an agent can launch or even draft workflows.
- **Workflow → agent:** the Agent node sends a task to an agent and awaits its structured result (sync with timeout, or async continuation).
- Shared mission context: a workflow started by an agent carries the agent's mission ID; traces nest.
- **Agent → agent (Stage 8, G12-lite)**: `agent.ask` delegates a task to another agent by
  id/name as a nested mission and returns its reply. Delegation depth is capped at 2 hops
  (§1.2: strong single agents over deep team hierarchies), self-delegation is refused, and
  risky tools inside the child still gate on their own tiers.

### 3.4 Tool Layer (MCP)
- One catalog of MCP servers per workspace; per-agent and per-workflow **tool grants**.
- Bundled connectors (Gmail, Slack, Sheets, HTTP/webhook, filesystem) run as sidecar MCP servers.
- Credentials encrypted at rest (per-workspace key), injected into MCP servers at spawn.
- **MCP 2026 reach (Stage 7)**: alongside stdio, a **streamable-HTTP client** — workspace
  servers are stored in `mcp_servers` (added from the Tools view, not env) and reconnected on
  boot; auth headers may reference the vault (`Authorization: Bearer {{credential:NAME}}`),
  resolved only at connect. The public **MCP registry** is browsable
  (`GET /api/mcp/registry?q=`, proxying registry.modelcontextprotocol.io) with one-click add.
  Server **elicitation** requests are mapped into the approval inbox: the asking tool call
  blocks while an `elicitation` approval is pending; approve → accept, reject/timeout →
  decline, and requests outside any mission context are declined. Removing a server closes
  the connection and unregisters its tools. (Full OAuth resource-server flows are not wired
  yet — bearer tokens via the vault cover the common case.)

### 3.5 Model Router
- Provider abstraction (Anthropic / OpenAI / Ollama / vLLM) with per-agent model choice, fallbacks, token accounting, and streaming.
- **Fallback chains (Stage 8)**: a model string may list candidates separated by `|`
  (`"claude-sonnet-5|openai/gpt-5|mock"`); candidates are tried in order, per-model failure
  counts are exposed at `GET /api/usage` (`routerFailures`), and llm.call audit entries record
  `servedBy` when a fallback answered. Streaming (Stage 6) rides the same chain.
- **Router profiles (Stage 9A, docs/9ROUTER-ADOPTION.md)**: named workspace-level chains in
  `router_profiles` — `model: "profile:NAME"` resolves at call time to ordered candidates
  `[{model, costClass}]` (classes `premium|cheap|local|free`), so editing a profile re-routes
  every consumer. `minClassForGatedTools` is an anti-silent-substitution floor: for agents
  that can reach write/destructive tools, below-floor candidates are excluded, and a chain
  that can only answer below the floor pauses the tick behind a `router-floor` approval
  (audited as `router.floor.gate`; rejection fails the tick, approval permits the downgrade
  for that mission). llm.call audit records `profile` + `servedBy`; the usage ledger accrues
  cost to the serving candidate. REST: `GET /api/router/profiles` (member; builders reference
  profiles by name), mutations admin; ROUTER PROFILES panel in the EVALS view.
- **Health-aware routing (Stage 9B)**: an in-memory per-candidate health map — a quota/429
  error (retry-after honoured, capped) cools a candidate immediately; other errors cool it
  after `ROUTER_FAILURE_THRESHOLD` consecutive failures (default 3) for
  `ROUTER_COOLDOWN_MS` (default 30s, doubling per repeat cycle up to
  `ROUTER_COOLDOWN_MAX_MS`, default 120s). Cooling candidates are **deprioritized, never
  removed**: healthy candidates are tried first, cooling ones remain as last resort, so a
  chain never fails closed on stale health state. Cooldown expiry is the half-open probe
  (the failure counter survives expiry, so one more miss re-arms at once). Transitions are
  audited as `router.cooldown`; `GET /api/usage` exposes `routerHealth`
  (state/cooldownUntil/lastError per candidate) rendered in the EVALS view's ROUTER HEALTH
  panel next to `routerFailures`.

### 3.6 Policy & Approval Engine
- Autonomy tiers per agent: **read = auto, write = approval, destructive = always confirm** (defaults; configurable per tool/action).
- Approval requests pause the mission and appear in the dashboard inbox (and later, notifications).
- Every LLM call, tool call, and approval decision is written to an append-only audit log.
- **Auto-allow policies** (`approval_policies`, admin-managed at `/api/policies`): per-agent or
  workspace-wide rules — a tool pattern (`email.send` / `email.*`) plus argument predicates
  (`to endsWith "@acme.io"`) — that let a matching gated call execute without pausing. Auto-approved
  calls are audited as `approval.auto` with the policy id; anything unmatched still gates, and a
  policy-lookup failure fails closed to the human gate.

### 3.7 Trust boundary hardening (Stage 1)
- **Credentials vault**: `credentials` stores AES-256-GCM envelopes sealed under
  `PUPPETMASTER_MASTER_KEY` (scrypt-derived key). Write-only API at `/api/credentials` (admin) —
  values are never returned after write. MCP server env may reference secrets as
  `{{credential:NAME}}`; refs are resolved at spawn, and a missing credential fails that server's
  connect loudly.
- **Untrusted-data delimiters**: catalog tool results and webhook payloads are wrapped in
  `<untrusted_data source="...">` envelopes before entering agent context (provenance separation
  against indirect prompt injection); the system prompt instructs the model to treat the contents
  as data, never instructions. Enforcement stays structural — tiers/approvals gate the resulting
  actions regardless of what injected content asks for.
- **MCP tool-description pinning**: each tool's description+schema sha-256 is pinned in
  `mcp_tool_pins` at first connect; a changed hash on reconnect (tool-poisoning canary) is logged
  and audited as `mcp.description.drift` before the pin updates.
- **Egress allowlist**: with `HTTP_ALLOWED_HOSTS` set (comma-separated hostnames; subdomains
  match), `http.get` refuses any other host.

### 3.8 Knowledge base / RAG (Stage 3)
- Per-workspace document store (`documents` + `document_chunks(embedding vector)`); md/txt
  ingest with **heading-aware chunking** (breadcrumbs like "Handbook › Ops › Escalation",
  ~1.4k-char chunks split on paragraph boundaries), embedded at ingest.
- **Hybrid retrieval** per §1.6 best practices: pgvector cosine (dense) + Postgres full-text
  `ts_rank` (sparse, ILIKE fallback) → top-50 each → **reciprocal-rank fusion** → top-k with
  citations (`Title#chunk (breadcrumb)`); an optional reranker hook slots between fusion and
  the final cut.
- `kb.search` / `kb.read` are read-tier tools in the shared catalog — agents and workflow
  action nodes cite the same knowledge base, and results flow through the untrusted-data
  envelope like any tool output.
- KNOWLEDGE view: upload (file or paste), browse/delete, and a search-test panel that hits
  the same retrieval path as the tool. REST: `/api/kb/documents[...]`, `/api/kb/search`
  (upload/delete builder+).

### 3.9 Evals & observability (Stage 5)
- **Eval harness** (τ-bench style, §1.5): golden tasks run k× against a fresh ephemeral PGlite
  with the deterministic mock provider; grading = mission outcome + output predicate +
  **DB-state predicate** + **trajectory assertions** (must-call / may-call-only over the step
  log, catching "corrupt success"). pass^k requires all k runs green. CLI `pnpm eval [--k N]`;
  `POST /api/evals/run` stores results in `eval_runs` for the EVALS view (admin).
- **OTel GenAI export**: with `OTEL_EXPORTER_OTLP_ENDPOINT` set, every finished mission is
  exported as one OTLP/HTTP JSON trace — root mission span + child spans per step, `gen_ai.*`
  semantic-convention attributes (operation name, request model, token usage). Spans are built
  from the persisted step log, so durations are real and the hot path pays nothing.
- **Cost ledger + budgets**: every `llm.call` audit entry also lands in `usage_ledger`;
  `GET /api/usage` aggregates month-to-date by agent + model. `budgets` (workspace-wide or
  per-agent monthly token limits, admin CRUD at `/api/budgets`) gate new agent ticks behind an
  approval when exhausted — the operator can approve a one-off override or reject the tick.

### 3.10 Workflow copilot (Stage 6)
- **NL→draft**: `POST /api/workflows/draft` turns a description into a WorkflowGraph — model-
  drafted (`COPILOT_MODEL`), with a deterministic keyword heuristic under the keyless mock
  provider. The draft is returned to the Canvas as *editable state*, never auto-saved
  (human-in-command per §1.2); lint issues ride along.
- **Graph linter** (`POST /api/workflows/lint`, surfaced in the editor): missing trigger,
  dangling edges/self-loops, cycles, duplicate ids, unreachable nodes, write/destructive
  actions with no approval upstream, network calls with retries=0, unknown tools, unconfigured
  agent nodes, empty code nodes.
- **Failure explainer**: `POST /api/missions/:id/explain` returns a deterministic locator line
  ("failed at node X on attempt N: err") plus a model-written root-cause diagnosis of the
  recorded trace — rendered as a DIAGNOSIS card in the trace panel.
- **Streaming**: assistant replies stream as `agent.message.delta` bus events (true token
  streaming on Anthropic, chunked delivery elsewhere); the Command view renders a live bubble
  replaced by the persisted message.

### 3.11 The Workshop — verifiable software development (AI-SDLC plan)
The Workshop turns the platform into a software-development environment where work passes
through **deterministic gates** rather than the model's self-report. Its mechanisms are
shipped; the full phase orchestration (EXECUTE via a headless CLI) is in progress — see
`docs/AI-SDLC-INTEGRATION-PLAN.md`.
- **Domain model** (WP2): a `projects` row (mode `supervised`|`gated`, a phase, optional
  `repoRef`) owns versioned `project_artifacts` — `spec`/`plan` (new version per re-write),
  `todo` (backlog|active|completed, completion carries the completing `missionId` as a
  mandatory audit link), `learning` (append-only), `adr` (proposed→accepted; accepted is
  immutable). Lifecycle rules live in the repo layer, so agents and workflow action nodes hit
  the same surface (`project.*` tools) as the REST API.
- **Verify gates** (WP4): the `verify` node kind runs one named check via the deployment's
  **CheckRunner** and returns *evidence*, never a bare verdict. Pass opens the edge; failure
  loops a configured fix agent up to `retriesBeforeEscalate` times with the check's own output
  as the instruction, then escalates to a human approval with the run history attached (the
  corpus's 8-block override, made policy). Missing/disabled/misconfigured checks **throw** —
  a gate fails closed, loudly, never passes by absence. `evidence` rows (test-output, diff,
  screenshot, state-assert) hang off the step or the approval.
- **Check library** (`verify.ts`): DB-native checks need no workbench — `todo-sync` (a spec
  that changed without its todos following blocks) and `spec-sections` (the newest spec must
  carry every required section with concrete content — the "architecture theater" refusal).
  Workbench-backed checks run a command through a **CommandExecutor**: `test`/`arch`/`custom`
  (exit 0 = pass), `refactor-gate` (`git diff --diff-filter=M` on test paths — editing test
  expectations during a refactor blocks; adding tests is fine, P14), and `load` (refuses
  without declared SLOs — an invented threshold is the smell, S2; with SLOs, runs the declared
  command). Checks are **earned policies**: created disabled, enabling requires a note on the
  failure that earned it.
- **Workbench executor** (WP3, ADR-002/005): the `CommandExecutor.run()` seam is where the
  isolation boundary lives. `LocalCommandExecutor` runs on the host (trusted-local, and the way
  the checks are proven in evals). `DockerCommandExecutor` (`WORKBENCH_MODE=docker`) keeps a
  capped, non-root base container and named `/workbench` volume for ordinary checks. Its default
  network is `none`; configured provider egress uses an internal project network plus an
  allowlisting proxy. Coding-provider turns use disposable profile containers rather than
  `docker exec` into the base container. These boundaries are host-verified by the Docker suite.
- **`bench.*` tools** (WP3b.3): `bench.read` (read), `bench.exec`/`bench.write`/`bench.git.commit`
  (write, gated), `bench.git.status`/`.diff` (read), `bench.git.push` (destructive) — a tiered,
  workspace-scoped surface over the same executor; results inherit the untrusted-data envelope
  and Stage 9C compaction like any catalog tool. Absent an executor, every call refuses by name.
- **`bench.delegate`** (WP3b.4, ADR-002 + **ADR-008**): delegates a coding task to a headless
  coding CLI running in a disposable provider profile (write-tier, turn + wall-clock budget). The
  `CodingCliAdapter` seam (`coding-cli.ts`) ships Claude stream-json and Aider plain-output parsers.
  Claude remains the supported mutating tool path. Mutating `bench.delegate(aider)` fails closed
  because workflow nodes do not yet supply the durable run ID/generation required by the signed
  copy-back ledger; Aider Plan remains available, and OpenAI mutation is supported through the
  CLAUDE page Execute path. This restriction prevents a provider choice from bypassing durable
  ownership rather than weakening the boundary to preserve the original adapter promise.
- **Knowledge mirror** (ADR-004): accepted `spec`/`learning` artifacts mirror into the KB on
  write (one live document per project+kind+title, replaced each version) so `kb.search` and
  citations work over them; a mirror failure never loses the artifact write.
- **Decision graph** (research-led WP7 increment): `project_trace_links` preserves a
  directional, rationale-bearing reasoning edge (`informs`|`derives`|`verifies`|`mitigates`)
  between durable project artifacts and checks. Both endpoints are revalidated against the
  project in the repo layer; cross-project/self/duplicate links fail closed and every change
  is audited. Readiness/orphan signals use current artifact versions only, so a revision must
  be re-confirmed rather than silently inheriting stale trust. See
  `docs/WORKSHOP-DECISION-GRAPH.md`.
- **UI**: the WORKSHOP view (project list, dossier with phase strip + todo board + artifact
  reader + the **forcing-section coverage meter** reading the same required list the
  spec-sections gate uses, + artifact/check authoring, the earned-policy check panel, and the
  advisory Decision Graph with trace coverage, orphan warnings, and next-move guidance); the
  Canvas `verify` node skin and its structured config inspector (check picker,
  retries-before-escalate); the approval inbox's evidence panel.

### 3.12 Claude Code control plane

Claude Code is a parallel mission runtime over the Workshop isolation boundary, not a second
orchestrator. Its implementation is split deliberately between planning and execution:

- **Plan** is read-only: Anthropic gets a read-only project-volume mount and Claude `plan`; OpenAI
  gets a sanitized disposable copy and Aider `ask`. **Execute** is write-tier and always creates a
  pending approval before Claude `acceptEdits` or Aider `code`; the dedicated API exposes no bypass.
- Runs are Docker-only, serialized to one active run per project, and refuse a missing or
  ambiguous repository. An empty workbench is populated from the project's `repoRef`.
- Each project receives separate `/workbench`, persistent Claude configuration, and named lock
  volumes. Coding turns run in disposable provider-profile containers. Anthropic mounts its
  companion configuration volume; OpenAI never does. Both approved Execute providers edit an
  attempt-owned scratch-volume copy, while secret-free trusted holders perform HMAC-signed v3
  snapshot/apply/status/ack operations. The durable journal is commit-wins: rollback is possible
  only before the signed committed marker; a later cancel cannot undo committed files. A database
  `workbench_copybacks` ledger atomically couples that receipt to run/session/mission completion,
  resumes cleanup after restart, and quarantines malformed or tampered evidence. The isolated
  holder owns cancellation independently of the local `docker exec` client; normal cleanup proves
  exact run ID/generation holder removal before removing scratch/state volumes.
- Run state, stream events, usage, mission state, and terminal audit evidence are durable.
  Workspace-scoped WebSocket updates are best-effort accelerators over polling and paged event
  recovery, not the source of truth.
- Startup reconciliation runs before queue intake. It handles ledger rows and also enumerates
  pre-intent `running` claims, proves exact-generation (or legacy generation-zero) termination,
  removes disposable artifacts, and terminalizes the guarded run/mission. Shutdown rejects new
  mutations, stops queue/HTTP intake, aborts active provider attempts, and drains them while the
  database, bus, and MCP dependencies remain alive. Shared `flock` guards Plan/status/diff reads;
  exclusive `flock` guards Execute copy-back and other project mutations.
- The CLAUDE UI exposes sessions, transcript, tool/task traces, diffs, models, permissions, and
  provenance. Official Anthropic documentation is the behavior authority; the referenced
  third-party corpus is retained only as untrusted provenance metadata.
- Sessions also carry immutable `provider` and `backend` snapshots. Existing and omitted values
  default to `anthropic` / `claude`, preserving the original Claude Code path. Selecting OpenAI
  creates an `openai` / `aider` session that reads `OPENAI_API_KEY` (and an optional
  `OPENAI_API_BASE` / `OPENAI_BASE_URL`) from the server's secret map. Provider credentials are
  made available only to that disposable provider process. Values exist solely in the Docker CLI
  child environment and `docker exec` receives names (`-e NAME`), so persistent holder
  `Config.Env`/`Config.Cmd` contains neither configured secret values nor provider commands. Claude
  and Aider cannot see each other's environment or companion configuration, and neither Execute
  backend sees the durable project writable.
  Readiness validates credentials for the selected Anthropic transport (direct, Bedrock, or
  Foundry), rejects ambiguous multiple-cloud selection, and deliberately leaves Vertex unavailable
  until container ADC can be provisioned and proven. It also probes the configured workbench image
  for the pinned CLI/helper versions and verifies that the local proxy image exists instead of
  inferring runtime availability from credentials alone. OpenAI custom endpoints reject literal
  loopback/unspecified hosts because those resolve inside the disposable container. Neither image
  is built, pulled, or replaced by server startup; building both and passing the Docker
  verification suite are deployment prerequisites.
- OpenAI Plan maps to Aider's non-editing `ask` mode; Execute maps to `code` mode behind the same
  write approval and Docker boundary. Both Aider modes run from a sanitized disposable repository copy;
  repository Aider config/model metadata and dotenv discovery are removed, ambient `AIDER_*`
  variables are scrubbed, and automatic lint/test or shell suggestions are disabled. Plan discards
  the copy; a successful approved Execute copies code back while preserving Git metadata and the
  repository's protected control files. Managed Claude turns similarly exclude project/local
  setting sources, disable hooks, and use a strict empty MCP configuration. The UI
  discloses the backend's narrower telemetry: Aider emits plain output rather than Claude
  stream-json tool events and does not enforce Claude's CLI turn/spend caps or resume Claude
  sessions.
- The current recovery owner is intentionally single-host: database run claims are durable, but
  startup reconciliation has no distributed lease/fencing and named filesystem locks are scoped to
  one Docker daemon. Active-active CLAUDE execution across servers/hosts is unsupported.

## 4. Data model (core tables)

`users`, `workspaces`, `memberships(role)`, `agents`, `agent_memories`, `workflows`,
`workflow_versions`, `missions`, `mission_steps`, `approvals`, `tools(mcp_servers)`,
`tool_grants`, `credentials`, `templates`, `audit_log`, `ui_preferences(user layouts/themes)`,
`branding(workspace)`. Workshop (§3.11): `projects`, `project_artifacts`, `verify_checks`,
`project_trace_links`, `evidence`. Claude Code (§3.12): `claude_sessions(provider, backend)`,
`claude_runs(provider, backend, execution_generation)`, `claude_events`,
`workbench_copybacks(execution_id, execution_generation, state)`.

## 5. Frontend architecture

- App shell implements the FUI design system (see DESIGN-LANGUAGE.md) with a panel/grid layout engine for user-arrangeable dashboards.
- Views: **Command** (chat + live mission feed), **Canvas** (React Flow editor), **Missions** (trace/timeline/cost), **Agents** (roster + memory inspector), **Tools** (MCP catalog), **Workshop** (projects, dossier, verify checks — §3.11), **Admin** (members, roles, branding).
- Role-based navigation config drives which menus/widgets render; AI-adaptive suggestions come from a usage-stats service.
- Real-time via WebSocket subscriptions to bus events.

## 6. Security

- Session auth (later OIDC), RBAC enforced at gateway; workspace-scoped everything.
- Code nodes run in isolated workers with no ambient network/filesystem (explicit grants only).
- MCP servers run as separate processes/containers; least-privilege credential injection.

## 7. Monorepo layout (planned)

```
apps/
  server/        # Fastify API + kernel
  web/           # React app
packages/
  kernel/        # agent runtime, workflow engine, bridge
  mcp-connectors/# bundled first-party MCP servers
  shared/        # types, schemas (zod), client SDK
  ui/            # FUI design-system components
docker/          # compose files
docs/
```

## 8. Phased roadmap

- **M0 — Skeleton:** monorepo, compose stack, auth, workspaces, model router.
- **M1 — Workflow engine + canvas:** triggers, MCP action nodes, code nodes, traces.
- **M2 — Agent runtime:** agent definitions, memory, schedules, chat view, approvals.
- **M3 — The bridge:** agent↔workflow invocation, nested missions, shared tool grants.
- **M4 — FUI shell:** full design system, role dashboards, arrangeable panels, branding.
- **M5 — Ecosystem:** templates/marketplace, RAG pipeline, adaptive UI, desktop (Tauri).
