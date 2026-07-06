# Building Software with AI Agents: A Reproducible Workflow Guide
 
**Version 1.3 — June 2026.** Synthesized from 20 sources: Anthropic's canonical engineering documentation, the Claude Code blog corpus (38 articles triaged, 16 read in depth), and direct inspection of two production repositories built with these workflows. **v1.3 adds the MCP context budget (§3, Invariant 1.5), the pass@k/pass^k consistency selector for choosing a verification rung (§3, Invariant 2; cross-referenced in §4.4), an MCP-vs-CLI row in the §7 CLAUDE.md table, and a concrete external anti-example (§5, Appendix B) — drawn from inspecting a non-Anthropic community config pack (E4), whose mechanisms are used and whose self-reported metrics are discarded as non-credible.** v1.2 added §10 (failure modes of this guide's own prompts) and revised §4.1, §4.6, and §7 from field-logged sessions — the first evidence in this guide that is neither vendor-published nor curated.
 
**Companion document:** `ai-sdlc-worked-examples.md` — three end-to-end walkthroughs (one per track) demonstrating §4's workflow from empty folder or legacy module to verified result. They are constructed demonstrations of evidenced mechanisms, not recorded transcripts, and say so.
 
---
 
## 0. What this guide claims — and what it does not
 
This guide was commissioned with the goal of a workflow "reproducible for any project, in any state, for anyone without exception." The research does not support that claim, and this guide will not pretend it does. Here is what the evidence actually supports:
 
**One invariant core, three on-ramps, one honest prerequisite.** Every successful project examined — a 17-year-old, 900,000-line scientific codebase; a lawyer's hackathon-winning permit tool; a project manager's App Store product — converged independently on the same workflow architecture. That convergence is the strongest evidence in this guide. But every success also shared a hidden floor that the marketing framing omits:
 
> **The prerequisite floor:** the ability to write precise, structured English; the willingness to produce and maintain written artifacts (specifications, rules, learnings, task lists); and the discipline to iterate systematically instead of hoping. Coding skill is genuinely not required. Artifact discipline genuinely is.
 
The "non-technical" success stories confirm this rather than refute it. The lawyer who won first place "without reading a line of code" wrote specifications, sixteen skill files, a design bible, and learnings documents. The "zero-code" project manager had ten years of process discipline managing engineering teams. Treat anyone selling a workflow with no prerequisites as selling something.
 
### How evidence is marked in this guide
 
Because roughly 90% of the source corpus is published by Anthropic (the vendor), every substantive claim carries an evidence class:
 
| Mark | Meaning |
|------|---------|
| **E1** | Primary evidence — verified by direct inspection of public repositories (pwiz-ai, cc-crossbeam) |
| **E2** | Canonical documentation — Anthropic's live docs and engineering blog; checkable mechanisms, current as of June 2026 |
| **E3** | Vendor claim — case-study outcomes, self-reported numbers, no controls. Plausible, unverified |
| **E4** | External claim — non-Anthropic source, not independently verified here |
 
A useful rule the corpus itself teaches: **trust mechanisms over outcomes.** "A Stop hook blocks the turn until tests pass" is checkable on your machine today (E2). "We finished a stalled feature in two weeks" is marketing until you can reproduce it (E3).
 
### The two-layer design: durable principles vs. current knobs
 
Specific commands, model settings, and feature availability changed measurably *during the research window* (between Opus 4.6 and 4.7, and again with dynamic workflows in May 2026). A guide that mixes principles with knobs dies in one model cycle. So:
 
- **Sections 1–7** contain only durable principles — things grounded in how language models work (finite attention, no reliable self-judgment) or in convergent practice across independent projects. Expect these to hold across model generations.
- **Appendix A** contains the current knobs, dated, with an explicit expiry warning and pointers to the live documentation at `code.claude.com/docs`. When this guide disagrees with the live docs, the live docs win.
---
 
## 1. Which track are you on?
 
The original brief divided readers by background: commoner, software developer, professional software engineer. Background is the wrong axis — a cardiologist with twenty years of side-project software is functionally a developer, and a CS graduate who never shipped is functionally not. The axis that actually determines your workflow is **what you can personally verify**, because (as Section 3 establishes) verification is half of the entire discipline.
 
| Track | You can verify… | Typical people | Your ceiling on the automation ladder (§5) |
|-------|----------------|----------------|--------------------------------------------|
| **A — Operator** ("commoner") | **Behavior only.** You can use the product, read a screenshot, judge whether it does what you wanted. You cannot read code. | Domain experts, PMs, lawyers, doctors, founders without engineering backgrounds | Rungs 1–3, supervised |
| **B — Developer** | **Code.** You can read a diff, write or at least read tests, and judge whether an implementation is sound. | Solo developers, hobbyists with real shipping experience, engineers working alone | Rungs 1–5 |
| **C — Engineer** | **Systems.** You are accountable for production: CI, security posture, review process, other people's code, long-term maintenance. | Professional engineers, tech leads, engineering orgs | Full ladder, plus org-level practice |
 
Tracks are cumulative: B includes everything in A; C includes everything in B. Everyone — all three tracks — runs the same core workflow in Section 4. The tracks differ only in how far up the automation ladder you safely climb and which verification instruments you can wield.
 
One honest note for Track A: this guide gives you a real, evidenced path to shipping working software. It does not make you immune to the failure mode you cannot see — code that works today and breaks in ways no screenshot reveals. Your countermeasure is Section 6's verification regime, and it is not optional for you the way it is merely *strongly advised* for Track B.
 
---
 
