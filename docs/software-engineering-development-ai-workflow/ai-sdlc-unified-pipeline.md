# Unified Pipeline — Software Engineer, Pro Plan
 
**Version 1.2 — July 2026.** A single comprehensive pipeline for a software engineer who can read diffs, write tests, and judge behavior — but operates under Pro-plan token constraints that rule out Pipeline C's dynamic workflows (rung 6). Derived from `ai-sdlc-pipelines.md` Pipelines A and B; tracks guide v1.3. **v1.1 added:** deepened SPEC.md "Code architecture" forcing sections, "Scale & operations" spec sections, the `/arch-verify` command, the `architecture-constraints` on-demand skill, named review-gate failure classes, and three new failure modes. See `ai-sdlc-architecture.md`. **v1.2 adds:** the `/refactor` command (behavior-preserving contract with coverage precondition and scope lock), the `refactoring` on-demand skill (code-smell vocabulary and AI-specific failure modes), refactoring mode-mapping rule (opportunistic → supervised, structural → gated), four new review-gate failure classes for refactoring, the refactor gate (earned Stop hook blocking test-expectation edits in refactor commits), and five new failure modes. See `ai-sdlc-refactoring.md` for the companion doc. Standing-context delta: 0 lines (all additions are on-demand).
 
This is not two pipelines stapled together. It is one pipeline with a **mode switch** — supervised or gated autonomous — chosen per-task by asking one question: *does this task need to work once, or every time unattended?*
 
> **Rot banner.** The *structure* (specify → plan → execute → verify → record) is durable. The *syntax* of slash commands, hook events, and flags is the rot-prone layer. Before running any command/hook below, verify against `code.claude.com/docs`. Where this doc and the live docs disagree, the docs win.
 
---
 
## 0. What you provide vs. what the agent does
 
Across both modes, your inputs are exactly three kinds: **interview answers**, **choices** when the agent surfaces a domain/risk decision, and **evidence review** at gates. Everything between those points is automated.
 
| You provide | The agent does |
|---|---|
| Interview answers (once per feature) | Restates understanding, interviews you, writes `SPEC.md` |
| Confirm or adjust the MCP/CLI recommendation | Applies Invariant 1.5 to the declared tech stack |
| One edit to the plan (gated mode) or confirm-before-each-task (supervised mode) | Explores in plan mode, proposes plan, creates todos |
| Review evidence at each stop | Implements, writes + runs tests, produces screenshots/evidence, updates todos + learnings, **stops** at the mode-appropriate boundary |
| Approve the merge / send back | Merges or re-runs |
 
**What stays manual by necessity (identical to every track):**
 
| Cannot be automated | Why |
|---|---|
| **The interview** | Your domain/risk/scope judgment. The agent cannot invent your retention policy or your definition of "done." |
| **The review gate** | The *enforcement* of the gate is automated (hooks, test scripts). The *judgment* of whether the result is right is yours. |
 
---
 
## 1. One-time setup (do once per project, ~30 min with the agent)
 
### 1.1 Environment
 
1. **Make a project folder** containing nothing you can't lose (or use an existing repo). Open Claude Code there. Run `/init` to seed `CLAUDE.md`.
2. **Permissions:** keep **default permissions** for the first week. That approval-per-action prompt is tedious and also the only way to build intuition for what the agent actually does. Two hard rules (guide §6, E2):
   - **Never** use `--dangerously-skip-permissions`. It exists for isolated containers you control. That is not a Pro-plan web session.
   - Auto mode only while you are actively watching — it has documented false negatives.
3. **Initialize git** if not already a repo. Hooks and the artifact-sync gate depend on `git diff`.
### 1.2 CLAUDE.md discipline (guide §7, E2)
 
If you have an existing `CLAUDE.md`, put it on a diet *now*, before you start using this pipeline:
 
```
Apply the pruning test "would removing this cause the agent to make
mistakes?" to every line of CLAUDE.md. Delete anything readable from
code, any platitude ("write clean code"), any frequently-changing list,
any file-by-file description. Show me the diff.
```
 
**What survives** (the canonical include/exclude table):
 
| Include | Exclude |
|---|---|
| Build/test/deploy commands the agent can't guess | Anything readable from the code itself |
| Style rules that differ from language defaults | Standard conventions the model already knows |
| Testing instructions and preferred runners | Detailed API docs (link instead) |
| Repo etiquette: branch naming, PR conventions | Frequently-changing information |
| Environment quirks and required env vars | File-by-file codebase descriptions |
| Genuine gotchas and non-obvious behaviors | "Write clean, idiomatic code"-grade platitudes |
| CLI wrappers worth a standing command (e.g. `gh pr create`) | Always-loaded wrapper MCPs a CLI already covers (§3, Invariant 1.5) |
 
