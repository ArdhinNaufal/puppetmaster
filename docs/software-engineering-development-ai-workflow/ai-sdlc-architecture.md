# Architecture Layer — Companion to the AI SDLC Workflow Guide
 
**Version 1.0 — July 2026.** Extension session 1 deliverable. Tracks guide v1.3 and unified pipeline v1.1. Framing locked per plan: **constraints, not patterns** — patterns appear only as reviewer vocabulary; every rule below either names its deterministic verifier or is marked **[judgment — review gate]**.
 
> **Activation note (read first).** Everything in this doc is **on-demand**: spec sections activate at `/spec` time, the skill loads only on structural work, `/arch-verify` runs once per feature after `/stack`, and the fitness check rides the *existing* `test-gate.sh` loop. **Net standing-context cost: 0 lines.** Nothing here is loaded into every session — if you find yourself pasting this doc into CLAUDE.md, you are re-creating the ECC failure (guide §5, E4).
 
> **Rot banner.** Tool names, config syntax, and CLI flags below are the rot-prone layer. Verify against each tool's live docs before running; where this doc and live docs disagree, the docs win.
 
---
 
## 0. The one idea this layer adds
 
Architecture rules were already Invariant 2 waiting to be applied: the industry's own canon defines an architectural fitness function as *"any mechanism that provides an objective integrity assessment of some architectural characteristic(s)"* (E2c fetched, Ford/Parsons et al.) — a verifier, not a prose rule. The same canon supplies the boundary this doc obeys: objective measures (dependency counts, cycle detection, size numbers) can be gated; *"readability" is explicitly a bad fitness function* (E2c fetched) and belongs to the review gate.
 
So the layer splits cleanly:
 
| Concern | Instrument | Rung |
|---|---|---|
| Territories, dependency direction, cycles, size budgets | Spec declaration → `/arch-verify` → `scripts/verify-arch.sh` → existing test gate | 3–5, deterministic |
| Responsibility fit, naming, intent, readability | Named failure classes in `/review` and the milestone gate | [judgment — review gate] |
 
There are no universal architecture rules in this doc, on the authority of the concept's own authors — asked for "the fitness functions for a banking application," Parsons answers *no* (E2c fetched). Every constraint below is **declared per project at spec time**, then enforced as declared.
 
---
 
## 1. The SPEC.md forcing sections
 
These replace the one-line "Code architecture" bullet in `/spec` and add the scalability declarations (carried from session 4 per the plan). The mechanism is unchanged from guide §4.1: required output sections pull the interview; the agent keeps asking until each can be filled **concretely**.
 
### 1.1 Code architecture (deepened)
 
Required declarations — the section is written backward from what a fitness tool can consume (territories + allowed-direction matrix), which is what makes vagueness detectable:
 
```
- Code architecture:
  * Runnables — every separately-running thing (app, API, worker, db) and
    its one-line job. (C4 "container" level.)
  * Territories — the modules/folders inside each runnable, each with ONE
    named responsibility. A territory whose responsibility needs "and" is
    two territories.
  * Dependency direction — the allowed-imports matrix: for each territory,
    which territories it MAY import. Everything not listed is forbidden.
    Cycles are forbidden by default; any exception must be named here.
  * Size budgets — max lines per file and max files per territory before a
    split is forced. Declared numbers, not adjectives.
  * Abstraction ceremony position — one of the three positions in §2,
    named explicitly, with one sentence on why for THIS project.
```
 