## 2. The mental model: you are managing a context window
 
Everything in this guide reduces to one sentence: **an AI agent's competence at any moment is a function of what is in its context window, and your job is to decide what that is.**
 
Why this is physics, not opinion (E2, *Effective Context Engineering for AI Agents*): transformer attention computes n² pairwise relationships between tokens. As context grows, that attention is stretched thinner, and models were trained mostly on shorter sequences. The result is **context rot** — a measured, gradual degradation of recall and reasoning as the window fills. It is a gradient, not a cliff, and it produces a cruel irony: the model is at its *least* capable exactly when the window is nearly full — which is precisely when automatic compaction fires and summarizes your session. Bad compactions are not bad luck; they are structural.
 
Therefore the goal, in Anthropic's own canonical phrasing (E2): **find the smallest possible set of high-signal tokens that maximizes the likelihood of the desired outcome.**
 
Once you see this, every feature of an agentic coding tool resolves into a context instrument:
 
| Feature | What it actually is |
|---------|---------------------|
| CLAUDE.md | Static context, paid for at the start of *every* session |
| Skills | On-demand context, loaded only when triggered |
| Subagents | Context isolation — exploration happens in a disposable window; only conclusions return |
| Hooks | Automated context injection and deterministic gating |
| Sessions / clear / compact / rewind | Context lifecycle management |
| Specs, todos, learnings files | Context that survives outside any window — the only kind that persists |
 
This is the spine of the guide. It is not a feature tour; it is one discipline expressed through six instruments.
 
---
 
## 3. The two invariants
 
### Invariant 1: Context is the scarce resource — spend it deliberately
 
Consequences you will apply constantly:
 
1. **Every token competes with every other token.** A bloated CLAUDE.md does not just waste budget — it causes the model to *ignore your actual instructions* (E2, canonical docs, stated explicitly). The pruning test for any line of persistent context: *"Would removing this cause the agent to make mistakes?"* If not, cut it.
2. **Prefer just-in-time over preloaded.** Keep lightweight identifiers (file paths, doc links, queries) in context and let the agent fetch content when needed. Claude Code's own design is a hybrid (E2): CLAUDE.md loaded up front, everything else retrieved via search tools at runtime.
3. **Don't state the obvious.** The model already knows standard syntax and conventions. Persistent context should encode only what pushes it *off* its defaults: your quirks, your gotchas, your non-standard rules (E2, Anthropic internal skills practice).
4. **Information that must survive belongs in files, not in conversation.** Conversation is volatile and lossy; the repo is durable. This single idea generates the entire artifact architecture in Section 4.
5. **A loaded MCP server is persistent context you pay for every turn — budget it like one.** Each MCP server injects its tool descriptions into the window whether or not you use them that session; a stack of them is a standing tax on the same attention budget as a bloated CLAUDE.md, and produces the same failure (your real instructions get crowded out). The remedy follows from point 2: most wrapper MCPs (version control, database, deploy — GitHub, Supabase, Vercel, Railway) are thin shells over a CLI that already exists, so replace the always-loaded MCP with on-demand CLI calls bundled into a skill or command. A `/gh-pr` skill that wraps `gh pr create` costs context only when invoked; the GitHub MCP costs context always. The canonical form of this is in Appendix A (E2: CLI tools are the most context-efficient way to touch external services); it is restated here as an Invariant because it is one of the highest-leverage context decisions you make, and because an independent non-Anthropic practitioner converged on the same remedy (E4, ECC). **Working budget:** keep simultaneously-enabled MCP servers in the single digits, and reach for an MCP over a CLI only when the MCP exposes something the CLI genuinely can't. The "200k→~70k usable context" figure sometimes quoted for over-stacked MCPs is E4 — directionally consistent with the mechanism, not measured here; the check is yours to run by comparing your status-line context count with the MCP stack loaded versus stripped.
### Invariant 2: Trust comes from verifiers, not from the model
 
This phrasing is taken verbatim from the most instructive primary source in the corpus — the context repository of a 900k-line production codebase (E1, pwiz-ai `CRITICAL-RULES.md`):
 
> "Every rule below is intended to be enforced by a build, a test, or an inspection — not by the model reading and remembering. When a rule's verifier is weak, the rule will drift; strengthen the verifier rather than the wording."
 
The same conclusion arrives independently from three other directions, which is why it ranks as the best-corroborated principle in this guide:
 
- Anthropic's canonical docs make "give Claude a check it can run" the *first* best practice: "It's the difference between a session you watch and one you walk away from" (E2).
- Anthropic's internal teams report that **verification skills had the most measurable impact on output quality** of any skill category — worth "an engineer spending a week just making your verification skills excellent" (E3, but consistent with E1 and E2).
- The dynamic-workflows release names the failure modes of unverified agents (E2): **agentic laziness** (declares done at item 35 of 50), **self-preferential bias** (favors its own output when judging it), and **goal drift** (constraints erode through lossy compaction).
The deep consequence of self-preferential bias: **an agent checking its own work inside the same context window is structurally unreliable.** Independence requires either a deterministic check (a test, a build, a diff) or a *fresh context* (a verification subagent, a second reviewer session) — "so the agent doing the work isn't the one grading it" (E2).
 
**The verification escalation ladder** (E2, canonical) — each step trades setup effort for the right to stop watching:
 
