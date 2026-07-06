# RESEARCH LEDGER — Architecture (Extension Session 1)
 
**July 2026.** Per plan §4. Evidence marks follow the session-1 ruling: **E2c (fetched)** = read live this session; **E2c (training-recall)** = book content recalled from training, not inspected — weaker, and load-bearing claims were cross-checked against a fetched source wherever one exists.
 
## A. Findings by source
 
### 1. Ford/Parsons/Kua/Sadalage — fitness functions — E2c (fetched: book excerpt PDF via Thoughtworks; InfoQ 2025 practitioner article; O'Reilly ch. 2 extract)
 
- Canonical definition, verbatim from the book via a fetched secondary: *"An architectural fitness function is any mechanism that provides an objective integrity assessment of some architectural characteristic(s)."* This is guide Invariant 2 pre-existing in the industry canon — architecture rules enforced by a check, not by reading and remembering. The bridge the plan predicted is real and direct.
- **Objectivity requirement** (fetched, InfoQ): "readability" is explicitly named a *bad* fitness function; good ones produce numbers/counts ("2 forbidden dependencies found"). This cleanly sorts session-1 scope: dependency direction, cycles, size budgets → deterministic; readability/naming/intent → [judgment — review gate]. The industry source draws the same verifiable/judgment line the plan drew independently.
- **No universal fitness functions** (fetched, gotopia interview): Parsons, asked for "the fitness functions for a banking application": *"no."* Characteristics are per-project. Direct corroboration for the plan's constraints-not-patterns, declared-per-project framing — from the source that invented the concept.
- **Innovation-stage caveat** (fetched, InfoQ): in the *explore* stage, fitness functions "might impose too much unwanted direction"; broad guardrails in stage 2; narrow in stage 3. This is the fetched anchor for the YAGNI side of the mandatory conflict table, and the direct mitigation for the "over-constraining small projects" failure mode.
- Book mechanics (fetched extract): JDepend import-direction test as the book's own first example — the historical original of `/arch-verify`'s whole category. Continuous-deployment pipelines as the enforcement point.
- **Outcome claims** ("prevents degradation over time") — treated per plan §1 as E3-grade: plausible, no controls, not load-bearing.
### 2. ArchUnit / dependency-cruiser / import-linter — tool layer — E2 (live docs & repo docs, fetched extracts)
 
- **ArchUnit** (JVM): rules as unit tests (`noClasses().that().resideInAPackage("..backend..").should().dependOnClassesThat().resideInAPackage("..frontend..")`), `layeredArchitecture()` preset, `slices().should().beFreeOfCycles()`. Runs inside JUnit — i.e., inside the existing test suite, which means inside the existing `test-gate.sh` with zero new machinery.
- **dependency-cruiser** (JS/TS): config with `forbidden` / `allowed` / `required` rule arrays over path regexes; `depcruise --init` ships defaults (no-circular, no-orphans, missing-in-package.json, prod-code-on-devDeps); CLI exit-code semantics fit a shell verifier directly. Severity levels (`error`/`warn`/`info`) enable a **ratchet** on legacy code: tolerate the current count, block increases.
- **import-linter** (Python): `layers`, `forbidden`, `independence` contract types in a declarative config; `lint-imports` CLI reports KEPT/BROKEN per contract. The `layers` contract is literally "declare the layer order, imports may only point downward" — the spec section's dependency-direction declaration maps onto it one-to-one.
- Cross-tool synthesis: all three consume the same input shape — *a declared set of territories and an allowed-direction matrix*. That shape is therefore what the SPEC.md section must force the project to produce. **The spec section is designed backward from the tools' input format** — that is the session's central design move, because it makes "too vague to translate into a rule" a mechanical test for architecture theater.
### 3. Martin, *Clean Architecture* — E2c (training-recall), used critically per plan
 
- **The verifiable core:** the Dependency Rule — source-code dependencies point only inward, toward higher-level policy; nothing inner knows anything outer. As a *direction constraint over declared territories* it is exactly lintable (all three tools above).
- **The contested remainder** (marked contested, not inherited): mandatory interface/boundary ceremony at every layer crossing, framework-independence as a general goal, entity/use-case layer separation as universal. Cost: indirection, file count, cognitive overhead — disputed by the simplicity camp for small/medium systems. No controlled evidence on either side's outcome claims.
- Per plan §1's conflict rule → tradeoff table + per-project decision hook (companion doc §2). Not resolved in the guide.
### 4. Fowler — YAGNI / simplicity camp; PoEAA as vocabulary — E2c (training-recall; the *stage* counterweight is covered by the fetched item in #1)
 
- YAGNI: presumptive features/abstractions cost build, carry, and repair; add structure when the second concrete use exists, not when it's foreseen. Design Stamina Hypothesis: *some* design payoff threshold exists — YAGNI is not "no design," it's "no speculative design." Both positions are consistent with declared-per-project ceremony.
- PoEAA supplies reviewer vocabulary only (layering terms, gateway/repository/service names) — per the locked framing, patterns never appear as compliance rules.
### 5. SOLID — E2c (training-recall), decomposed per-claim per plan
 
