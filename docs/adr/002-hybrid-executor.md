# ADR-002: Hybrid executor — headless coding CLI for EXECUTE, native agents elsewhere

## Status

Accepted (owner ruling 2, 2026-07-06 — see docs/AI-SDLC-INTEGRATION-PLAN.md §8)

## Context

Someone has to do the Workshop's actual coding. The corpus the feature implements is
written for a mature coding CLI (Claude Code); Puppetmaster's native agent runtime is an
orchestration loop, not a coding agent. Invariant 2 (trust from verifiers) means
Puppetmaster's differentiating value is the harness — gates, evidence, artifacts, audit —
not the executor.

## Alternatives considered

- **Pure native** (agent runtime + `bench.*` tools does all coding) — rejected for v1:
  re-implements years of coding-agent maturity (context management, repo navigation,
  edit reliability); slowest path to value.
- **Pure headless CLI** (CLI does everything incl. interview/plan/review) — rejected: the
  interview is conversation-shaped and belongs in the Command view on the native runtime;
  review independence must be *our* structural guarantee (`agent.ask`, separate agent id,
  trajectory-asserted), not delegated to the same external tool that wrote the code.

## Decision

Hybrid. **EXECUTE** delegates coding tasks to a headless coding CLI running *inside* the
project's workbench container via `bench.delegate(task, budget)` — hard token/time budget,
progress streamed into the mission trace, output through untrusted-data envelopes, no
credentials beyond the workbench's own scoped set. **SPECIFY / PLAN / VERIFY-review /
RECORD** run on the native agent runtime (Interviewer, Foreman, Reviewer). The CLI version
is pinned in the workbench image and upgraded deliberately.

## Spike (feasibility validation)

Protocol committed as `scripts/spike-adr002.sh`. Two halves:

1. **Headless-CLI contract** — run the CLI headless against a toy repo with a strict
   budget; assert machine-readable stream output, budget enforcement, clean exit
   semantics, and that the produced change passes the toy repo's test.
   **Status: PASSED 2026-07-06** in the dev environment (claude CLI 2.1.202) — evidence
   in `docs/adr/spike-002-record.md`.
2. **Container half** — validates the ADR-005 isolation substrate: the candidate image
   (`docker/workbench.Dockerfile`) has the toolchain, runs non-root, executes a
   deterministic check inside, refuses egress under `--network none`, and accepts CPU/
   memory/pid caps. **Status: PASSED (5/5) on the owner's Docker host, 2026-07-06** after
   an assertion-3 harness fix (host bind mount → in-container file creation as `bench`).
   Evidence in `docs/adr/spike-002-record.md`. Both halves of the spike now pass; ADR-002
   is validated and WP3 is unblocked.

## Consequences

- Positive: mature coding capability on day one; Puppetmaster stays the harness; native
  fallback path remains open.
- Negative: an external-tool dependency in the product's flagship feature (version drift,
  auth/licensing per deployment — teams need their own CLI credentials); offline/local-only
  deployments without CLI access degrade to the native path with lower coding capability.

## Reconsider when

- The CLI's headless interface breaks `bench.delegate` twice in a quarter, **or**
- native-agent coding quality reaches parity on the WP9 golden suite (measured, pass^k),
  **or** a customer segment requires fully local execution with no external CLI — then
  promote the native path from fallback to default.

**Update (2026-07-08, ADR-008):** the "variety of provider / no lock to one vendor" facet of
these triggers is addressed without a rewrite — `bench.delegate` is now pluggable over a
`CodingCliAdapter` interface, shipping a `claude` and a provider-agnostic `aider` adapter. The
native-path-as-default question above remains open; it becomes a future adapter-or-none choice
rather than a re-architecture. See docs/adr/008-pluggable-coding-cli.md.