1. **In-prompt:** include the check in the task itself — "run the tests after implementing and iterate until they pass."
2. **Session goal:** set the check as a `/goal` condition; a separate evaluator re-checks it after every turn.
3. **Deterministic gate:** a Stop hook runs your check as a script and blocks the agent from finishing until it passes. (Know the limit: the tool overrides the hook after 8 consecutive blocks.)
4. **Independent judge:** a verification subagent or adversarial workflow in a fresh context tries to refute the result.
**Before you pick a rung: decide how much consistency the task actually needs.** The ladder tells you how to verify; it doesn't tell you how high to climb. That's set by one question — does this need to succeed *once*, or *every time*?
 
Two framings make the difference concrete (standard eval vocabulary; the concept is established, any specific percentages are illustrative — E4):
 
- **pass@k** — at least one of `k` attempts succeeds. Use it when you just need a working result and can pick the good one: a one-off script, an exploration, anything a human eyeballs before it matters.
- **pass^k** — *all* `k` attempts must succeed. Use it when the behavior runs unattended and repeatedly: a billing webhook, a migration, anything inside a loop or a pipeline.
The asymmetry is the whole point. A step that is 70% reliable per attempt is fine under pass@k but collapses under pass^k as `k` grows — three independent runs that must *all* pass land far below the per-run rate, five lower still. So the rule is mechanical: **a task that must hold under pass^k cannot be trusted to in-prompt iteration or a self-review (rungs 1–2) — its unreliability compounds every time it runs. It needs a deterministic gate or an independent judge (rungs 3–4).** This is the quantitative reason self-preferential bias is disqualifying: *"it worked when I asked it to check"* is a pass@1 observation being used to justify a pass^k deployment. Match the rung to the exponent, not to how the last single run happened to go.
 
And in every case: **demand evidence, not assertions.** Test output, the exact command and its return, a screenshot, a recording of the flow being exercised. Reviewing evidence is faster than re-running the verification yourself, and it is the only thing that makes unattended sessions trustworthy.
 
---
 
## 4. The universal core workflow
 
Every track runs this loop. It has five phases; the evidence for each is listed where it matters.
 
```
SPECIFY  →  PLAN  →  EXECUTE  →  VERIFY  →  RECORD
   ↑                                           |
   └───────────── learnings feed back ─────────┘
```
 
### 4.1 Specify — let the agent interview you
 
The single most teachable workflow in the corpus, canonical in Anthropic's docs (E2) and independently practiced by the first-place hackathon winner before it was documented (E1, cc-crossbeam's `spec.md`). The naive version of the prompt — used in v1.0 of this guide — is:
 
> *"I want to build [brief description]. Interview me in detail using the AskUserQuestion tool. Ask about technical implementation, UI/UX, edge cases, concerns, and tradeoffs. Don't ask obvious questions — dig into the hard parts I might not have considered. Keep interviewing until we've covered everything, then write a complete spec to SPEC.md."*
 
**This version has two field-tested failure modes (§10, logged from real sessions). Use the hardened prompt below instead.**
 
**Failure 1 — context anchoring.** Run that prompt inside a named or pre-populated repository and the agent will anchor its questions on the most salient token it can see — typically the repository name or existing folder names — instead of the description you wrote. It will ask questions premised on what it *assumes* the project is, sometimes without asking what the project is at all. The defense is to name your description as the sole source of truth, neutralize the competing context explicitly, and force the agent to **restate its understanding before asking anything** — so the misunderstanding surfaces in turn one, where it is cheap to correct, instead of silently shaping the whole interview.
 
**Failure 2 — uneven topic coverage.** A prompt that *lists* topics ("ask about UI/UX, architecture…") gets uneven results, because the agent chooses how deeply to pursue each one. Listing a topic is a hope, not a guarantee. The fix is to stop driving coverage from the interview and drive it from the **required structure of the SPEC.md output**: declare the sections the spec must contain, and instruct the agent to keep interviewing until it can fill every one concretely. The spec's structure now pulls the interview, instead of the interview hopefully producing a good spec. This is the reliable way to guarantee architecture and UI/UX are actually covered.
 
The hardened interview prompt:
 
```
Here is what I'm building: [your description].
 
Ignore the repository name and any existing folder/file names — treat my
description above as the ONLY source of truth for what this project is.
 
Before asking me anything, restate in your own words what you understand
this project to be, and wait for me to confirm or correct it.
 
Once I confirm, interview me in detail using the AskUserQuestion tool. Dig
into the hard parts I might not have considered; skip the obvious. Keep
interviewing until you can concretely fill EVERY required section of the
spec below — if you can't yet write a section concretely, keep asking.
 
Then write SPEC.md with these required sections:
- Data model — what is stored, where, and any privacy/retention constraints
- Code architecture — layers, key modules, how they communicate
- UI/UX direction — primary screens, the main user flows, design constraints
- Edge cases & failure handling
- Out of scope — what this explicitly will NOT do
- Verification (end-to-end) — concrete steps that prove the feature works
```
 
Adjust the required-section list to your project: a CLI tool needs no "UI/UX direction," a data pipeline needs a "data contracts" section. The mechanism is what matters — *required output sections, not suggested interview topics.*
 
**Ordering, if structure already exists.** v1.0 implied interview-then-build on a clean sweep. Field experience corrected this: if your repo already has a scaffold or any structure, let the agent **read what exists before interviewing**, or build the bare scaffold first and interview second. A grounded agent looking at real files asks better questions than one theorizing from a description alone. Interview-first is right only for a genuinely empty folder.
 
Then — and this is the part people skip — **start a fresh session to execute the spec.** The interview session is full of meandering context; the implementation session should contain only the distilled spec. A good spec is self-contained: it names the files and interfaces involved, states what is *out of scope*, and ends with an end-to-end verification step that proves the feature works.
 
