# Refactoring Layer — Companion to the AI SDLC Workflow Guide
 
**Version 1.0 — July 2026.** Extension session 2 deliverable. Tracks guide v1.3 and unified pipeline v1.1 → v1.2. Framing locked per plan: **best verifier fit in the plan; aim for rung 5.** Every rule below either names its deterministic verifier or is marked **[judgment — review gate]**. Refactoring has the highest machine-verifiability profile in the plan — most rules here have deterministic checks, not judgment marks.
 
> **Activation note (read first).** Everything in this doc is **on-demand**: the `/refactor` command activates per-task, the skill loads only when triggered by code-smell vocabulary or explicit refactoring intent, the coverage-precondition check uses the project's `/stack`-declared coverage tool, and the refactor gate (earned hook) is installed only after silent behavior change has bitten. **Net standing-context cost: 0 lines.** Nothing here enters CLAUDE.md or loads into every session.
 
> **Verification ceiling honesty.** This session has the highest verifiability in the plan. The behavior-preserving contract can be checked deterministically (test results, test-file diffs). Coverage can be measured. Commit separation can be checked. What *cannot* be verified deterministically: whether the refactoring *improved* the code's structure — that is [judgment — review gate], and this doc says so.
 
> **Rot banner.** Coverage tool CLI syntax, test runner flags, and `git diff` options below are the rot-prone layer. Verify against each tool's live docs before running.
 
---
 
## 0. The one idea this layer adds
 
Refactoring is the oldest formalized behavior-preserving discipline in software engineering (Fowler, 1999/2018, E2c). Its entire contract reduces to one sentence: *change internal structure without changing observable behavior*. That contract is **directly checkable** — the test suite's results must be identical before and after (modulo timing and ordering). An AI agent asked to "refactor" without this contract enforced will violate it in over half of all commits (E4, Horikawa et al. 2025: 53.9% of agent refactoring instances appear tangled with behavioral changes).
 
So the layer adds **the contract as a gate, the coverage precondition as a check, and the separation rule as a verifier** — all riding the existing pipeline machinery.
 
| Concern | Instrument | Rung |
|---|---|---|
| Behavior preservation per commit | Test results identical pre/post; test-expectation files unchanged in refactor-tagged commits | 3–5, deterministic |
| Adequate coverage of refactor target | Coverage-precondition check before transformation begins; routes to characterization tests if below threshold | 3, deterministic |
| Refactor/feature separation | `git diff` on test files in refactor-tagged commits shows no expectation changes | 3–5, deterministic |
| Scope containment | Diff limited to named target; files outside target unchanged | [judgment — review gate] (scope is partially checkable via diff path inspection, but the boundary of "target" is judgment) |
| Structural improvement quality | Did the refactoring actually make the code better? | [judgment — review gate] — not pretending otherwise |
 
---
 
## 1. The `/refactor` command
 
`.claude/commands/refactor.md`:
 
```
Refactor the following: $ARGUMENTS
 
BEHAVIOR-PRESERVING CONTRACT — non-negotiable:
1. Run the FULL test suite FIRST. Record the results (pass/fail per test,
   total count). These are the "before" results.
2. Check test coverage of the refactor target using the project's declared
   coverage tool (per /stack). If coverage of the target area is below 70%
   line coverage:
   - STOP. Do NOT refactor yet.
   - Write characterization tests for the target area first: run the code,
     observe actual outputs, assert those outputs. These tests document
     current behavior, not desired behavior.
   - Re-check coverage after adding characterization tests. Proceed only
     when target coverage ≥ 70%.
3. Refactor in small steps. Each step:
   - Is a single, nameable transformation (e.g., "extract function
     calculateTotal from processOrder").
   - Compiles and passes the full test suite after the step.
   - Does NOT change observable behavior.
   - Is committed separately if in /loop mode.
4. After ALL steps: run the full test suite again. The results MUST match
   the "before" results — same tests, same pass/fail status, same count.
   If any test that previously passed now fails, you introduced a behavior
   change. Revert the failing step and retry.
5. NEVER edit test expectations in a refactor commit. If a test needs to
   change, that is a behavior change — switch hats, make a separate commit.
   The only exception: adding NEW characterization tests (step 2) in a
   preparatory commit before the refactor begins.
 
SCOPE LOCK:
- Only modify files in the named target area.
- If you discover issues outside the target, list them at the end as
  "noticed but not changed" — do NOT fix them in this refactor.
- If you find yourself wanting to rename/restructure things "while you're
  in there" beyond the named target, STOP. That is scope creep.
 
WHAT COUNTS AS THE TARGET:
The target is exactly what $ARGUMENTS names — a function, a class, a
module, a directory. Nothing more. If the target is ambiguous, ask before
starting.
 
After completing, show:
- The "before" test results (count and status)
- The "after" test results (count and status)
- The list of transformations applied (one line each)
- Coverage of the target area before and after
```
 
