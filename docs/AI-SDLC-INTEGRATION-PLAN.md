# Puppetmaster — AI SDLC Workflow Integration Plan

**Version:** 1.0 · **Date:** 2026-07-06 · **Status: PLAN ONLY — nothing in this document has
been executed.** Each work package runs only on the owner's explicit go-ahead, in order,
following the same convention as `docs/RESEARCH-ROADMAP.md`.

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

**Recommendation: integrate it as a dedicated product feature — a "Dev Pipeline"
subsystem — built in phases that *begin* as an operation-style composition of existing
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
   needs a machine-verdict node), **durable pipeline artifacts** (spec/todos/learnings have
   no home — agent memory and KB are the wrong shape), and a **dev-workspace tool surface**
   (git + test execution; sandboxed code nodes are FS/network-isolated by design). Those
   gaps are what makes this a *feature*, not just an operation. Gap analysis is §4.
4. The corpus's own escalation rule ("automate a behavior only after you've repeated it
   manually"; "capability built ahead of pain becomes a context tax") dictates the build
   order: compose first, promote to first-class machinery only where composition
   demonstrably fails. The phasing in §6 obeys this.

**Explicitly not executed yet.** This document is the deliverable. No schema, code, or
config changes accompany it.

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

**Option B — dedicated feature.** A first-class "Dev Pipeline" subsystem: new domain
entities (pipelines, artifacts, evidence), a deterministic `verify` node kind, a
dev-workspace tool surface (git/test execution), pipeline-aware UI (progress, artifact
inspector, evidence panel in the approval inbox), and builtin templates on top.

### 2.2 Decision matrix