The canonical doc's claim, which the primary evidence supports: *time spent making the spec precise pays off more than time spent watching the implementation.* For Track A readers, this is not one technique among many — it is your entire job description. You are not a prompter; you are a specification writer.
 
### 4.2 Plan — explore first, separately
 
Use plan mode (the agent reads and reasons but cannot modify anything) to explore the codebase and produce an implementation plan before any code changes. Review the plan; edit it directly if the tool allows. Then switch modes and implement *against the plan*.
 
The exception rule, verbatim from canon (E2): **if you could describe the diff in one sentence, skip the plan.** Planning is overhead; it pays for itself only when the approach is uncertain, the change spans multiple files, or the code is unfamiliar.
 
### 4.3 Execute — front-load, then leave it alone
 
Durable principles (extracted from model-specific advice that will rot, E2):
 
- **Full task specification in the first message:** intent, constraints, acceptance criteria, file locations, what *not* to touch. Each correction turn you add later costs tokens and degrades context.
- **Reference patterns, don't describe them.** "Look at how HotDogWidget.php is implemented and follow that pattern" beats three paragraphs of description.
- **Delegate, don't pair-program.** The model batches its own questions; answer them in batches. Minimizing interaction turns is both cheaper and better.
### 4.4 Verify — close the loop (see §3, Invariant 2)
 
Pick your rung on the verification ladder before the session starts, not after the agent claims success. Pick it with the consistency question from §3 (Invariant 2): a once-is-enough task (pass@k) can live on rungs 1–2; a runs-every-time task (pass^k) needs a deterministic gate or independent judge (rungs 3–4), because its unreliability compounds on every run. Minimum viable verification per track: Track A — agent-written tests plus visual evidence (screenshots, recordings) of the actual flow working; Track B — tests you can read, run by a gate; Track C — independent review context plus CI.
 
### 4.5 Record — the step most people skip
 
The trainee-onboarding loop, the only fully transferable *process* found in any case study (E1/E3, MacCoss Lab, 17-year codebase):
 
1. Give the agent a deliberately scoped first project.
2. When it stumbles, **record what it needed to know** as a context artifact (a rule, a gotcha, a skill).
3. Expand scope on the next iteration. Repeat.
The practitioner's claim — unverifiable but consistent with everything else here (E3): *recording context is "the part most developers skip, and why most developer success plateaus."* Context is a project artifact. Version it, grow it, prune it, maintain it — exactly like code.
 
### 4.6 Session discipline — the per-turn decision table
 
Context lifecycle management, condensed from the session-management corpus (E2):
 
| Situation | Action |
|-----------|--------|
| Current context is still load-bearing for the task | Continue |
| Agent went down a wrong path | **Rewind** to just after the file reads; re-prompt incorporating what you learned. Strictly better than saying "that didn't work, try X" — the failed attempt stops polluting the window |
| Mid-task, window bloated with stale tool output | **Compact with a hint** ("focus on the API changes") — never let auto-compaction choose for you at the worst possible moment |
| Starting an unrelated task | **Clear / new session.** You hand-write the carry-forward brief. New task = new session, no exceptions |
| Next chunk of work produces output you only need the *conclusion* of | **Subagent.** Test: "will I need this raw output again, or just the answer?" |
 
Two rules of thumb with canonical backing (E2): if you have corrected the agent **twice on the same issue**, the context is poisoned — clear and re-prompt with learnings; a clean session with a better prompt almost always beats a long session with accumulated corrections. And quick side questions should never enter the main context at all (use the side-question facility; see Appendix A).
 
**The session-resume ritual (do not skip — a new session knows nothing).** This is the most common operational misunderstanding of these tools, so it gets stated bluntly: **a fresh session has zero memory of the previous one.** It does not "pick up where you left off." It knows only what is written in files. Whenever the workflow tells you to start a new session, the carry-forward is *your* job and it must read from artifacts, not from your memory of the last session. Use this prompt verbatim as the first message of any continuation session:
 
```
Read SPEC.md, todos/active/, and learnings.md. Tell me the current state
of the project and what the next undone task is. Do NOT start work yet —
confirm your understanding with me first.
```
 
This doubles as a diagnostic: **if that prompt cannot reconstruct where you were, your artifacts are too thin** — that is the signal to write more down at the end of each session, not to rely on conversation memory (which is gone). The "confirm before working" clause is the same defense as the interview's "restate before asking": force the agent to prove it understood before it acts.
 
**Artifact drift is structural, not a bug.** The agent updates exactly the files your prompt names, and nothing else — there is no ambient "keep my project files in sync" behavior, and expecting one contradicts Invariant 1. In practice this means: you ask for a feature spec, you get a spec; the `todos/` do *not* update unless that same turn told them to. You will hit this. Two ways to handle it, at different rungs of the ladder (§5):
- *Manual (rungs 1–2):* end every feature-changing prompt with a standing clause — "after implementing, update `todos/` and `learnings.md` to reflect what changed." You will sometimes forget. That forgetting is the price of staying low on the ladder.
- *Deterministic (rung 5):* a Stop hook that blocks the session from ending if `SPEC.md` changed but `todos/` did not. This is the guide's own "trust comes from verifiers, not the model" principle (§3) applied to artifact maintenance — when you notice the model won't reliably self-maintain its files, stop relying on it and add a check. See §7 for the hook. Hitting this friction *is* the signal you've earned the rung.
### 4.7 The convergent architecture — what every successful project ends up with
 
