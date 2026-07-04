# Puppetmaster — Product Requirements Document

**Version:** 0.1 (draft) · **Date:** 2026-07-04

## 1. Vision

Puppetmaster is a **local-first platform that unifies an AI Agent OS and an AI workflow
automation engine into one system**. Today teams glue together separate tools — n8n for
automation, Dify/Flowise for agents, Ollama for local inference — and lose shared memory,
permissions, and observability across the seams. Puppetmaster provides one runtime where
**agents can trigger workflows and workflows can invoke agents**, sharing a single tool
catalog (MCP), memory layer, permission model, and audit trail.

## 2. Target users

Small teams / SMBs running Puppetmaster on their own server (LAN or VPS). Multi-user with
roles and shared assets. Secondary: technical solo users.

## 3. Positioning & differentiation

| Category | Examples | Gap Puppetmaster fills |
|---|---|---|
| Workflow automation | n8n, Make | AI is bolted on as nodes; no persistent agents |
| LLM app builders | Dify, Flowise | Chat/RAG-centric; weak ops-style automation |
| Agent OS research/runtimes | AIOS, OpenFang | No visual workflow layer, not team products |

Differentiators:
1. **The bridge** — agents and workflows are peer citizens on one runtime, mutually invocable.
2. **One MCP tool catalog** shared by agents and workflow nodes.
3. **Local-first** — data and orchestration on the team's own hardware; cloud LLMs allowed, Ollama supported.
4. **FUI command-center UX** — a cinematic, data-dense interface (see DESIGN-LANGUAGE.md), personalized per user/role.

## 4. Core concepts

- **Agent** — a long-running, stateful worker with a persona/goal, memory, tool grants, and a schedule or event subscriptions.
- **Workflow** — a deterministic, visual DAG of nodes (triggers, actions, logic, code, agent-invocations).
- **Tool** — an MCP server capability, available identically to agents and workflow nodes.
- **Mission** — a unit of execution (agent run or workflow run) with full trace, cost, and approval history.
- **Approval** — a human-in-the-loop gate. Default policy: agents propose; risky/external actions require approval; per-agent permission tiers (read = free, write = approved, destructive = always confirmed) are configurable.
- **Workspace** — a team space with members, roles, shared agents/workflows/tools, branding.

## 5. Primary use cases (MVP targets)

1. **Personal assistant** — email triage, calendar, reminders, daily briefings.
2. **Business/ops automation** — CRM syncs, invoicing, scraping, report generation.
3. **Dev automation** — CI babysitting, code-review agents, repo maintenance, release notes.
4. **Knowledge/RAG** — document ingestion, local vector search, Q&A over team data.

## 6. Interaction model

Two equal front doors sharing one runtime:
- **Command view (chat-first)** — talk to an orchestrator; it runs agents, creates/edits workflows, and surfaces missions.
- **Canvas view** — n8n-style visual editor where **Agent nodes are first-class** alongside triggers/actions/logic.

Personalization requirements:
- Role-based dashboards (menus/widgets per role).
- User-arrangeable workspace (drag/pin/hide panels, per-user theming).
- AI-adaptive UI (surface frequently used agents/workflows).
- White-label branding per workspace (logo, colors, menu structure).

## 7. Extensibility

- **MCP is the tool standard** — every integration is an MCP server.
- **Built-in connector library** — curated first-party connectors (Gmail, Slack, Sheets, webhooks) implemented as bundled MCP servers.
- **Custom code nodes** — sandboxed JS (later Python) snippets in workflows.
- **Marketplace/templates** — shareable agent + workflow templates within and between teams.

## 8. Deployment

- **Phase 1:** Docker Compose on a team server; browser clients.
- **Phase 2:** Desktop client (Tauri) connecting to the server core; possible single-user embedded mode.

## 9. Non-functional requirements

- Local-first: no required cloud dependency except optional LLM APIs.
- Multi-user auth, RBAC (owner / admin / builder / member).
- Full audit log of every tool call, LLM call, and approval.
- Cost tracking per mission (tokens, API spend).
- Works with Anthropic/OpenAI APIs and local runtimes (Ollama, vLLM) behind one model-provider abstraction.

## 10. Out of scope (v1)

Mobile apps, hosted/multi-tenant SaaS, fine-tuning, computer-use agents, plugin billing.

## 11. Success criteria for MVP

A small team can: install via `docker compose up`; connect a model provider; build a workflow on the canvas; create an agent with memory and MCP tools; have that agent trigger a workflow and a workflow invoke that agent; approve a gated action from the dashboard; and see the full mission trace — all without leaving their own server.