If the agent keeps violating a rule that's written down, your file is probably too long and the rule is drowning — the fix is deletion elsewhere, not more emphasis.
 
### 1.3 MCP stack discipline (guide §3, Invariant 1.5)
 
Apply the same pruning to your MCP servers. Each loaded MCP injects tool descriptions into *every* session — standing context tax competing with your written rules.
 
**Decision rule per service:** does the MCP expose something the CLI genuinely can't do? If no → drop the MCP, wrap the CLI in a command. If yes → keep it, but name the specific capability that earns its slot.
 
**Working budget:** single-digit enabled MCP servers. The `/stack` command below automates this decision per-project.
 
### 1.4 Create command files
 
Tell the agent: *"create the file `.claude/commands/<name>.md` with exactly this content"* for each.
 
---
 
#### `.claude/commands/spec.md` — the interview front-end
 
```
Here is what I'm building: $ARGUMENTS
 
Ignore the repository name and any existing folder/file names — treat my
description above as the ONLY source of truth for what this project is.
 
Before asking me anything, restate in your own words what you understand
this project to be, and wait for me to confirm or correct it.
 
Once I confirm, interview me using the AskUserQuestion tool. Dig into the
hard parts I might not have considered — especially domain rules, privacy,
and what counts as "done" — and skip the obvious. Keep interviewing until
you can concretely fill EVERY required section below. If you can't yet
write a section concretely, keep asking.
 
Then write SPEC.md with these required sections:
- Tech stack — languages, frameworks, and every external service or API
  this project will use (be exhaustive: include auth, database, hosting,
  payments, email, storage, or anything else that requires a third-party
  integration)
- Data model — what is stored, where, privacy/retention constraints
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
  * Abstraction ceremony position — one of: Direct (no internal layering
    beyond territories), Pragmatic layers (default — interfaces only where
    a second implementation exists), or Ports & adapters (core isolated
    behind declared ports). Name the position and one sentence why.
  Acceptance test: every declaration above must be translatable into a
  rule by /arch-verify. "Clean separation of concerns" fails; "ui →
  services → data; nothing imports ui; no cycles" passes.
- Scale & operations:
  * Load profile — expected users/requests/data at launch + 12-month
    growth assumption. Numbers or explicit "unknown."
  * SLOs — declared targets, or "none — best effort." Both valid; silence
    is not.
  * Scaling strategy + known ceiling — the simplest design and the point
    it breaks: "single VM + Postgres holds to ~N concurrent; past that,
    re-architect X."
- UI/UX direction — primary screens, main user flows, design constraints
- Edge cases & failure handling
- Out of scope — what this will NOT do
- Verification (end-to-end) — concrete steps that prove the feature works,
  including both automated test expectations AND visual/behavioral checks
  ("after this, doing X shows Y")
 
Finally, create todos/active/ with one task file per buildable increment
drawn from the spec, smallest first, and create learnings.md (empty).
```
 