This is the strongest single piece of evidence in this guide, because it was *not designed* — it emerged independently in a 17-year-old scientific codebase (E1), a lawyer's six-week product (E1), Anthropic's internal practice (E2/E3), and a PM's App Store app (E3):
 
```
your-project/
├── CLAUDE.md            # environment mechanics & universally-true rules (lean!)
├── MEMORY.md            # project knowledge — what the code can't tell you
├── CRITICAL-RULES.md    # bare constraints, each backed by a verifier
├── SPEC.md / specs/     # what is being built, per feature
├── learnings/           # what was discovered the hard way (gotchas)
├── todos/               # persistent task state: active / backlog / completed
└── .claude/
    ├── skills/          # on-demand expertise, one job each
    ├── agents/          # specialized subagent definitions
    └── settings.json    # permissions, hooks
```
 
Notable refinements from the primary evidence that no blog post mentions:
 
- **Layered context files, one job each** (E1, pwiz-ai). Their CLAUDE.md is dominated by *environment mechanics* (shell quirks, path handling) — not project lore, which lives in MEMORY.md, with bare constraints in CRITICAL-RULES.md. Resist the single-mega-file.
- **Todos as versioned artifacts** (E1). Session plans don't survive sessions; files do. pwiz-ai's `todos/` directory (15 active, 51 completed at inspection) doubles as an audit trail of AI-assisted work.
- **A separate context repository** is worth considering for large/legacy codebases (E1): it spans branches and survives history rewrites.
- For solo and small projects, all of this starts as **three files**: CLAUDE.md, SPEC.md, and a learnings file. Grow it only when pain demands it — "each addition should solve a real problem you encountered, not theoretical concerns" (E2).
---
 
## 5. The automation ladder
 
Six rungs. Each rung up buys autonomy and costs tokens, setup, and blast radius. Climbing past your verification ability (§1) is how people get hurt.
 
| Rung | Instrument | What it does | Cost | Minimum track |
|------|-----------|--------------|------|---------------|
| 1 | **Conversation** | You prompt, it acts, you watch | Lowest | A |
| 2 | **CLAUDE.md + session discipline** | Persistent rules; deliberate context lifecycle | Small, recurring (loaded every session) | A |
| 3 | **Skills & commands** | On-demand expertise and repeatable workflows | Setup time; trivial runtime cost via progressive disclosure | A (consuming), B (authoring freely) |
| 4 | **Subagents** | Context isolation; parallel research; independent review | Tokens (each runs its own window) | B |
| 5 | **Hooks** | Deterministic policy: gates, auto-formatting, context injection | Setup + real blast radius — hooks run arbitrary shell with your permissions | B (carefully), C |
| 6 | **Dynamic workflows / orchestration loops** | The agent writes its own multi-agent harness: fan-out, adversarial verification, tournaments, loop-until-done | **Token furnace.** Significantly more expensive; reserve for high-value tasks | C (or B on API/Max budgets) |
 
Rung 6 is the documented mechanism behind the "I don't prompt anymore, I write loops" philosophy from this project's seed document (E2, dynamic workflows, May 2026) — the head of Claude Code's daily practice sits at the top of this ladder, not outside it. The same source includes its own counterweight, which budget-constrained readers should tattoo somewhere visible: *"most traditional coding tasks do not need a panel of 5 reviewers."*
 
**Escalation rule** (E2): start conversational; automate a behavior only after you've repeated it manually and it works. A rule that exists because of a real failure earns its context cost. A rule added "just in case" is paying rent forever for nothing — and skills follow the same law: *"most of our best skills began as a few lines and a single gotcha"* (E2, Anthropic internal). The opposite is a real and visible failure mode: one widely-promoted community config pack ships ~249 skills, ~63 agents and dozens of MCP definitions to every user at once, then has to warn — in its own docs — that too many MCPs shrink the usable window and that stacked installs duplicate behavior (E4, ECC). That is this guide's anti-example made concrete: capability built ahead of pain becomes a context tax that makes the agent worse, exactly as Invariant 1 predicts.
 
**Budget note for Claude Pro subscribers** (the constraint this project was researched under): you live on rungs 1–4. Track usage with the built-in usage command, run one task per session, lean hard on rewind-instead-of-correct (failed attempts you keep paying for are the silent budget killer), and treat rung 6 as something you do deliberately on rare high-value occasions, not as a default.
 
---
 
## 6. Track A — The Operator (no code-reading ability)
 
**Honest preconditions.** You can write clear, structured English and you are willing to maintain written artifacts. If you want to type one sentence and receive a finished product, this track will fail you slowly and expensively. The evidence for what actually works at this level is the first-place hackathon winner's repository (E1): a man who truthfully never read a line of code, and whose repo contains a spec, a design bible, sixteen skill files, and learnings documents. **"No code" never meant "no writing." It meant the writing moved up a level of abstraction.**
 
### Day-one setup
 
1. Install Claude Code (see Appendix A for the current installation reference).
2. Work inside an isolated environment — at minimum a dedicated folder that contains nothing you can't lose; ideally the tool's sandbox mode or a cloud session (E2). 
3. Keep **default permissions** (the tool asks before acting). Yes, the prompts are tedious. They are also the only review process you have. Two hard rules, both grounded in the security corpus (E2):
   - **Never** use the skip-permissions flag. It exists for isolated containers run by people who can audit the damage. That is not you.
   - Classifier-based auto-approval ("auto mode") only while you are actively watching, never unattended — it has documented false negatives.
4. Run the init command in your project folder to generate a starter CLAUDE.md, even on an empty project.
### Your workflow is §4 with two amplifiers
 