| Principle | Verifiability | Session-1 disposition |
|---|---|---|
| Dependency direction (DIP, and the Dependency Rule generally) | **Checkable** — import-direction lint | Enters `/arch-verify` |
| Acyclic dependencies (ADP, from the same lineage) | **Checkable** — cycle detection is a default in all three tools | Enters `/arch-verify` |
| Single responsibility | Partially — size/complexity budgets are a checkable *proxy*, honesty required that the proxy is weak | Size budgets enter spec section; SRP itself → review gate |
| Open-closed, Liskov, interface segregation | Judgment | Reviewer vocabulary only, [judgment — review gate] |
 
### 6. C4 model — E2c (fetched: c4model.com abstractions pages + FAQ)
 
- Hierarchy: system context → containers (runtime units: app, db, SPA) → components (grouping of related functionality, not separately deployable) → code. Explicitly notation- and tooling-independent; explicitly *not* org constructs (packages, JARs).
- FAQ insight worth keeping: the value is the *small fixed set of named abstractions* forcing precision ("is 'the database' a container or a component?" forces you to say what you mean).
- **Session-1 use, per the confirmed scope ruling: expression structure only, no diagram deliverable.** The spec section's declarations are organized at C4's *container* and *component* levels (what runs, and what territories exist inside each runnable) — because those are exactly the two levels the fitness tools operate on. Code-level (L4) is explicitly out: the guide's constraints stop where lintability stops.
### 7. LLM-specific architecture anti-patterns — **E4 / field-observed** (honesty mark the plan's own §4 needs)
 
The plan asserts "LLMs specifically over-apply patterns (unnecessary abstraction layers, factory-for-everything, premature interfaces)." Evidence status: widely reported practitioner observation, consistent with this project's own field logs (worked-examples Example 4's over-eager scaffolding is adjacent), **not measured anywhere in the corpus**. The skill's gotchas are therefore marked E4/field-observed and written to be falsifiable by the user's own sessions — if a gotcha never fires, prune it (guide §5 escalation rule applied to skill content).
 
## B. Cross-cutting synthesis
 
1. **Fitness functions are Invariant 2 with thirty years of prior art.** The strongest finding: the industry's architecture-governance canon and the guide's verifier principle are the same idea, independently converged — which upgrades confidence in both, the same way §4.7's convergent architecture did. And the canon's own objectivity test ("readability is a bad fitness function") pre-draws the deterministic/judgment boundary this session needed.
2. **Design the spec section backward from the verifier's input format.** All three tools consume "territories + allowed-direction matrix." Forcing the spec to produce that shape makes vagueness mechanically detectable: *if `/arch-verify` cannot translate a declaration into a rule, the declaration failed the section.* This is the anti-theater mitigation the plan asked to be designed in-session — and it's a verifier on spec quality, not a prose exhortation.
3. **The conflict is real and stays open.** Ceremony-vs-simplicity has no evidence-based winner (both sides' outcome claims are uncontrolled). What *is* decidable: dependency direction is checkable at every point on the spectrum; the spectrum only varies how much structure gets declared. So the decision hook declares a position; the verifier enforces whatever was declared. Default leans simple for one fetched reason (explore-stage caveat) and one E4 reason (LLM over-application) — stated as a default, not a ruling.
4. **Zero new gate machinery is needed.** `test-gate.sh` already loops `scripts/verify-*.sh`; `/arch-verify` just has to *produce* `scripts/verify-arch.sh`. The fitness tool rides the existing rung-5 gate — the "standing tax" failure mode is structurally prevented, not just warned against.
5. **Legacy needs a ratchet, not a gate.** A legacy codebase fails any honest dependency rule on day one. dependency-cruiser's severity tiers / known-violations support the pattern: baseline the current violation count, block only *increases*, burn the baseline down via the trainee loop. Without this, `/arch-verify` on legacy is unusable and will be deleted — the tool docs supply the mechanism.
## C. Dispositions
 
| Source | Disposition |
|---|---|
| Building Evolutionary Architectures | Core concept fetched via excerpts; full-book depth not needed — the definition, objectivity test, and stage caveat carry the session |
| Clean Architecture | Training-recall; dependency rule extracted, ceremony marked contested; conflict table in companion §2 |
| Fowler bliki (YAGNI, Design Stamina) | Training-recall, positions uncontroversial; fetched stage-caveat substitutes as the anchored counterweight |
| PoEAA | Vocabulary only, no further reading needed |
| SOLID | Decomposed per-claim (table above); no source reading beyond recall required |
| C4 | Fetched (c4model.com); expression structure only, diagrams out of scope |
| Tool docs (ArchUnit, dependency-cruiser, import-linter) | Fetched extracts sufficient for the selection rule; live docs win at run time (rot banner applies) |
| JMolecules, SonarQube, eslint-boundaries, Nx module boundaries, ts-arch | Noted as alternates in the selection table; not researched in depth — the deliverable is the selection *rule*, not a tool census |
 
Research pass closed. Deliverable: `ai-sdlc-architecture.md` + integration diffs to `ai-sdlc-unified-pipeline.md` (v1.0 → v1.1).