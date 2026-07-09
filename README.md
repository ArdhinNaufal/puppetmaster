# Puppetmaster

**A local-first platform unifying an AI Agent OS and AI workflow automation into one system.**

Agents can trigger workflows; workflows can invoke agents — on a single runtime with one
MCP tool catalog, shared memory, human-in-the-loop approvals, and a full audit trail.
Built for small teams running it on their own server.

## Status

📐 Specification phase. Read the docs:

- [The Complete Guide (non-technical setup + every feature)](docs/GETTING-STARTED.md)
- [Installing Puppetmaster (technical reference)](docs/INSTALL.md)
- [Product Requirements (PRD)](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [FUI Design Language](docs/DESIGN-LANGUAGE.md)

## Highlights

- **The bridge:** agents and workflows are peer citizens, mutually invocable, with nested mission traces.
- **MCP-native:** every integration is an MCP server, shared by agents and workflow nodes.
- **Local-first:** your data and orchestration on your hardware; Anthropic/OpenAI APIs or local models (Ollama/vLLM).
- **Human-in-the-loop by default:** tiered autonomy (read auto / write approved / destructive confirmed).
- **FUI command-center UX:** dark, cinematic, data-dense — with role-based, user-arrangeable, brandable dashboards.

## Planned stack

TypeScript monorepo · Fastify · React + React Flow · PostgreSQL + pgvector · Redis/BullMQ · Docker Compose.