**Why the interview is structured this way (so you don't weaken it by editing):**
 
- "Restate before asking" — forces misunderstandings to surface in turn 1, where they're cheap, not silently shaping the whole interview (guide §4.1 failure mode 1, field-tested).
- "Ignore the repository name" — the agent anchors on the most salient token in context; a repo name will hijack its questions if you don't neutralize it explicitly (guide §4.1 failure mode 1, field-tested).
- Required SPEC.md sections *pull* the interview — listing topics is a hope; requiring output sections guarantees coverage. If you can't tell afterward whether architecture was covered, the spec's section headings tell you (guide §4.1 failure mode 2, field-tested).
- "Tech stack" as its own section — forces the stack to be declared in writing, which is a prerequisite for `/stack` to process.
- "Code architecture" deepened from a one-liner to five declarations — each is designed backward from what fitness tools consume (territories + allowed-direction matrix); the acceptance test makes "too vague to translate into a rule" a mechanical definition of architecture theater. See `ai-sdlc-architecture.md` §1.1 for the full rationale and the ceremony conflict table (§2).
- "Scale & operations" — carried from extension session 4; declares numbers the load-test verifier (session 4) will assert against. No declared numbers → the verifier refuses, and that's correct.
**Ordering note:** if your repo already has a scaffold or existing structure, let the agent **read what exists before interviewing**, or build the bare scaffold first and interview second. A grounded agent looking at real files asks better questions than one theorizing (guide §4.1).
 
---
 
#### `.claude/commands/stack.md` — MCP-vs-CLI decision (run once after `/spec`)
 
```
Read the Tech stack section of SPEC.md. For each external service, API, or
platform listed, work through this decision in order:
 
1. Does a CLI exist for this service? (e.g. gh, supabase, vercel, stripe,
   railway, fly, prisma, firebase-tools — name it if so.)
2. Does the MCP for this service expose something the CLI genuinely cannot
   do — schema introspection, real-time event subscriptions, actions the
   CLI has no command for? Answer concretely, not in principle.
3. Verdict: CONNECT the MCP (only if yes to both questions) or WRAP the CLI
   in a command file instead (if the CLI covers everything we need).
 
Then produce two outputs:
- A list of MCPs to connect, each with one sentence naming the specific
  capability that earns it a standing slot. If the list exceeds five, flag
  it — that is a context-budget warning (guide §3, Invariant 1.5).
- For every service that did NOT earn an MCP: create a stub command file in
  .claude/commands/ that wraps the CLI calls I will actually repeat most
  often for that service. Leave the command body as a clear placeholder I
  can fill in.
 
Do NOT connect any MCP yet. Present the full recommendation and wait for
me to confirm or adjust each item before anything is connected.
```
 
---
 
#### `.claude/commands/arch-verify.md` — fitness-tool selection (run once after `/stack`)
 
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
 
**Why this exists:** dependency direction is a pass^k property — it must hold on every change and erodes one import at a time. Step 1 is the theater detector: translation failure objectively signals the spec section was prose, not decisions. Step 3 makes legacy adoption survivable — an honest rule fails a 12-year codebase on day one; a ratchet (tolerate current count, block increases) converts an unusable wall into a one-way door. Step 4 costs zero new machinery. See `ai-sdlc-architecture.md` §4 for the full design rationale.
 
---
 
#### `.claude/commands/refactor.md` — behavior-preserving code transformation (on-demand)
 
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
 
**Why this exists:** AI agents violate the behavior-preserving contract in over half of refactoring commits (E4, Horikawa et al. 2025: 53.9% tangled with behavioral changes). The command enforces: tests-as-precondition (Fowler, Feathers — E2c), small steps (Fowler — E2c), two-hats commit separation (Fowler/Beck — E2c), coverage precondition with characterization-test route (Feathers — E2c), and scope lock (agent-specific, E4). The coverage tool is selected per `/stack` — same selection mechanism as `/arch-verify`, no new machinery. See `ai-sdlc-refactoring.md` §1 for the full design rationale.
 
---
 
#### `.claude/commands/plan.md` — explore before touching
 
```
Plan mode only — read, do not modify anything. Read the relevant
directories and answer: where does this change live, what's the existing
pattern to follow, and what could break. Then write the implementation
plan to PLAN.md as an ordered task list. I will edit PLAN.md before you
touch code.
```
 
**When to skip planning** (canonical rule, E2): if you could describe the diff in one sentence, skip `/plan` and go straight to execution. Planning is overhead; it pays for itself only when the approach is uncertain, the change spans multiple files, or the code is unfamiliar.
 
---
 
#### `.claude/commands/next.md` — supervised mode (one task, then stop)
 
```
Read SPEC.md, todos/active/, and learnings.md. Tell me the single next
undone task and confirm your understanding of it with me before starting.
 
Once I confirm, do ONLY that one task:
1. Implement it, staying strictly inside what SPEC.md lists. Never add a
   data field or feature the spec doesn't name — ask me first.
2. Write automated tests for it and run them. Show me the pass/fail output.
3. Run the SPEC.md verification steps that apply to this task and give me
   visual evidence (screenshots, phone-sized if the spec says phone-first).
4. Move the finished task to todos/completed/, add any newly discovered
   work to todos/backlog/, and append anything you learned the hard way to
   learnings.md.
5. STOP. Do not start the next task. Present the evidence and wait for me.
```
 
**When to use supervised mode:** UI/UX work where visual judgment is the verifier; exploratory tasks where you don't know the shape yet; anything where you want to confirm direction after each step; early in a project before you've built verification skills and hooks.
 
---
 
#### `.claude/commands/loop.md` — gated autonomous mode (runs until a gate fires)
 
```
Read SPEC.md, PLAN.md, todos/active/, and learnings.md. Then work through
todos/active/ in order WITHOUT stopping between tasks, except:
- STOP at any task tagged [review] and present the branch diff.
- STOP if a hook blocks you and report what it said.
 
For each task: write the tests that define done FIRST, run them, confirm
they fail for the right reason, then implement until green and run
scripts/verify-*.sh. Move finished tasks to todos/completed/, log gotchas
to learnings.md as you hit them. Checkpoint after each task so I can
rewind. When you reach a [review] tag or run out of tasks, stop.
```
 
**When to use gated autonomous mode:** tasks where you have a test suite or verification script; tasks with a clear mechanical sequence (multiple API endpoints, CRUD operations, migration steps); anything that's pass^k — must work every time unattended (webhook handlers, billing logic, auth flows, data pipelines).
 
---
 
#### `.claude/commands/review.md` — Writer/Reviewer independence (guide §7, E2)
 
```
Fresh context. Review the diff on this branch against main as a skeptical
senior engineer. Attack specifically: [the failure classes this feature is
prone to]. Run scripts/verify-*.sh and include its output as evidence, not
assertion. List findings by severity with a proposed fix each.
```
 
---
 
### 1.5 Hooks (add one at a time, only after the failure has bitten)
 
Hooks run arbitrary shell with your permissions. They are your largest self-inflicted blast radius below production. **Do not add all of these on day one.** Each is an earned policy — add it after the specific failure it prevents has bitten you at least twice.
 
Register hooks in `.claude/settings.json` under the appropriate lifecycle event. Create the scripts in `.claude/hooks/`.
 
#### `.claude/hooks/test-gate.sh` — Stop hook: blocks finishing until tests pass
 
```bash
#!/usr/bin/env bash
# Stop hook: block session end until tests + verification script pass.
if ! <your test command> >/tmp/tg.log 2>&1; then
  echo "Tests failing. Fix before finishing:" >&2
  tail -20 /tmp/tg.log >&2
  exit 2   # exit 2 = block; stderr becomes the agent's instruction
fi
# Run verification scripts if they exist
for script in scripts/verify-*.sh; do
  [ -f "$script" ] || continue
  if ! bash "$script" >>/tmp/tg.log 2>&1; then
    echo "Verification failed ($script). Fix before finishing:" >&2
    tail -20 /tmp/tg.log >&2
    exit 2
  fi
done
exit 0
```
 
**Add this first.** It's the highest-value hook — the one that makes `/loop` mode safe. Know the limit: the tool overrides after 8 consecutive blocks (E2). That makes it a strong nudge, not an absolute wall. Note: `scripts/verify-arch.sh` (created by `/arch-verify`) is picked up by the `scripts/verify-*.sh` loop above — zero additional wiring needed.
 
#### `.claude/hooks/require-todo-sync.sh` — Stop hook: blocks if spec drifts from todos
 
```bash
#!/usr/bin/env bash
# Stop hook: block if SPEC changed but todos/ did not.
spec_changed=$(git diff --name-only HEAD -- SPEC.md specs/ | head -1)
todo_changed=$(git diff --name-only HEAD -- todos/ | head -1)
if [ -n "$spec_changed" ] && [ -z "$todo_changed" ]; then
  echo "SPEC changed but todos/ was not updated. Update todos/ to reflect the spec change before finishing." >&2
  exit 2
fi
exit 0
```
 
**Add this second — only after artifact drift has bitten you more than once** (guide §4.6). Until then, the manual standing clause in `/next` handles it. A hook added "just in case" is paying rent forever (§5).
 
#### `.claude/hooks/refactor-gate.sh` — Stop hook: blocks test-expectation edits in refactor commits (EARNED)
 
```bash
#!/usr/bin/env bash
# Stop hook: block if refactor-tagged work modified test expectations.
# EARNED — install only after silent behavior change in a refactor has
# bitten you. Same shape as "agent edits fitness config to pass."
 
COMMIT_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if ! echo "$COMMIT_MSG $BRANCH" | grep -qi "refactor"; then
  exit 0  # Not refactor-tagged; skip
fi
 
MODIFIED_TESTS=$(git diff --name-only --diff-filter=M HEAD -- \
  '*test*' '*spec*' '*__tests__*' '*.test.*' '*.spec.*' \
  'tests/' 'test/' 'spec/' | head -5)
 
if [ -n "$MODIFIED_TESTS" ]; then
  echo "REFACTOR GATE: Test expectation files were MODIFIED in a refactor-tagged commit:" >&2
  echo "$MODIFIED_TESTS" >&2
  echo "In a refactoring commit, test expectations must not change." >&2
  echo "If behavior needs to change, make a separate non-refactor commit." >&2
  exit 2
fi
exit 0
```
 
**Add this third — only after silent behavior change during a refactoring has bitten you.** The check: in a refactor-tagged commit, were test files *modified* (not *added* — new characterization tests are fine)? If yes, the agent changed behavior and edited the safety net to hide it, which is the same failure shape as editing fitness config to pass (session-1 gotcha). Same 8-block override limit applies. See `ai-sdlc-refactoring.md` §4 for full design rationale.
 
---
 
### 1.6 Verification skills (build these — highest-impact category, E3 corroborated)
 
Do not write skills speculatively. The authoring law (guide §7, E2): iterate on a hard task in conversation until the agent succeeds, *then* extract the winning approach into a skill. Skills are crystallized in-context learning.
 
When you extract a skill:
 
- **The description field is a trigger spec for the model**, not a summary for humans. Pattern: what it does + when to use it + phrases you'd actually say + explicit negative triggers ("Do NOT use for…").
- **The gotchas section is the highest-signal content**: append-only tables, endpoints that lie with 200s, field-name aliases, staging-vs-production quirks. Skip everything the model already knows.
- **Bundle validation scripts, not validation prose**: `scripts/verify-<feature>.sh` that exercises the feature and asserts on resulting *state* (DB rows, files), never on a status code. "Code is deterministic; language interpretation isn't" (E2).
- **One skill, one job.** Test the trigger by asking: "when would you use the <name> skill?" — it quotes the description back.
---
 
## 2. The mode switch — how to decide per task
 
Before starting any task, answer one question from guide §3 (Invariant 2):
 
**Does this task need to succeed *once* (pass@k), or *every time it runs unattended* (pass^k)?**
 
| If… | Then… | Mode | Why |
|---|---|---|---|
| You just need a working result and will eyeball it before it matters (a UI page, a one-off script, an exploration) | pass@k — once is enough | **Supervised** (`/next`) | You are the verifier. The loop stops after each task so you can judge behavior. |
| The behavior runs unattended and must be correct every single time (a webhook handler, a billing flow, a migration, a data pipeline, auth logic) | pass^k — every run must succeed | **Gated autonomous** (`/loop`) | A task that's 95% reliable per run still fails often enough across thousands of executions to be unacceptable. In-prompt iteration is a pass@1 observation; the unreliability compounds. Only a deterministic gate (test-gate hook) or independent judge (review session) buys pass^k reliability. |
| You're early in the project and don't have verification scripts or hooks yet | Start supervised regardless | **Supervised** (`/next`) | You haven't built the infrastructure that makes `/loop` safe. |
| The task is trivial — a one-line config change, a copy edit | Skip both; just prompt directly | Neither | Don't ceremony a task that takes one turn. |
 
**Refactoring mode rule:** opportunistic refactoring (litter-pickup, comprehension, preparatory — minutes, small scope) → supervised `/next`. Planned or structural refactoring (hours, multi-step, or touching multiple modules) → gated `/loop` with test-gate mandatory. Multi-step refactoring is a pass^k task: every step must preserve behavior, and unreliability compounds. See `ai-sdlc-refactoring.md` §3.
 
The mode switch is per-task, not per-project. You will use both in the same week, sometimes in the same session. A project that runs everything through `/loop` is over-engineering; one that runs everything through `/next` is under-using your ability to build verifiers.
 
---
 
## 3. How you run it — the full sequence
 
### Phase 1: Specify + Stack (Session 1)
 
```
[S-1]  /spec <one paragraph describing what you want>      ← you answer the interview
[S-1]  (same session)  /stack       → review MCP recommendations → confirm or adjust
[S-1]  (same session)  /arch-verify → review tool + config → confirm or adjust
```
 
Run all three in the *same* session as `/spec` — the declared tech stack and architecture are fresh in context. Connect any approved MCPs and install the fitness tool before starting the build session. If `/arch-verify` step 1 reports a declaration as too vague to translate, fix the spec *now* — that's the theater detector doing its job.
 
**After this phase you have:** `SPEC.md` with all required sections filled, `todos/active/` with scoped tasks, `learnings.md` (empty), your MCP/CLI setup resolved, and `scripts/verify-arch.sh` wired into the existing test gate.
 
### Phase 2: Plan (Session 2, or skip for small changes)
 
```
[S-2]  /plan  → review PLAN.md → edit it → tag the PR-boundary task [review] in todos/
```
 
Open the plan in your editor (Ctrl+G, E2). Make the human-judgment edits the agent can't: ordering priorities, scope boundaries, out-of-scope markers. Tag the task that should be the PR boundary with `[review]` in `todos/active/`.
 
**Skip this phase** if you could describe the diff in one sentence.
 
### Phase 3: Execute (Session 2 continued, or Session 3)
 
**Choose your mode per the §2 decision table above.**
 
#### Supervised mode:
 
```
/next  → review evidence → "looks right" or correction-as-spec → /next → ...
```
 
You see evidence after every task. Your corrections must be *specs*, never adjectives ("make it nicer" fails; "minimum 18px text, 60px buttons, high contrast" works).
 
#### Gated autonomous mode:
 
```
/loop  → agent runs multiple tasks unattended → stops at [review] tag or hook block
```
 
You are not in the loop between gates. That's the point, and it's only safe because the tests you wrote and the hooks you installed are catching drift.
 
**Budget rule for Pro plan (guide §5):** cap each `/loop` at roughly one PR's worth of work. A long session accumulates context rot. After each `/loop` completes, `/clear` and resume in a fresh session.
 
### Phase 4: Review (fresh session)
 
```
[S-3]  /review  → read findings + diff → approve or send back
```
 
This runs in a **fresh context** — the writer's context is structurally bad at seeing its own bugs (self-preferential bias, E2). The reviewer session has no knowledge of the implementation conversation.
 
Fill in the `[the failure classes this feature is prone to]` bracket with specifics: "idempotency under concurrent requests," "data leak through the magic-link endpoint," "silent failure on webhook timeout." For structural work, add the architecture review classes from `ai-sdlc-architecture.md` §5: ten-minute-test (can a new hire understand this territory's role?), names-carry-intent, no-unexplained-cleverness, abstraction-earns-its-keep (every interface names ≥2 real consumers), and compliance-without-gaming (fitness config/baseline unchanged unless explicitly approved). For refactoring work, add the refactoring review classes from `ai-sdlc-refactoring.md` §6.4: tangled-refactoring-commit (test expectations modified in a refactor-tagged commit — deterministic check via `git diff --diff-filter=M` on test files), refactoring-without-coverage (target area lacked coverage and no characterization tests were added — deterministic), scope-expansion (diff touches files outside the named target — partially deterministic), and wholesale-rewrite (file deleted and recreated rather than incrementally transformed — [judgment — review gate]).
 
### Phase 5: Record (end of every session)
 
If the agent didn't already update `learnings.md` and `todos/` (it should have, per the command files), do it now:
 
```
Update learnings.md with anything discovered this session. Move completed
tasks to todos/completed/. Add any new work discovered to todos/backlog/.
Update CLAUDE.md only if something is now true for every future session.
```
 
### The session-resume ritual (mandatory at every fresh session)
 
**A fresh session has zero memory of the previous one.** It does not "pick up where you left off." It knows only what is in files. Use this verbatim as the first message of any continuation session:
 
```
Read SPEC.md, todos/active/, and learnings.md. Tell me the current state
of the project and what the next undone task is. Do NOT start work yet —
confirm your understanding with me first.
```
 
This doubles as a diagnostic: **if that prompt cannot reconstruct where you were, your artifacts are too thin** — write more down at the end of each session, not rely on conversation memory.
 
---
 
## 4. Milestone gate (run every few cycles — your code review)
 
Separate from per-task review. This is a periodic health check, especially important for any area the per-task tests don't cover:
 
```
Use a subagent with fresh context to review this codebase for security
problems and data-loss risks, paying special attention to [the sensitive
parts your spec named]. Run all tests and scripts/verify-*.sh. List every
finding by severity with a proposed fix. Then re-run the SPEC.md
verification steps and show evidence of each.
```
 
For areas you verify by behavior (UI, flows), demand **visual evidence**: screenshots or a screen recording of the actual flow being exercised (E2, Anthropic internal verification practice).
 
---
 
## 5. Session discipline — the per-turn decision table (guide §4.6)
 
| Situation | Action |
|---|---|
| Current context is still load-bearing for the task | Continue |
| Agent went down a wrong path | **Rewind** to just after the file reads; re-prompt with what you learned. Strictly better than "that didn't work, try X" — the failed attempt stops polluting the window |
| Mid-task, window bloated with stale tool output | **Compact with a hint** ("focus on the API changes") — never let auto-compaction choose for you at the worst moment |
| Starting an unrelated task | **Clear / new session.** New task = new session, no exceptions |
| Next chunk produces output you only need the *conclusion* of | **Subagent.** Test: "will I need this raw output again, or just the answer?" |
| Corrected the agent **twice on the same issue** | Context is poisoned. **Clear** and re-prompt with learnings. A clean session with a better prompt almost always beats a long session with accumulated corrections |
| Quick side question | Use `/btw` — it never enters the main context |
 
**Rewind > correction** is the single biggest Pro-plan budget saver. Failed attempts you keep in context are tokens you keep paying for. Rewind to just after file reads, re-prompt incorporating what you learned, and the failed path is gone from the window.
 
---
 
## 6. Skill extraction — the growth loop (guide §7)
 
The pipeline gets cheaper over time because you extract reusable skills from successful sessions. The law: **iterate on a hard task in conversation until the agent succeeds, then crystallize it.**
 
```
Create .claude/skills/<name>/ from what worked in this session. SKILL.md
must contain: [the approach that worked], [the gotchas discovered], and a
Gotchas section. Bundle scripts/verify-<feature>.sh that exercises the
feature and asserts resulting state — a script, not prose. Description
field is a trigger spec: what it does, when to load it, phrases I'd
actually say, and explicit "Do NOT use for..." exclusions.
```
 
Test the trigger: ask "when would you use the <name> skill?" — it should quote the conditions back.
 
**Build verification skills first** — the category with the most measurable impact (E3, corroborated E1/E2). The investment ratio worth noticing: roughly half your effort should produce reusable verification infrastructure, not feature code.
 
---
 
## 7. Subagents — context isolation and review independence (guide §7)
 
Use subagents for:
 
- **Research that would flood your window** — the subagent burns 10k+ tokens exploring and returns a 1–2k summary. Your main context stays clean.
- **Fresh-context review** — the structural answer to self-preferential bias. The Writer/Reviewer two-session pattern: one session writes, a second session with clean context reviews.
- **Pre-commit verification** — a subagent runs the full test suite and verification scripts as an independent check.
Do **not** use subagents for: sequential dependent work (results feed each other), same-file edits (conflict risk), small tasks (overhead > value), or breeding a zoo of specialists (too many dilutes routing).
 
---
 
## 8. The convergent architecture — what your project ends up with (guide §4.7)
 
This structure emerged independently across every successful project in the corpus (E1). You don't need to create all of it on day one — start with three files (CLAUDE.md, SPEC.md, learnings.md) and grow when pain demands it.
 
```
your-project/
├── CLAUDE.md              # environment mechanics & non-default rules (lean!)
├── MEMORY.md              # project knowledge — what the code can't tell you
├── SPEC.md / specs/       # what is being built, per feature
├── PLAN.md                # current implementation plan (ephemeral per feature)
├── learnings.md           # what was discovered the hard way (gotchas, append-only)
├── todos/                 # persistent task state
│   ├── active/            #   current work
│   ├── backlog/           #   discovered but not started
│   └── completed/         #   done (audit trail)
├── scripts/
│   ├── verify-*.sh        # verification scripts (deterministic, bundled with skills)
│   └── verify-arch.sh     # architecture fitness check (created by /arch-verify, per-stack)
├── .dependency-cruiser.js # or .importlinter / ArchUnit rules — per-stack fitness config
├── arch-baseline           # (legacy only) committed violation count for the ratchet
└── .claude/
    ├── commands/           # spec.md, stack.md, arch-verify.md, refactor.md, plan.md, next.md, loop.md, review.md
    ├── skills/             # on-demand expertise, one skill one job (incl. architecture-constraints/, refactoring/)
    ├── hooks/              # test-gate.sh, require-todo-sync.sh, refactor-gate.sh (all earned policies)
    └── settings.json       # permissions, hook registration
```
 
**Key principles from primary evidence (E1, pwiz-ai):**
 
- **Layered context files, one job each.** CLAUDE.md = environment mechanics. MEMORY.md = project knowledge. Resist the single mega-file.
- **Todos as versioned artifacts.** Session plans don't survive sessions; files do. The `todos/` directory doubles as an audit trail.
- **Each addition should solve a real problem you encountered**, not theoretical concerns (E2).
---
 
## 9. Pro-plan budget discipline (guide §5)
 
You live on rungs 1–5. Rung 6 (dynamic workflows) is Max/API territory — treat it as something you do deliberately on rare high-value occasions, not as a default.
 
**Budget rules:**
 
- **One task per `/loop`, or one PR's worth at most.** Then `/clear` and resume.
- **Track usage** with the built-in `/usage` command before starting anything large.
- **Rewind instead of correct.** Failed attempts you keep paying for are the silent budget killer. Rewind to just after file reads, re-prompt with learnings.
- **Separate sessions are the budget strategy.** The interview, the build, the review are separate sessions — each starts clean.
- **Vague prompts are expensive.** A prompt that needs three corrections costs three turns of context. Front-load specificity.
- **Side questions via `/btw`** — they never enter the main context, so they don't dilute the window or cost you on the next turn.
---
 
## 10. Known failure modes — what will go wrong and how to fix it (guide §10)
 
| Symptom | Why | Fix |
|---|---|---|
| Interview anchors on the repo name, not your description | Repo name is the most salient token in context | Already handled: "ignore the repository name" clause in `/spec` |
| Interview covers some topics deeply, skips others | Listing topics is a hope | Already handled: required SPEC.md sections pull the interview |
| Agent asks theoretical questions when code already exists | Interview-first assumes empty folder | Read existing structure before interviewing, or scaffold first |
| New session doesn't know where the last one stopped | Fresh session has zero memory | Session-resume ritual (§3, Phase 5) |
| Spec updated but todos not | Agent edits only files the prompt names | Manual clause in `/next` + `require-todo-sync.sh` hook in `/loop` |
| Agent declares done but result is wrong | Self-preferential bias — it grades its own work favorably | Fresh-context `/review`; never trust self-reported success |
| Hook fires but agent keeps failing the same way | 8-consecutive-block override (E2) | The gate is a strong nudge, not a wall. Rewind and re-approach |
| CLAUDE.md rules get ignored | File is too long; real rules are drowning | Prune — the fix is deletion, not emphasis |
| MCP stack eating context | Too many always-loaded servers | Re-run `/stack` logic; drop any MCP a CLI covers |
| Architecture section filled with untranslatable prose (theater) | Vague words are cheaper than decisions | `/arch-verify` step 1 refuses and routes back to interview — translation failure is the detector |
| Agent edits fitness config/baseline to make violations pass | Same shape as editing tests to pass (session-2 gotcha) | `/review` checks fitness config paths are unchanged (`git diff`); candidate hook only if it bites twice |
| Day-one architecture gate failure on legacy codebase → gate deleted | Honest rules vs. years of accumulated violations | `/arch-verify` step 3 ratchet: baseline current count, block increases only |
| Agent refactors code with no test coverage → "refactoring succeeded" | Absence of test failures ≠ success; agent doesn't check coverage first | `/refactor` command checks target-area coverage first; routes to characterization tests if below 70% |
| Agent edits test expectations to make refactored code pass | Same shape as editing fitness config — agent "fixes" the safety net | Refactor gate (earned hook) blocks modified (not added) test files in refactor-tagged commits |
| Agent rewrites instead of refactoring (deletes old, writes new) | Agent lacks small-steps discipline; rewriting is faster than incremental transformation | Skill gotcha #1 names it explicitly; `/review` checks for deleted-and-recreated files |
| Agent scope-creeps during refactoring ("while I'm in here…") | Agent lacks a scope reflex (E4: task was 40 files, it touched 140) | `/refactor` command SCOPE LOCK clause; skill gotcha #2 |
| Coverage check passes but target area is still under-tested (theater) | High coverage of trivial paths only; edge cases uncovered | Necessary-not-sufficient; the coverage check catches worst case (zero); the review gate catches quality |
 
---
 
## 11. Artifact drift — why it happens and both fixes (guide §4.6)
 
**The agent updates exactly the files your prompt names, and nothing else.** There is no ambient "keep my project files in sync" behavior. You ask for a feature spec → you get a spec; `todos/` does *not* update unless that same turn told it to.
 
**Two fixes at different rungs:**
 
- **Manual (supervised mode):** the `/next` command already includes "move finished task to todos/completed/" and "append to learnings.md." But *you* will sometimes forget to include this in ad-hoc prompts. End every feature-changing prompt with: *"after implementing, update todos/ and learnings.md to reflect what changed."*
- **Deterministic (gated mode):** the `require-todo-sync.sh` Stop hook blocks the session if SPEC.md changed but todos/ didn't. Add it only after the drift has actually bitten you more than once — a hook added "just in case" is paying rent forever.
---
 
## Quick-reference: the full run sequence on one page
 
```
ONE-TIME SETUP
  /init → prune CLAUDE.md → create command files → (hooks later, earned)
 
PER FEATURE
  [S-1]  /spec <description>          ← interview: you answer domain/risk questions
  [S-1]  /stack                       ← review MCP/CLI recommendation, confirm
  [S-1]  /arch-verify                 ← review fitness tool + config, confirm
         (connect approved MCPs, install fitness tool)
 
  [S-2]  /plan                        ← review + edit PLAN.md (skip if trivial)
         (tag [review] on PR-boundary task in todos/)
 
  [S-2]  Choose mode:
           /next  (supervised — task by task, you review each)
           /loop  (gated autonomous — runs until [review] or hook block)
 
  [S-3]  /review                      ← fresh context, skeptical review of diff
         → approve or send back
 
  End of session:
         Update learnings.md, todos/, CLAUDE.md if needed
         Extract skill if a hard task succeeded for the first time
 
CONTINUATION SESSION (every time)
  "Read SPEC.md, todos/active/, and learnings.md. Tell me current state
   and next undone task. Do NOT start work yet — confirm with me first."
 
MILESTONE GATE (every few cycles)
  Fresh-context security/data-loss review + SPEC.md verification re-run
```