**Acceptance examples (the anti-theater device — include them in the section definition, same mechanism as the verification section's "show me a screenshot"):**
 
- ✅ Accepted: `"ui → services → data; shared ← anything; nothing imports ui; no cycles"` — translates directly into rules.
- ❌ Rejected: `"clean separation of concerns with modular layers"` — translates into nothing.
**The mechanical test:** a declaration passes this section **only if `/arch-verify` (§4) can translate it into a rule.** "Untranslatable" is the objective definition of architecture theater — a verifier on spec quality itself, not a hope (guide §10 repair pattern: hope → structure).
 
### 1.2 Scalability declarations (carried from session 4)
 
```
- Scale & operations:
  * Load profile — expected users/requests/data volume at launch, and the
    growth assumption for 12 months. Numbers or explicit "unknown."
  * SLOs — declared targets, or the honest declaration "none — best
    effort." Both are valid; silence is not.
  * Scaling strategy + known ceiling — the deliberate simplest design and
    the point it breaks: "single VM + Postgres holds to ~N concurrent
    users / ~M GB; past that, re-architect X."
```
 
Two rules attach: (a) building past the declared profile is out of scope by default — premature scale machinery is the §5 anti-example in infrastructure form; (b) **no declared numbers → the session-4 load-test verifier will refuse to run**, and that refusal is correct behavior, not a bug. The ceiling declaration becomes an ADR in session 3's mechanism.
 
---
 
## 2. The ceremony conflict — tradeoff table + decision hook (mandatory, plan §1)
 
The first genuine E2c collision, surfaced rather than resolved:
 
| | **Structure-first** (Clean/hexagonal camp — E2c training-recall, Martin; contested portions marked) | **Simplicity-first** (YAGNI camp — E2c training-recall, Fowler; fetched stage-caveat anchor) |
|---|---|---|
| Core claim | Boundaries + inward-only dependencies + interfaces at crossings keep change cheap as the system grows | Speculative structure costs build/carry/repair; add abstraction at the *second* concrete use, not the foreseen one |
| What it buys | Substitutable infrastructure, testable core, decay resistance | Velocity, less indirection, code an LLM (and a newcomer) can hold in view |
| What it costs | Ceremony: more files, more indirection, interfaces with one implementation | Refactoring debt when scale arrives; tighter framework coupling |
| Evidence honesty | Outcome claims ("maintainability," "decay prevention") are **uncontrolled on both sides** — E3-grade at best. The only decidable part: dependency direction is checkable at *every* point on the spectrum. | Same. Plus one fetched data point favoring restraint early: in the explore stage, fitness constraints "impose too much unwanted direction" (E2c fetched). |
| AI-specific factor | — | LLMs are field-observed to over-apply structure unprompted (E4 — reported widely, measured nowhere; see §7). A structure-first declaration *amplifies* the model's own worst habit; a declared budget caps it. |
 
**Decision hook — the spec's "abstraction ceremony position," one of three:**
 
1. **Direct** — no internal layering beyond territories; framework APIs used natively. For: small tools, explores, anything Track A ships. Most of §1.1 collapses to territories + no-cycles.
2. **Pragmatic layers** *(default when the project can't argue otherwise)* — territories + one-way dependency direction; interfaces only where a second implementation *exists* (a real test double counts).
3. **Ports & adapters** — core isolated behind declared ports; infrastructure behind adapters; direction strictly inward. For: long-lived systems, teams, planned infrastructure substitution. Earns its ceremony or doesn't get it.
Per the conflict rule: the guide states the default and its two reasons (fetched stage-caveat + E4 over-application) — and then the project decides, in writing, per feature-set. `/arch-verify` enforces whichever position was declared; it never argues for one.
 
---
 
## 3. The architecture skill (on-demand — never standing context)
 
`.claude/skills/architecture-constraints/SKILL.md`. Gotchas-first per guide §7: everything the model already knows about architecture is omitted; only what pushes it off its defaults is encoded. **All gotchas are E4/field-observed — falsifiable by your own sessions; prune any that never fires (guide §5).**
 
```yaml
description: Structural constraints for design and implementation work in
  this project — territories, dependency direction, size budgets, and the
  declared ceremony position from SPEC.md. Load when creating modules,
  moving code between territories, adding layers or interfaces, or when a
  task says architect, structure, restructure, or reorganize. Do NOT load
  for single-file scripts, throwaway explorations, copy edits, or tasks
  that change no import statements.
```
 
```markdown
# Architecture constraints
 
Read the Code-architecture section of SPEC.md first. The declared
territories, allowed-imports matrix, size budgets, and ceremony position
are binding. Do not exceed the declared ceremony position — extra
structure is a spec violation here, exactly like an extra data field.
 
## Gotchas — the defaults you (the model) must resist
 
- **Speculative generality.** No interface, base class, or factory with
  one implementation, unless the ceremony position is ports-&-adapters
  AND the port is declared in SPEC.md. A real test double counts as a
  second implementation; an imagined future one does not.
- **Pattern reflex.** Do not introduce a named pattern (factory,
  strategy, repository, observer) unless the constraint forcing it can be
  stated in one sentence — and then state it in a comment at the site.
- **God-module drift.** Nothing lands in utils/, helpers/, common/, or
  shared/ without naming the ≥2 territories that need it. One consumer →
  it lives in that consumer's territory.
- **Layer skipping.** Only the allowed-imports matrix authorizes an
  import. "It's just one function" is how the matrix dies. If the matrix
  genuinely blocks the task, STOP and surface the conflict as a spec
  decision — never route around it.
- **Config sprawl.** New config values go in the project's one declared
  config surface. Do not invent a second env-file, settings module, or
  constants dump because it's nearer.
- **Wrapper reflex.** No wrapper class around a library used in one
  territory. Wrappers are earned by the second consuming territory or by
  a declared port — not by tidiness.
 
## When the constraints hurt
 
If a declared constraint makes the current task materially worse, do NOT
silently comply or silently violate. Present the conflict: the
constraint, the cost, the two ways out (change the spec / change the
approach). Constraint changes are spec changes and get decided by the
human.
```
 
Extraction law still applies (guide §7): if your sessions surface a *new* recurring structural failure, iterate to a win in conversation first, then append it here as a gotcha.
 
---
 
## 4. `/arch-verify` — the selection step (deterministic layer)
 
Run **once per feature, after `/stack`**, same session. Like `/stack`, it recommends and waits — it installs nothing without confirmation (Invariant 1.5 discipline applied to dev-dependencies).
 
`.claude/commands/arch-verify.md`:
 
```
Read the Code-architecture section of SPEC.md and the Tech-stack section.
 
1. TRANSLATE: convert every declared constraint (dependency direction,
   cycle rule, size budgets) into checkable rules. If any declaration
   cannot be translated into a rule, STOP and report it as too vague —
   that section of the spec has failed and must be re-interviewed. Do
   not paper over vagueness with an invented rule.
 
2. SELECT the fitness tool for the declared stack:
   - JS/TS → dependency-cruiser (forbidden/allowed rules over path
     regexes; init defaults give no-circular + no-orphans)
   - Python → import-linter (layers / forbidden / independence contracts)
   - JVM → ArchUnit (rules run inside the existing test suite — if so,
     skip step 4; the test gate already covers it)
   - Other/none of the above → write a minimal AST- or grep-based checker
     for the allowed-imports matrix. The tool is secondary; the
     deterministic check is the deliverable.
   Name the tool and show me the generated config mapping each SPEC
   declaration to its rule. Size budgets: implement as a script check
   (line/file counts per territory), not prose.
 
3. LEGACY RATCHET: if the codebase predates the constraints, run the
   check once, record the current violation count as a committed
   baseline, and configure the gate to fail only on INCREASES. Burning
   the baseline down is backlog work (trainee loop), not a day-one gate.
 
4. WIRE: create scripts/verify-arch.sh that runs the tool and exits
   non-zero on violations (or on baseline increase). Do not touch
   test-gate.sh — it already loops scripts/verify-*.sh, so the check is
   picked up by the existing gate with zero new machinery.
 
5. Present the tool choice, the config, the baseline (if legacy), and
   the exact install command. WAIT for my confirmation before installing
   or committing anything.
```
 
Three properties are load-bearing:
 
- **Step 1 is the theater detector.** Translation failure is the objective signal the spec section was filled with prose. It routes back to the interview, not forward into a fake gate.
- **Step 4 costs zero standing machinery.** No new hook, no MCP, no always-on layer — the check rides the gate that already exists. This is the structural answer to the "fitness tool becomes a standing tax" failure mode, not a warning about it.
- **Step 3 is what makes legacy adoption survivable.** An honest dependency rule fails a 12-year codebase on day one; a gate that always fails gets deleted within a week. The ratchet (tolerate current count, block increases — supported natively by severity tiers/known-violations in the tool layer, E2) converts an unusable wall into a one-way door.
**pass@k/pass^k placement (guide §3, Invariant 2):** dependency direction is a pass^k property — it must hold on *every* change, forever, and erodes silently one import at a time ("death by a thousand cuts" is the tool literature's own phrase, E2). That is why it gets a deterministic gate rather than reviewer vigilance, and why the reviewer's architecture attention (§5) is freed for what only judgment can see.
 
---
 
## 5. Review-gate failure classes — [judgment — review gate], all of them
 
Appended to the `/review` bracket and the milestone gate. These are the classes the deterministic layer is structurally blind to; naming them is what makes the review attack them instead of re-checking what the gate already checked:
 
- **Ten-minute test:** a competent new hire understands this territory's role, boundaries, and one main flow in ten minutes of reading. [judgment]
- **Names carry intent:** the reader learns what a thing is *for* from its name, not from opening it. [judgment]
- **No unexplained cleverness:** anything non-obvious carries a comment naming the constraint that forced it. Presence of the comment is checkable; sufficiency is [judgment].
- **Abstraction earns its keep:** every interface/base class/generic names its ≥2 real consumers on request. Semi-checkable (an implementation count script can flag suspects); the verdict is [judgment].
- **Compliance without gaming:** the diff satisfies the declared constraints *without* having edited the fitness config or the baseline. The config-untouched part is checkable (`git diff` on the config paths — see §7); whether an *approved* config change was legitimate is [judgment].
Prose exhortations about these five would violate acceptance invariant 2. As named review-attack targets, they are the honest form: judgment, located at the gate built for judgment.
 
---
 
## 6. Integration diffs — `ai-sdlc-unified-pipeline.md` v1.0 → v1.1 (applied)
 
| # | Where | Change |
|---|---|---|
| 1 | §1.4 `spec.md` command | "Code architecture" line replaced with §1.1's five declarations; "Scale & operations" section added (§1.2); acceptance-example note added to the design rationale |
| 2 | §1.4 (new) | `.claude/commands/arch-verify.md` added (full text, §4 above) |
| 3 | §1.5 `test-gate.sh` | **No change** — `verify-arch.sh` is picked up by the existing `scripts/verify-*.sh` loop; a one-line comment records this so nobody adds duplicate wiring |
| 4 | §3 Phase 1 | Run order becomes `/spec` → `/stack` → `/arch-verify`, same session |
| 5 | Phase 4 `/review` guidance | §5's failure classes added to the bracket-filling instructions |
| 6 | §8 tree | `scripts/verify-arch.sh` and the fitness-tool config (+ optional `arch-baseline`) added, marked per-stack |
| 7 | §10 table | Three rows added: architecture theater, fitness-config gaming, day-one legacy wall |
| 8 | Header | Version bump to 1.1 with changelog line |
 
Standing-context delta: **0 lines** to CLAUDE.md or any always-loaded file (ruling 2: command files and skills are on-demand). Invariant 1 satisfied with margin.
 
---
 
## 7. Known failure modes (seeded — populate from field use, guide §10 practice)
 
| Symptom | Why | Fix | Status |
|---|---|---|---|
| Spec architecture section filled with untranslatable prose (theater) | Vague words are cheaper than decisions | `/arch-verify` step 1 refuses and routes back to interview — translation failure is the detector | Mitigation designed; **unfielded** |
| Small project drowning in ceremony | Constraints imported wholesale instead of declared | Ceremony position "direct" collapses §1.1 to territories + no-cycles; every constraint is a spec-time choice | Mitigation designed; unfielded |
| Fitness tool becomes standing tax | Tool wired as new always-on layer | Structurally prevented: rides existing `verify-*.sh` loop; no hook, no MCP | Prevented by construction |
| Agent edits fitness config/baseline to make red turn green | Same shape as editing tests to pass a refactor (session-2 gotcha, anticipated) | Config + baseline paths added to `/review`'s checkable list (`git diff` on them must be empty or explicitly approved); candidate PreToolUse hook **only if it bites twice** | Anticipated; hook deliberately not shipped |
| Day-one gate failure on legacy → gate deleted | Honest rules vs. 12 years of violations | §4 step 3 ratchet: baseline current count, block increases only | Mitigation designed; unfielded |
| False positives on generated/vendored code | Checker sees code no one owns | Exclusion paths in the tool config, declared at `/arch-verify` time | Known tool-layer issue (E2) |
| Skill gotchas that never fire | Anti-patterns asserted (E4), not measured | Prune per guide §5 — each gotcha is individually falsifiable by your sessions | Honesty mark, by design |
 
---
 
## Appendix — evidence register additions (for guide Appendix B)
 
| Source | Class | Role |
|---|---|---|
| Ford/Parsons/Kua/Sadalage, *Building Evolutionary Architectures* (definition, objectivity test, stage caveat — via fetched excerpts/interview) | **E2c (fetched)** | Fitness-function concept = Invariant 2's industry twin; the deterministic/judgment boundary; the explore-stage counterweight |
| c4model.com (abstractions + FAQ) | **E2c (fetched)** | Container/component levels structure §1.1's declarations; diagrams excluded by scope ruling |
| dependency-cruiser / import-linter / ArchUnit docs | **E2** | Selection table, rule shapes, ratchet mechanism; live docs win |
| Martin, *Clean Architecture* | **E2c (training-recall), contested portions marked** | Dependency Rule = the verifiable core; ceremony = one side of §2's open conflict |
| Fowler (YAGNI, Design Stamina, PoEAA) | **E2c (training-recall)** | Simplicity side of §2; reviewer vocabulary |
| SOLID | **E2c (training-recall), per-claim** | Decomposed: direction/cycles checkable → §4; the rest → §5 |
| "LLMs over-apply structure" | **E4 / field-observed** | Skill gotchas; default-lean in §2 — falsifiable, prunable |
 
*Maintained the way the guide preaches: on-demand by construction, verifiers named, conflicts surfaced, and its own failure modes logged before the first field session.*