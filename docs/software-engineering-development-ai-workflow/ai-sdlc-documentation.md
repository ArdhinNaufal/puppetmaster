# Documentation Layer — Companion to the AI SDLC Workflow Guide
 
**Version 1.0 — July 2026.** Extension session 3 deliverable. Tracks guide v1.3, unified pipeline v1.2 (becomes v1.3 after integration). Framing locked per plan: **lowest verification ceiling in this plan** — presence and drift are gateable; quality is almost pure judgment.
 
> **Activation note (read first).** Everything in this doc is **on-demand**: spec sections activate at `/spec` time, the ADR skill loads when a forcing-section decision is made or changed, the doc-generation skill loads when user-facing docs are needed, the style skill loads when prose quality matters, and the docs-drift hook is **earned** (install only after drift has bitten you more than once). **Net standing-context cost: 0 lines.** Nothing here is loaded into every session.
 
> **Rot banner.** References to external sites (diataxis.fr, developers.google.com/style, adr.github.io) are the rot-prone layer. Verify links before citing; where this doc and the live sources disagree, the live sources win.
 
---
 
## 0. The one idea this layer adds
 
The workflow already produces structured artifacts (SPEC.md, learnings.md, todos/) and already suffers from the drift problem (guide §4.6: "the agent updates exactly the files your prompt names, and nothing else"). This layer does two things:
 
1. **Forces documentation decisions at spec time** — using Diátaxis (E2c fetched, diataxis.fr) as the organizing framework that the spec interview pulls through, so every project declares what documentation it produces and where each piece lives.
2. **Records architecture decisions as they happen** — using Nygard's ADR mechanism (E2c fetched, adr.github.io) integrated with session 1's forcing sections, so the rationale behind spec decisions doesn't evaporate between sessions.
There are no universal documentation rules in this doc, for the same reason session 1 has no universal architecture rules: what a project documents, how much, and in what style depends on that project's audience, lifecycle stage, and team. The spec interview forces the decisions; this layer provides the vocabulary and the enforcement mechanisms.
 
| Concern | Instrument | Rung | Verifier |
|---|---|---|---|
| What documentation exists, who it's for, where it lives | Spec-interview forcing section (Diátaxis quadrants) | 2 (CLAUDE.md-level) | Presence check: section filled concretely [Deterministic] |
| Why architecture decisions were made | ADR skill (Nygard template) | 3 (on-demand skill) | ADR file created when forcing section changes [Deterministic presence, judgment quality] |
| User-facing docs generated from workflow artifacts | Doc-generation skill | 3 (on-demand skill) | Output produced [Deterministic presence]; accuracy is [judgment — review gate] |
| Prose quality and style consistency | Style skill (Google guide reference) | 3 (on-demand skill) | [judgment — review gate] entirely |
| Code changed but docs didn't | Docs-drift hook (earned) | 5 (hook) | `git diff` presence check [Deterministic] |
 
---
 
## 1. The SPEC.md forcing section — Documentation plan
 
Added to `/spec`'s required output sections, after the existing "Scale & operations" sections from session 1. The mechanism is unchanged: required sections pull the interview.
 
### 1.1 Documentation plan
 
```
- Documentation plan:
  * Audience — who reads this project's documentation? (developers on
    the team, external API consumers, non-technical stakeholders, end
    users — list each audience)
  * Quadrant allocation — for each audience, which Diátaxis quadrants
    apply:
      - Tutorials (learning-oriented, guided lessons)
      - How-to guides (task-oriented, assume competence)
      - Reference (information-oriented, mirrors code structure)
      - Explanation (understanding-oriented, context and rationale)
    Not every project needs all four. A library with a stable API may
    need only Reference + How-to. An onboarding-heavy project may need
    Tutorials + Explanation. Declare what you will produce.
  * Location — where does each doc artifact live? In-repo markdown,
    external site, generated from code, or "derived from SPEC/ADRs via
    the doc-generation skill"?
  * ADR policy — will this project record architecture decision records?
    Default: yes, for any decision made in the Code Architecture or
    Scale & Operations spec sections. Override: state why not.
```
 
