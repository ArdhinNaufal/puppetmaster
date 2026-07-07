# Puppetmaster — AI SDLC Workflow Integration Plan

**Version:** 1.1 · **Date:** 2026-07-06 · **Status: IN EXECUTION.** Owner rulings on all
six open decisions are recorded in §8; the owner's start signal was given 2026-07-06.
**WP0 is complete** (dogfood assets live: `todos/`, `learnings.md`, `docs/adr/`,
`.claude/commands/`, `scripts/verify-arch.sh` with acceptance verified). **WP1 is complete
except one item:** the ADR-002 container spike half is blocked on a docker-capable host
(the headless-CLI half PASSED — `docs/adr/spike-002-record.md`). ADRs 000–007 are written.
**WP2 is complete** (domain model + artifact store + tools + REST; golden eval
`workshop-artifact-lifecycle` green at pass^3). **WP4's workbench-independent core is
complete** (verify node + evidence + bounded fix loop + escalation + todo-sync check +
inbox evidence; four golden evals green at pass^3) — its shell-backed check runner rides
WP3. **WP5a (workbench-free WP5 increment) is complete**: the spec-sections theater gate,
the ADR-004 KB mirror, and the three builtin Workshop agents (suite 12/12 at pass^3).
**WP7a (Workshop UI read/manage surface) is complete**: WORKSHOP view + NEXUS chip +
projectApi, gated-mode lint wired through the endpoint, all smoke-tested live against a
booted server. **WP9.1 is complete**: the failure-mode mapping ledger
(`docs/WORKSHOP-FAILURE-MODES.md`) dispositions all 37 unique corpus failure modes with
zero unmapped. Everything remaining (WP3, WP5/WP7/WP9 rest, WP6, WP8) funnels through
the workbench: WP3 is gated on the ADR-002 container spike passing on a docker-capable
host — that spike is now the single blocking item. Each work package runs only on
explicit go-ahead, in order, following the same convention as `docs/RESEARCH-ROADMAP.md`.

**v1.1 changelog:** records the §8 rulings; names the feature (**the Workshop**; entity
**`project`**; per-project dev container **`workbench`**, tools `bench.*`); fixes ADR-002 as
**hybrid** (headless coding CLI for EXECUTE via `bench.delegate`, native agents for
interview/plan/review) and re-sizes WP5 M accordingly; narrows WP1's ADR-002 spike to a
feasibility check; marks v1 audience as Track B/C only; confirms WP0 at full scope; makes
this plan the active roadmap ahead of Tauri packaging and remaining M5 work.

**Sources analyzed:** all 15 files in `docs/software-engineering-development-ai-workflow/`
(7 core documents + 8 research ledgers), read in full, against `docs/PRD.md`,
`docs/ARCHITECTURE.md`, `docs/RESEARCH-ROADMAP.md`, `docs/NEXUS.md`, `docs/HANDOFF.md`, and
direct inspection of `packages/kernel`, `packages/db`, `packages/shared`, and
`apps/server/src/eval`.

---

## 0. Executive summary

The workflow corpus describes a complete, evidence-graded discipline for building software
with AI agents: a five-phase loop (**SPECIFY → PLAN → EXECUTE → VERIFY → RECORD**) governed
by two invariants (*context is the scarce resource*; *trust comes from verifiers, not the
model*), a per-task mode switch (supervised vs. gated-autonomous, chosen by the
pass@k/pass^k question), durable artifacts (spec, plan, todos, learnings, ADRs), and four
on-demand quality layers (architecture, refactoring, documentation, scalability).

**Approved direction (§8 ruling 1): integrate it as a dedicated product feature — the
Workshop — built in phases that *begin* as an operation-style composition of existing
primitives, plus a near-free Work Package 0 that adopts the workflow for developing
Puppetmaster itself.** The full analysis is §2; the short version:

1. It is product-strategic. PRD §5 use case 3 ("Dev automation — CI babysitting,
   code-review agents, repo maintenance") is an MVP target with no implementation today,
   and no competitor in PRD §3's landscape ships an SDLC pipeline with deterministic
   verification gates. This is a differentiator on the same tier as the Bridge.
2. Puppetmaster already has ~70% of the *conceptual* machinery: missions, approval gates,
   autonomy tiers, audit, the Bridge (fresh-context delegation via `agent.ask`), pass^k
   evals (Stage 5 harness is literally τ-bench pass^k — the corpus's Invariant 2 already
   implemented), procedural memory (Stage 4 — the corpus's "skills are crystallized
   learning"), untrusted-data envelopes (the corpus's quarantine pattern), and a workflow
   copilot. The mapping is §3.
3. But three mechanisms cannot be faithfully composed from existing primitives:
   **deterministic gates** (approval nodes are human-only; the corpus's Stop-hook analog
   needs a machine-verdict node), **durable project artifacts** (spec/todos/learnings have
   no home — agent memory and KB are the wrong shape), and a **workbench tool surface**
   (git + test execution; sandboxed code nodes are FS/network-isolated by design). Those
   gaps are what makes this a *feature*, not just an operation. Gap analysis is §4.
4. The corpus's own escalation rule ("automate a behavior only after you've repeated it
   manually"; "capability built ahead of pain becomes a context tax") dictates the build
   order: compose first, promote to first-class machinery only where composition
   demonstrably fails. The phasing in §6 obeys this.

**Execution log:** plan authored and approved 2026-07-06 as a plan-only deliverable;
execution began the same day on the owner's signal (WP0 + WP1 — see §7 checkboxes and the
status header). Product code (WP2+) remains untouched pending go-ahead.

---

## 1. What the corpus actually contains

### 1.1 File inventory and roles

| File | Role | Integration relevance |
|---|---|---|
| `ai-sdlc-workflow-guide.md` (v1.3) | The master guide: invariants, tracks A/B/C, core loop, automation ladder (rungs 1–6), convergent artifact architecture, failure modes | **Primary source.** Defines every mechanism to port |
| `ai-sdlc-unified-pipeline.md` (v1.2) | The operational pipeline: 8 command definitions (`/spec`, `/stack`, `/arch-verify`, `/refactor`, `/plan`, `/next`, `/loop`, `/review`), 3 hook scripts, mode-switch decision table, run sequence | **Primary source.** The concrete behavior spec for the feature's phases |
| `ai-sdlc-architecture.md` (v1.0) | Architecture layer: SPEC forcing sections (5 declarations), ceremony positions, fitness-function gate (`/arch-verify`), legacy ratchet, review failure classes | Quality layer 1 |
| `ai-sdlc-refactoring.md` (v1.0) | Refactoring layer: behavior-preserving contract, coverage precondition (70%), characterization tests, two-hats commit separation, refactor gate | Quality layer 2 — highest machine-verifiability |
| `ai-sdlc-documentation.md` (v1.0) | Documentation layer: Diátaxis forcing section, ADR skill (Nygard + reconsider-when), doc-generation, docs-drift hook | Quality layer 3 — lowest verification ceiling |
| `ai-sdlc-scalability.md` (v1.0) | Scalability layer: YAGNI-counterweighted skill, load-test verifier (k6/locust), ceiling-ADR pattern | Quality layer 4 |
| `ai-sdlc-org-layer.md` (v1.0) | Org layer: evidence-on-PR policy, shared-context curation, ownership question, rollout sizing | Maps to workspace/RBAC/marketplace |
| 8 × `RESEARCH LEDGER…` / `RESEARCH_LEDGER…` | Evidence provenance (E1–E4 grading) behind the docs above | No mechanisms of their own; keep as reference; the E-grading practice itself is worth adopting for our own claims |

**Corpus-internal gaps worth noting:** the guide references two companions that are *not*
present in the directory — `ai-sdlc-worked-examples.md` and `ai-sdlc-pipelines.md`
(Pipelines A and C; only the unified B-track pipeline is here). Nothing below depends on
them, but the owner should know the set is incomplete. Also note the corpus is written for
Claude Code (a coding CLI); §2.3 addresses what "porting" means.

### 1.2 The distilled operating model (what must survive translation)

1. **Invariant 1 — context is scarce.** Standing context is a tax; everything possible is
   on-demand. All four quality layers advertise "standing-context delta: 0 lines."
   *Puppetmaster translation:* agent personas stay lean; quality-layer knowledge loads
   per-task (procedural memory / KB retrieval), never into every tick's prompt. The MCP
   budget rule (Invariant 1.5) maps to per-agent tool grants — grant few, grant narrow.
2. **Invariant 2 — trust comes from verifiers.** Every rule is enforced by a build, test,
   or inspection — not by the model remembering. The verification ladder: in-prompt →
   session goal → deterministic gate → independent judge. The pass@k/pass^k selector
   decides how high to climb: anything that runs unattended repeatedly needs rungs 3–4.
   *Puppetmaster translation:* rung 3 = a new deterministic `verify` node; rung 4 = a
   fresh-context reviewer agent via the existing `agent.ask` bridge; pass^k = the existing
   Stage 5 eval harness.
3. **The five-phase loop** with hard session boundaries (interview, build, and review run
   in separate contexts) and a **per-task mode switch**: supervised (`/next` — one task,
   stop, show evidence) vs. gated autonomous (`/loop` — run until a gate fires).
4. **Artifacts over conversation.** SPEC (with forcing sections that *pull* the interview),
   PLAN, todos (active/backlog/completed as an audit trail), learnings (append-only
   gotchas), ADRs (immutable, superseded-not-edited, with "Reconsider when" triggers).
5. **Earned automation.** Hooks/gates are installed only after their failure mode has
   bitten twice. The anti-example (ECC's 249-skill config pack) is named in the corpus as
   exactly what not to do.
6. **Evidence, not assertions.** Test output, exact commands and returns, screenshots,
   state assertions — attached to the work, reviewed by humans at gates (org layer §1:
   "a PR without its evidence artifact is not ready for review").

---

## 2. Dedicated operation vs. dedicated feature — the analysis

### 2.1 Definitions, in Puppetmaster's vocabulary

**Option A — dedicated operation.** The workflow ships as a *composition of existing
primitives*: builtin templates (`templates` table, `kind: workflow|agent`) implementing the
pipeline as a workflow graph; a "Foreman" orchestrator agent and a "Reviewer" agent; the
five phases expressed with today's node kinds (agent, approval, code, logic); artifacts
stored as KB documents; policies via `approval_policies`. Operators run it like any other
mission from Command/Canvas/NEXUS. No new tables, node kinds, or views.

**Option B — dedicated feature.** A first-class SDLC subsystem (named **the Workshop** per
the §8 ruling): new domain entities (projects, artifacts, evidence), a deterministic
`verify` node kind, a workbench tool surface (git/test execution), workshop-aware UI
(progress, artifact inspector, evidence panel in the approval inbox), and builtin templates
on top.

### 2.2 Decision matrix

| Criterion | A — Operation (compose) | B — Feature (first-class) |
|---|---|---|
| Time to first value | Days — templates + agents only | Weeks — schema, kernel, UI |
| Fidelity to Invariant 2 (deterministic gates) | **Fails.** Approval nodes are human-only; a "gate" acted by an LLM judging itself is the self-preferential bias the corpus disqualifies. Code nodes can compute a verdict but can't run tests (no FS/network) and can't *block with retry-instruction semantics* | Native: `verify` node runs a real check, exit-code gates, stderr becomes the agent's instruction, N-block override |
| Artifact durability & audit | Weak — KB is a retrieval store; no typed task state, no active/backlog/completed lifecycle, no todo↔mission linkage | Typed artifact store; todos link to the missions that completed them (the corpus's "51 completed todos = audit trail") |
| Can execute real SDLC work (git, tests, coverage) | **No.** No repo tool surface exists at all | Yes, via a workbench connector (the single biggest work item, §5.3) |
| Evidence-on-PR mechanism | Prose in mission output — unenforceable | Evidence entities attached to gates; approval inbox renders them |
| Product differentiation (PRD §3) | Invisible — looks like any template | A headline capability: "SDLC with verifiable gates" |
| Risk of over-building (corpus §5 anti-example) | None | Real — mitigated by phasing: build each piece only when the composed version has demonstrated the need |
| Blast radius | ~0 | Schema + kernel + security surface (workbench) |

### 2.3 One honest complication: the corpus is written for a coding CLI

The commands, hooks, and skills in the corpus are Claude Code artifacts. Porting them into
Puppetmaster means *translating mechanisms, not copying files*:

| Corpus construct | Puppetmaster analog |
|---|---|
| Slash command (`/spec`, `/next`…) | Workshop phase = template + agent behavior (persona + task prompt + tool grants) |
| Stop hook (test-gate, refactor-gate…) | `verify` node in the project's graph + policy checks |
| Skill (on-demand expertise) | Procedural memory entry / KB document retrieved per-task (Stage 4 already models "task → steps that worked") |
| CLAUDE.md / MEMORY.md | Agent persona (lean) + workspace KB |
| Session / clear / compact | Agent tick boundaries; Stage 9C compaction; fresh nested mission via `agent.ask` = fresh context |
| Git worktree / repo | Workbench (new tool surface, §5.3) |

The executor question — who does the EXECUTE phase's actual coding — was the plan's
highest-variance decision and is now **ruled (ADR-002, §8): hybrid.** The EXECUTE phase
delegates coding tasks to a **headless coding CLI running inside the workbench container**
(`bench.delegate`), while the interview, plan, and review phases run on **Puppetmaster's
native agent runtime**. This reuses a mature coding agent where coding depth matters, keeps
Puppetmaster in the role the corpus assigns to the *harness* — gates, evidence, artifacts,
audit — and preserves the native path as fallback (§9 risk table). Invariant 2 holds either
way: Puppetmaster's value is the verification machinery around the executor, not the
executor itself.

### 2.4 Recommendation — **accepted (§8 ruling 1)**

**Build Option B — a dedicated feature — phased so that its first shippable increment is
Option A's composition, plus a Work Package 0 that costs almost nothing:**

- **WP0 (operation, repo-level):** adopt the workflow for developing Puppetmaster itself
  (`.claude/` commands and hooks, `todos/`, `learnings.md`, ADRs in `docs/adr/`). This
  dogfoods every mechanism before we productize it — the corpus's own law ("iterate until
  it works, then crystallize") applied at product scale — and pays back immediately in the
  repo's existing session-handoff practice (HANDOFF.md is already a hand-rolled version of
  the corpus's session-resume ritual).
- **WP2–WP4 before UI:** the artifact store, the workbench, and the `verify` node are
  the three things composition can't fake; they are the feature's spine.
- **Templates last, not first:** the project templates ship (WP8) once the machinery they
  reference exists, becoming the marketplace's flagship builtin.

**Naming (§8 ruling 3).** The feature is **the Workshop**; the domain entity is a
**`project`**; the per-project isolated dev container is a **`workbench`** (tools
`bench.*`). Rationale: "pipeline" collides with the existing *workflow* vocabulary (two
process-nouns in one DAG product guarantees permanent confusion); "project" is what the
entity actually is — a repo plus its spec/todos/learnings/ADRs — and collides with nothing;
"the Workshop" follows the house grammar that gives differentiating subsystems theatrical
names (the Bridge, the Construct, NEXUS) while entities stay plain — in puppetry, the
workshop is where marionettes are built and strung before they take the stage. "Workbench"
also removes v1.0's latent `ws.*`-reads-as-workspace ambiguity. Formalized in ADR-001
(WP1), where the owner may still veto.

---

## 3. Concept mapping — corpus → Puppetmaster

Status: ✅ exists · 🟡 partial (exists but needs extension) · ❌ gap (new work)

| # | Corpus concept | Puppetmaster primitive | Status |
|---|---|---|---|
| 1 | Verification rung 4 — independent judge in fresh context | `agent.ask` nested mission (Stage 8): different agent, fresh context, own tool tiers | ✅ |
| 2 | pass^k eval discipline | Stage 5 harness: golden tasks k×, DB-state predicates, trajectory assertions, `pnpm eval` | ✅ |
| 3 | Skills as crystallized learning | Stage 4 procedural memory ("task → tool steps that worked") | 🟡 needs per-task retrieval into workshop prompts + a curation/promotion path (org layer §2) |
| 4 | Quarantine pattern for untrusted input | Stage 1 untrusted-data envelopes + tiers gating resulting actions | ✅ |
| 5 | Human review gate | Approval nodes + inbox + `approval_policies` | 🟡 needs evidence attachment (org layer §1) |
| 6 | Deterministic gate (Stop hook / test-gate) | — (approval nodes are human-only; code nodes can't run tests) | ❌ `verify` node kind |
| 7 | Artifacts: SPEC / PLAN / todos / learnings / ADRs | — (KB is retrieval-shaped; agent memories are agent-scoped) | ❌ typed artifact store |
| 8 | Dev workspace: git, test runner, coverage, fitness tools | — (code nodes are FS/network-isolated by design; no git connector) | ❌ workbench connector |
| 9 | Spec interview (restate-first, forcing sections pull coverage) | Stage 6 copilot NL→draft (draft-never-autosaved is the same human-in-command stance) | 🟡 interview loop + forcing-section templates are new |
| 10 | Plan phase (read-only explore → editable PLAN) | Agent tick with read-tier grants; copilot draft pattern | 🟡 |
| 11 | Mode switch: supervised `/next` vs. gated `/loop` | Approval-after-every-task vs. run-until-gate are both expressible as graph shapes | 🟡 needs the two execute-mode graph templates + the pass@k/pass^k chooser surfaced to the operator |
| 12 | Session lifecycle / context rot management | Ticks, Stage 9C compaction, memory admission control | ✅ |
| 13 | Artifact-sync enforcement (require-todo-sync) | — | ❌ rides the `verify` node (check: spec changed ⇒ todos changed) |
| 14 | Refactor contract (coverage precondition, two-hats, no test-expectation edits) | — | ❌ refactor project template + verify checks (`git diff --diff-filter=M` on test paths) |
| 15 | Architecture fitness (`/arch-verify`, legacy ratchet) | Graph linter exists for *workflow* graphs — same pattern, different target | ❌ per-repo fitness config + verify check |
| 16 | ADRs (immutable, reconsider-when) | — | ❌ artifact type + template; also adopt for our own repo in WP0 |
| 17 | Evidence-on-PR (org layer) | Audit log + mission traces record everything already | 🟡 needs evidence surfaced *at the gate*, not just in the trace |
| 18 | Tracks A/B/C (sort people by what they can verify) | RBAC roles (owner/admin/builder/member) | 🟡 mapping: which roles may run which project modes (member = supervised only, builder+ = gated, admin = policy edits) |
| 19 | Org rollout / shared-context curation | Templates + marketplace (M5), workspace scoping | 🟡 promotion-by-traction needs usage counting |
| 20 | Budget discipline (rungs, token budgets) | Stage 5 cost ledger + budgets gating ticks | ✅ |
| 21 | Model-quality floors for risky work | Stage 9A router profiles `minClassForGatedTools` | ✅ |
| 22 | Failure-mode tables (corpus §10) | Golden-task suite | 🟡 each mapped failure mode becomes an eval case (WP9) |

The density of ✅/🟡 in rows 1–5 and 12/20/21 is the argument that this integration is
*natural* for Puppetmaster; the ❌ rows 6–8 are the feature's spine and the reason Option A
alone was rejected.

---

## 4. Gap analysis (continuing RESEARCH-ROADMAP.md's G-numbering: W = workflow gaps)

| # | Gap | Today | Needed |
|---|---|---|---|
| W1 | Deterministic verification gate | Approval = human; code node = no FS/exec | `verify` node kind: runs a declared check (tool call / script in the workbench), exit code gates the DAG, failure output feeds back to the acting agent as instruction, N-consecutive-failure escalation to a human approval (the corpus's 8-block override, made policy) |
| W2 | Project artifact store | No typed home for spec/plan/todos/learnings/ADRs | `project_artifacts` (typed, versioned, workspace-scoped, linked to projects and missions); todo lifecycle active→completed with mission linkage |
| W3 | Workbench tool surface | No git/exec/coverage tools; sandbox is JS-only, isolated | A containerized workbench per project: git ops, dependency install, test/coverage/fitness execution — least-privilege, egress-allowlisted, credentials via vault. **Largest security surface in this plan** |
| W4 | Project entity & phase state | Missions are single runs; a feature = many runs across phases | `projects` entity grouping missions per phase with the artifact set; or a long-lived workflow + convention. Decide in WP1 (ADR-003) |
| W5 | Interview elicitation loop | Copilot is one-shot NL→draft | Multi-turn interview with restate-first and forcing-section pull; runs in Command view against the Interviewer agent |
| W6 | Evidence at gates | Trace has the data; inbox shows only a prompt | Evidence records (test output, diffs, screenshots, state assertions) attached to `verify`/approval steps; inbox renders them |
| W7 | Quality-layer knowledge delivery | Personas or nothing | On-demand injection per task type (architecture / refactoring / docs / scalability guidance), 0 standing lines — via procedural memory or KB retrieval keyed by project phase + task tags |
| W8 | Mode governance | Any builder can run anything | Role × mode matrix (track B/C analog); gated-autonomous requires the project to have a passing verify configuration first ("you haven't built the infrastructure that makes /loop safe" — the project refuses, like the corpus's verifier refusals) |

---

## 5. Target design sketch (what "done" looks like)

This is a sketch to size the work packages, not a binding design; WP1 turns it into ADRs.

### 5.1 Domain model additions (`packages/shared`, `packages/db`)

```
projects             id, workspaceId, name, repoRef, mode (supervised|gated),
                     phase (specify|plan|execute|verify|record|idle),
                     workbenchId, createdAt, status
project_artifacts    id, projectId, kind (spec|plan|todo|learning|adr|evidence),
                     status (todo: active|backlog|completed; adr: proposed|accepted|superseded),
                     title, body (md/json), version, supersedesId,
                     missionId (which run produced/consumed it), createdAt
verify_checks        id, projectId, name (test|arch|refactor-gate|todo-sync|load|custom),
                     command/toolRef, baseline (legacy ratchet), enabled, earnedNote
evidence             id, stepId/approvalId, kind (test-output|diff|screenshot|state-assert),
                     content/ref, createdAt
```

### 5.2 Kernel additions (`packages/kernel`)

- **`verify` node kind** (W1): config = `{checkRef | inline command, retriesBeforeEscalate}`;
  handler executes in the project's workbench, stores evidence, and on failure loops
  control back to the paired agent node with stderr as instruction (bounded, then escalates
  to a human approval). Graph linter learns: *gated project with no verify node between
  agent and terminal = lint error* (mirror of today's "write action with no approval
  upstream").
- **Executor support** for the bounded agent↔verify retry loop (today edges + resume
  cursor cover most of this; the bounded-loop counter is new).
- **Project orchestrator**: phase transitions, artifact read/write tools exposed to agents
  (`project.artifact.read/write/list`, `project.todo.next/complete` — read/write tiers).

### 5.3 Workbench connector (`packages/mcp-connectors`) — the big rock (W3)

A bundled MCP server managing per-project containerized workbenches:
`bench.clone`, `bench.git` (status/diff/commit/branch; push is **write-approved**),
`bench.exec` (allowlisted commands: install/test/coverage/fitness; **write tier**),
`bench.read`/`bench.write` files (write tier), `bench.destroy` (**destructive**).
Constraints carried over from Stage 1 posture: egress allowlist per workbench, credentials
injected from the vault at spawn, everything audited, results through untrusted-data
envelopes. Per the ADR-002 ruling (hybrid), the headless coding CLI runs *inside* this
container as **`bench.delegate(task, budget)`** and inherits the same walls (filesystem
*and* network isolation — the corpus Track C sandbox rule, verbatim).

### 5.4 Agents (builtin templates, `kind: agent`)

- **Interviewer** — runs SPECIFY: restate-first, forcing sections pull the interview, writes
  the spec artifact + initial todos. Read-tier only. Native runtime.
- **Foreman** — orchestrates phases, decomposes the plan into todos, dispatches EXECUTE
  tasks (via `bench.delegate` per ADR-002), enforces the mode switch. Write-approved.
- **Reviewer** — rung 4: fresh context via `agent.ask`, reads only the diff + spec +
  failure-class list (never the builder's conversation), attacks named failure classes,
  returns findings by severity. Read-tier. Native runtime.

### 5.5 UI (`apps/web`)

- **Workshop view** + NEXUS task pane (`WORKSHOP` chip; a Construct stratum comes later if
  earned): project list + detail — phase progress, artifact browser
  (spec/todos/learnings/ADRs), verify-check dashboard with baselines.
- **Approval inbox extension**: evidence panel (test output, diff, screenshots) rendered
  with the approval — org layer §1 made concrete.
- **Canvas**: `verify` node skin (FUI: a gate glyph; green/red state ring), project
  templates openable/editable like any workflow (human-in-command preserved).

---

## 6. Work packages

> Sizing uses RESEARCH-ROADMAP conventions (S/M/L). Every acceptance criterion is
> verifier-shaped per the corpus's own rule: enforced by a build, test, or inspection.
> Dependencies form a DAG; WP0 and WP1 can start in parallel; nothing else starts before
> WP1 lands.

### WP0 — Dogfood: adopt the workflow for developing Puppetmaster itself · size S · independent · **scope ruled: full, as written (§8 ruling 5)**

*The "operation" track. Zero product code. Immediately useful; field-tests every mechanism
we later productize.*

1. Create `todos/{active,backlog,completed}/` and `learnings.md`; backfill active todos
   from HANDOFF.md §3 and this plan's WP list.
2. Create `docs/adr/` and backfill ADR-000 (adopt ADR practice) plus retroactive ADRs for
   the two biggest locked decisions (TypeScript full-stack; the Bridge as differentiator)
   — marked as retroactive, per the ADR skill's own gotcha #1 honesty rule.
3. Add `.claude/commands/` translated for this repo: `spec`, `plan`, `next`, `loop`,
   `review`, `refactor` (corpus texts §1.4 of the unified pipeline, adjusted: test command
   is `pnpm test`, verify loop is `pnpm typecheck && pnpm build && pnpm eval`).
4. Add `scripts/verify-arch.sh` with **dependency-cruiser** enforcing the monorepo's
   declared dependency direction (`apps → packages; kernel ↛ apps; shared imports nothing
   internal`) with a committed baseline (legacy ratchet — tolerate current count, block
   increases).
5. Hooks: **none on day one.** Per the earned rule, install `test-gate.sh` only after an
   agent session ships a regression that tests would have caught; log the incident in
   `learnings.md` when it happens.
6. Update HANDOFF.md to point at the session-resume ritual ("Read SPEC/todos/learnings…")
   instead of duplicating state.

**Acceptance:** a fresh Claude Code session, given only the resume ritual prompt,
correctly states project state and next undone task (the corpus's own diagnostic);
`scripts/verify-arch.sh` exits non-zero on a deliberately-introduced kernel→apps import
and zero otherwise.

### WP1 — Decisions & ADRs (spike) · size S · gates everything

*Rulings 2–4 and 6 (§8) pre-resolve the largest questions; WP1 formalizes them as ADRs and
closes the rest.*

1. ADR-001: formalize the feature name (**ruled: the Workshop / `project` / `workbench`**
   — owner veto window at ADR review) and the v1 scope boundary (what the Workshop v1 will
   NOT do — e.g., no multi-repo projects, no CI-provider integration in v1).
2. ADR-002: document the **ruled hybrid executor** (headless coding CLI inside the
   workbench via `bench.delegate` for EXECUTE; native agents for interview/plan/review).
   The spike narrows from option-comparison to **feasibility validation**: run a headless
   coding CLI inside a candidate container image against a toy repo, proving budget
   enforcement (token/time caps), progress streaming into a mission trace, and clean exit
   semantics. Include the fallback trigger ("Reconsider when") for the native path.
3. ADR-003: project state representation (new `projects` entity vs. long-lived workflow
   + conventions). Recommendation going in: new entity (missions stay single runs; the
   corpus is explicit that the loop spans many sessions).
4. ADR-004: artifact storage (typed `project_artifacts` vs. KB reuse). Recommendation:
   typed table; optionally *mirror* accepted specs/learnings into KB for retrieval.
5. ADR-005: workbench isolation technology (container per project vs. per exec;
   image contents; resource caps) and its egress/credential policy.
6. Formalize the role × mode matrix (W8). v1 audience is **ruled: Track B/C only**
   (§8 ruling 4) — the standing suggestion (member = supervised + interviews, builder+ =
   gated, admin = check config/policies) becomes the ADR'd default.

**Acceptance:** five accepted ADRs in `docs/adr/` (WP0 format), each with alternatives
considered and a "Reconsider when" trigger; ADR-002's feasibility spike has a recorded
pass (budget cap provably enforced, trace populated); owner sign-off recorded.

### WP2 — Domain model & artifact store · size M · needs WP1

1. `packages/shared`: zod schemas for `Project`, `ProjectArtifact` (all kinds + todo/ADR
   status enums), `VerifyCheck`, `Evidence`; extend `WorkflowNodeKind` with `verify`.
2. `packages/db`: tables + repos (`project-repo.ts`), idempotent migration, workspace
   scoping, indexes on `(projectId, kind, status)`.
3. Artifact lifecycle rules in the repo layer: ADR immutability (supersede, never edit);
   todo transitions require a `missionId`; learnings are append-only.
4. Kernel tools: `project.artifact.*`, `project.todo.*` (read/write tiers per PRD §4)
   registered in the shared catalog so both agents and workflow nodes use them (one-catalog
   rule preserved).
5. REST: `/api/projects` CRUD + `/api/projects/:id/artifacts` (builder+); audit entries
   for artifact writes.

**Acceptance:** `pnpm typecheck && pnpm build && pnpm test` green; a golden eval task
creates a project, writes a spec artifact, advances a todo to completed with a mission
link, and a DB-state predicate verifies the lifecycle rules (editing an accepted ADR
fails; completing a todo without a mission fails).

### WP3 — Workbench connector · size L · needs WP1 (ADR-005); parallel with WP2

1. Workbench lifecycle: create (clone from `repoRef`, vault-injected credentials),
   suspend/resume, destroy (destructive tier). Container per ADR-005.
2. Tools: `bench.git.*`, `bench.exec` (command allowlist from project config),
   `bench.read/write`, with tiers as §5.3; results wrapped in untrusted-data envelopes;
   Stage 9C compaction applies to bulky outputs (test logs are exactly the corpus's "stale
   tool output" case).
3. Security hardening: no ambient network (explicit egress allowlist), resource caps
   (CPU/mem/disk/time), workspace-scoped secrets only, `mcp_tool_pins` posture for the
   connector's own descriptions.
4. `bench.delegate(task, budget)` per the ADR-002 ruling — run the coding CLI headless
   inside the container, stream progress to the mission trace, hard token/time budget.
5. Golden eval: clone a fixture repo, run its test suite via `bench.exec`, assert
   exit-code propagation and that a disallowed egress attempt is refused **and audited**.

**Acceptance:** the eval above passes under `pnpm eval`; a penetration-style golden task
(tool output containing an injection attempting `bench.git.push`) shows the push gated
behind approval — the Stage 1 structural-enforcement story extended to the new surface.

### WP4 — Verification gate machinery · size M · needs WP2 + WP3

1. `verify` node handler: executes a `VerifyCheck` in the project's workbench,
   persists an `Evidence` record, exit code gates the edge.
2. Bounded retry loop: verify-fail routes back to the paired agent node with the check's
   stderr as instruction; after `retriesBeforeEscalate` (default 8 — the corpus's
   override constant, now a policy) an approval is raised instead (human sees evidence).
3. Standard check library (each an *earned* option, off by default, enable per project):
   `test` (suite pass), `todo-sync` (spec artifact changed ⇒ todos changed),
   `refactor-gate` (`--diff-filter=M` on test paths in refactor-tagged work),
   `arch` (fitness tool with ratchet baseline), `load` (SLO thresholds; skips without
   declared numbers — refusal is correct behavior, verbatim from the scalability layer).
4. Graph linter rules: gated project without a verify node = error; verify node whose
   check is disabled = warning; fitness-config/baseline edits inside an execute mission =
   flagged for review (the "agent edits the verifier" failure shape).
5. Evidence in the approval inbox (server: include evidence with approvals; web: render
   test output/diff blocks in the inbox and NEXUS AUTH pane).

**Acceptance:** golden tasks — (a) failing test blocks the project, agent receives stderr,
fix attempt reruns, pass proceeds (trajectory-asserted); (b) 8 consecutive failures
escalate to approval with evidence attached; (c) refactor-gate blocks a run whose diff
modifies test expectations but passes one that only adds test files.

### WP5 — Workshop phases as agent behaviors · size M (per ADR-002 ruling: EXECUTE delegates to the headless CLI) · needs WP2–WP4

1. **SPECIFY:** Interviewer agent + Command-view flow: restate-first, forcing sections
   (tech stack; the five architecture declarations; scale & ops; documentation plan; edge
   cases; out of scope; verification steps) pull the interview; output = spec artifact +
   seeded todos. Include the untranslatable-declaration refusal ("architecture theater"
   detector) when WP4's arch check can't parse a declaration.
2. **PLAN:** read-only explore in the workbench → plan artifact, editable in UI before
   execution (draft-never-autosaved, same as copilot). Skip affordance: one-sentence-diff
   tasks go straight to execute.
3. **EXECUTE — supervised mode:** one todo per mission; implement (`bench.delegate`) →
   test → evidence → approval → artifact updates → stop. (The `/next` contract as a graph
   shape.)
4. **EXECUTE — gated mode:** run todos in order; verify gates between tasks; stop on
   `[review]`-tagged todo or gate escalation. (`/loop` as a graph shape.) Mode chooser in
   the UI asks the pass@k/pass^k question in plain words ("must this work every time
   unattended?") and enforces W8's precondition: no enabled verify checks ⇒ gated mode
   refuses to start.
5. **VERIFY (milestone) + RECORD:** Reviewer agent via `agent.ask` with the failure-class
   list assembled from the quality layers; RECORD writes learnings (append-only), completes
   todos, mirrors accepted artifacts to KB, and — where a hard task succeeded after
   iteration — proposes a procedural-memory entry (skill extraction, human-approved).
6. **Refactor project variant:** the behavior-preserving contract as a template — before
   results recorded, coverage precondition (default 70%, spec-overridable) with the
   characterization-test route, small steps, after-results must match before-results,
   refactor-gate check enabled by default in this variant only.

**Acceptance:** end-to-end golden scenario on a fixture repo: interview → spec artifact
with all forcing sections concretely filled (predicate: no section empty, architecture
section machine-translatable) → plan → two todos executed in supervised mode with evidence
at each approval → one gated run blocked by a deliberately broken test and recovered →
review findings produced by a *different* agent id than the builder (trajectory assertion —
independence is checked, not assumed) → learnings artifact grew.

### WP6 — Quality layers on demand · size M · needs WP5

1. Knowledge packs (procedural memory / KB entries with trigger metadata, 0 standing
   lines): architecture-constraints (the six gotchas: speculative generality, pattern
   reflex, god-module drift, layer skipping, config sprawl, wrapper reflex), refactoring
   (five AI failure modes + smell vocabulary), documentation (ADR gotchas, Diátaxis
   compass, style highlights), scalability (YAGNI counterweight + strategy ladder +
   negative triggers verbatim — they matter more than the positive ones).
2. Injection rule: project phase + task tags select at most one pack per tick; measured
   via audit so unused packs get pruned (the corpus: a gotcha that never fires gets cut).
3. Reviewer failure-class assembly from active packs (ten-minute test, names-carry-intent,
   abstraction-earns-its-keep, compliance-without-gaming, tangled-refactor,
   scope-expansion, stale-docs, premature-scaling, undeclared-ceiling…).
4. ADR artifact flow: architecture/scale decisions during SPECIFY/PLAN prompt an ADR
   artifact (proposed → accepted at the next human gate); ceiling-ADRs require a populated
   "Reconsider when."

**Acceptance:** eval predicates — a refactor-variant mission's context contains the
refactoring pack and not the scalability pack (trajectory/log assertion); a spec whose
scale section says "unknown" never triggers the scalability pack; an accepted scaling
decision without "Reconsider when" fails the record phase's todo-sync-style check.

### WP7 — UI surfaces · size M · needs WP4 (inbox) / WP5 (view)

1. Workshop view: project list + detail (phase stepper, todo board
   active/backlog/completed, artifact reader with version history, verify-check panel with
   baselines and evidence history, mode indicator).
2. NEXUS: `WORKSHOP` task-pane chip in the tray registry (per NEXUS §4 pane conventions);
   Construct stratum deferred until projects earn ambient presence (complexity budget).
3. Approval inbox evidence panel (from WP4.5) polished: diff viewer, test-output block,
   screenshot display; FUI grammar per DESIGN-LANGUAGE.
4. Canvas: verify-node skin + config inspector (check picker, retries-before-escalate);
   project templates open in the canvas like any workflow.
5. Command view: interview session UX (restate card, forcing-section progress meter — the
   spec's unfilled sections are the interview's progress bar).

**Acceptance:** manual UAT script appended to `docs/uat/` covering: run a supervised
project from NEXUS only; approve a gated escalation from the inbox seeing its evidence;
edit a plan artifact before execution. Keyboard + reduced-motion checks per
DESIGN-LANGUAGE hard requirements.

### WP8 — Templates, packaging, org layer · size S · needs WP5

1. Builtin templates: `workshop-supervised`, `workshop-gated`, `workshop-refactor`, plus
   Interviewer/Foreman/Reviewer agent templates — `builtin: true`, category `dev`.
2. Role × mode enforcement (W8, per ADR from WP1.6) at the gateway; member = run
   supervised + answer interviews; builder = gated + template edits; admin = check config
   + policies.
3. Evidence-on-PR as workspace policy: a toggle requiring every gated project's terminal
   approval to carry evidence records (default on).
4. Shared-context curation: procedural-memory promotion flow (sandbox → traction counter →
   workspace-shared), usage measured, prune list surfaced in EVALS view.
5. Ownership line (org layer §3): one paragraph in the workspace settings — who owns
   project-produced code — shown at project creation. Cheapest item in the corpus;
   included because its failure mode is an incident, not friction.

**Acceptance:** fresh workspace: instantiate the supervised template and reach the
interview in <5 minutes without touching the canvas; member role cannot start a gated
project (403, audited); a gated project with the evidence policy on refuses to finish
without evidence.

### WP9 — Evals, failure-mode hardening, docs · size M · needs WP5; grows with each WP

1. Map every row of the corpus's failure-mode tables (guide §10, pipeline §10, four layer
   §7s) to either a golden eval case, a linter rule, or an explicit "accepted risk" line in
   this plan's risk register — no silent drops. (~25 rows; the mapping doc is the
   deliverable.)
2. Priority evals: interview anchoring (repo name ≠ spec subject), agent-edits-verifier
   (fitness config/baseline diffs flagged), wholesale-rewrite detection
   (delete-and-recreate in refactor variant), artifact drift (spec changed ⇒ todo gate),
   invented load thresholds (every threshold traces to a declared SLO), premature-scaling
   (scaling infra without measured failure — reviewer class), stateful-but-replicated.
3. Product docs: `docs/WORKSHOP.md` (operator guide: the five phases, the mode question,
   the earned-checks philosophy), ARCHITECTURE.md §3.11, PRD update (use case 3 →
   implemented-by), NEXUS registry update.
4. Dogfood closure: run WP0's repo workflow *through the product itself* on a small real
   task (self-hosting smoke test) and record learnings.

**Acceptance:** `pnpm eval` green with the new suite at k≥2 (pass^k, not pass@k — this
feature is precisely the "runs unattended repeatedly" case); failure-mode mapping doc has
zero unmapped rows; UAT report updated.

---

## 7. Consolidated master todo checklist

*(Tracking convention as NEXUS §10 — update checkboxes as work lands. Nothing below is
started.)*

**WP0 — Dogfood (operation track)** — ✅ complete 2026-07-06
- [x] `todos/` tree + `learnings.md` seeded from HANDOFF + this plan
- [x] `docs/adr/` + ADR-000 + two retroactive ADRs (ADR-006, ADR-007 — marked retroactive)
- [x] `.claude/commands/{spec,plan,next,loop,review,refactor}.md` translated for this repo
- [x] `scripts/verify-arch.sh` (dependency-cruiser + ratchet baseline = 0; acceptance
      verified: deliberate kernel→apps import fails, clean tree passes)
- [x] HANDOFF.md §0 points at the session-resume ritual
- [ ] (earned, deferred by design) `test-gate` hook — install only after the failure bites

**WP1 — Decisions** — ✅ complete 2026-07-06 except the container spike half
- [x] ADR-001 feature name (ruled: Workshop/project/workbench) + v1 scope boundary
- [x] ADR-002 hybrid executor (ruled); spike headless-CLI half PASSED
      (`docs/adr/spike-002-record.md`: stream output, turn budget, clean exit, scope kept)
- [ ] ADR-002 spike container half — blocked: no Docker daemon in the dev environment;
      rerun `scripts/spike-adr002.sh --container` on a docker-capable host (WP3 precondition)
- [x] ADR-003 project state representation (first-class `projects` entity)
- [x] ADR-004 artifact storage (typed table, KB mirror on acceptance)
- [x] ADR-005 workbench isolation (sibling container per project, default-closed egress)
- [x] Role × mode matrix formalized in ADR-001 (v1 tracks ruled: B/C only)

**WP2 — Domain model** — ✅ complete 2026-07-06
- [x] Shared zod schemas (Project, ProjectArtifact, VerifyCheck, Evidence, `verify` kind;
      deviation: evidence is its own step/approval-scoped table only, not an artifact
      kind — one home per concept)
- [x] DB tables + repos + migration + lifecycle rules (ADR immutability, todo↔mission,
      append-only learnings, spec/plan versioning via supersedesId)
- [x] `project.artifact.*` / `project.todo.*` catalog tools (tiered, workspace-scoped;
      executor ToolContext now carries missionId for the audit link)
- [x] `/api/projects` REST (builder+ mutations) + audit entries
- [x] Golden eval `workshop-artifact-lifecycle`: pass^3 green, trajectory-asserted,
      incl. both lifecycle negatives (accepted-ADR edit refused, mission-less todo
      completion refused)

**WP3 — Workbench connector**
- [ ] Workbench lifecycle (create/suspend/destroy) per ADR-005
- [ ] `bench.git.*`, `bench.exec`, `bench.read/write` with tiers + envelopes + compaction
- [ ] Egress allowlist, resource caps, vault-only secrets
- [ ] `bench.delegate` with hard budgets (per ADR-002 ruling)
- [ ] Golden evals: exit-code propagation; injection→push gated; egress refusal audited

**WP4 — Verification gates** — ✅ workbench-independent core complete 2026-07-06
- [x] `verify` node handler + Evidence persistence (fail-closed on missing/disabled
      check or absent runner)
- [x] Bounded retry loop (fix agent as nested child mission, instruction = check
      failure output) + escalation-to-approval (default 8; override recorded honestly)
- [x] Check library: todo-sync live (DB-native); test / refactor-gate / arch(ratchet) /
      load(skip-without-SLOs) refused-with-pointer until the WP3 workbench runner
      replaces the builtin (noted in the WP3 todo)
- [x] Linter rules (verify-invalid-config; gated-without-verify +
      gated-agent-without-verify behind projectMode — WP5 wires the mode)
- [ ] Linter/review flag for verifier-edit (fitness config/baseline) — workbench
      territory, rides WP3
- [x] Evidence rendered in approval inbox (API + AUTHORIZATIONS panel)
- [x] Golden evals: gate-pass w/ step evidence; escalate-with-evidence; bounded
      fix loop (2 attempts → 1 nested fix mission); disabled-check fails closed
      (refactor-gate M-vs-A eval rides WP3's runner)

**WP5 — Phases** — 🟡 WP5a (workbench-free increment) complete 2026-07-06
- [x] Theater refusal as a deterministic gate: `spec-sections` builtin check
      (required sections concrete or the gate escalates with the section list as
      evidence; per-project override via check command; two golden evals at pass^3)
- [x] KB mirror (ADR-004): spec/learning writes mirror to the KB via tool + REST
      paths, one live doc per artifact replaced per version (eval-pinned)
- [x] Interviewer / Foreman / Reviewer builtin agent templates seeded (corpus
      contracts as personas; Reviewer read_auto with named failure classes)
- [ ] Command-view interview UX (restate card, section progress — with WP7)
- [ ] PLAN (read-only workbench explore → editable artifact) — needs WP3
- [ ] EXECUTE supervised template (`/next` contract; `bench.delegate`) — needs WP3
- [ ] EXECUTE gated template (`/loop`; mode chooser; no-verify ⇒ refuse) — needs WP3
- [ ] RECORD orchestration (ADR-on-accept mirror; skill-extraction proposal)
- [ ] Refactor variant (coverage precondition, characterization route) — needs WP3
- [ ] End-to-end golden scenario (independence trajectory-asserted) — needs WP3

**WP6 — Quality layers**
- [ ] Four knowledge packs (0 standing lines; negative triggers included)
- [ ] Phase/tag-keyed injection + usage audit + prune list
- [ ] Reviewer failure-class assembly
- [ ] ADR flow in SPECIFY/PLAN (ceiling-ADRs require Reconsider-when)
- [ ] Eval predicates (right pack, only the right pack)

**WP7 — UI** — 🟡 WP7a (read/manage surface) complete 2026-07-06
- [x] Workshop view (phase strip, todo board with mission-link badges, artifact
      reader, checks panel with enable-requires-earned-note) + `projectApi` client;
      live smoke test against a booted keyless server incl. REST-path KB mirror
- [x] NEXUS `WORKSHOP` tray chip (jumpOnly per the v0 pane convention)
- [x] Inbox evidence panel (landed with WP4); diff/screenshot renderers ride WP3's
      evidence kinds
- [x] Lint endpoint accepts `projectId` → gated-mode rules verified live
- [ ] Canvas verify-node skin + inspector
- [ ] Interview UX (restate card, section progress) — pairs with WP5 interview flow
- [ ] UAT script in `docs/uat/` (incl. keyboard/reduced-motion) — once full flows exist

**WP8 — Packaging & org**
- [ ] Three project templates + three agent templates (builtin)
- [ ] Role × mode gateway enforcement
- [ ] Evidence-required workspace policy
- [ ] Memory promotion-by-traction + prune surfacing
- [ ] Ownership statement at project creation

**WP9 — Hardening** — 🟡 WP9.1 (mapping ledger) complete 2026-07-06
- [x] Failure-mode mapping ledger (`docs/WORKSHOP-FAILURE-MODES.md`): 50 corpus rows →
      37 unique modes, every one dispositioned (EVAL/LINTER/DESIGN/REVIEW/EARNED/
      DEFERRED-with-mitigation); zero unmapped; DEFERRED upgrades fold into future WP
      acceptance
- [ ] Priority evals needing WP3/WP5 machinery (verifier-edit, rewrite detection,
      invented thresholds, refactor-gate M-vs-A) + interview-anchoring (real-model)
- [ ] `docs/WORKSHOP.md` + ARCHITECTURE/PRD/NEXUS updates — once full flows exist
- [ ] Self-hosting smoke test + learnings

---

## 8. Decision log — owner rulings, 2026-07-06

| # | Question (as put to the owner) | Ruling | Effect on this plan |
|---|---|---|---|
| 1 | Go/no-go on the recommendation (§2.4): dedicated feature, phased, with WP0 | **Go** | Plan approved; this document is the active roadmap for the feature |
| 2 | ADR-002 executor: native agents vs. headless coding CLI vs. hybrid | **Hybrid** | EXECUTE delegates to a headless coding CLI inside the workbench (`bench.delegate`); interview/plan/review run on the native agent runtime. WP1's spike narrows to feasibility validation; WP5 sizes M |
| 3 | Feature name; does "pipeline" collide with existing vocabulary? | **Delegated to Claude — recommendation adopted:** the **Workshop** (feature), **`project`** (entity), **`workbench`** (dev container, `bench.*` tools) | Applied throughout (v1.1). Rationale in §2.4. Formal veto window remains at ADR-001 review |
| 4 | v1 audience: Track B/C only, Track A deferred? | **Yes** | Track B/C (builders/engineers) only in v1; Track A no-code operator flow stays out of scope (§10). Role × mode matrix formalized in WP1.6 |
| 5 | WP0 scope: full as written, or minimal? | **Full as written** | WP0 runs all six items, including commands and the arch-fitness ratchet |
| 6 | Sequencing vs. the existing roadmap | **Yes — this plan takes priority** | WP0/WP1 slot ahead of Tauri packaging and remaining M5 marketplace work; RESEARCH-ROADMAP stages already shipped are unaffected |

**Still open (in-WP1, non-blocking to WP0):** ADR-003 (state representation), ADR-004
(artifact storage), ADR-005 (isolation technology) — recommendations are stated in WP1 and
§5; they get decided at WP1 with alternatives on record.

## 9. Risk register (product-level; corpus-derived risks live in WP9's mapping)

| Risk | Severity | Mitigation |
|---|---|---|
| Workbench = arbitrary code execution surface | High | WP3 hardening; FS **and** network isolation (either alone is escapable — corpus §8); destructive tier on destroy; egress allowlist default-closed for workbenches |
| Over-building (the ECC anti-example: capability ahead of pain) | Medium | Phasing; earned-checks off by default; WP6 packs pruned by measured usage; no Construct stratum until earned |
| Executor bet ages badly (headless CLI API drift) | Medium | ADR-002 isolates it behind `bench.delegate`; native path remains as fallback; "Reconsider when" trigger recorded in the ADR |
| Verification theater (gates exist, checks weak) | Medium | Checks ship with honest refusal semantics (skip ≠ pass, loudly); reviewer class "compliance without gaming"; WP9 evals |
| Token cost of gated projects | Medium | Stage 5 budgets gate ticks already; per-project budget field; router profiles floor risky work |
| Scope creep into a CI system | Low | ADR-001 scope boundary: v1 has no CI-provider integration; verify runs in *our* workbench only |
| Deferred corpus failure modes (workbench-dependent) | Medium | `docs/WORKSHOP-FAILURE-MODES.md` is the ledger: 12 DEFERRED modes, each with a named interim mitigation; upgrading them is part of WP3/WP5/WP6 acceptance |

## 10. Out of scope (v1)

Multi-repo projects; CI-provider integrations (GitHub Actions etc.); Track A no-code
operator flow (ruled: v2 — §8 ruling 4); dynamic-workflow rung 6 (agent-written
orchestration harnesses); fine-tuned review models; Windows workbenches; marketplace
*sale* of projects (sharing yes, per M5).

---

*Maintained the way the corpus preaches: this plan is a context artifact — version it,
check off what lands, append what the field teaches, and strengthen its verifiers rather
than its wording.*
