# RESEARCH LEDGER — Refactoring (Extension Session 2)
 
**July 2026.** Per plan §5. Evidence marks follow the session-1 ruling: **E2c (fetched)** = read live this session via web search/fetch; **E2c (training-recall)** = book content recalled from training, not inspected — weaker, and load-bearing claims were cross-checked against a fetched source wherever one exists. **E4 (fetched)** = external source, not independently verified beyond the fetch itself.
 
## A. Findings by source
 
### 1. Fowler, *Refactoring* 2nd ed. (2018) — E2c, strongest in the plan
 
**Fetched evidence:** Fowler's workflows-of-refactoring article on martinfowler.com; catalog at refactoring.com; book review summaries with direct quotes cross-checked across multiple independent reviews; Fowler's own "Second Edition" article on changes between editions.
 
**Training-recall (cross-checked):** book structure, two-hats metaphor, code-smell catalog, small-steps discipline, refactoring-workflow taxonomy.
 
Core claims used in this session:
 
- **Definition (the load-bearing one):** a change to internal structure that does not alter observable behavior. Fowler is explicit: if the behavior changed, it was not a refactoring. A refactoring *preserves bugs too* — if you fix a bug, you are not refactoring (E2c fetched, understandlegacycode.com, directly attributed). This is the contract the `/refactor` command enforces.
- **Two Hats (Kent Beck, presented in Fowler ch. 2):** at any moment you are either adding functionality or refactoring — never both. During refactoring, you add no new capability and do not add or change tests. During feature work, you do not restructure. You may swap hats frequently — but consciously, and one at a time (E2c fetched, multiple independent reviews all agree on this formulation). **This maps directly to the "never refactor and change behavior in the same commit" gateable rule.**
- **Small steps:** refactoring proceeds as a series of transformations each "too small to be worth doing," with the code compiling and tests passing after every step. The cumulative effect is significant; the small-step discipline keeps the code never-broken and makes errors trivially locatable (E2c fetched, martinfowler.com). **This is the justification for the pass^k classification of multi-step refactoring.**
- **Tests as precondition:** "Before you start refactoring, check that you have a solid suite of tests. These tests must be self-checking" (E2c fetched, multiple reviews attribute this to ch. 1). No test suite → no safe refactoring. **This is the coverage-precondition rule's E2c anchor.**
- **Workflow taxonomy (E2c fetched, martinfowler.com/articles/workflowsOfRefactoring):**
  - *TDD refactoring* — refactor step in red-green-refactor
  - *Litter-pickup* — camp-site rule, clean as you go
  - *Comprehension* — refactor to understand (cf. Feathers' characterization tests, different mechanism same impulse)
  - *Preparatory* — refactor to make the upcoming feature easier (Beck's "make the change easy, then make the easy change")
  - *Planned* — dedicated attention to a neglected area; necessary but a sign that opportunistic refactoring hasn't been happening enough
  - *Long-term* — multi-iteration replacement of a large subsystem
  
  **Session-2 mode mapping uses this taxonomy:** litter-pickup/comprehension/preparatory → opportunistic → supervised `/next`; planned/long-term → structural → gated `/loop`.
- **Code smells, 2nd ed. catalog — 24 smells (E2c, fetched changes list + training-recall):**
  Mysterious Name, Duplicated Code, Long Function, Long Parameter List, Global Data, Mutable Data, Divergent Change, Shotgun Surgery, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Loops, Lazy Element, Speculative Generality, Temporary Field, Message Chains, Middle Man, Insider Trading, Large Class, Alternative Classes with Different Interfaces, Data Class, Refused Bequest, Comments-as-deodorant. 4 new in 2nd ed. (Mysterious Name, Global Data, Mutable Data, Loops); 2 removed (Parallel Inheritance Hierarchies, Incomplete Library Class).
  
  **The skill uses these as its trigger vocabulary, not as compliance rules.** The smell names are the "phrases users actually say" in the skill description field — they trigger the skill's activation, not a pattern-compliance gate.
- **Refactoring catalog, 2nd ed. — 75 refactorings (E2c training-recall, catalog structure fetched at refactoring.com):**
  Organized into: basic (Extract Function, Inline Function, Extract Variable, etc.), encapsulation, moving features, organizing data, simplifying conditionals, refactoring APIs, dealing with inheritance. **These are reviewer vocabulary only — the deliverable does not prescribe which refactoring to apply.**
- **On commits:** Fowler recommends committing refactorings in isolation from behavior changes. The two-hats metaphor maps to separate commits: refactoring hat → commit with no test-expectation changes; feature hat → commit that may change tests (E2c fetched, multiple reviews). **This is the verifiable version of two-hats: `git diff` on test files in a refactor-tagged commit must be empty (or only additions of characterization tests).**
### 2. Feathers, *Working Effectively with Legacy Code* (2004) — E2c
 
**Fetched evidence:** understandlegacycode.com key-points summary; InfoQ 2021 interview with Feathers; bssw.io review; multiple Goodreads detailed reviews; GitHub gist notes from the book (jeremy-w).
 
**Training-recall (cross-checked):** Legacy Code Change Algorithm steps, characterization test definition, seam model, sprout/wrap techniques.
 
Core claims used:
 
- **Legacy code = code without tests (E2c fetched, Feathers' definition).** Not "old code" or "bad code" — code whose behavior cannot be verified because no tests protect it. This is the definition the coverage-precondition rule uses: if the refactor target has no test coverage, it is *legacy code by Feathers' definition*, and the first step is characterization tests, not transformation.
- **The Legacy Code Change Algorithm (E2c fetched, multiple sources agree on the 5 steps):**
  1. Identify change points
  2. Find test points (where behavior can be sensed)
  3. Break dependencies (carefully, with minimal code changes — *before* tests)
  4. Write tests (characterization tests documenting actual behavior)
  5. Make changes and refactor
  
  **Step 3 is the dangerous one for AI agents:** breaking dependencies requires "very conservative refactorings" done *without sufficient tests* — a necessary evil. The agent doing step 3 must not exceed the minimum change. This feeds the skill's gotcha on scope creep: the agent treats step 3 as license to restructure broadly.
- **Characterization tests (E2c fetched, Feathers' term, also called "pinning tests"):** tests that document what the code *actually does*, not what it *should* do. You write them by running the code, observing the output, and asserting that output. They capture current behavior including bugs. When the specification differs from actual behavior, go with actual behavior because users depend on it (E2c fetched, bssw.io). **The `/refactor` command's coverage-precondition routes to characterization tests, not to specification-derived tests, because the goal is to preserve current behavior, warts and all.**
- **Seams (E2c fetched, Feathers' definition):** "A place where you can alter behavior in your program without editing in that place." Types: object seams (interfaces, dependency injection), link seams (classpath substitution), preprocessing seams (macros). Object seams preferred. **Seams are the mechanism vocabulary for the skill, not a rule.** The skill names seams as the technique for making untested code testable before refactoring.
- **The paradox (E2c fetched):** you need tests to change code safely; you need to change code to add tests. The resolution is *minimal safe refactorings* that are too small to break things, applied to make the code testable. **This is the same small-steps discipline Fowler describes, applied in a harder context.** The agent's tendency to make large changes in step 3 is the specific AI failure this paradox predicts.
- **Scope discipline (E2c fetched, Feathers):** "The refactoring must not extend outside code that is sufficiently covered by tests." **This is a gateable constraint:** the diff of a refactor-tagged commit should not touch files that lack test coverage. The `/refactor` command makes this an explicit precondition check.
### 3. Beck, *Tidy First?* (2023) — E2c-borderline
 
**Fetched evidence:** multiple book reviews (henrikwarne.com, lethain.com, sandordargo.com, danlebrero.com, itnext.io, DEV Community); book summary at workingsoftware.dev.
 
**Training-recall:** minimal — this is a recent book with weaker consensus, and the plan explicitly asks to mark it as E2c-borderline.
 
This source is used where it adds something Fowler doesn't cover. It is never load-bearing for a verifier.
 
- **Tidying vs. refactoring — terminology distinction (E2c-borderline, fetched):** Beck coined "tidying" for the smallest-grain refactorings because "refactoring took fatal damage when folks started using it to refer to long pauses in feature development." A tidying is "the cute, fuzzy, little refactoring that nobody could possibly hate on." Scale: minutes, not hours. **The distinction is useful for the mode mapping:** tidyings are opportunistic by definition and never need the gated loop.
- **Structural changes vs. behavioral changes — sequencing (E2c-borderline, fetched):** Beck's central contribution is separating changes into S (structural, no behavior change) and B (behavioral). A PR should be a sequence like SSSSBBSB where each *commit* is purely S or purely B. **This is the two-hats rule at commit granularity — Fowler's idea, Beck's operationalization.** The `/refactor` command's commit rule is this, mechanized.
- **Separate PRs (E2c-borderline, fetched):** structural and behavioral changes should be in separate PRs or at minimum separate commits. The stated reason: code is easier to review, reason about, and revert when the two types don't mix. **Consistent with the two-hats commit rule but extends it to the PR level — our deliverable enforces at the commit level only (the PR level is org taste and out of scope).**
- **The "one hour" heuristic (E2c-borderline, fetched):** "More than one hour tidying at a time before making any behavioral changes likely means you have lost track of the minimum set of structural changes needed." **This is the scope-creep detector, stated as a heuristic.** The skill's gotcha turns it into an explicit warning: if the agent is still refactoring after a large number of steps without returning to feature work, it has likely drifted.
- **When not to tidy (E2c-borderline, fetched):**
  - If you are never going to touch the code again (very unlikely).
  - If you don't have enough time right now (list it for later — tidying later is a learning tool).
  - If the tidying doesn't make the upcoming change easier.
  
  **The cost-benefit framing is Beck's addition to Fowler.** Fowler doesn't provide explicit negative triggers for "when not to refactor." Beck does — and they feed the skill's "do NOT use for" section.
- **Outcome claims (discounted cash flows, optionality):** Beck frames tidying as creating options (future value) at a cost (present time). The option-pricing analogy is his theoretical contribution. **Treated as E3-equivalent: plausible framing, not load-bearing in this deliverable.**
### 4. AI agent refactoring failure modes — E4 (fetched)
 
**Fetched evidence:** "Agentic Refactoring" empirical study (Horikawa et al., Nara Institute/Queen's University, 2025, arxiv 2511.04824) — 15,451 refactoring instances across 12,256 PRs; "Refactoring Runaway" (arxiv 2605.22526); DEV Community article "Stop Letting AI Agents Go Rogue" (OpenSite, 2026); DEV Community "Scope Lock Prompt" (2026); Kiro blog "Refactoring made right" (2026).
 
These are external, but the mechanisms described are inspectable and consistent with the guide's existing findings on agentic laziness, scope creep, and self-preferential bias (guide §3, E2).
 
- **Tangled commits — the dominant failure shape (E4 fetched, Horikawa et al.):** 53.9% of agent refactoring instances occur in commits *without* explicit refactoring intent — mixed with feature/bug work. This is the two-hats violation at scale: agents do not naturally separate structural from behavioral changes. **The `/refactor` command's commit-separation rule directly addresses this.** The "Refactoring Runaway" paper (2605.22526) further finds that higher-autonomy frameworks produce more tangled refactorings than structured/pipeline-based frameworks.
- **Low-level dominance (E4 fetched, Horikawa et al.):** agent refactoring is dominated by rename/type-change operations (35.8% low-level vs. 24.4% for humans). Agents do fewer high-level structural changes than humans (43.0% vs. 54.9%). **This means agents are good at the tidying-scale changes Beck describes, but weak at the planned/structural refactoring Fowler describes.** The mode mapping reflects this: tidying-scale → `/next` is safe; structural → `/loop` with mandatory gates.
- **Scope creep — the "140 files" problem (E4 fetched, DEV Community 2026):** "You ask an AI agent to migrate my components to TypeScript. An hour later it has renamed your props, refactored three utility functions, installed two new packages, reorganized your folder structure, and changed your ESLint config 'while it was in there.' The task was 40 files. It touched 140." **Agents lack a scope reflex.** The `/refactor` command names the target explicitly and the skill's gotcha flags scope expansion.
- **Silent behavior change (E4 fetched, Kiro 2026):** "What should have been a 20-second refactor turns into a 5-minute debugging and cleanup session." Agents can produce diffs that look like refactorings but introduce subtle behavioral changes — missed call sites, broken imports, changed semantics. **The refactor gate (earned hook) detects this by comparing test results pre/post.**
- **Wholesale rewrite disguised as refactoring (E4 fetched, multiple):** instead of small-step transformation, the agent deletes the old implementation and writes a new one from scratch. The new version may be functionally equivalent — or may not. There is no chain of small behavior-preserving steps to audit. **This is the highest-risk AI failure mode for refactoring. The skill's gotcha names it explicitly; the small-steps discipline is the defense.**
- **Smell introduction (E4 fetched, Horikawa et al. + Cedrim et al. cited therein):** less than 10% of refactorings effectively remove code smells, while over 30% introduce new ones. Agent refactoring fails to consistently reduce design/implementation smell counts (median Δ = 0.00). **Coverage is necessary-not-sufficient: the code may pass tests but be structurally worse. This is the honest limit — the review gate, not a verifier, catches structural degradation.**
## B. Cross-cutting synthesis
 
1. **The behavior-preserving contract is the entire session.** All three E2c sources agree on one thing: refactoring = no behavior change. Fowler defines it; Feathers operationalizes it for untested code; Beck operationalizes it at commit granularity. Every verifier in this session is a different way of checking that contract.
2. **Tests are the precondition, not the safety net.** Fowler: "check that you have a solid suite of tests." Feathers: legacy code *is* code without tests, and you must add them *before* refactoring. The coverage-precondition rule follows directly: the `/refactor` command checks coverage first and refuses if coverage is insufficient. This is the session's most important AI-specific addition — the sources assume a human who *knows* they need tests; the agent will happily refactor uncovered code.
3. **Two hats, one commit.** Fowler states the principle. Beck operationalizes it as S/B commit sequencing. The AI evidence (Horikawa et al.) shows agents violate it in 53.9% of cases. The gateable verifier is: `git diff` on test-expectation files in a refactor-tagged commit must be empty (modulo characterization-test additions). This is the session's highest-confidence verifier — deterministic, cheap, directly from the E2c canon.
4. **Small steps discipline is the structural defense against wholesale rewrite.** Fowler's "too small to be worth doing" and Feathers' "minimal safe refactorings" converge: each step should be individually trivially-correct, with tests passing after every step. The agent failure mode of deleting and rewriting is the *opposite* of this discipline. The skill names it as the top gotcha; the mode mapping puts structural refactoring in `/loop` so the test gate runs after every step.
5. **Characterization tests solve the Feathers paradox for AI agents.** The agent can *write* characterization tests faster than a human (it reads the code, runs it, captures outputs). This makes Feathers' step 3 (break dependencies) less dangerous: the agent writes pinning tests first, then makes minimal changes. But the agent must not confuse "I wrote tests" with "coverage is sufficient" — coverage of the *specific refactor target* is the check, not global coverage.
6. **Beck adds the grain distinction Fowler lacks.** Fowler's taxonomy covers the *motivation* axis (preparatory, comprehension, planned) but not the *size* axis explicitly. Beck's tidying/refactoring split gives us the grain: tidyings (minutes, trivial risk) → supervised is fine; planned refactoring (hours, structural risk) → gated mandatory. This is the mode-mapping justification.
7. **Coverage-as-theater is a real risk.** High global coverage doesn't mean the refactor *target* is covered. The precondition check must be target-specific, not project-wide. The coverage tools (Istanbul/c8, coverage.py, JaCoCo — selected per `/stack`) support file/directory-level coverage reports. The `/refactor` command checks the *target area's* coverage, not the project average. This is necessary-not-sufficient, and the doc says so.
## C. Dispositions
 
| Source | Disposition |
|---|---|
| Fowler, *Refactoring* 2nd ed. | Core canon. Definition, two-hats, small-steps, tests-as-precondition, smell catalog, workflow taxonomy — all used. Refactoring catalog → reviewer vocabulary only. E2c (strongest). |
| Feathers, *Working Effectively with Legacy Code* | Legacy Code Change Algorithm and characterization tests used for the coverage-precondition route. Seams → skill vocabulary. Scope discipline → gateable constraint. E2c. |
| Beck, *Tidy First?* | Tidying/refactoring grain distinction and S/B commit sequencing used for mode mapping and commit rule. One-hour heuristic → scope-creep detector. Marked E2c-borderline per plan. Not load-bearing for any verifier. |
| Horikawa et al. (2025) | Empirical data on agent refactoring: tangled commits, low-level dominance, smell non-reduction. E4 (fetched). Mechanisms inspectable, consistent with guide's existing E2 findings on agent failure modes. |
| OpenSite / Scope Lock / Kiro articles | Practitioner reports on agent scope creep and wholesale rewrite. E4 (fetched). Used for skill gotchas. |
| Coverage tool docs (Istanbul/c8, coverage.py, JaCoCo) | Tool-layer, E2 (live docs). Not researched in depth — the `/stack` selection mechanism from Session 1 governs tool choice. Selection table in companion doc mirrors Session 1's pattern. |
 
Research pass closed. Deliverables: `ai-sdlc-refactoring.md` + integration diffs to `ai-sdlc-unified-pipeline.md` (v1.1 → v1.2).