**The compass rule** (Diátaxis, E2c fetched): when you're not sure which quadrant a piece of documentation belongs to, ask two questions: (1) does it inform action or cognition? (2) does it serve the reader's acquisition of skill or application of skill? The answers yield the quadrant. This rule is for the operator's use during the interview, not for the agent to enforce mechanically.
 
**What this section prevents:** projects that produce documentation without declaring its audience or purpose — the equivalent of writing code without a spec. The interview forces the declaration; the declaration makes later presence-checking possible.
 
---
 
## 2. The ADR skill (on-demand — `.claude/skills/adr/`)
 
### Trigger specification (the description field)
 
```
Use this skill when: a decision is made or changed in SPEC.md's Code
Architecture or Scale & Operations sections, or when the operator says
"record this decision," "ADR," "why did we decide," or "document this
architectural choice." Also triggers from /plan when a plan step
involves choosing between architectural alternatives.
 
Do NOT use this skill for: routine implementation decisions (which
library version, which API endpoint), bug fixes, style choices, or
anything that doesn't affect the project's architectural structure,
dependency direction, scaling strategy, or module boundaries.
```
 
### Template (Nygard + Reconsider-when)
 
```markdown
# ADR-NNN: [Title — the decision in imperative mood]
 
## Status
 
[Proposed | Accepted | Deprecated | Superseded by ADR-NNN]
 
## Context
 
[What forces are at play? What is the motivating issue? Include the
relevant SPEC.md section that forced this decision. Reference any
tradeoff tables from ai-sdlc-architecture.md §2 or
ai-sdlc-refactoring.md §5 if the decision resolves an E2c conflict.]
 
## Alternatives considered
 
[List each alternative with one sentence on why it was rejected. This
section is often the most valuable to future readers (E4, confirmed
across S5/S6/S7). An ADR with no alternatives considered is a
retroactive justification, not a decision record.]
 
## Decision
 
[What is the change? State the concrete choice and its scope.]
 
## Consequences
 
[What becomes easier or more difficult? Separate positive and negative.
State consequences as forecasts ("we expect..."), not outcomes.]
 
## Reconsider when
 
[Name the trigger for revisiting this decision. Examples: "if we exceed
the declared scaling ceiling of N," "if the team grows beyond 3
developers," "if the dependency direction constraint proves too costly
for feature X." An ADR without a reconsider-trigger never expires, which
is an ADR failure mode (E4, S6).]
```
 
### ADR file conventions
 
- **Location:** `docs/adr/` directory in the project root. Numbered sequentially: `001-use-postgres.md`, `002-monorepo-structure.md`.
- **Immutability:** Accepted ADRs are never edited. If a decision changes, a new ADR supersedes it (Status → "Superseded by ADR-NNN"). History matters.
- **Size guard:** An ADR longer than one page is probably a design document in disguise (the "Mega-ADR" anti-pattern, E4, Zimmermann). Move the detailed design to a separate doc and link from the ADR.
### Gotchas — the defaults the model must resist
 
| # | Gotcha | Why it happens | What to do instead |
|---|--------|---------------|-------------------|
| 1 | **Retroactive ADR** — writing the ADR after the decision is already implemented | The model treats documentation as a post-hoc activity | Write the ADR *during* `/plan` or `/spec`, not after `/next` completes |
| 2 | **Missing alternatives** — only documenting the chosen option | The model optimizes for the winning path and discards the analysis | Always fill "Alternatives considered" — an ADR with no alternatives is a justification, not a decision record |
| 3 | **Mega-ADR** — stuffing implementation details, code snippets, and diagrams into the ADR | The model conflates "document this decision" with "write a design doc" | Keep the ADR to context + decision + consequences. Link to design docs for detail. |
| 4 | **Vague consequences** — "this will improve maintainability" | The model produces plausible-sounding but unverifiable prose | State concrete forecasts: "adding the message queue increases operational complexity (one more service to monitor)" |
| 5 | **No reconsider-when** — the ADR has no expiry trigger | The model doesn't think about decision shelf life | Always fill the field. If you can't name a trigger, the decision may not be architecturally significant enough for an ADR. |
 