**Amplifier 1 — the interview is everything.** Run the §4.1 spec interview for every feature, no matter how small it feels. You cannot catch a wrong implementation by reading the diff, so the only place you can catch it is in the spec. Pivots, by the way, are no longer fatal: a full framework rewrite mid-project cost one practitioner a few hours, not a restart (E3) — so a wrong early technology choice is recoverable; a chronically vague spec is not.
 
**Amplifier 2 — screenshots are your interface to everything.** Vision is the documented unlock for non-developers (E3, consistent across cases): paste a screenshot of any confusing console — App Store submission, API dashboards, analytics setup — and ask "what should I press here?" The non-coding work of *shipping* (store review, error tracking, analytics) is agent-guidable end to end.
 
### Your verification regime (not optional)
 
You verify behavior, so engineer the behavior evidence:
 
- Every spec ends with verification criteria *you* can judge: "after this change, doing X in the app shows Y."
- Instruct the agent, every task: *write tests for this, run them, and show me the output.* You don't read the tests; you read the pass/fail and you keep the habit because it gates the agent, not you.
- Demand visual evidence of flows: screenshots or a screen recording of the actual signup/checkout/whatever being exercised (E2, Anthropic internal verification practice).
- Ask for a fresh-context review at milestones: *"use a subagent to review this code for security problems and data-loss risks, and explain findings to me in plain language."*
### What you do not do
 
No hooks (you cannot audit a script that runs with your permissions). No editing files by hand. No production secrets pasted into context or committed into CLAUDE.md. And no unattended overnight runs — unattended autonomy belongs to people who can read the wreckage.
 
---
 
## 7. Track B — The Developer
 
Everything in Track A, plus rungs 4–5, plus authorship of the context layer. Your leverage point: you can read code, so you can build verifiers — which means you can safely buy much more autonomy.
 
### CLAUDE.md discipline (the canonical include/exclude table, E2)
 
| Include | Exclude |
|---------|---------|
| Commands the agent can't guess (build, test-one-file, deploy) | Anything readable from the code itself |
| Style rules that differ from language defaults | Standard conventions the model already knows |
| Testing instructions and preferred runners | Detailed API docs (link instead) |
| Repo etiquette: branch naming, PR conventions | Frequently-changing information |
| Environment quirks and required env vars | File-by-file codebase descriptions |
| Genuine gotchas and non-obvious behaviors | "Write clean code"-grade platitudes |
| The few CLI wrappers worth a standing command (e.g. `gh pr create`) | Always-loaded wrapper MCPs a CLI already covers (§3, Invariant 1.5) |
 
Apply the pruning test per line (§3). If the agent keeps violating a rule that's written down, your file is probably too long and the rule is drowning — the fix is deletion elsewhere, not more emphasis. The same budget governs your MCP stack, not just the file: every always-loaded MCP server competes with your written rules for the same window (§3), so keep enabled servers in the single digits and prefer a CLI-wrapping skill to a standing MCP wherever the CLI suffices.
 
### Skills: crystallized learning, gotchas first
 
The authoring law (E2, Anthropic internal + skills guide): iterate on a hard task in conversation until the agent succeeds, *then* extract the winning approach into a skill. Skills are crystallized in-context learning, not documentation you write speculatively.
 
- **The description field is the highest-leverage element** — it is a trigger specification for the model, not a summary for humans. Pattern: what it does + when to use it + the phrases users actually say. Under-triggering → enrich keywords; over-triggering → add explicit negative triggers ("Do NOT use for…").
- **The gotchas section is the highest-signal content** (E2): append-only tables, endpoints that lie with 200s, field-name aliases. Skip everything the model already knows.
- **Build verification skills first** — the category with the most measurable impact (E3, corroborated): scripted checkers, headless-browser flow drivers, state assertions. Bundle validation *scripts*, not validation prose: "code is deterministic; language interpretation isn't" (E2).
- One skill, one job. Test the trigger by asking the model when it would use the skill — it quotes the description back.
### Subagents and review independence
 
Use subagents for research that would flood your window (the isolation math, E2: a subagent burns 10k+ tokens exploring and returns a 1–2k summary) and for **fresh-context review** — the structural answer to self-preferential bias. The Writer/Reviewer two-session pattern (E2) is the cheapest version: one session writes, a second session with clean context reviews. Don't use subagents for sequential dependent work or same-file edits (conflict risk), and resist breeding a zoo of specialists — too many dilutes routing.
 
### Scoping and parallelism
 
TDD regains its old power as a *scoping* discipline (E2): have the agent write the tests that define done, confirm they fail, then implement until green — this is the in-prompt verification rung formalized. For parallel work, use git worktrees or parallel desktop sessions so edits don't collide; checkpoint/rewind liberally — checkpoints make "try the risky approach" cheap, but they track only the agent's changes and are not a git substitute (E2).
 
### Hooks, carefully
 
Hooks are for policies with zero tolerated exceptions: format-on-edit, block-writes-to-migrations, test-gate-on-stop (mind the 8-block override), back-up-transcript-before-compaction. Remember the trade: CLAUDE.md is advisory; hooks are deterministic — and they run arbitrary shell with your permissions, so they are also your largest self-inflicted blast radius below production.
 
**Worked example — the artifact-sync gate (the structural fix for the drift in §4.6).** If you keep finding that `SPEC.md` got updated but `todos/` didn't, stop reminding the model and gate it. A Stop hook checks, on session end, whether the spec changed without a corresponding todo change, and blocks completion if so:
 