| Criterion | A — Operation (compose) | B — Feature (first-class) |
|---|---|---|
| Time to first value | Days — templates + agents only | Weeks — schema, kernel, UI |
| Fidelity to Invariant 2 (deterministic gates) | **Fails.** Approval nodes are human-only; a "gate" acted by an LLM judging itself is the self-preferential bias the corpus disqualifies. Code nodes can compute a verdict but can't run tests (no FS/network) and can't *block with retry-instruction semantics* | Native: `verify` node runs a real check, exit-code gates, stderr becomes the agent's instruction, N-block override |
| Artifact durability & audit | Weak — KB is a retrieval store; no typed task state, no active/backlog/completed lifecycle, no todo↔mission linkage | Typed artifact store; todos link to the missions that completed them (the corpus's "51 completed todos = audit trail") |
| Can execute real SDLC work (git, tests, coverage) | **No.** No repo tool surface exists at all | Yes, via a dev-workspace connector (the single biggest work item, §5.3) |
| Evidence-on-PR mechanism | Prose in mission output — unenforceable | Evidence entities attached to gates; approval inbox renders them |
| Product differentiation (PRD §3) | Invisible — looks like any template | A headline capability: "SDLC with verifiable gates" |
| Risk of over-building (corpus §5 anti-example) | None | Real — mitigated by phasing: build each piece only when the composed version has demonstrated the need |
| Blast radius | ~0 | Schema + kernel + security surface (dev-workspace) |

### 2.3 One honest complication: the corpus is written for a coding CLI

The commands, hooks, and skills in the corpus are Claude Code artifacts. Porting them into
Puppetmaster means *translating mechanisms, not copying files*:

| Corpus construct | Puppetmaster analog |
|---|---|
| Slash command (`/spec`, `/next`…) | Pipeline phase = template + agent behavior (persona + task prompt + tool grants) |
| Stop hook (test-gate, refactor-gate…) | `verify` node in the pipeline graph + policy checks |
| Skill (on-demand expertise) | Procedural memory entry / KB document retrieved per-task (Stage 4 already models "task → steps that worked") |
| CLAUDE.md / MEMORY.md | Agent persona (lean) + workspace KB |
| Session / clear / compact | Agent tick boundaries; Stage 9C compaction; fresh nested mission via `agent.ask` = fresh context |
| Git worktree / repo | Dev-workspace (new tool surface, §5.3) |

There is also a load-bearing open decision (ADR-002, §8): does the EXECUTE phase's coding
work run on **(a)** Puppetmaster's native agent runtime armed with dev-workspace tools,
**(b)** an external headless coding CLI (e.g. `claude -p`) orchestrated as an MCP tool
inside the dev-workspace container, or **(c)** hybrid (native for small edits, headless CLI
for full features)? Option (b) reuses a mature coding agent and keeps Puppetmaster in the
role the corpus assigns to the *human-built harness*: gates, evidence, artifacts, audit.
Option (a) is more self-contained but re-implements a coding agent. Invariant 2 holds
either way — Puppetmaster's value is the verification machinery around the executor, not
the executor itself. **This is the first decision to make in WP1, and it swings WP5's
size.**

### 2.4 Recommendation

**Build Option B — a dedicated feature — phased so that its first shippable increment is
Option A's composition, plus a Work Package 0 that costs almost nothing:**

- **WP0 (operation, repo-level):** adopt the workflow for developing Puppetmaster itself
  (`.claude/` commands and hooks, `todos/`, `learnings.md`, ADRs in `docs/adr/`). This
  dogfoods every mechanism before we productize it — the corpus's own law ("iterate until
  it works, then crystallize") applied at product scale — and pays back immediately in the
  repo's existing session-handoff practice (HANDOFF.md is already a hand-rolled version of
  the corpus's session-resume ritual).
- **WP2–WP4 before UI:** the artifact store, the dev-workspace, and the `verify` node are
  the three things composition can't fake; they are the feature's spine.
- **Templates last, not first:** the pipeline templates ship (WP8) once the machinery they
  reference exists, becoming the marketplace's flagship builtin.

The name for the feature ("Dev Pipeline" is used throughout this plan; "Forge" and
"Assembly" are candidates) is an owner decision — ADR-001.

---

## 3. Concept mapping — corpus → Puppetmaster

Status: ✅ exists · 🟡 partial (exists but needs extension) · ❌ gap (new work)

| # | Corpus concept | Puppetmaster primitive | Status |
|---|---|---|---|
| 1 | Verification rung 4 — independent judge in fresh context | `agent.ask` nested mission (Stage 8): different agent, fresh context, own tool tiers | ✅ |
| 2 | pass^k eval discipline | Stage 5 harness: golden tasks k×, DB-state predicates, trajectory assertions, `pnpm eval` | ✅ |
| 3 | Skills as crystallized learning | Stage 4 procedural memory ("task → tool steps that worked") | 🟡 needs per-task retrieval into pipeline prompts + a curation/promotion path (org layer §2) |
| 4 | Quarantine pattern for untrusted input | Stage 1 untrusted-data envelopes + tiers gating resulting actions | ✅ |
| 5 | Human review gate | Approval nodes + inbox + `approval_policies` | 🟡 needs evidence attachment (org layer §1) |
| 6 | Deterministic gate (Stop hook / test-gate) | — (approval nodes are human-only; code nodes can't run tests) | ❌ `verify` node kind |
| 7 | Artifacts: SPEC / PLAN / todos / learnings / ADRs | — (KB is retrieval-shaped; agent memories are agent-scoped) | ❌ typed artifact store |
| 8 | Dev workspace: git, test runner, coverage, fitness tools | — (code nodes are FS/network-isolated by design; no git connector) | ❌ dev-workspace connector |
| 9 | Spec interview (restate-first, forcing sections pull coverage) | Stage 6 copilot NL→draft (draft-never-autosaved is the same human-in-command stance) | 🟡 interview loop + forcing-section templates are new |
| 10 | Plan phase (read-only explore → editable PLAN) | Agent tick with read-tier grants; copilot draft pattern | 🟡 |
| 11 | Mode switch: supervised `/next` vs. gated `/loop` | Approval-after-every-task vs. run-until-gate are both expressible as graph shapes | 🟡 needs the two pipeline graph templates + the pass@k/pass^k chooser surfaced to the operator |
| 12 | Session lifecycle / context rot management | Ticks, Stage 9C compaction, memory admission control | ✅ |
| 13 | Artifact-sync enforcement (require-todo-sync) | — | ❌ rides the `verify` node (check: spec changed ⇒ todos changed) |
| 14 | Refactor contract (coverage precondition, two-hats, no test-expectation edits) | — | ❌ refactor pipeline template + verify checks (`git diff --diff-filter=M` on test paths) |
| 15 | Architecture fitness (`/arch-verify`, legacy ratchet) | Graph linter exists for *workflow* graphs — same pattern, different target | ❌ per-repo fitness config + verify check |
| 16 | ADRs (immutable, reconsider-when) | — | ❌ artifact type + template; also adopt for our own repo in WP0 |
| 17 | Evidence-on-PR (org layer) | Audit log + mission traces record everything already | 🟡 needs evidence surfaced *at the gate*, not just in the trace |
| 18 | Tracks A/B/C (sort people by what they can verify) | RBAC roles (owner/admin/builder/member) | 🟡 mapping: which roles may run which pipeline modes (member = supervised only, builder+ = gated, admin = policy edits) |
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
| W1 | Deterministic verification gate | Approval = human; code node = no FS/exec | `verify` node kind: runs a declared check (tool call / script in dev-workspace), exit code gates the DAG, failure output feeds back to the acting agent as instruction, N-consecutive-failure escalation to a human approval (the corpus's 8-block override, made policy) |
| W2 | Pipeline artifact store | No typed home for spec/plan/todos/learnings/ADRs | `pipeline_artifacts` (typed, versioned, workspace-scoped, linked to pipelines and missions); todo lifecycle active→completed with mission linkage |
| W3 | Dev-workspace tool surface | No git/exec/coverage tools; sandbox is JS-only, isolated | A containerized dev-workspace per pipeline: git ops, dependency install, test/coverage/fitness execution — least-privilege, egress-allowlisted, credentials via vault. **Largest security surface in this plan** |
| W4 | Pipeline entity & phase state | Missions are single runs; a feature = many runs across phases | `pipelines` entity grouping missions per phase with the artifact set; or a long-lived workflow + convention. Decide in WP1 (ADR-003) |
| W5 | Interview elicitation loop | Copilot is one-shot NL→draft | Multi-turn interview with restate-first and forcing-section pull; runs in Command view against the Interviewer agent |
| W6 | Evidence at gates | Trace has the data; inbox shows only a prompt | Evidence records (test output, diffs, screenshots, state assertions) attached to `verify`/approval steps; inbox renders them |
| W7 | Quality-layer knowledge delivery | Personas or nothing | On-demand injection per task type (architecture / refactoring / docs / scalability guidance), 0 standing lines — via procedural memory or KB retrieval keyed by pipeline phase + task tags |
| W8 | Mode governance | Any builder can run anything | Role × mode matrix (track A/B/C analog); gated-autonomous requires the pipeline to have a passing verify configuration first ("you haven't built the infrastructure that makes /loop safe" — pipeline refuses, like the corpus's verifier refusals) |

---

## 5. Target design sketch (what "done" looks like)

This is a sketch to size the work packages, not a binding design; WP1 turns it into ADRs.

### 5.1 Domain model additions (`packages/shared`, `packages/db`)

```
pipelines            id, workspaceId, name, repoRef, mode (supervised|gated),
                     phase (specify|plan|execute|verify|record|idle),
                     devWorkspaceId, createdAt, status
pipeline_artifacts   id, pipelineId, kind (spec|plan|todo|learning|adr|evidence),
                     status (todo: active|backlog|completed; adr: proposed|accepted|superseded),
                     title, body (md/json), version, supersedesId,
                     missionId (which run produced/consumed it), createdAt
verify_checks        id, pipelineId, name (test|arch|refactor-gate|todo-sync|load|custom),
                     command/toolRef, baseline (legacy ratchet), enabled, earnedNote
evidence             id, stepId/approvalId, kind (test-output|diff|screenshot|state-assert),
                     content/ref, createdAt
```

### 5.2 Kernel additions (`packages/kernel`)

- **`verify` node kind** (W1): config = `{checkRef | inline command, retriesBeforeEscalate}`;
  handler executes in the pipeline's dev-workspace, stores evidence, and on failure loops
  control back to the paired agent node with stderr as instruction (bounded, then escalates
  to a human approval). Graph linter learns: *gated-autonomous pipeline with no verify node
  between agent and terminal = lint error* (mirror of today's "write action with no
  approval upstream").
- **Executor support** for the bounded agent↔verify retry loop (today edges + resume
  cursor cover most of this; the bounded-loop counter is new).
- **Pipeline orchestrator**: phase transitions, artifact read/write tools exposed to agents
  (`pipeline.artifact.read/write/list`, `pipeline.todo.next/complete` — read/write tiers).

### 5.3 Dev-workspace connector (`packages/mcp-connectors`) — the big rock (W3)

A bundled MCP server managing per-pipeline containerized workspaces:
`ws.clone`, `ws.git` (status/diff/commit/branch; push is **write-approved**),
`ws.exec` (allowlisted commands: install/test/coverage/fitness; **write tier**),
`ws.read`/`ws.write` files (write tier), `ws.destroy` (**destructive**).
Constraints carried over from Stage 1 posture: egress allowlist per workspace, credentials
injected from the vault at spawn, everything audited, results through untrusted-data
envelopes. If ADR-002 chooses the headless-CLI executor, it runs *inside* this container as
`ws.delegate` and inherits the same walls (filesystem *and* network isolation — the corpus
Track C sandbox rule, verbatim).

### 5.4 Agents (builtin templates, `kind: agent`)

- **Interviewer** — runs SPECIFY: restate-first, forcing sections pull the interview, writes
  the spec artifact + initial todos. Read-tier only.
- **Foreman** — orchestrates phases, decomposes the plan into todos, dispatches EXECUTE
  tasks, enforces the mode switch. Write-approved.
- **Reviewer** — rung 4: fresh context via `agent.ask`, reads only the diff + spec +
  failure-class list (never the builder's conversation), attacks named failure classes,
  returns findings by severity. Read-tier.

### 5.5 UI (`apps/web`)

- **Pipelines view** + NEXUS task pane (`PIPELINE` chip; a stratum comes later if earned):
  phase progress, artifact browser (spec/todos/learnings/ADRs), verify-check dashboard with
  baselines.
- **Approval inbox extension**: evidence panel (test output, diff, screenshots) rendered
  with the approval — org layer §1 made concrete.
- **Canvas**: `verify` node skin (FUI: a gate glyph; green/red state ring), pipeline
  templates openable/editable like any workflow (human-in-command preserved).

---

## 6. Work packages

> Sizing uses RESEARCH-ROADMAP conventions (S/M/L). Every acceptance criterion is
> verifier-shaped per the corpus's own rule: enforced by a build, test, or inspection.
> Dependencies form a DAG; WP0 and WP1 can start in parallel; nothing else starts before
> WP1 lands.

### WP0 — Dogfood: adopt the workflow for developing Puppetmaster itself · size S · independent

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

1. ADR-001: feature name and scope boundary (what "Dev Pipeline" v1 will NOT do — e.g.,
   no multi-repo pipelines, no CI-provider integration in v1).
2. ADR-002: **executor choice** (native agent runtime vs. headless coding CLI in the
   dev-workspace vs. hybrid). Includes a ½-day spike per option against a toy repo.
   This is the plan's highest-variance decision (swings WP5 by ±L).
3. ADR-003: pipeline state representation (new `pipelines` entity vs. long-lived workflow
   + conventions). Recommendation going in: new entity (missions stay single runs; the
   corpus is explicit that the loop spans many sessions).
4. ADR-004: artifact storage (typed `pipeline_artifacts` vs. KB reuse). Recommendation:
   typed table; optionally *mirror* accepted specs/learnings into KB for retrieval.
5. ADR-005: dev-workspace isolation technology (container per pipeline vs. per exec;
   image contents; resource caps) and its egress/credential policy.
6. Rule on the role × mode matrix (W8) and on which corpus tracks v1 serves (recommend:
   Track B/C personas only; Track A "operator builds an app by interview" is a v2 goal).

**Acceptance:** five accepted ADRs in `docs/adr/` (WP0 format), each with alternatives
considered and a "Reconsider when" trigger; owner sign-off recorded.

### WP2 — Domain model & artifact store · size M · needs WP1

1. `packages/shared`: zod schemas for `Pipeline`, `PipelineArtifact` (all kinds + todo/ADR
   status enums), `VerifyCheck`, `Evidence`; extend `WorkflowNodeKind` with `verify`.
2. `packages/db`: tables + repos (`pipeline-repo.ts`), idempotent migration, workspace
   scoping, indexes on `(pipelineId, kind, status)`.
3. Artifact lifecycle rules in the repo layer: ADR immutability (supersede, never edit);
   todo transitions require a `missionId`; learnings are append-only.
4. Kernel tools: `pipeline.artifact.*`, `pipeline.todo.*` (read/write tiers per PRD §4)
   registered in the shared catalog so both agents and workflow nodes use them (one-catalog
   rule preserved).
5. REST: `/api/pipelines` CRUD + `/api/pipelines/:id/artifacts` (builder+); audit entries
   for artifact writes.

**Acceptance:** `pnpm typecheck && pnpm build && pnpm test` green; a golden eval task
creates a pipeline, writes a spec artifact, advances a todo to completed with a mission
link, and a DB-state predicate verifies the lifecycle rules (editing an accepted ADR
fails; completing a todo without a mission fails).

### WP3 — Dev-workspace connector · size L · needs WP1 (ADR-005); parallel with WP2

1. Workspace lifecycle: create (clone from `repoRef`, vault-injected credentials),
   suspend/resume, destroy (destructive tier). Container per ADR-005.
2. Tools: `ws.git.*`, `ws.exec` (command allowlist from pipeline config), `ws.read/write`,
   with tiers as §5.3; results wrapped in untrusted-data envelopes; Stage 9C compaction
   applies to bulky outputs (test logs are exactly the corpus's "stale tool output" case).
3. Security hardening: no ambient network (explicit egress allowlist), resource caps
   (CPU/mem/disk/time), workspace-scoped secrets only, `mcp_tool_pins` posture for the
   connector's own descriptions.
4. If ADR-002 = headless CLI: `ws.delegate(task, budget)` — run the coding CLI headless
   inside the container, stream progress to the mission trace, hard token/time budget.
5. Golden eval: clone a fixture repo, run its test suite via `ws.exec`, assert exit-code
   propagation and that a disallowed egress attempt is refused **and audited**.

**Acceptance:** the eval above passes under `pnpm eval`; a penetration-style golden task
(tool output containing an injection attempting `ws.git.push`) shows the push gated behind
approval — the Stage 1 structural-enforcement story extended to the new surface.

### WP4 — Verification gate machinery · size M · needs WP2 + WP3

1. `verify` node handler: executes a `VerifyCheck` in the pipeline's dev-workspace,
   persists an `Evidence` record, exit code gates the edge.
2. Bounded retry loop: verify-fail routes back to the paired agent node with the check's
   stderr as instruction; after `retriesBeforeEscalate` (default 8 — the corpus's
   override constant, now a policy) an approval is raised instead (human sees evidence).
3. Standard check library (each an *earned* option, off by default, enable per pipeline):
   `test` (suite pass), `todo-sync` (spec artifact changed ⇒ todos changed),
   `refactor-gate` (`--diff-filter=M` on test paths in refactor-tagged work),
   `arch` (fitness tool with ratchet baseline), `load` (SLO thresholds; skips without
   declared numbers — refusal is correct behavior, verbatim from the scalability layer).
4. Graph linter rules: gated pipeline without a verify node = error; verify node whose
   check is disabled = warning; fitness-config/baseline edits inside an execute mission =
   flagged for review (the "agent edits the verifier" failure shape).
5. Evidence in the approval inbox (server: include evidence with approvals; web: render
   test output/diff blocks in the inbox and NEXUS AUTH pane).

**Acceptance:** golden tasks — (a) failing test blocks the pipeline, agent receives stderr,
fix attempt reruns, pass proceeds (trajectory-asserted); (b) 8 consecutive failures
escalate to approval with evidence attached; (c) refactor-gate blocks a run whose diff
modifies test expectations but passes one that only adds test files.

### WP5 — Pipeline phases as agent behaviors · size L (M if ADR-002 = headless CLI) · needs WP2–WP4

1. **SPECIFY:** Interviewer agent + Command-view flow: restate-first, forcing sections
   (tech stack; the five architecture declarations; scale & ops; documentation plan; edge
   cases; out of scope; verification steps) pull the interview; output = spec artifact +
   seeded todos. Include the untranslatable-declaration refusal ("architecture theater"
   detector) when WP4's arch check can't parse a declaration.
2. **PLAN:** read-only explore in the dev-workspace → plan artifact, editable in UI before
   execution (draft-never-autosaved, same as copilot). Skip affordance: one-sentence-diff
   tasks go straight to execute.
3. **EXECUTE — supervised mode:** one todo per mission; implement → test → evidence →
   approval → artifact updates → stop. (The `/next` contract as a graph shape.)
4. **EXECUTE — gated mode:** run todos in order; verify gates between tasks; stop on
   `[review]`-tagged todo or gate escalation. (`/loop` as a graph shape.) Mode chooser in
   the UI asks the pass@k/pass^k question in plain words ("must this work every time
   unattended?") and enforces W8's precondition: no enabled verify checks ⇒ gated mode
   refuses to start.
5. **VERIFY (milestone) + RECORD:** Reviewer agent via `agent.ask` with the failure-class
   list assembled from the quality layers; RECORD writes learnings (append-only), completes
   todos, mirrors accepted artifacts to KB, and — where a hard task succeeded after
   iteration — proposes a procedural-memory entry (skill extraction, human-approved).
6. **Refactor pipeline variant:** the behavior-preserving contract as a template — before
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
2. Injection rule: pipeline phase + task tags select at most one pack per tick; measured
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

1. Pipelines view: list + detail (phase stepper, todo board active/backlog/completed,
   artifact reader with version history, verify-check panel with baselines and evidence
   history, mode indicator).
2. NEXUS: `PIPELINE` task-pane chip in the tray registry (per NEXUS §4 pane conventions);
   Construct stratum deferred until pipelines earn ambient presence (complexity budget).
3. Approval inbox evidence panel (from WP4.5) polished: diff viewer, test-output block,
   screenshot display; FUI grammar per DESIGN-LANGUAGE.
4. Canvas: verify-node skin + config inspector (check picker, retries-before-escalate);
   pipeline templates open in the canvas like any workflow.
5. Command view: interview session UX (restate card, forcing-section progress meter — the
   spec's unfilled sections are the interview's progress bar).

**Acceptance:** manual UAT script appended to `docs/uat/` covering: run a supervised
pipeline from NEXUS only; approve a gated escalation from the inbox seeing its evidence;
edit a plan artifact before execution. Keyboard + reduced-motion checks per
DESIGN-LANGUAGE hard requirements.

### WP8 — Templates, packaging, org layer · size S · needs WP5

1. Builtin templates: `dev-pipeline-supervised`, `dev-pipeline-gated`,
   `dev-pipeline-refactor`, plus Interviewer/Foreman/Reviewer agent templates —
   `builtin: true`, category `dev`.
2. Role × mode enforcement (W8) at the gateway; member = run supervised + answer
   interviews; builder = gated + template edits; admin = check config + policies.
3. Evidence-on-PR as workspace policy: a toggle requiring every gated pipeline's terminal
   approval to carry evidence records (default on).
4. Shared-context curation: procedural-memory promotion flow (sandbox → traction counter →
   workspace-shared), usage measured, prune list surfaced in EVALS view.
5. Ownership line (org layer §3): one paragraph in the workspace settings — who owns
   pipeline-produced code — shown at pipeline creation. Cheapest item in the corpus;
   included because its failure mode is an incident, not friction.

**Acceptance:** fresh workspace: instantiate the supervised template and reach the
interview in <5 minutes without touching the canvas; member role cannot start a gated
pipeline (403, audited); a gated pipeline with the evidence policy on refuses to finish
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
3. Product docs: `docs/PIPELINES.md` (operator guide: the five phases, the mode question,
   the earned-checks philosophy), ARCHITECTURE.md §3.11, PRD update (use case 3 →
   implemented-by), NEXUS registry update.
4. Dogfood closure: run WP0's repo pipeline *through the product itself* on a small real
   task (self-hosting smoke test) and record learnings.

**Acceptance:** `pnpm eval` green with the new suite at k≥2 (pass^k, not pass@k — this
feature is precisely the "runs unattended repeatedly" case); failure-mode mapping doc has
zero unmapped rows; UAT report updated.

---

## 7. Consolidated master todo checklist

*(Tracking convention as NEXUS §10 — update checkboxes as work lands. Nothing below is
started.)*

**WP0 — Dogfood (operation track)**
- [ ] `todos/` tree + `learnings.md` seeded from HANDOFF + this plan
- [ ] `docs/adr/` + ADR-000 + two retroactive ADRs (marked retroactive)
- [ ] `.claude/commands/{spec,plan,next,loop,review,refactor}.md` translated for this repo
- [ ] `scripts/verify-arch.sh` (dependency-cruiser + ratchet baseline)
- [ ] HANDOFF.md points at the session-resume ritual
- [ ] (earned, deferred) `test-gate` hook — install only after the failure bites

**WP1 — Decisions**
- [ ] ADR-001 feature name + v1 scope boundary
- [ ] ADR-002 executor choice (+ spike per option)
- [ ] ADR-003 pipeline state representation
- [ ] ADR-004 artifact storage
- [ ] ADR-005 dev-workspace isolation + egress/credential policy
- [ ] Role × mode ruling; v1 tracks ruling (B/C only?)

**WP2 — Domain model**
- [ ] Shared zod schemas (Pipeline, PipelineArtifact, VerifyCheck, Evidence, `verify` kind)
- [ ] DB tables + repos + migration + lifecycle rules (ADR immutability, todo↔mission)
- [ ] `pipeline.artifact.*` / `pipeline.todo.*` catalog tools (tiered)
- [ ] `/api/pipelines` REST + audit
- [ ] Golden eval: artifact lifecycle predicates

**WP3 — Dev-workspace connector**
- [ ] Workspace lifecycle (create/suspend/destroy) per ADR-005
- [ ] `ws.git.*`, `ws.exec`, `ws.read/write` with tiers + envelopes + compaction
- [ ] Egress allowlist, resource caps, vault-only secrets
- [ ] (if ADR-002 = CLI) `ws.delegate` with hard budgets
- [ ] Golden evals: exit-code propagation; injection→push gated; egress refusal audited

**WP4 — Verification gates**
- [ ] `verify` node handler + Evidence persistence
- [ ] Bounded retry loop + escalation-to-approval (default 8)
- [ ] Check library: test / todo-sync / refactor-gate / arch(ratchet) / load(skip-without-SLOs)
- [ ] Linter rules (gated-without-verify; verifier-edit flag)
- [ ] Evidence rendered in approval inbox
- [ ] Golden evals (block/recover; escalate-with-evidence; refactor-gate M-vs-A)

**WP5 — Phases**
- [ ] Interviewer + SPECIFY flow (restate-first; forcing sections; theater refusal)
- [ ] PLAN (read-only explore → editable artifact; skip affordance)
- [ ] EXECUTE supervised template (`/next` contract)
- [ ] EXECUTE gated template (`/loop` contract; mode chooser; no-verify ⇒ refuse)
- [ ] Reviewer via `agent.ask` + RECORD (learnings, todo completion, skill-extraction proposal)
- [ ] Refactor variant (coverage precondition, characterization route, contract checks)
- [ ] End-to-end golden scenario (independence trajectory-asserted)

**WP6 — Quality layers**
- [ ] Four knowledge packs (0 standing lines; negative triggers included)
- [ ] Phase/tag-keyed injection + usage audit + prune list
- [ ] Reviewer failure-class assembly
- [ ] ADR flow in SPECIFY/PLAN (ceiling-ADRs require Reconsider-when)
- [ ] Eval predicates (right pack, only the right pack)

**WP7 — UI**
- [ ] Pipelines view (stepper, todo board, artifact reader, checks panel)
- [ ] NEXUS `PIPELINE` pane chip
- [ ] Inbox evidence panel polish (diff/test/screenshot)
- [ ] Canvas verify-node skin + inspector
- [ ] Interview UX (restate card, section progress)
- [ ] UAT script in `docs/uat/` (incl. keyboard/reduced-motion)

**WP8 — Packaging & org**
- [ ] Three pipeline templates + three agent templates (builtin)
- [ ] Role × mode gateway enforcement
- [ ] Evidence-required workspace policy
- [ ] Memory promotion-by-traction + prune surfacing
- [ ] Ownership statement at pipeline creation

**WP9 — Hardening**
- [ ] Failure-mode mapping doc (corpus tables → eval/linter/accepted-risk; zero unmapped)
- [ ] Priority evals (anchoring, verifier-edit, rewrite, drift, invented thresholds, premature scaling, stateful-replica)
- [ ] `docs/PIPELINES.md` + ARCHITECTURE/PRD/NEXUS updates
- [ ] Self-hosting smoke test + learnings

---

## 8. Open decisions for the owner (blocking, in order)

1. **Go/no-go on the recommendation** (§2.4): dedicated feature, phased, with WP0.
   Alternative if capacity is tight: WP0 + WP1 only now; product feature deferred intact.
2. **ADR-002 executor** — the highest-variance choice (§2.3). Plan default if undecided:
   hybrid with headless-CLI for EXECUTE, native agents for interview/plan/review.
3. **Feature name** (ADR-001) and whether "pipeline" collides with existing vocabulary.
4. **v1 audience** — recommend Track B/C only (builders/engineers); Track A operator flow
   (build-by-interview for non-coders) deferred to v2.
5. **WP0 scope** — full as written, or minimal (todos + ADRs only, no commands)?
6. **Sequencing vs. the existing roadmap** — this plan does not preempt
   RESEARCH-ROADMAP stages; the owner decides where WP1+ slots relative to Tauri/desktop
   and remaining M5 work.

## 9. Risk register (product-level; corpus-derived risks live in WP9's mapping)

| Risk | Severity | Mitigation |
|---|---|---|
| Dev-workspace = arbitrary code execution surface | High | WP3 hardening; FS **and** network isolation (either alone is escapable — corpus §8); destructive tier on destroy; egress allowlist default-closed for pipelines |
| Over-building (the ECC anti-example: capability ahead of pain) | Medium | Phasing; earned-checks off by default; WP6 packs pruned by measured usage; no Construct stratum until earned |
| Executor bet ages badly (headless CLI API drift) | Medium | ADR-002 isolates it behind `ws.delegate`; native path remains |
| Verification theater (gates exist, checks weak) | Medium | Checks ship with honest refusal semantics (skip ≠ pass, loudly); reviewer class "compliance without gaming"; WP9 evals |
| Token cost of gated pipelines | Medium | Stage 5 budgets gate ticks already; per-pipeline budget field; router profiles floor risky work |
| Scope creep into a CI system | Low | ADR-001 scope boundary: v1 has no CI-provider integration; verify runs in *our* workspace only |

## 10. Out of scope (v1)

Multi-repo pipelines; CI-provider integrations (GitHub Actions etc.); Track A no-code
operator flow; dynamic-workflow rung 6 (agent-written orchestration harnesses); fine-tuned
review models; Windows dev-workspaces; marketplace *sale* of pipelines (sharing yes, per
M5).

---

*Maintained the way the corpus preaches: this plan is a context artifact — version it,
check off what lands, append what the field teaches, and strengthen its verifiers rather
than its wording.*
