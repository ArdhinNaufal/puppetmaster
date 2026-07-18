# Puppetmaster

**A local-first platform unifying an AI Agent OS and AI workflow automation into one system.**

Agents can trigger workflows; workflows can invoke agents — on a single runtime with one
MCP tool catalog, shared memory, human-in-the-loop approvals, and a full audit trail.
Built for small teams running it on their own server.

## Status

🛠 Active implementation. The single-host Claude Code control plane and its no-cost Docker
acceptance are verified; paid-live provider success and full interactive UI acceptance remain
explicitly tracked rather than implied.
Read the docs:

- [The Complete Guide (non-technical setup + every feature)](docs/GETTING-STARTED.md)
- [WORKSHOP Manual (beginner software-building walkthrough)](docs/WORKSHOP.md)
- [CLAUDE Manual (junior-friendly setup, Plan, Execute, approvals, and troubleshooting)](docs/CLAUDE-CODE-MANUAL.md)
- [Installing Puppetmaster (technical reference)](docs/INSTALL.md)
- [Product Requirements (PRD)](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [FUI Design Language](docs/DESIGN-LANGUAGE.md)
- [Claude Code integration plan](docs/CLAUDE-CODE-PLAN.md)
- [Claude Code implementation and evidence](docs/CLAUDE-CODE-IMPLEMENTATION.md)

## Highlights

- **The bridge:** agents and workflows are peer citizens, mutually invocable, with nested mission traces.
- **MCP-native:** every integration is an MCP server, shared by agents and workflow nodes.
- **Local-first:** your data and orchestration on your hardware; Anthropic/OpenAI APIs or local models (Ollama/vLLM).
- **Human-in-the-loop by default:** tiered autonomy (read auto / write approved / destructive confirmed).
- **FUI command-center UX:** dark, cinematic, data-dense — with role-based, user-arrangeable, brandable dashboards.
- **Claude Code control plane:** persistent Plan/Execute sessions with Anthropic/Claude retained as the default and an additive selectable OpenAI/Aider backend, provider-scoped readiness, approval-gated scratch/copy-back edits, and project-isolated Docker workbenches.

## Stack

TypeScript monorepo · Fastify · React + React Flow · PostgreSQL + pgvector · Redis/BullMQ · Docker Compose.