### 1.1 Design rationale
 
The command encodes three E2c principles as mechanical steps:
 
**Tests as precondition (Fowler, Feathers).** Step 1 runs the suite before any change. Step 2 checks coverage of the specific target, not the project average. The 70% threshold is a starting default, not an empirically derived number — projects may adjust it in SPEC.md. The key insight is *target-area* coverage: a project with 90% global coverage may have 0% coverage of the exact module being refactored. The precondition checks *that module* (E2c, Feathers: "The refactoring must not extend outside code that is sufficiently covered by tests").
 
**Small steps (Fowler, Beck).** Step 3 enforces Fowler's "too small to be worth doing" discipline. Each step is nameable and independently passes. The cumulative effect is the refactoring; the small steps make errors trivially locatable. This is the structural defense against the wholesale-rewrite failure mode: the agent cannot delete everything and rewrite because each intermediate state must pass.
 
**Two hats, one commit (Fowler, Beck).** Step 5 is the verifiable two-hats rule. In a refactor-tagged commit, `git diff` on test files must show no expectation changes. This is the session's highest-confidence verifier — deterministic, cheap, mechanically checkable. Characterization tests (new test *files*, not changed expectations in existing tests) are the sole exception, and they go in a preparatory commit before the refactor commits begin.
 
### 1.2 Coverage precondition — tool selection
 
The coverage tool follows `/stack`'s existing selection mechanism (per the session kickoff ruling). The `/refactor` command uses whatever coverage tool the project's `/stack` declared:
 
| Stack | Coverage tool | Target-area command pattern |
|---|---|---|
| JS/TS (Jest) | Istanbul/c8 (built into Jest) | `jest --coverage --collectCoverageFrom='<target-glob>'` |
| JS/TS (Vitest) | c8/Istanbul (built into Vitest) | `vitest run --coverage --coverage.include='<target-glob>'` |
| Python | coverage.py | `coverage run --source=<target-module> -m pytest <target-tests> && coverage report` |
| JVM (Maven) | JaCoCo | `mvn test -pl <module>` with JaCoCo agent; inspect `target/site/jacoco/index.html` for package coverage |
| JVM (Gradle) | JaCoCo | `./gradlew test jacocoTestReport`; inspect package-level coverage in report |
| Go | built-in | `go test -coverprofile=cover.out ./<target-package>/... && go tool cover -func=cover.out` |
 
**If the stack lacks a declared coverage tool, the `/refactor` command asks the operator to declare one before proceeding.** It does not guess. The tool table above is illustration, not prescription — live docs win.
 
### 1.3 Characterization test route (Feathers)
 
When coverage is below threshold, the command routes to characterization tests before any refactoring begins. The characterization test procedure:
 
