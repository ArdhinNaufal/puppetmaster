# Puppetmaster — Architecture

**Version:** 0.1 (draft)

## 1. Stack

- **TypeScript full-stack**, pnpm monorepo.
- **Server:** Node.js (Fastify) + WebSocket for live mission/trace streaming.
- **Web app:** React + Vite; **React Flow** for the canvas; Tailwind for the FUI design system.
- **Persistence:** PostgreSQL (+ pgvector for RAG). SQLite adapter later for single-user/desktop mode.
- **Queue/scheduler:** BullMQ on Redis (workflow steps, agent ticks, cron triggers).
- **Model providers:** one abstraction over Anthropic, OpenAI, and local runtimes (Ollama, vLLM).
- **Tools:** MCP client in the runtime; connectors ship as bundled MCP servers.
- **Deploy:** Docker Compose (server, web, postgres, redis, connector sidecars). Tauri desktop client in phase 2.

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
  the checks are proven in evals); `DockerCommandExecutor` (`WORKBENCH_MODE=docker`) execs into
  a per-project container — non-root, `--network none`, resource caps, a named volume at
  `/workbench` — host-verified via `scripts/verify-workbench.mjs`.
- **`bench.*` tools** (WP3b.3): `bench.read` (read), `bench.exec`/`bench.write`/`bench.git.commit`
  (write, gated), `bench.git.status`/`.diff` (read), `bench.git.push` (destructive) — a tiered,
  workspace-scoped surface over the same executor; results inherit the untrusted-data envelope
  and Stage 9C compaction like any catalog tool. Absent an executor, every call refuses by name.
- **`bench.delegate`** (WP3b.4, ADR-002 + **ADR-008**): delegates a coding task to a headless
  coding CLI running inside the workbench (write-tier, turn + wall-clock budget). The CLI is
  **pluggable** via a `CodingCliAdapter` (`coding-cli.ts`) — ships `claude` (Anthropic,
  stream-json) and `aider` (provider-agnostic: OpenAI/Anthropic/Gemini/Ollama/local, model via
  `DELEGATE_MODEL`), selected per call (`cli`) or per deployment (`DELEGATE_CLI`). This is the
  EXECUTE-phase complement to §3.5's already-multi-provider Model Router — together they mean no
  Workshop surface is locked to a single AI provider.
- **Knowledge mirror** (ADR-004): accepted `spec`/`learning` artifacts mirror into the KB on
  write (one live document per project+kind+title, replaced each version) so `kb.search` and
  citations work over them; a mirror failure never loses the artifact write.
- **UI**: the WORKSHOP view (project list, dossier with phase strip + todo board + artifact
  reader + the **forcing-section coverage meter** reading the same required list the
  spec-sections gate uses, + the earned-policy check panel); the Canvas `verify` node skin and
  its structured config inspector (check picker, retries-before-escalate); the approval inbox's
  evidence panel.

## 4. Data model (core tables)

`users`, `workspaces`, `memberships(role)`, `agents`, `agent_memories`, `workflows`,
`workflow_versions`, `missions`, `mission_steps`, `approvals`, `tools(mcp_servers)`,
`tool_grants`, `credentials`, `templates`, `audit_log`, `ui_preferences(user layouts/themes)`,
`branding(workspace)`. Workshop (§3.11): `projects`, `project_artifacts`, `verify_checks`,
`evidence`.

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
