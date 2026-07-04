# Kick-off prompt (paste into the new Claude Code session)

```
You are continuing work on Puppetmaster in the ArdhinNaufal/puppetmaster repo.

First read, in this order: docs/HANDOFF.md, docs/PRD.md, docs/ARCHITECTURE.md,
docs/DESIGN-LANGUAGE.md. These lock in all product and technical decisions —
do not re-interview me or revisit settled choices.

Context: PR #1 (spec + M0 monorepo skeleton) is on branch
claude/ai-agent-automation-platform-e7nwzf. The M0 skeleton builds green
(pnpm install && pnpm build) and the Fastify server smoke-tests OK.

Your task: proceed with milestone M1 — workflow engine + canvas — exactly as
specified in docs/HANDOFF.md §3 and docs/ARCHITECTURE.md §3.2/§8:
1. Postgres persistence (workflows, workflow_versions, missions, mission_steps)
   with pgvector-ready setup.
2. Deterministic DAG executor on BullMQ with retries, timeouts, and per-node
   IO snapshots; trigger nodes (cron/webhook/manual), MCP action nodes, logic
   nodes, sandboxed JS code nodes, and human-approval nodes.
3. Redis-streams EventBus implementation behind the existing interface in
   packages/kernel.
4. React Flow canvas editor in apps/web with node skins following
   docs/DESIGN-LANGUAGE.md tokens.

Working rules: keep pnpm build and typecheck green before each push; commit to
the designated claude/* branch for this session; verify the server end-to-end
(run a sample workflow) before declaring M1 done; pause for my manual review
when M1 is complete.
```