---
 
## 3. The doc-generation skill (on-demand — `.claude/skills/doc-generation/`)
 
### Trigger specification
 
```
Use this skill when: the operator asks to generate user-facing
documentation, a README, onboarding guide, decision history, or any
non-technical documentation from the project's existing artifacts. Also
triggers on "generate docs," "write a README," "create onboarding
guide," "summarize decisions for stakeholders."
 
Do NOT use this skill for: writing or updating SPEC.md, MEMORY.md,
learnings.md, or any workflow-internal artifact. Those are the INPUT
to this skill, not its output.
```
 
### The mapping — existing artifacts to user-facing documentation
 
| Input artifact | Diátaxis quadrant of output | Generated document | What the skill does |
|---|---|---|---|
| SPEC.md (tech stack, data model, architecture sections) | **Reference** | README / project overview | Extracts the "what" from spec sections; strips interview mechanics; writes for the declared audience |
| ADRs (docs/adr/) | **Explanation** | Decision history | Summarizes each ADR's context + decision + consequences for the non-technical audience; links to full ADRs for technical readers |
| learnings.md | **Explanation** / **How-to** | Onboarding guide / gotchas doc | Reorganizes learnings by topic; adds context for new team members; surfaces the "watch out for" patterns |
| SPEC.md (verification steps) + scripts/verify-*.sh | **How-to** | Testing / verification guide | Describes how to run the verification suite and what each check does |
 
### Constraints on generation
 
- **The generated doc is a view, not a source of truth.** The source of truth remains SPEC.md, ADRs, and learnings.md. If the generated doc and the source disagree, the source wins. State this in the generated doc's header.
- **Quality is [judgment — review gate].** The skill can produce plausible-but-wrong prose. The operator must review generated docs before they're committed. The presence-hook (§5) cannot catch this. Say so.
- **Audience matching.** The skill reads the documentation plan from SPEC.md (§1) to determine audience. If no documentation plan exists, the skill refuses and routes back to the spec interview — same pattern as `/arch-verify` refusing when architecture sections are vague.
---
 
## 4. The style skill (on-demand — `.claude/skills/documentation-style/`)
 
### Trigger specification
 
```
Use this skill when: the operator asks for documentation to follow a
style guide, asks for prose quality review, or says "check the style,"
"review the writing," "make this consistent," "follow Google style."
 
Do NOT use this skill for: code comments, commit messages, or
agent-facing artifacts (CLAUDE.md, skill files, command files). Those
have their own conventions. This skill is for human-facing prose only.
```
 
### Content — pointers, not reproduction
 
The Google developer documentation style guide (E2c fetched, developers.google.com/style) is too large to load as a skill. The skill contains only:
 
**The highlights (fetched, E2c):**
1. Conversational, friendly tone — not frivolous
2. Second person ("you"), active voice, present tense
3. Sentence case for headings
4. Descriptive link text (not "click here")
5. Serial commas
6. Code in code font, UI elements in bold
7. Write for accessibility; write for a global audience
8. "Guidelines, not rules — depart when doing so improves your content"
**The gotchas — what the model gets wrong without the guide:**
 
| # | Gotcha | What the model does | What the guide says |
|---|--------|--------------------|--------------------|
| 1 | **Passive voice** | Defaults to passive in technical prose ("the file is created") | Active voice with clear actor ("the system creates the file" or "create the file") |
| 2 | **Future tense for present behavior** | "The function will return…" | Present tense: "The function returns…" |
| 3 | **First person plural** | "We can see that…" "Let's configure…" | Second person: "You can see…" "Configure…" |
| 4 | **Non-descriptive links** | "Click here for more information" | Descriptive: "For more information, see [Configuring authentication]" |
| 5 | **Anthropomorphizing software** | "The server wants to…" "The API knows…" | Software doesn't want or know things. "The server requires…" "The API provides…" |
| 6 | **Excessive hedging** | "You might want to consider possibly…" | Direct: "Consider…" or just do it |
 
**The pointer:** For anything beyond these highlights, consult developers.google.com/style directly. The guide is searchable. Don't reproduce it.
 
---
 