1. Identify the public entry points of the target area.
2. Call each entry point with representative inputs (observed from existing callers, test data, or constructed from type signatures).
3. Capture the actual outputs — return values, side effects, error conditions.
4. Write tests asserting *those actual outputs*. Not what the spec says the output should be. Not what you think the output should be. What it *actually is*.
5. Run with coverage. Iterate until the target area meets the threshold.
6. Commit the characterization tests as a separate preparatory commit *before* any refactor commits.
**The agent is good at this.** It can read the target code, identify entry points, construct inputs, and capture outputs faster than a human. This is the Feathers paradox resolved for AI agents: the agent adds tests without deep understanding, then refactors with those tests as a safety net.
 
---
 
## 2. The refactoring skill
 
`.claude/skills/refactoring/`:
 
**`description.md`:**
 
```
Refactoring guidance — behavior-preserving code transformation.
 
USE when: the task involves restructuring existing code without changing
behavior. Trigger phrases: "refactor", "clean up", "extract", "inline",
"rename", "move", "simplify", "reduce duplication", "code smell",
"technical debt cleanup", "tidy", "restructure."
 
Also triggers on any Fowler smell name: Long Function, Duplicated Code,
Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery,
Divergent Change, Large Class, Long Parameter List, Speculative
Generality, Message Chains, Middle Man, Mysterious Name, Global Data,
Mutable Data, Repeated Switches.
 
Do NOT use for:
- Bug fixes (changing behavior is not refactoring)
- Feature additions (adding capability is not refactoring)
- Performance optimization that changes observable timing/behavior
- "Refactoring" that is actually a rewrite (deleting and recreating)
- Migration to a new framework (that is a feature change, not a refactor)
```
 
**`SKILL.md`:**
 
```
# Refactoring Skill — Gotchas First
 
## The contract (memorize this)
A refactoring changes internal structure WITHOUT changing observable
behavior. Tests pass identically before and after. If behavior changed,
it was not a refactoring — revert and separate the concerns.
 
## AI-specific failure modes (the reason this skill exists)
 
### 1. Wholesale rewrite disguised as refactoring [HIGHEST RISK]
You delete the old implementation and write a new one "that does the same
thing." This is NOT refactoring — it is a rewrite. There is no chain of
small behavior-preserving steps to verify. The new version may introduce
subtle behavioral differences.
 
INSTEAD: Apply named transformations one at a time. Each step should be
individually trivial-to-verify. "Extract function X from Y" is a step.
"Rewrite Y" is not.
 
### 2. Scope creep beyond the named target
You are asked to refactor function A. While working, you notice function
B could also be improved. You fix B too. Now your diff is larger than
expected, harder to review, and may introduce changes the operator didn't
ask for.
 
INSTEAD: List what you noticed about B at the end ("noticed but not
changed"). Stay in the named target.
 
### 3. Silent behavior change disguised as cleanup
You rename a variable, and in the process "fix" a conditional that looked
wrong. Or you extract a function and "improve" its error handling. These
are behavior changes hiding inside a refactoring commit.
 
INSTEAD: If you see a bug, note it. Fix it in a SEPARATE commit with
the feature/fix hat on. The refactor commit must preserve behavior,
including bugs.
 
### 4. Editing tests to make them pass
The refactoring broke a test. Instead of reverting the refactoring step,
you edit the test to match the new behavior. This defeats the entire
safety net.
 
INSTEAD: If a test fails after a refactoring step, the step changed
behavior. Revert the step, not the test.
 
### 5. Refactoring without adequate test coverage
You refactor a function that has zero test coverage. The refactoring
"succeeds" because no tests fail — but no tests fail because no tests
exist. Behavior may have changed silently.
 
INSTEAD: Use the /refactor command, which checks coverage first. If
coverage is insufficient, write characterization tests before refactoring.
 
## Code-smell vocabulary (trigger, not prescription)
 
When you detect these in code you're working on, the refactoring skill
is relevant. The smell tells you WHERE to look; the specific
transformation is chosen based on the code, not prescribed by the smell.
 
Common smells and typical (not mandatory) responses:
- Long Function → Extract Function, Decompose Conditional
- Duplicated Code → Extract Function, Slide Statements
- Feature Envy → Move Function
- Data Clumps → Extract Class, Introduce Parameter Object
- Primitive Obsession → Replace Primitive with Object
- Shotgun Surgery → Move Function, Combine Functions into Class
- Large Class → Extract Class, Extract Superclass
- Long Parameter List → Introduce Parameter Object, Preserve Whole Object
- Speculative Generality → Inline Function/Class, Collapse Hierarchy
- Middle Man → Inline Function, Remove Middle Man
 
These are reviewer vocabulary from Fowler's catalog (E2c). They are
NOT compliance rules — "this code has Feature Envy" does not mean
"apply Move Function." It means "look at this area; it may benefit from
restructuring."
 
## Characterization tests (Feathers)
When you need to refactor code that lacks tests:
1. Identify public entry points of the target.
2. Call them with representative inputs.
3. Capture actual outputs.
4. Assert those outputs — you are documenting what the code DOES,
   not what it SHOULD do.
5. These tests go in a preparatory commit BEFORE refactor commits.
 
## Sequencing discipline (Beck, E2c-borderline)
Structural changes (S) and behavioral changes (B) go in separate
commits. A refactoring session produces: [S, S, S, S] — all structural.
If a behavior change is needed, switch hats: close the refactoring,
commit, then start a new behavioral commit. Do not mix S and B in one
commit.
```
 
