# ADR-007: The Bridge — agents and workflows as peer citizens — **Retroactive**

## Status

Accepted (decision locked ~2026-07-04, PRD §3; recorded retroactively 2026-07-06 —
context reconstructed from docs/PRD.md and docs/ARCHITECTURE.md §3.3)

## Context

The market splits into workflow automation with AI bolted on (n8n, Make) and agent/LLM-app
builders with weak ops automation (Dify, Flowise). Teams gluing them together lose shared
memory, permissions, and observability at the seams.

## Alternatives considered

(Reconstructed.)

- Workflow-first with agent nodes only — rejected: agents become stateless steps; no
  persistent memory/schedules/autonomy tiers.
- Agent-first with workflows as tools only — rejected: loses the deterministic, auditable
  DAG that ops automation needs.

## Decision

One kernel where both are first-class and mutually invocable over a typed event bus:
workflows exposed to agents as MCP tools (`workflow.run`, `workflow.create_draft`); the
Agent node lets workflows await an agent's structured result; nested missions share one
trace, tool catalog, permission model, and audit trail.

## Consequences

- Positive: the differentiator the PRD claims; the Workshop feature (AI-SDLC plan) builds
  directly on it — `agent.ask` is the fresh-context reviewer primitive, and workshop
  phases are missions on the same bus.
- Negative: two execution models to keep coherent (ticks vs. DAG steps); the Bridge is a
  standing complexity tax every new subsystem must integrate with.

## Reconsider when

If usage telemetry shows one direction of the Bridge essentially unused after the Workshop
ships (agents never launching workflows, or workflows never invoking agents), simplify
toward the used direction.