## 5. Docs-drift hook (earned — `.claude/hooks/docs-drift.sh`)
 
**EARNED, NOT DAY-ONE.** Install this hook only after documentation drift has bitten you more than once. A hook added "just in case" is paying rent forever (guide §5). The manual interim: review your documentation plan (§1) at each `/review` and ask whether any code changes affected documented areas.
 
### The hook (concrete script)
 
```bash
#!/usr/bin/env bash
# .claude/hooks/docs-drift.sh — Stop hook
# Blocks session end if code in documented areas changed but docs did not.
#
# PREREQUISITE: A docs/map.txt file listing the mapping from code
# directories to doc files, one mapping per line:
#   src/auth/ -> docs/authentication.md
#   src/api/  -> docs/api-reference.md
#
# If docs/map.txt does not exist, this hook exits 0 (no-op).
# This is intentional: the hook only activates for projects that have
# declared their documentation mapping. No mapping = nothing to check.
 
MAP_FILE="docs/map.txt"
 
if [ ! -f "$MAP_FILE" ]; then
  exit 0
fi
 
CHANGED_CODE=$(git diff --name-only HEAD)
DRIFT_FOUND=0
 
while IFS='->' read -r code_dir doc_file; do
  code_dir=$(echo "$code_dir" | xargs)  # trim whitespace
  doc_file=$(echo "$doc_file" | xargs)
 
  [ -z "$code_dir" ] && continue
  [ -z "$doc_file" ] && continue
 
  code_changed=$(echo "$CHANGED_CODE" | grep "^${code_dir}" | head -1)
  doc_changed=$(echo "$CHANGED_CODE" | grep "^${doc_file}" | head -1)
 
  if [ -n "$code_changed" ] && [ -z "$doc_changed" ]; then
    echo "DOCS DRIFT: Code in ${code_dir} changed but ${doc_file} was not updated." >&2
    DRIFT_FOUND=1
  fi
done < "$MAP_FILE"
 
if [ "$DRIFT_FOUND" -eq 1 ]; then
  echo "Update the affected documentation files, or remove the mapping from docs/map.txt if the docs are no longer relevant." >&2
  exit 2   # exit 2 = block, stderr becomes the agent's instruction
fi
 
exit 0
```
 
### Design notes
 
- **`docs/map.txt` as the prerequisite.** The hook does nothing without an explicit mapping file. This is the same pattern as `/arch-verify` refusing without concrete spec sections: no declaration → no enforcement → correct behavior. Projects that haven't declared their doc mapping don't get false positives.
- **Presence, not quality.** The hook checks whether the doc file was touched, not whether the update is correct. This is honestly weak on quality, and that's stated here. The quality check is the review gate.
- **The 8-block override applies.** Same as every Stop hook: after 8 consecutive blocks, the tool overrides. The hook is a strong nudge, not an absolute wall.
- **"Detection is the tool's job. Mutation is the agent's job."** (E4, driftdev.sh — design principle adopted.) The hook detects; the agent or human decides what to update.
---
 
## 6. Integration diffs — unified pipeline v1.2 → v1.3
 
### 6.1 Spec section addition
 
**Add** to `/spec` command's required SPEC.md sections, after "Scale & operations":
 
```
- Documentation plan:
  * Audience — who reads this project's documentation?
  * Quadrant allocation — for each audience, which Diátaxis quadrants
    apply (Tutorial, How-to, Reference, Explanation)? Not every project
    needs all four. Declare what you will produce.
  * Location — where does each doc artifact live?
  * ADR policy — will this project record architecture decision records?
    Default: yes for Code Architecture and Scale & Operations decisions.
```
 
### 6.2 Skill additions
 
**Add** to `.claude/skills/` directory:
 
- `adr/` — Architecture Decision Records (§2 above). Trigger: forcing-section decisions made or changed.
- `doc-generation/` — User-facing documentation from workflow artifacts (§3 above). Trigger: operator requests generated docs.
- `documentation-style/` — Google style guide highlights and gotchas (§4 above). Trigger: prose quality review.
### 6.3 Review-gate failure classes
 
**Add** to the `/review` command's failure-class list:
 