---
 
## 3. Mode mapping
 
Refactoring maps to the pipeline's existing mode switch (supervised vs. gated autonomous) based on **grain and risk**:
 
| Refactoring type | Fowler workflow | Beck grain | Pipeline mode | Why |
|---|---|---|---|---|
| Litter-pickup / comprehension / preparatory | Opportunistic | Tidying (minutes) | Supervised (`/next`) | Low risk; operator reviews after each task; single-step or few-step |
| Planned / long-term / structural decomposition | Planned | Refactoring (hours) | Gated (`/loop`) with test-gate mandatory | **pass^k task** — every step must preserve behavior; multi-step refactor compounds failure risk per guide §3's asymmetry |
 
**The pass^k classification of multi-step refactoring is the key insight.** A single rename that passes tests is pass@1 — fine. A 15-step Extract Class refactoring where *every* step must preserve behavior is pass^k with k=15. Per guide §3, a task that must hold under pass^k cannot be trusted to self-review (rungs 1–2) — it needs the test gate (rung 3+). The test gate runs `scripts/verify-*.sh` after every step in `/loop` mode, which includes the full test suite. If any step breaks a test, the loop blocks.
 
**The `/refactor` command does not select the mode** — the operator does, based on the task's grain. The command works in either mode. But the skill's description marks planned/structural refactoring as "recommended: use `/loop`" because the mode is what makes the pass^k safety net real.
 
---
 
## 4. Refactor gate (earned hook)
 
**This hook is NOT installed on day one.** Per the plan's earned-policy rule (guide §5): add it only after silent behavior change during a refactoring has bitten you. The hook's existence in this document is a *design*, not a deployment instruction.
 
`.claude/hooks/refactor-gate.sh` — Stop hook:
 
```bash
#!/usr/bin/env bash
# .claude/hooks/refactor-gate.sh — Stop hook (EARNED — install only
# after silent behavior change in a refactor has bitten you)
#
# Blocks session end if refactor-tagged work modified test expectations.
# The check: in files touched since the last non-refactor commit, are
# there changes to test files that alter expectations (not just add new
# characterization tests)?
 
# Only run if the commit message or branch name contains "refactor"
COMMIT_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if ! echo "$COMMIT_MSG $BRANCH" | grep -qi "refactor"; then
  exit 0  # Not a refactor-tagged change; skip
fi
 
# Check for modified (not added) test files
# M = modified, not A = added (new characterization tests are OK)
MODIFIED_TESTS=$(git diff --name-only --diff-filter=M HEAD -- \
  '*test*' '*spec*' '*__tests__*' '*.test.*' '*.spec.*' \
  'tests/' 'test/' 'spec/' | head -5)
 
if [ -n "$MODIFIED_TESTS" ]; then
  echo "REFACTOR GATE: Test expectation files were MODIFIED in a refactor-tagged commit:" >&2
  echo "$MODIFIED_TESTS" >&2
  echo "" >&2
  echo "In a refactoring commit, test expectations must not change." >&2
  echo "If behavior needs to change, make a separate non-refactor commit." >&2
  echo "If these are characterization tests being updated, tag the commit" >&2
  echo "as 'characterization' not 'refactor'." >&2
  exit 2  # Block
fi
 
exit 0
```
 