```bash
#!/usr/bin/env bash
# .claude/hooks/require-todo-sync.sh  — Stop hook
# Blocks session end if SPEC.md changed but todos/ did not.
spec_changed=$(git diff --name-only HEAD -- SPEC.md specs/ | head -1)
todo_changed=$(git diff --name-only HEAD -- todos/ | head -1)
if [ -n "$spec_changed" ] && [ -z "$todo_changed" ]; then
  echo "SPEC changed but todos/ was not updated. Update todos/ to reflect the spec change before finishing." >&2
  exit 2   # exit 2 = block, stderr becomes the agent's instruction
fi
exit 0
```
 
Note exactly what this does and doesn't do: it enforces *that* the todos are touched, not that they're touched *correctly* — a verifier on presence, not quality. That's honest to the principle: a weak verifier still beats a wishful instruction, and you strengthen it later if drift continues (E1, "strengthen the verifier rather than the wording"). Mind the 8-consecutive-block override (E2): this is a strong nudge, not an absolute wall. And don't add this hook until the drift has actually bitten you more than once — a hook added "just in case" is paying rent forever (§5).
 
---
 
## 8. Track C — The Engineer and the Organization
 
Everything in Track B, plus the org layer. The frame, triple-corroborated and now canonical (E2/E3, AI-native org practice): **when agentic coding becomes the default, coding throughput stops being the constraint. The bottleneck migrates to verification capacity, review process, security validation, and ownership norms.** Optimizing prompt quality while your review process is the constraint is solving the wrong problem.
 
### Individual practice at the top of the ladder
 
- **Dynamic workflows** (rung 6) for tasks that defeat single-context execution: large migrations, fan-out analysis, adversarial verification, tournament judging (pairwise comparison is more reliable than absolute scoring, E2). Set explicit token budgets in the request. Save proven workflows as templates; treat them as templates, not verbatim scripts.
- **The quarantine pattern** for anything touching untrusted content (E2): agents that read untrusted input are barred from high-privilege actions in the same run. This is your prompt-injection defense; make it policy, not preference.
- **Real sandboxing requires filesystem *and* network isolation** (E2) — either alone is escapable (no network isolation → exfiltrate credentials; no FS isolation → escape and reach the network).
- **Headless mode in CI** for mechanical work at scale; agent teams where coordination between sessions is itself automated.
### Rolling it out (E3 — vendor playbook, but the only one in the corpus)
 
Pilot with 20–50 genuine enthusiasts whose deliverables are *artifacts*: CLAUDE.md files, skills, an automation inventory, a support channel. Launch wide with a hackathon; sustain with internal champions rather than external training. Govern skills organically — sandbox folder → traction → promotion to a shared marketplace; every checked-in skill costs context for everyone, so promotion is curation (E2). Measure skill usage with tool-use logging hooks; measure outcomes with task-completion time, migration velocity, onboarding duration — and treat lines-of-code as what the vendor itself admits it is: "activity, not necessarily value" (E3).
 
### Norms that must be rewritten
 