- **Stale documentation** — code in a documented area changed but the corresponding documentation was not updated. Verifier: `git diff` cross-reference against `docs/map.txt` (if it exists). [Deterministic presence check, judgment quality check]
- **Quadrant mismatch** — documentation placed in the wrong Diátaxis quadrant (e.g., a tutorial overloaded with reference material, or a how-to guide that teaches rather than directs). Verifier: apply the Diátaxis compass (action vs. cognition? acquisition vs. application?). [judgment — review gate]
- **Retroactive ADR** — an ADR written after implementation is complete, with reconstructed context and no genuine alternatives considered. Verifier: check ADR timestamps against implementation commits. [Partially deterministic; judgment for quality of alternatives]
### 6.4 Known failure modes additions to pipeline §10
 
**Add:**
 
| Symptom | Why | Fix |
|---|---|---|
| Doc generation produces plausible-but-wrong prose that the presence-hook happily passes | The hook checks whether the doc file was touched, not whether the content is correct; the model generates fluent text that sounds right | The honest answer is the review gate; no pretending otherwise. Review generated docs before committing. |
| Documentation debt accumulates in `/loop` mode because the drift hook isn't installed yet | The hook is earned, not day-one; without it, doc updates depend on manual discipline | The manual interim: review the documentation plan at each `/review`. The hook is the earned enforcement. |
| ADR written months after the decision — context reconstructed, alternatives forgotten | The model treats documentation as post-hoc | The ADR skill's gotcha #1; the trigger integration with `/plan` and `/spec` makes concurrent writing the default path |
| ADR used as a design document (Mega-ADR) | The model conflates decision recording with design documentation | Skill gotcha #3; the size guard (one page max) |
 
### 6.5 Convergent architecture tree update
 
**Add** to pipeline §8's project tree:
 
```
├── docs/
│   ├── adr/                   # architecture decision records (numbered, immutable)
│   │   ├── 001-*.md
│   │   └── ...
│   └── map.txt                # (optional) code-dir → doc-file mapping for drift hook
├── .claude/
│   ├── skills/
│   │   ├── adr/               # ADR template, trigger, gotchas
│   │   ├── doc-generation/    # artifact-to-user-docs mapping
│   │   ├── documentation-style/ # Google style guide highlights + gotchas
│   │   └── ...existing...
│   ├── hooks/
│   │   ├── docs-drift.sh      # (EARNED) blocks if code changed but mapped docs didn't
│   │   └── ...existing...
```
 
### 6.6 Version bump
 
`ai-sdlc-unified-pipeline.md` version: **v1.2 → v1.3.** Version line update:
 
> **Version 1.3 — July 2026.** [...] **v1.3 adds:** the documentation plan forcing section in `/spec` (Diátaxis quadrant allocation, audience declaration, ADR policy), three on-demand skills (ADR recording with Nygard template and reconsider-when field, doc-generation mapping from SPEC/ADRs/learnings to user-facing docs, documentation-style with Google guide highlights and gotchas), three new review-gate failure classes (stale documentation, quadrant mismatch, retroactive ADR), the docs-drift earned Stop hook (presence check against declared code-to-doc mapping), and four new failure modes. See `ai-sdlc-documentation.md` for the companion doc. Standing-context delta: 0 lines (all additions are on-demand).
 
---
 
## 7. Known failure modes (seeded)
 
Per plan §2 invariant 6. Seeded from the plan's anticipated modes plus research findings. To be populated by field use.
 