### 4.1 Design notes
 
**What it checks:** modified (not newly added) test files in refactor-tagged commits. New test files (characterization tests) are permitted because they are *added* (git status `A`), not *modified* (`M`). This matches the contract: you may add characterization tests before refactoring, but you may not change existing test expectations during refactoring.
 
**What it doesn't check:** whether the *code* changes actually preserved behavior. That's what the test suite is for. The hook checks the *shape* of the commit (did you edit tests in a refactor commit?), not the *content* of the transformation.
 
**Granularity of the ruling (from kickoff):** the hook checks pass/fail at the test-file-modification level, not byte-identical stdout. Per the ruling: same pass/fail status per test case, no test removals, no test-expectation edits. The hook implements the "no test-expectation edits" part. The "same pass/fail" part is enforced by the `/refactor` command itself (step 4).
 
**The 8-block override applies** (guide §7, E2): this hook is a strong nudge, not an absolute wall. After 8 consecutive blocks, the agent overrides. That's a feature, not a bug — it prevents deadlock on false positives (e.g., a test file that moved paths and git reports as M+A).
 
**Connection to Session 1:** the architecture companion's failure-modes table already names "agent edits fitness config to make violations pass" as "same shape as editing tests to pass a refactor" and adds the config paths to `/review`'s checkable list. This hook is the refactoring-specific instance of that pattern.
 
---
 
## 5. E2c conflict: Fowler's small-steps vs. Beck's tidying-first sequencing
 
The plan's mandatory conflict rule (§1) requires surfacing E2c tensions as a tradeoff table, not silently resolving them.
 
**The tension:** Fowler's small-steps discipline says: run tests after every step, never break the code, each step is "too small to be worth doing." Beck's tidying-first says: batch structural changes before behavioral changes, and if tidying takes more than an hour you've lost track. These *mostly* agree but diverge on one question: **do you commit each micro-step, or batch tidyings into one commit?**
 
| Position | What it optimizes | What it costs | When it wins |
|---|---|---|---|
| **Commit per step (Fowler strict)** | Maximum auditability; every step independently revertable; `git bisect` works at the transformation level | Commit noise; slower; harder to review a long series of micro-commits | High-risk structural refactoring; legacy code; any case where the refactor target is poorly understood |
| **Batch tidyings, commit once (Beck)** | Cleaner commit history; faster; PR review sees the net result not the journey | Harder to pinpoint which step broke something if a test fails; cannot bisect within the batch | Low-risk tidyings; well-understood code; small scope |
 
**Decision hook (per-project, declared in workflow):** the operator chooses. The `/refactor` command works either way — in `/loop` mode each step is naturally a gate point (commit-per-step), while in `/next` mode the operator decides the commit granularity. The default leans toward commit-per-step for gated mode (Fowler strict) because multi-step refactoring is a pass^k task. For supervised mode, batching is fine because the operator is watching.
 
