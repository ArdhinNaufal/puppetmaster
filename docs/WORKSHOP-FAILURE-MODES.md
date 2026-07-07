# Workshop — corpus failure-mode mapping ledger

**Version 1.0 — 2026-07-06.** WP9.1 deliverable (docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP9):
every row of the corpus's failure-mode tables mapped to a disposition — **no silent
drops**. Sources: `ai-sdlc-workflow-guide.md` §10, `ai-sdlc-unified-pipeline.md` §10, and
the §7/§6 tables of the four layer companions in
`docs/software-engineering-development-ai-workflow/`.

Maintained the way the corpus preaches: when a deferred row's machinery lands, upgrade its
disposition here in the same commit; when field use discovers a new failure mode, append
it with a disposition or an honest OPEN mark.

## Dispositions

| Mark | Meaning |
|---|---|
| **EVAL** | Pinned by a named golden task (pass^3, `pnpm eval`) — deterministic regression |
| **LINTER** | Deterministic graph-lint rule (named code) |
| **DESIGN** | Prevented by construction — the failure has no code path (mechanism named) |
| **REVIEW** | Named judgment class in the Workshop Reviewer persona / review gate — the corpus itself marks these [judgment]; a deterministic check would be theater |
| **EARNED** | Deliberately not automated until the failure bites (the corpus's own escalation rule); interim mitigation named |
| **DEFERRED(WPn)** | Machinery rides a future work package; interim mitigation named. These are the plan's accepted-risks-until-WPn (risk register §9 points here) |

## 1. Unified pipeline §10 (subsumes guide §10 rows 1–5)

| # | Failure mode | Disposition |
|---|---|---|
| P1 | Interview anchors on the repo name, not the description | DEFERRED(WP5 interview flow) — needs real-model sessions to pin. Interim: Interviewer persona clause ("the operator's description is the ONLY source of truth; ignore project or repo names") + P2's output gate catches the damage |
| P2 | Interview covers some topics deeply, skips others | **EVAL** `workshop-spec-gate-theater-refusal` — the spec-sections gate refuses a spec with missing/thin sections; coverage is pulled by required output sections, not hoped for |
| P3 | Agent asks theoretical questions when code already exists | DEFERRED(WP5 + WP3) — grounded interviewing needs the workbench to read. Interim: Interviewer persona contract; spec-sections still gates the output |
| P4 | New session doesn't know where the last one stopped | **DESIGN** — project state lives in `project_artifacts`/todos, not conversation (ADR-003/004); `project.todo.next` is the resume surface. Repo-level: HANDOFF §0 resume ritual (WP0) |
| P5 | Spec updated but todos not | **EVAL** `workshop-verify-gate-pass` / `workshop-verify-gate-escalates` — the todo-sync check as a verify gate |
| P6 | Agent declares done but result is wrong (self-preferential bias) | Split: deterministic side **LINTER** `gated-without-verify` + `gated-agent-without-verify` (a gated agent cannot reach terminal without a gate); judgment side DEFERRED(WP5 e2e) — Reviewer independence via `agent.ask` exists, the builder≠reviewer trajectory assertion rides the real EXECUTE path |
| P7 | Gate fires but agent keeps failing the same way (8-block override) | **EVAL** `workshop-verify-fix-loop-bounded` — bounded loop, then escalation approval with the full run history as evidence; override recorded honestly (`overridden: true`, `verify.override` audit) |
| P8 | CLAUDE.md rules ignored (file too long, rules drowning) | DEFERRED(WP6) — product analog is lean personas + on-demand knowledge packs (0 standing lines) with usage-audited pruning. Interim: the three seeded personas are deliberately short contracts |
| P9 | MCP stack eating context | **DESIGN** — per-agent `toolGrants` scope the catalog per agent (Invariant 1.5's product analog); the seeded Workshop agents carry narrow grants |
| P10 | Architecture section is untranslatable prose (theater) | Split: spec-concreteness half **EVAL** `workshop-spec-gate-theater-refusal`; translation-to-fitness-rules half DEFERRED(WP3 arch check). Interim: Interviewer persona requires checkable declarations ("'clean separation of concerns' fails") |
| P11 | Agent edits fitness config/baseline to make red turn green | DEFERRED(WP3) — the config lives in the workbench. Interim: Foreman/Reviewer personas name it ("never edit verify checks, baselines, or test expectations to make a gate pass"); check mutations are admin-only REST, audited (`project.check.update`); repo-level `/review` command flags verifier edits (WP0) |
| P12 | Day-one arch gate failure on legacy code → gate deleted | **DESIGN** (mechanism) + DEFERRED(WP3) (usage) — `verify_checks.baseline` is the ratchet column; this repo's own `scripts/verify-arch.sh` implements tolerate-count/block-increase (WP0, acceptance-tested) |
| P13 | Agent "refactors" code with no test coverage → success by absence | DEFERRED(WP3+WP5 refactor variant — coverage precondition needs the workbench's coverage tool). Interim: repo-level `/refactor` command enforces the contract for our own development (WP0) |
| P14 | Agent edits test expectations to make refactored code pass | **EVAL** (WP3b.6) — `refactor-gate` check runs `git diff --diff-filter=M --name-only HEAD`, blocks when a *modified* file matches the test-path patterns; added tests pass. Golden tasks `refactor-gate-blocks-test-edit-local` / `-passes-added-test-local` at pass^3 |
| P15 | Agent rewrites instead of refactoring (delete + recreate) | **REVIEW** — "wholesale rewrite" is a named Reviewer attack class; the corpus marks it [judgment]. WP3 adds the partially-deterministic deleted-and-recreated diff signal |
| P16 | Agent scope-creeps ("while I'm in here…") | **REVIEW** — "scope expansion beyond the named target" is a named Reviewer class; WP3's refactor variant adds the diff-paths-vs-target check |
| P17 | Coverage passes but the area is under-tested (coverage theater) | **REVIEW** — necessary-not-sufficient per the corpus; the deterministic check catches zero-coverage (WP3), quality stays with the review gate |

## 2. Architecture layer §7

| # | Failure mode | Disposition |
|---|---|---|
| A1 | Spec architecture theater | = P10 |
| A2 | Small project drowning in ceremony | **REVIEW** — ceremony position is a spec-time declaration; "abstraction earns its keep / every abstraction names its second consumer" is a named Reviewer class |
| A3 | Fitness tool becomes a standing context tax | **DESIGN** — checks ride verify nodes executed per-mission; nothing loads into every tick's context. The corpus's "prevented by construction" claim holds structurally here |
| A4 | Fitness config/baseline gaming | = P11 |
| A5 | Day-one legacy wall | = P12 |
| A6 | False positives on generated/vendored code | DEFERRED(WP3) — exclusion paths belong to the workbench check config (`verify_checks.command`); the schema already carries the field |
| A7 | Skill gotchas that never fire | DEFERRED(WP6) — knowledge packs ship with usage auditing so unfired gotchas get pruned (the corpus's own honesty mark) |

## 3. Refactoring layer §7

| # | Failure mode | Disposition |
|---|---|---|
| R1 | Coverage threshold as theater | = P17 |
| R2 | Tests edited to game behavior-preservation | = P14 |
| R3 | Wholesale rewrite disguised as refactoring | = P15 |
| R4 | Scope creep | = P16 |
| R5 | Tangled refactor commits (structure + behavior mixed) | DEFERRED(WP3/WP5 refactor variant — commit-shape checks need workbench git). Interim: "tangled-refactoring-commit" is a named Reviewer class; repo-level two-hats rule in `/refactor` (WP0) |
| R6 | Characterization tests assert wrong behavior | **REVIEW** — the corpus marks this [judgment]: the operator reviews characterization tests before the refactor begins; no deterministic fix exists and pretending otherwise would be theater |
| R7 | Refactor gate false positive on test-file moves (git M+A) | EARNED — same shape as the corpus's answer: the escalation approval prevents deadlock (a human can override with the evidence in view); refine path-matching only if it bites twice |

## 4. Documentation layer §7

| # | Failure mode | Disposition |
|---|---|---|
| D1 | Plausible-but-wrong generated docs pass the presence check | **REVIEW** — the corpus is explicit that no deterministic fix exists; generated docs are reviewed before commit. Honesty is the mitigation |
| D2 | Documentation debt accumulates in gated mode | EARNED — the docs-drift check is an earned policy (needs a declared code→doc mapping, WP3 workbench); until then the Reviewer's "stale documentation" class is the interim |
| D3 | Retroactive ADR (reconstructed context, fabricated alternatives) | Split: **DESIGN** for practice (this repo's ADR-006/007 are explicitly marked Retroactive — the convention forces the disclosure); product-side timestamp check (ADR artifact vs. mission timeline) DEFERRED(WP6 record phase) |
| D4 | Mega-ADR (design doc stuffed into a decision record) | **REVIEW** — one-page size guard is judgment; the ADR-000 convention states it |
| D5 | Docs-drift mapping goes stale → false alarms | EARNED — the mapping file is itself an earned artifact; a stale mapping firing on every change is the signal to fix or delete the mapping (corpus's own design note) |
| D6 | Quadrant contamination (tutorial full of reference matter) | **REVIEW** — pure judgment per the corpus (the Diátaxis compass); lands in WP6's documentation pack as reviewer vocabulary |
| D7 | Doc generation without a documentation plan | **DESIGN** (when WP6 lands) — the doc-generation pack refuses without a declared plan section, same refusal pattern as the spec-sections/disabled-check gates already pinned by `workshop-verify-disabled-fails-closed` |

## 5. Scalability layer §6

| # | Failure mode | Disposition |
|---|---|---|
| S1 | Scalability guidance triggers on projects that merely mention "performance" | DEFERRED(WP6) — negative triggers in the scalability pack require concrete Scale & operations numbers; the spec-sections gate already forces that section to exist concretely (**EVAL** coverage via `workshop-spec-gate-theater-refusal`) |
| S2 | Load-test thresholds invented rather than traced to declared SLOs | **EVAL** (WP3b.6) — the `load` check refuses (throws, fail-closed) without declared `slos`; never passes by absence. Golden task `load-refuses-without-slos-local` at pass^3 (the pass path `load-passes-with-slos-local` runs the declared command) |
| S3 | Premature scaling infrastructure (cache/queue/replicas before measured failure) | **REVIEW** — "premature scaling" is a named Reviewer class, informed by presence/absence of load-test evidence (corpus marks it [judgment]) |
| S4 | Stateful process replicated without externalizing state | **REVIEW** — named Reviewer class; partially checkable once the workbench can inspect session/state code (WP3+) |
| S5 | Ceiling ADR without a populated "Reconsider when" | DEFERRED(WP6 record phase) — the record-phase check refuses an accepted scaling ADR without the trigger field. Interim: ADR-000 convention requires it for this repo's own ADRs (all eight comply) |
| S6 | Load test only ever runs against localhost | **REVIEW** — dev/prod parity is judgment; the WP3 verifier's TARGET_URL prerequisite surfaces it but cannot judge representativeness |
| S7 | Pack gotchas that never fire | = A7 |

## 6. Coverage summary

50 source rows (guide §10: 5, pipeline §10: 17, architecture §7: 7, refactoring §7: 7,
documentation §7: 7, scalability §6: 7) → **37 unique failure modes** after cross-table
subsumption. Primary dispositions across the 37:

**6 EVAL** (P2, P5, P7, P10, P14, S2 — P14/S2 upgraded from DEFERRED by WP3b.6's
refactor-gate + load checks) · **1 LINTER** (P6's deterministic half) · **6 DESIGN**
(P4, P9, P12, A3, D3, D7) · **11 REVIEW** (P15–P17, A2, R6, D1, D4, D6, S3, S4, S6 —
all rows the corpus itself marks [judgment]) · **3 EARNED** (R7, D2, D5) ·
**10 DEFERRED** (P1, P3, P8, P11, P13, A6, A7, R5, S1, S5 — mostly WP3-bound, each
with a named interim mitigation).

Zero unmapped. Upgrading DEFERRED dispositions is part of each future WP's acceptance
from here on.