Review capacity is now the scarce resource — budget human review for *design and risk*, delegate mechanical review to fresh-context agents, and require evidence artifacts (test output, screenshots, recordings) attached to AI-produced PRs. Ownership needs an explicit answer to "who owns code no human wrote" before the incident, not after. Hiring (E3, Anthropic's own stated practice): index on product-sense builders and deep systems expertise — raw throughput is what the models took.
 
---
 
## 9. Project-state branching: greenfield, legacy, stalled
 
**Greenfield.** Run the spec interview before any code exists; let the architecture come out of the interview. Write CLAUDE.md from day one — even three lines. Encode conventions *as they are decided*, because in a greenfield project every convention is one session old and the agent was there when it happened. Cheap pivots (E3) mean you should bias toward building and revising over deliberating.
 
**Legacy / large / old.** This is the best-evidenced scenario in the entire corpus (E1: 17 years, 900k lines, 8 developers). The method is §4.5's trainee loop, applied patiently: scoped first project → record what the agent needed to know → expand scope. Three legacy-specific findings from the primary evidence: keep the context layer in a **separate versioned repository** so it spans branches and decades; let skills *reference* your existing documentation rather than duplicate it; and route skills by file path, not just description, once the codebase has distinct territories (E1 — their hook injects the right skill based on which paths are touched). The headline outcomes — a year-stalled feature in two weeks, a three-year-frozen module updated in a day — are E3: plausible, self-reported, uncontrolled. The *method* is E1 and checkable.
 
**Stalled or mid-flight (the "any state" case).** Adopt the architecture retroactively: run the init command, then a dedicated archaeology session — "read this codebase and draft MEMORY.md: what would a new senior developer need to know that the code doesn't say?" Mine your own history: past sessions and git logs can be processed into CLAUDE.md rules and gotchas (E2, a documented workflow use case). Then re-enter the loop at §4.1 with a spec for the next increment, however small. The trainee loop does not care how messy the trainee's first day is.
 
---
 
## 10. Known failure modes of this guide's own prompts
 
A guide that preaches "trust verifiers, not wording" must apply that to itself. These are defects observed when the v1.0 prompts met real sessions (E-class: **field-logged, n=1** — directionally real, not statistically established). Each is a case of the same root cause: *the model acts on what is in context, and a prompt's wording failed to put the right thing there.* That is not a model defect; it is a prompt-design defect, and it is fixable.
 
| Symptom | Why it happens | Fix | Where |
|---------|----------------|-----|-------|
| Interview anchors questions on the repo/folder name, not your description; sometimes never asks what the project *is* | The repo name is a high-salience token competing with your description; the model anchors on it | "Description is the only source of truth; ignore the repo name; restate your understanding before asking" | §4.1 |
| Interview covers some topics deeply, skips others (e.g., architecture or UI/UX barely touched) | Listing topics is a suggestion the model prioritizes unevenly | Drive coverage from **required SPEC.md sections**, not interview topics; keep interviewing until each section is concretely fillable | §4.1 |
| Agent asks theoretical questions when a scaffold already exists | Interview-first assumes an empty folder; with structure present the agent should read first | Read existing structure (or scaffold first) *before* interviewing; interview-first is for empty folders only | §4.1 |
| New session doesn't know where the last one stopped | A fresh session has zero memory; it knows only files | The session-resume ritual: "Read SPEC.md, todos/active/, learnings.md; tell me state and next task; confirm before working" | §4.6 |
| Spec gets updated but `todos/` silently doesn't | The model edits only the files the prompt names; no ambient sync exists | Manual standing clause (rungs 1–2) or the artifact-sync Stop hook (rung 5) | §4.6, §7 |
 
The cross-cutting lesson, and the reason these clustered rather than scattered: **three of these five are the guide stating a principle but supplying a prompt too weak to enforce it.** The repair pattern is identical every time — convert a hope embedded in wording into a structural constraint (a required output section, a restate-before-acting clause, a deterministic gate). If you discover a sixth failure mode in your own use, it almost certainly fits this shape too; fix it the same way, and log it here. This section is itself a `learnings.md` for the guide.
 
---
 
## Appendix A — Current knobs (June 2026; **this section rots**)
 
Verify anything here against the live docs before relying on it: **`code.claude.com/docs`** (the best-practices page there is the canonical successor to most of the blog corpus). When this appendix disagrees with the docs, the docs win.
 
- **Session & context:** checkpoints on every prompt (restore conversation/code/both; persist across sessions); `/rewind` incl. summarize-from-here; `/compact <hint>`; `/clear`; `/btw` for side questions that never enter context; `/rename`, `claude --continue`, `claude --resume`; `/usage` for plan limits; custom status line for live context tracking.
- **Spec & planning:** plan mode; `Ctrl+G` to edit the plan in your editor; `AskUserQuestion`-driven interviews.
- **Verification:** `/goal` conditions; Stop hooks (8-consecutive-block override); verification subagents; dynamic workflows.
- **Context layer:** `/init`; CLAUDE.md `@path` imports; placement hierarchy (`~/.claude/CLAUDE.md`, `./CLAUDE.md`, gitignored `./CLAUDE.local.md`, parent/child for monorepos); skills in `.claude/skills/` with `$ARGUMENTS` and `disable-model-invocation: true` (skills have absorbed legacy slash commands); subagents in `.claude/agents/`; hooks across 8 lifecycle events in `.claude/settings.json`.
- **Permissions:** default prompts → allowlists (`/permissions`) → auto mode (classifier; availability is plan-gated and changing — check docs) → `--sandbox` (OS-level isolation) → `--dangerously-skip-permissions` (isolated environments only).
- **Scale:** `claude -p` headless (`--output-format stream-json`); git worktrees; desktop parallel sessions; agent teams; dynamic workflows (~May 2026) with promptable token budgets, resumability, and saving to `~/.claude/workflows`.
- **Model-version-specific advice** (effort levels, thinking budgets, subagent spawn defaults) changed between consecutive Opus releases during this research. Treat all such advice as having a shelf life of one model cycle.
## Appendix B — Evidence register
 
| Source | Class | Role in this guide |
|--------|-------|--------------------|
| pwiz-ai repository (ProteoWizard, cloned & inspected Jun 12 2026) | **E1** | Convergent architecture; verifier principle (verbatim); layered context files; persistent todos; path-based skill routing |
| cc-crossbeam repository (hackathon winner, cloned & inspected Jun 12 2026) | **E1** | Operator-track reality check: spec/skills/design-bible artifacts behind the "no code" story; skills as product runtime |
| Best practices (live canonical docs, code.claude.com) | **E2** | Verification ladder; spec interview; CLAUDE.md tables; session mechanics; current knobs |
| Effective Context Engineering for AI Agents (Anthropic engineering) | **E2** | Attention budget; context-rot mechanism; just-in-time retrieval; compaction/notes/subagents |
| Skills guide (PDF) + "How we use skills" + dynamic workflows + hooks + subagents + sessions + CLAUDE.md articles | **E2** | Mechanisms throughout §§3–8 |
| MacCoss/Skyline, Respiro/Vlasenko, hackathon winners, org-scaling, AI-native-org articles | **E3** | Case outcomes, rollout playbook, role-reshaping claims — plausible, vendor-reported, uncontrolled |
| Bun Zig→Rust rewrite via workflows | **E4** | Sole external workflow success claim; cited as claim, not verified |
| ECC community config pack (affaan-m/ECC, README + in-repo longform guide, inspected Jun 2026) | **E4** | External non-Anthropic witness to convergent architecture; concrete anti-example for §5 (capability ahead of pain → context tax); MCP-budget remedy (§3) and pass@k/pass^k selector (§3). Self-reported scale/popularity metrics non-credible (internally contradictory, commercially motivated) — mechanisms used, outcome claims discarded |
 
**Corpus bias statement:** ~90% of sources are Anthropic-published. Mechanisms in this guide are checkable on your own machine; outcome numbers are not. The strongest evidence herein is the unplanned convergence of independent projects on the same architecture — and you will replicate or refute that yourself within your first month of disciplined practice.
 
*End of guide. Maintained the way it preaches: this document is a context artifact. Version it, prune it, and strengthen its verifiers.*