| # | Failure mode | Verifier | Status |
|---|---|---|---|
| 1 | **Plausible-but-wrong generated docs** — the doc-generation skill produces fluent prose that sounds right but misrepresents the spec or learnings. The presence-hook detects that docs exist, not that they're correct. | [judgment — review gate] — the operator must review generated docs before committing. No deterministic fix exists for this failure mode; honesty is the mitigation. | Anticipated (plan §6) |
| 2 | **Documentation debt in `/loop` mode** — docs don't update because the drift hook isn't installed and no standing clause in `/loop` names doc files. Docs quietly fall behind code. | The manual interim: check the documentation plan at each `/review`. The drift hook is the earned enforcement layer. | Anticipated (plan §6) |
| 3 | **Retroactive ADR** — ADR written after implementation, with reconstructed context and fabricated alternatives. Has the form of a decision record but not the substance. | ADR skill gotcha #1; trigger integration with `/plan` and `/spec` makes concurrent writing the default. [Partially deterministic — timestamp check; judgment for alternative quality] | Anticipated (research, E4 S5/S6) |
| 4 | **Mega-ADR** — detailed design, code snippets, and diagrams stuffed into what should be a one-page decision record. Drowns the actual decision in noise. | ADR skill gotcha #3; size guard (one page max, link to design docs for detail). [judgment — review gate] | Anticipated (research, E4 S7) |
| 5 | **Drift hook false positive** — the code-to-doc mapping in `docs/map.txt` is stale (maps to a doc file that was moved or renamed), causing the hook to fire on every code change. | The hook exits 0 if `docs/map.txt` doesn't exist. But a stale mapping triggers false alarms until the mapping is fixed. The operator must maintain the mapping file. | Anticipated |
| 6 | **Quadrant contamination** — the model writes a tutorial overloaded with reference material, or a how-to guide that explains rather than directs. Diátaxis's most common failure mode. | [judgment — review gate] — apply the compass (action/cognition × acquisition/application). The review-gate failure class "Quadrant mismatch" names this. | Anticipated (research, E2c S1) |
| 7 | **Doc-generation skill produces output without a documentation plan** — the model generates docs without knowing the audience or quadrant allocation, producing generic prose that serves no one. | The skill refuses if no documentation plan section exists in SPEC.md. Same pattern as `/arch-verify` refusing without concrete spec sections. | Prevented by construction |
 
---
 
## 8. Ruling-driven deviation log
 
| Ruling | Plan text | Deviation | Rationale |
|---|---|---|---|
| Issue 1 | "Standing clauses in `/next` and `/loop`: documentation updates named explicitly in the per-task step list" (plan §6, scope item 3) | No changes to `/next` or `/loop`. Documentation updates beyond learnings are on-demand only (skills + earned hook). | Operator ruling: doc updates are on-demand, not standing. Consistent with escalation rule — don't add clauses until drift has bitten you. The drift hook is the earned enforcement. |
 
---
 
## 9. Acceptance invariant checklist (self-verification)
 
| # | Invariant | Status |
|---|---|---|
| 1 | Standing-context ≤ 10 lines | **Pass.** 0 lines. All additions are on-demand: spec section activates at `/spec` time, three skills load on trigger, hook is earned. |
| 2 | Every rule names its verifier or is marked [judgment — review gate] | **Pass.** Presence checks → deterministic (`git diff`, file existence). Quadrant allocation → compass test (judgment). Style → judgment. Doc quality → judgment, explicitly stated as lowest verification ceiling. |
| 3 | No pattern-compliance rules | **Pass.** Diátaxis quadrants are a classification framework, not a compliance rule. The spec interview asks "which quadrants do you produce?" — it doesn't say "you must produce all four." ADRs are optional (spec section has a default-yes with override). Style is guidelines, not rules (Google's own framing). |
| 4 | Every E2c conflict → tradeoff table + decision hook | **Pass.** No E2c conflicts found. Sources (Diátaxis, Nygard, Google guide) are complementary, not contradictory. One tension (docs-as-code location) is a per-project decision hook, not a framework conflict. Documented in research ledger §3.4. |
| 5 | Integration diffs are explicit | **Pass.** §6: spec section addition, three skill additions, three review-gate failure classes, four failure mode additions, tree update, version bump — all named with concrete content. |
| 6 | Known failure modes section, seeded | **Pass.** §7: seven failure modes seeded from plan's anticipated modes and research findings. |
| 7 | Evidence marks on every substantive claim | **Pass.** Every source claim carries E2c/E2c-borderline/E4 + (fetched). |
| 8 | On-demand parts explicitly marked | **Pass.** Activation note at top; spec section is per-project; skills load on trigger; hook is earned-only with explicit "EARNED, NOT DAY-ONE" banner. |