**This is NOT a conflict in the "Clean Architecture vs. YAGNI" sense** (Session 1's conflict was about incompatible philosophies). This is a sequencing-granularity question where both positions are valid and the choice is operational, not philosophical. Marked as a tension, not a deep conflict.
 
---
 
## 6. Integration diffs — unified pipeline v1.1 → v1.2
 
### 6.1 New command file
 
**Add:** `.claude/commands/refactor.md` (§1 above) to the command-file list in pipeline §1.4 and the quick-reference sequence.
 
### 6.2 Skill addition
 
**Add:** `.claude/skills/refactoring/` (§2 above) to the skills directory in pipeline §8's convergent architecture tree, alongside the existing `architecture-constraints/` skill.
 
### 6.3 Mode-mapping addition to pipeline §2
 
**Add** to the mode-selection guidance in pipeline §2 (after the existing pass@k/pass^k discussion):
 
> **Refactoring mode rule:** opportunistic refactoring (litter-pickup, comprehension, preparatory — minutes, small scope) → supervised `/next`. Planned or structural refactoring (hours, multi-step, or touching multiple modules) → gated `/loop` with test-gate mandatory. Multi-step refactoring is a pass^k task: every step must preserve behavior, and unreliability compounds. See `ai-sdlc-refactoring.md` §3.
 
### 6.4 Review-gate failure classes
 
**Add** to the `/review` command's failure-class list:
 
- **Tangled refactoring commit** — a commit tagged as refactoring that also contains behavioral changes (test expectations modified). Verifier: `git diff --name-only --diff-filter=M` on test files. [Deterministic]
- **Refactoring without coverage** — the refactor target had insufficient test coverage and no characterization tests were added before the refactoring began. Verifier: coverage report on target area. [Deterministic]
- **Scope expansion** — the refactoring diff touches files outside the named target area. Verifier: compare diff paths to declared target. [Partially deterministic; boundary judgment for shared utilities]
- **Wholesale rewrite** — the diff shows a file deleted and recreated rather than incrementally transformed. No chain of small behavior-preserving steps. [judgment — review gate]
### 6.5 Known failure modes additions to pipeline §10
 
**Add:**
 
| Symptom | Why | Fix |
|---|---|---|
| Agent refactors code with no test coverage → "refactoring succeeded" (no test failures because no tests exist) | Agent doesn't check coverage before refactoring; absence of failure ≠ success | `/refactor` command checks target-area coverage first; routes to characterization tests if below 70% |
| Agent edits test expectations to make refactored code pass | Same shape as editing fitness config (Session 1 gotcha) — agent "fixes" the safety net instead of fixing the code | Refactor gate (earned hook) blocks if test files are modified (not added) in refactor-tagged commits |
| Agent rewrites instead of refactoring (deletes old, writes new) | Agent lacks small-steps discipline; rewriting is faster than incremental transformation | Skill gotcha #1 names this explicitly; `/review` checks for deleted-and-recreated files |
| Agent scope-creeps during refactoring ("while I'm in here…") | Agent lacks a scope reflex (E4: "the task was 40 files, it touched 140") | `/refactor` command's SCOPE LOCK clause; skill gotcha #2 |
| Coverage check passes but target area is still under-tested (coverage-as-theater) | High coverage of trivial paths (happy path only), edge cases uncovered | Necessary-not-sufficient — the coverage check catches the worst case (zero coverage); the review gate catches quality |
 
### 6.6 Convergent architecture tree update
 
**Add** to pipeline §8's project tree:
 
```
├── .claude/
│   ├── commands/
│   │   ├── refactor.md          # behavior-preserving refactoring (on-demand)
│   │   └── ...existing...
│   ├── skills/
│   │   ├── refactoring/         # code-smell vocabulary, AI gotchas, characterization tests
│   │   └── ...existing...
│   ├── hooks/
│   │   ├── refactor-gate.sh     # (EARNED) blocks test-expectation edits in refactor commits
│   │   └── ...existing...
```
 
### 6.7 Version bump
 
`ai-sdlc-unified-pipeline.md` version: **v1.1 → v1.2.** Version line update:
 
> **Version 1.2 — July 2026.** [...] **v1.2 adds:** the `/refactor` command (behavior-preserving contract with coverage precondition and scope lock), the `refactoring` on-demand skill (code-smell vocabulary and AI-specific failure modes), refactoring mode-mapping rule (opportunistic → supervised, structural → gated), four new review-gate failure classes for refactoring, the refactor gate (earned Stop hook blocking test-expectation edits in refactor commits), and five new failure modes. See `ai-sdlc-refactoring.md` for the companion doc. Standing-context delta: 0 lines (all additions are on-demand).
 
---
 
## 7. Known failure modes (seeded)
 
Per plan §2 invariant 6. Seeded from the plan's anticipated modes plus research findings. To be populated by field use.
 
| # | Failure mode | Verifier | Status |
|---|---|---|---|
| 1 | **Coverage threshold as theater** — high coverage of trivial paths, edge cases uncovered. A module at 80% line coverage that only tests the happy path gives false confidence. | Necessary-not-sufficient: the coverage check catches zero/low coverage; edge-case adequacy is [judgment — review gate] | Anticipated (plan §5) |
| 2 | **Agent edits tests to game "behavior-preserving"** — tests modified so refactored code passes, defeating the safety net. | Refactor gate (earned hook): `git diff --diff-filter=M` on test files in refactor-tagged commits blocks if test expectations were modified | Anticipated (plan §5) |
| 3 | **Wholesale rewrite disguised as refactoring** — agent deletes the old implementation and writes a new one. No small-step audit trail. May silently change behavior. | Skill gotcha #1; `/review` checks for deleted-and-recreated files. [Partially deterministic, partially judgment] | Anticipated (research, E4) |
| 4 | **Scope creep** — agent refactors beyond the named target, touching code the operator didn't ask about. | `/refactor` SCOPE LOCK clause; skill gotcha #2. [judgment — review gate] for boundary cases | Anticipated (research, E4) |
| 5 | **Tangled commits** — refactoring mixed with feature/bug work in the same commit, making it impossible to verify behavior preservation. | Refactor gate checks commit tagging. But the deeper fix is the two-hats discipline in the command itself. | Anticipated (research, E4: 53.9% incidence) |
| 6 | **Characterization tests are wrong** — agent writes tests that assert incorrect behavior because it misunderstood the code or tested with unrepresentative inputs. | [judgment — review gate] — the operator must review characterization tests before the refactoring begins. The tests assert actual behavior, but "actual" depends on the inputs chosen. | Anticipated |
| 7 | **Refactor gate false positive on test-file moves** — git reports a moved test file as M (modified) + A (added), triggering the hook on a legitimate structural change. | The 8-block override prevents deadlock; the operator can approve. Candidate improvement: refine the hook's path matching. | Anticipated |
 
---
 
## 8. Acceptance invariant checklist (self-verification)
 
| # | Invariant | Status |
|---|---|---|
| 1 | Standing-context ≤ 10 lines | **Pass.** 0 lines. All additions are on-demand: command file, skill, earned hook. |
| 2 | Every rule names its verifier or is marked [judgment — review gate] | **Pass.** Behavior preservation → test results + test-file diff. Coverage → tool report. Structural improvement quality → explicitly marked [judgment — review gate]. |
| 3 | No pattern-compliance rules | **Pass.** Code smells are trigger vocabulary, not compliance rules. Refactoring catalog is reviewer vocabulary. No rule says "use Extract Method" — rules say "test results must match" and "test expectations must not change." |
| 4 | Every E2c conflict → tradeoff table + decision hook | **Pass.** §5: Fowler commit-per-step vs. Beck batch-tidyings, with tradeoff table and per-project decision hook. |
| 5 | Integration diffs are explicit | **Pass.** §6: command file, skill, mode-mapping addition, four review-gate failure classes, five failure modes, tree update, version bump — all named. |
| 6 | Known failure modes section, seeded | **Pass.** §7: seven failure modes, seeded from plan's anticipated modes and research findings. |
| 7 | Evidence marks on every substantive claim | **Pass.** Every source claim carries E2c/E2c-borderline/E4 + (fetched)/(training-recall). |
| 8 | On-demand parts explicitly marked | **Pass.** Activation note at top; command is per-task; skill loads on trigger; hook is earned-only. |