# ADR-000: Adopt Architecture Decision Records

## Status

Accepted (2026-07-06)

## Context

The AI SDLC integration plan (docs/AI-SDLC-INTEGRATION-PLAN.md, WP0) adopts the workflow
corpus's documentation layer, whose ADR mechanism (Nygard template + "Reconsider when")
keeps decision rationale from evaporating between sessions — the failure this repo
currently absorbs into an ever-growing HANDOFF.md.

## Alternatives considered

- Keep everything in HANDOFF.md — rejected: it records *state*, not *decisions with
  alternatives*; it is rewritten each session, so rationale is lossy.
- Decision log table in ARCHITECTURE.md — rejected: no room for alternatives/consequences;
  edits overwrite history.

## Decision

Decisions that affect architectural structure, dependency direction, scaling strategy, or
module boundaries get a numbered ADR in `docs/adr/`, using the template embodied by this
file (Status / Context / Alternatives considered / Decision / Consequences / Reconsider
when). Accepted ADRs are immutable — a changed decision gets a new ADR that supersedes the
old one. ADRs longer than one page are design docs in disguise: link out instead.
Numbering is by creation order; ADRs documenting past decisions are marked **Retroactive**.

## Consequences

- Positive: rationale survives sessions and personnel; the Workshop feature (WP2+) reuses
  this exact convention for its own product ADR artifacts, so we dogfood the format first.
- Negative: one more artifact to keep honest; retroactive ADRs are reconstructions and say
  so rather than pretending contemporaneity.

## Reconsider when

ADRs stop being read (no ADR referenced in any PR or session for a quarter) — then the
practice is theater and should be cut or automated differently.
