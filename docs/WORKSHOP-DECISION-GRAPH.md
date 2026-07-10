# Workshop Decision Graph — research synthesis and implementation

**Status:** first traceability slice implemented 2026-07-10

## Context

The Workshop already had unusually strong SDLC primitives: versioned specs and plans,
mission-linked todos, append-only learnings, immutable accepted ADRs, deterministic verify
checks, and evidence-bearing approval gates. Its page did not connect those primitives into
an operator journey. It presented a flat dossier, so a reader could see *what* existed but
not reliably answer:

- Which plan or todo came from which current requirement or decision?
- What does an enabled check claim to verify?
- Which delivery items have lost their upstream context after an artifact revision?
- What is the most useful next move, without inventing another universal process gate?

## Research synthesis

| Evidence | Finding | Product implication |
| --- | --- | --- |
| Jeff Patton, [The New Backlog](https://jpattonassociates.com/the-new-backlog/) (2008, updated 2023) | A flat backlog loses goals, users, and the system journey; story maps preserve context and release slices. | Do not stop at a better todo list. Preserve the path from discovery context into delivery. |
| [From Ideas to Expressed Needs](https://conf.researchr.org/details/RE-2021/RE-2021-papers/15/From-Ideas-to-Expressed-Needs-an-Empirical-Study-on-the-Evolution-of-Requirements-du) (RE 2021) | Only part of final story content could be traced back to initial ideas; important content emerged in stakeholder conversation. | Capture provenance while decisions are made; it is unreliable to reconstruct afterward. |
| [Practitioners' perspectives on requirements traceability](https://link.springer.com/article/10.1007/s00766-023-00408-9) (2023) | Trace links are often manual and become stale; practitioners want repetitive work automated but links still human-validated. | Provide lightweight automation and warnings, but require a human-confirmed rationale for every link. |
| NASA, [SWE-072 Bidirectional Traceability](https://swehb.nasa.gov/spaces/7150/pages/16449898/SWE-072%2B-%2BBidirectional%2BTraceability%2BBetween%2BSoftware%2BTest%2BProcedures%2Band%2BSoftware%2BRequirements) (updated 2017) | Bidirectional requirement/test links support coverage and change-impact analysis. | Connect deterministic checks to the durable artifacts they verify and expose orphans. |
| [The Scrum Guide](https://scrumguides.org/scrum-guide.html) (2020) | Readiness emerges through ongoing refinement; the guide defines Product Goal, Sprint Goal, and Definition of Done commitments rather than a universal Definition of Ready. | Make Workshop readiness advisory. Existing deterministic verify checks remain the hard execution gates. |
| GOV.UK, [How the discovery phase works](https://www.gov.uk/service-manual/agile-delivery/how-the-discovery-phase-works) (updated 2021) | Discovery covers users, wider journeys, constraints, risky assumptions, success measures, and may conclude that work should not proceed. | Future graph nodes must represent evidence, assumptions, experiments, decisions, and outcomes—not only build tasks. |
| NIST, [Secure Software Development Framework 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) (2022) | Security practices usually need to be added explicitly to an SDLC. | Security/privacy/operational risk should become first-class Workshop lanes rather than implicit prose. |

## Research gap

The highest-value gap is not another workshop canvas. It is a continuously reviewable
reasoning chain across discovery and delivery:

`problem/evidence → assumption/constraint → decision → spec/plan → todo → check → outcome`

The repository currently has durable types for the middle and delivery end of that chain.
The safest first increment is therefore a **Decision Graph over existing durable artifacts
and checks**, followed later by first-class discovery and outcome nodes.

## Implemented solution — slice 1

### Durable, human-confirmed links

`project_trace_links` connects a project artifact or verify check to another artifact/check
using one directional relation:

- `informs` — evidence, learning, or a decision provides context;
- `derives` — a downstream plan or todo is derived from an upstream artifact;
- `verifies` — a deterministic check proves an artifact's intent;
- `mitigates` — a plan, todo, or check addresses a recorded risk/decision.

Every link requires a non-empty rationale. Endpoints are revalidated in the repository so
cross-project links, self-links, duplicates, and project-mismatched deletion fail closed.
Link creation and deletion are audited.

### Advisory readiness and orphan detection

The WORKSHOP page now derives a reviewable status from the *current* artifact versions:

1. the newest spec has concrete required sections;
2. the current plan is linked back to the current spec;
3. open todos retain upstream artifact context;
4. enabled checks are linked to what they verify.

The page shows trace coverage, confirmed-link count, orphan warnings, and a deterministic
"next move." This status is explicitly advisory; it does not bypass or replace verify
checks. A new spec or plan version does not inherit old links automatically. The old
reasoning stays in history while the new version becomes visibly unconfirmed.

### Self-contained operator workflow

Builders can now record or revise artifacts from the dossier and confirm/remove trace
links. Admins can add checks in the required disabled state, then enable them with an
earned-policy note. Project and artifact rows are keyboard-operable buttons, project-load
requests are race-guarded, and partial-load failures are visible rather than silently
swallowed.

### Integrity fixes made before exposing more mutations

- Verify-check ownership is checked before update, preventing cross-project mutation.
- Todo ownership is checked before completion through a project route.
- An enabled check requires a non-empty earned note in both REST and repository layers.

## Deliberate next increments

This slice does **not** pretend to complete the whole research model. The following remain:

1. first-class problem, user/evidence, assumption, experiment, decision, and outcome nodes;
2. story-map activities and end-to-end release slices;
3. project-scoped mission/conversation linkage and phase actions (interview, plan, execute,
   review, record);
4. check-run/evidence history and impact analysis when an upstream node changes;
5. explicit security, privacy, accessibility, legal, and operational risk lanes;
6. post-delivery metric reviews that feed outcomes back into assumptions and decisions.

Those increments should extend the same invariant: automation may propose or flag links,
but a durable reasoning edge remains attributable, reviewable, and historically honest.
