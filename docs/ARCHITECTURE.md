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

### 3.4 Tool Layer (MCP)
- One catalog of MCP servers per workspace; per-agent and per-workflow **tool grants**.
- Bundled connectors (Gmail, Slack, Sheets, HTTP/webhook, filesystem) run as sidecar MCP servers.
- Credentials encrypted at rest (per-workspace key), injected into MCP servers at spawn.

### 3.5 Model Router
- Provider abstraction (Anthropic / OpenAI / Ollama / vLLM) with per-agent model choice, fallbacks, token accounting, and streaming.

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

## 4. Data model (core tables)

`users`, `workspaces`, `memberships(role)`, `agents`, `agent_memories`, `workflows`,
`workflow_versions`, `missions`, `mission_steps`, `approvals`, `tools(mcp_servers)`,
`tool_grants`, `credentials`, `templates`, `audit_log`, `ui_preferences(user layouts/themes)`,
`branding(workspace)`.

## 5. Frontend architecture

- App shell implements the FUI design system (see DESIGN-LANGUAGE.md) with a panel/grid layout engine for user-arrangeable dashboards.
- Views: **Command** (chat + live mission feed), **Canvas** (React Flow editor), **Missions** (trace/timeline/cost), **Agents** (roster + memory inspector), **Tools** (MCP catalog), **Admin** (members, roles, branding).
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
