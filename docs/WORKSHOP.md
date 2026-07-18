# WORKSHOP Manual

## Build software step by step with verifiable quality gates

This manual explains how a beginner programmer can use Puppetmaster's **WORKSHOP** page to
take a software idea from a rough goal to a planned, reviewable, and testable increment.

The short version is:

1. Create a project.
2. Write a concrete specification.
3. Turn the specification into a small plan and todos.
4. Connect the reasoning with the Decision Graph.
5. Add verification checks before trusting a build.
6. Execute one small todo at a time.
7. Inspect evidence, record what you learned, and repeat.

The WORKSHOP is designed around a simple rule:

> An AI saying “done” is not proof. A deterministic check, a visible diff, a test result, or
> another concrete piece of evidence is proof.

## 1. What the WORKSHOP is — and is not

The WORKSHOP is a project dossier. It keeps the durable information that normally gets lost
between chat sessions:

- the project and its repository reference;
- the current phase and operating mode;
- versioned specifications and plans;
- todos and their completion history;
- learnings and architecture decisions;
- deterministic verification checks;
- links showing why a plan, todo, or check exists.

The phase strip is a status indicator:

`IDLE → SPECIFY → PLAN → EXECUTE → VERIFY → RECORD`

In the current release, the page does not yet contain one-click **START INTERVIEW** or
**RUN NEXT TODO** buttons. Use the WORKSHOP dossier for the durable project record, and use
TEMPLATES, COMMAND, CANVAS, and MISSIONS for the agent conversation, workflow wiring, and
execution evidence. The roadmap calls the missing one-click orchestration “phase-flow
actions.”

The WORKSHOP v1 also deliberately does not provide multi-repository projects, GitHub Actions
integration, Windows workbenches, or marketplace project sales. See the scope decision in
[ADR-001](./adr/001-workshop-naming-and-v1-scope.md).

## 2. Before you begin

### 2.1 What you need to know

You do not need to be an expert in Agile or AI agents. You should know:

- what software you want to build;
- which users will use it;
- where the source code lives, if a repository already exists;
- what “working” would look like in a small, observable example.

If you do not know the technology or architecture yet, write **unknown** in the relevant
specification section. “Unknown” is honest and reviewable. Silence is not a decision.

### 2.2 Start Puppetmaster locally

For a quick trial, run the server and web app in two terminals:

```bash
# Terminal 1
pnpm --filter @puppetmaster/server dev
```

```bash
# Terminal 2
pnpm --filter @puppetmaster/web dev
```

Open [http://localhost:3000](http://localhost:3000). The server defaults to an in-memory
PGlite database for local learning. Closing the server resets the data. The full installation
options, Docker setup, and persistent database instructions are in
[INSTALL.md](./INSTALL.md) and [GETTING-STARTED.md](./GETTING-STARTED.md).

### 2.3 Create the first account

On the first visit, Puppetmaster shows **FIRST RUN · CREATE OWNER**.

1. Enter your name.
2. Enter an email address. A local trial does not need a real mailbox.
3. Enter a password with at least eight characters.
4. Select **INITIALIZE WORKSPACE**.

The first account becomes the workspace owner. The owner has the same practical control as an
admin plus ownership of the workspace.

### 2.4 Roles and buttons

Your role affects what you see:

| Role | WORKSHOP ability |
| --- | --- |
| Member | Inspect projects, artifacts, checks, trace links, and evidence; participate in agent conversations. |
| Builder | Create projects, write artifacts, and create or remove trace links. |
| Admin | Everything a builder can do, plus create and configure verification checks. |
| Owner | Everything an admin can do, including workspace ownership. |

If this manual says “select a button” and it is not visible, you probably need a builder or
admin to perform that action.

## 3. Beginner vocabulary

| Word | Meaning |
| --- | --- |
| Project | The long-lived container for one software effort. It owns the specification, plan, todos, checks, and learnings. |
| Repository reference | The codebase source. WORKSHOP can display a human label, but the CLAUDE runtime passes this value to `git clone` when its workbench is empty. Use a real cloneable HTTPS URL for a CLAUDE project. |
| Phase | The current point in the software-development loop: specify, plan, execute, verify, or record. |
| Artifact | A durable project document or work item. WORKSHOP artifacts are `spec`, `plan`, `todo`, `learning`, and `adr`. |
| Spec | A concrete description of what to build, its boundaries, and how it will be verified. |
| Plan | The implementation approach, increment order, risks, and verification method. |
| Todo | One buildable unit of work. A good todo can be implemented and checked in one small pass. |
| Learning | An append-only note about something discovered while building. |
| ADR | Architecture Decision Record. It records a meaningful technical choice and its rationale. Accepted ADRs are frozen; a changed decision becomes a new superseding ADR. |
| Verify check | A deterministic quality policy such as `test`, `arch`, `todo-sync`, or `spec-sections`. A check returns evidence, not only a green/red word. |
| Gate | A point where a failed check stops the run and asks for repair or human review. |
| Evidence | Test output, a diff, a state assertion, or another inspectable result attached to a verification step or approval. |
| Decision Graph | The rationale-bearing links between artifacts and checks. It answers “where did this todo come from?” and “what proves it?” |
| Supervised mode | The safer beginner mode. The system stops after each task so a human can inspect the result. |
| Gated mode | A more autonomous mode. The system continues between verification gates, but refuses to start without an enabled check. |
| Workbench | The isolated coding environment used by `bench.*` tools and workbench-backed checks. |
| Mission | One execution record: an agent turn, workflow run, or phase operation. It contains a trace of steps and outcomes. |

## 4. Open the WORKSHOP page

In the top navigation, select **04 WORKSHOP**. You will see:

1. **PROJECTS** — the project list and project creation form.
2. **DOSSIER** — the selected project's phase strip, spec coverage, todos, artifacts, and artifact editor.
3. **VERIFY CHECKS** — checks configured for the selected project.
4. **DECISION GRAPH · TRACEABILITY** — current-link coverage, orphan warnings, next-move guidance, and the link editor.

The top counters show project-level activity for the selected project. **TRACE COVERAGE** is
an advisory percentage, not a pass/fail gate.

## 5. Create a project

In the **PROJECTS** panel, fill in:

- **Project name** — use a clear name such as `Reading List API`.
- **Repository reference** — for a dossier-only project, this can be a human label or blank. For
  CLAUDE, enter a real cloneable HTTPS URL such as
  `https://github.com/your-account/reading-list.git` at creation time. The current UI cannot edit
  this value later, so create a replacement project if it is wrong.
- **GATED MODE** — leave this off for your first project unless you already have a reliable check.

Select **CREATE PROJECT**. The new project appears in the list and opens automatically.

### Which mode should I choose?

| Supervised | Gated |
| --- | --- |
| Stops after each todo. | Continues until a verify gate, review marker, or human decision stops it. |
| Best for beginners, exploration, and visual work. | Best after checks are trustworthy and the task loop is repeatable. |
| Lets you inspect every diff and result. | Reduces manual pauses but increases the cost of a bad check. |
| Does not require an enabled check to create the project. | Requires at least one enabled verify check before it can run. |

Start supervised. Change to gated only after a real failure has earned a check and you have
seen that the check reports useful evidence.

## 6. Understand the five phases

The phases are a thinking order, not a ceremony for its own sake.

### SPECIFY — decide what “the problem” means

Output: one concrete `spec` artifact and a small initial set of todos.

Questions to answer:

- Who is the user?
- What problem are we solving?
- What is in scope and out of scope?
- What data exists?
- What behavior counts as correct?
- What is unknown or risky?

### PLAN — decide how to build the smallest useful slice

Output: one `plan` artifact with small, independently verifiable increments.

Questions to answer:

- What should be built first?
- What existing files or interfaces matter?
- What could go wrong?
- Which check proves each increment?

### EXECUTE — change the code

Output: a diff, test output, and a completed todo linked to the mission that performed it.

Use supervised mode until you trust the loop. Do not let an agent quietly expand the scope.

### VERIFY — run the evidence-producing checks

Output: check runs with evidence. A failed check blocks the next gated action or escalates to
human review.

### RECORD — preserve what was learned

Output: learning artifacts, accepted or superseded ADRs, completed todos, and a clear next
step. Recording is what makes the next session faster than the first one.

## 7. SPECIFY: write a useful specification

### 7.1 Required specification sections

The built-in `spec-sections` policy checks the newest spec for these seven headings:

1. `## Tech stack`
2. `## Data model`
3. `## Code architecture`
4. `## Scale & operations`
5. `## Edge cases`
6. `## Out of scope`
7. `## Verification`

The heading text matters. Use Markdown headings exactly as shown. Each heading needs concrete
content; a heading followed only by “TBD” is considered thin.

### 7.2 Write a spec from the dossier

Builders can use **ADD ARTIFACT** in the dossier:

1. Set **Kind** to `spec`.
2. Enter a title, for example `Reading List API Spec`.
3. Write the body using the seven headings.
4. Select **RECORD ARTIFACT**.

The spec-coverage meter immediately marks sections as **FILLED**, **THIN**, or **MISSING**.
Treat this meter as feedback, not as permission to invent details.

Example beginner spec:

```markdown
## Tech stack
TypeScript 5.x, Node.js 22, Fastify, and PostgreSQL in production.
The first local version may use the repository's PGlite setup.

## Data model
Each reading has an id, title, url, createdAt, and archived flag.
An account owns many readings. URLs are unique per account.

## Code architecture
HTTP routes validate input and call a service. The service owns business rules
and calls the repository. Routes must not contain SQL or duplicate service rules.

## Scale & operations
The first release targets 100 requests per second and fewer than 10,000
readings per account. Unknown: the expected archive batch size.

## Edge cases
Reject an empty title and malformed URL. Creating the same URL twice is
idempotent. Archived readings do not appear in the default list.

## Out of scope
Sharing, recommendations, full-text search, browser extensions, and mobile apps.

## Verification
Unit tests cover URL validation and idempotency. An HTTP test covers create,
list, archive, and the duplicate URL case.
```

### 7.3 Use the Workshop Interviewer

The seeded **Workshop Interviewer** agent is designed for SPECIFY. Find it through
**TEMPLATES → AGENT TEMPLATES**, select **USE THIS**, then open its channel from COMMAND.

Give it a prompt that names the project and the user goal. For example:

```text
Run SPECIFY for project <project id> (Reading List API).
Goal: let a signed-in user save and archive reading URLs.
Restate the goal first, then ask only the questions needed to fill all seven
required spec sections. Write the spec and seed small todos only after the answers
are concrete. Do not claim completion until spec-sections passes.
```

The agent is intentionally persistent about missing sections. That is useful: it is cheaper
to answer a question now than to discover the missing boundary after code has been written.

## 8. PLAN: turn the spec into buildable increments

Use the **Workshop Planner** agent or record a `plan` artifact manually.

A good plan contains these headings:

- `## Approach`
- `## Increments`
- `## Risks & unknowns`
- `## Verification`

Each increment should be small enough to finish and verify independently. Prefer:

1. schema/repository rule;
2. service behavior;
3. route or UI behavior;
4. tests and documentation.

The Planner explores the repository read-only. It must not write files or start coding. It
also has a **skip affordance**: for a truly trivial one-file change, a one-line plan and a
skip rationale are better than planning theater.

Example plan:

```markdown
## Approach
Build the reading-list path bottom-up so the business rule is testable without HTTP.

## Increments
1. Add the reading table and repository methods; verify with repository tests.
2. Add create/list/archive service methods; verify duplicate URL behavior.
3. Add Fastify routes; verify with HTTP tests.
4. Add the empty/loading/error states to the UI; verify with a browser smoke test.

## Risks & unknowns
The expected archive volume is unknown. Do not add a background job until a real
measurement shows it is needed.

## Verification
Every increment has a focused test. The final increment runs the full project test
command and an architecture/dependency check.
```

### Revise a plan safely

Use **REVISE** beside the current spec or plan. The title is locked, so a revision becomes
the next version of the same artifact chain. Old versions remain available for inspection,
and their old Decision Graph links are shown as historical rather than silently inherited.

Do not create a new title accidentally when you mean to revise. A different title creates a
new v1 artifact stream.

## 9. Create todos that an agent can finish

A todo is not “build the application.” It is one observable increment:

```text
Add repository validation for duplicate reading URLs and prove it with a focused test.
```

Good todos have:

- one clear outcome;
- a small change surface;
- a named verification method;
- no hidden second feature;
- a definition of what evidence should be shown when it is complete.

Use `backlog` for work that is not ready and `active` for the next item being executed. The
Foreman works one todo at a time. A completed todo must carry the mission that performed it;
do not fake a mission id just to make the status look complete.

## 10. Build the Decision Graph

The Decision Graph is the most important addition for avoiding beginner confusion. A flat
backlog tells you *what* to do. The graph records *why* it exists and *what proves it*.

### 10.1 The three-link beginner chain

For a normal delivery slice, create these links:

```text
SPEC  --derives-->  PLAN  --derives-->  TODO  --verifies-->  CHECK
```

Each link needs a rationale. Example rationales:

- `The plan implements the accepted Reading List scope.`
- `This todo is the first independently verifiable plan increment.`
- `The node test command proves the repository behavior required by this todo.`

### 10.2 Add a link in the page

In **DECISION GRAPH · TRACEABILITY**:

1. Select a **Source**.
2. Select a relationship.
3. Select a **Target**.
4. Enter a short rationale.
5. Select **CONFIRM LINK**.

The page guides valid endpoint shapes:

| Relationship | Meaning | Normal endpoint shape |
| --- | --- | --- |
| `derives` | A downstream artifact comes from an upstream artifact. | Artifact → artifact |
| `verifies` | A check proves an artifact's intent. | Artifact → check |
| `informs` | One artifact provides context to another. | Artifact/check → artifact/check |
| `mitigates` | A decision, task, or check addresses a risk or constraint. | Artifact/check → artifact/check |

The server also rejects cross-project endpoints, self-links, duplicate links, empty
rationales, and invalid `derives`/`verifies` shapes.

### 10.3 Read the advisory signals

- **TRACE COVERAGE** — the percentage of current spec, plan, open todos, and enabled checks that are connected.
- **CURRENT / TOTAL LINKS** — current links versus all links, including historical links from old artifact versions.
- **ORPHAN WARNINGS** — open todos with no current spec/plan context, plans not connected to the current spec, or checks not connected to an artifact.
- **NEXT MOVE** — a deterministic suggestion such as “Resolve 2 missing spec sections” or “Link 1 enabled check.”
- **UNKNOWN** — the page could not load enough data to make a safe judgment. Retry; do not treat an unknown value as zero.

Readiness is advisory. A 100% trace score does not replace a test, review, or approval.

### 10.4 What happens after a revision?

When you revise a spec or plan, the new version does not inherit old links automatically.
This is intentional. It prevents stale reasoning from looking current. Reconnect the new
version to the plan, todos, and checks after reviewing what changed.

## 11. Configure verification checks

Verification checks are policies that produce inspectable evidence. They are disabled by
default. An admin must record the real failure that earned a policy before enabling it.

### 11.1 Add a check

Admins use **ADD DISABLED CHECK** in the VERIFY CHECKS panel:

1. Choose the check name.
2. Provide the command or configuration when that check needs one.
3. Select **ADD CHECK**.
4. Review the command and the project context.
5. Select **ENABLE (EARN)**, describe the failure that earned the policy, and confirm.

The page prevents structurally invalid checks from being enabled.

### 11.2 Check reference

| Check | What it does | Configuration |
| --- | --- | --- |
| `test` | Runs the declared test command in the workbench. Exit 0 passes. | Required command, for example `node --test`. |
| `arch` | Runs the declared architecture/dependency command. | Required command, for example `bash scripts/verify-arch.sh`. |
| `custom` | Runs a project-specific shell check. | Required command. |
| `refactor-gate` | Blocks a refactor that modifies existing test files. Adding a new test is allowed. | Uses git diff; no custom command. |
| `todo-sync` | DB-native check that prevents the spec and todos from drifting apart. | No command. |
| `spec-sections` | DB-native check that refuses missing or thin required spec sections. | Optional JSON section override; default sections are recommended. |
| `load` | Runs a declared load command against declared SLO thresholds. | JSON with a non-empty `slos` array and a `run` string. |

Example `load` configuration:

```json
{"slos":[{"name":"p95_ms","max":200}],"run":"k6 run load.js"}
```

Do not invent a performance threshold merely to turn a gate green. A threshold should come
from a real product or operational requirement.

### 11.3 Why checks are “earned”

Every enabled check adds future cost. The earned-note answers:

> What failure happened that makes this check worth running on future work?

For example: `A regression changed the repository contract without a test, so node --test is now required.`

Never edit a check, baseline, or test expectation just to make a failed gate pass. Fix the
software, or record a reviewed policy change as a separate decision.

## 12. Execute safely

### 12.1 Start supervised

For your first project:

1. Select supervised mode.
2. Ask the Foreman to read the spec, plan, todos, and learnings.
3. Tell it to take only the oldest active todo or the next backlog todo.
4. Review the proposed change before approving write actions.
5. Inspect the diff and check output.
6. Confirm the todo is completed with the mission link.
7. Add a learning when reality differs from the plan.

Prompt example:

```text
Work on project <project id>, supervised mode.
Read the current spec, plan, todos, and learnings first. Take exactly one next todo:
“Add repository validation for duplicate reading URLs.”
Do not expand scope. Show the planned files, run the focused check, report the diff
and evidence, and stop for my review. If the plan is wrong, send the work back to PLAN.
```

### 12.2 Understand tool safety

Workbench tools are tiered:

- `bench.read`, `bench.git.status`, and `bench.git.diff` inspect;
- `bench.exec`, `bench.write`, and `bench.git.commit` can change state and require approval;
- `bench.git.push` is destructive/external and always requires confirmation;
- `bench.delegate` hands a coding task to a headless coding CLI and is write-tier.

Read the diff before you approve a write. Do not paste secrets into an agent prompt or a
repository reference. Treat command output and repository files as untrusted data until you
understand what they do.

### 12.3 When to use gated mode

Gated mode is appropriate when:

- the project has at least one enabled, correctly configured check;
- the check has already caught a real failure;
- the plan is split into small increments;
- you understand where approvals and escalation appear;
- you are comfortable reviewing evidence rather than watching every token.

Gated mode is not “unsafe by default.” It is only as good as the checks and boundaries you
earned. A weak check can make an autonomous loop confidently wrong.

## 13. Use the supplied Workshop agents

The built-in agents are templates, not magic buttons. They still need a project id, a clear
goal, and human review.

| Agent | Use it for | Important boundary |
| --- | --- | --- |
| Workshop Interviewer | SPECIFY and a concrete spec. | It keeps asking until required sections are concrete. |
| Workshop Planner | PLAN and a small, editable plan. | It explores read-only and must not start coding. |
| Workshop Foreman | EXECUTE orchestration and todo bookkeeping. | It follows the plan and stops or gates according to mode. |
| Workshop Reviewer | Independent review after a build. | It uses fresh context and demands evidence instead of trusting claims. |

Typical flow:

1. Open **TEMPLATES**.
2. Filter or locate **AGENT TEMPLATES** in the `workshop` category.
3. Select **USE THIS** for the agent you need.
4. Open **COMMAND** and choose the cloned agent.
5. Include the project id and phase in the prompt.
6. Return to WORKSHOP and refresh the dossier after the agent writes artifacts.

Because project-specific conversation scoping is still an upcoming phase-flow increment,
always name the project id in your prompt and ask the agent to read the project artifacts
before acting. Do not assume a previous conversation belongs to the current project.

## 14. Review and record

### 14.1 Use the Reviewer

Ask the Workshop Reviewer to inspect:

- the current spec and plan;
- the diff;
- check output;
- security and permission boundaries;
- scope expansion;
- stale documentation;
- architecture and dependency direction.

Example:

```text
Review project <project id> after the supervised increment.
Read the current spec, plan, changed files, and verification evidence.
Report findings by severity. Do not assume the builder's claims are true.
If there are no findings, say so plainly.
```

### 14.2 Record a learning

Use **ADD ARTIFACT → learning** for discoveries such as:

```text
The repository already had a URL-normalization helper. Reusing it avoided a second
implementation and means future URL rules belong in that helper's test file.
```

Learnings are append-only. Add a new learning rather than rewriting an old one.

### 14.3 Record an ADR

Use **ADD ARTIFACT → ADR** for a meaningful architecture decision:

```markdown
## Context
The API needs idempotent duplicate-URL behavior.

## Decision
Normalize the URL and enforce uniqueness per account in the repository.

## Alternatives considered
Rely on the client; rejected because other callers bypass the UI.

## Consequences
The repository becomes the single enforcement point and needs a unique index.

## Reconsider when
The product supports shared reading lists across accounts.
```

An accepted ADR is immutable. If the decision changes, create a new ADR that supersedes it.

## 15. A complete beginner example

This example builds the first increment of a Reading List API.

### Step 1 — Project

Create:

- Name: `Reading List API`
- Repository reference: a real cloneable URL for the repository, such as
  `https://github.com/your-account/reading-list.git` when following the CLAUDE workflow
- Mode: `supervised`

### Step 2 — Spec

Record `Reading List API Spec` with the seven required sections. Keep the first scope small:
save a URL, list URLs, archive a URL. Put sharing, search, recommendations, and mobile in
**Out of scope**.

### Step 3 — Plan

Record `Reading List API Plan`:

1. Add the reading repository and duplicate-URL test.
2. Add the service rule for archive/list behavior.
3. Add HTTP routes and request validation.

Name the verification command for each increment.

### Step 4 — Todos

Create:

- `Add reading repository with duplicate URL protection` — active
- `Add archive service rule` — backlog
- `Add create/list/archive HTTP routes` — backlog

### Step 5 — Check

An admin adds a disabled `test` check with:

```text
node --test
```

After a duplicate URL bug is found and fixed, the admin enables the check with the earned
note `A duplicate URL created two records during review.`

### Step 6 — Decision Graph

Create three links:

```text
Reading List API Spec --derives--> Reading List API Plan
Reading List API Plan --derives--> Add reading repository with duplicate URL protection
Add reading repository with duplicate URL protection --verifies--> test
```

Use a rationale on each edge. The dossier should now show the current plan and first todo as
connected. If the warning says the todo is orphaned, inspect the link direction and endpoint.

### Step 7 — Execute

Ask the Foreman for exactly one supervised todo. Approve only the files and commands that fit
the plan. Inspect the diff and test output.

### Step 8 — Review and record

Ask the Reviewer to inspect the increment. Add a learning if the repository structure or
domain rule surprised you. If the architecture choice is important, record an ADR.

### Step 9 — Next increment

Move the first todo to completed through the executing mission, then activate the archive
service todo. Keep the same loop: plan → one todo → evidence → review → record.

## 16. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| WORKSHOP is empty after restart | You are using the in-memory trial database. | Start the server again and recreate the fixture, or configure `PGLITE_DATA_DIR`/Postgres for persistence. |
| I can see a project but no CREATE or RECORD buttons | Your account is a member. | Ask a builder/owner to create or write the project artifacts. |
| I can add a check but cannot enable it | The check has no earned note or has invalid configuration. | Describe the real failure that earned it and supply the required command/configuration. |
| Gated mode refuses to start | No enabled verify check exists. | Add a check, earn it with a failure note, and enable it. |
| Spec coverage says THIN or MISSING | The heading is absent or contains no concrete decision. | Use the exact seven headings and replace placeholders with rules, numbers, examples, or explicit unknowns. |
| A plan or todo is marked orphaned | Its link is missing, points in the wrong direction, or points to an old artifact version. | Link the current spec/plan to the current downstream artifact and add a rationale. |
| A new revision became v1 unexpectedly | The title changed. | Use the bound **REVISE** action beside the current spec or plan. |
| Trace coverage is `—` or readiness is `UNKNOWN` | One of the project requests failed or is still loading. | Retry by selecting the project again; do not interpret unknown as zero. |
| A test check says no command is configured | `test`, `arch`, and `custom` need a command. | Edit the command in the enable form, for example `node --test`. |
| A load check refuses to run | SLO thresholds or the `run` command are missing/invalid. | Provide valid JSON with a non-empty `slos` array and a `run` string. |
| An agent edits outside the plan | The task was too broad or the agent was not given the project boundary. | Stop, inspect the diff, return to PLAN, and restart with one explicit todo. |
| A verify gate fails | The check found a real problem or cannot run. | Read the evidence, fix the software/configuration, and rerun. Never weaken the verifier to hide the failure. |
| A browser or API request returns 401 | The session expired or the server was restarted. | Sign in again or initialize the local owner account again. |
| Local workbench checks report `spawn sh ENOENT` on Windows | The current v1 workbench path expects Unix shell tooling; Windows workbenches are outside the v1 scope. | Use a supported Docker/Linux workbench for those checks, or rely on DB-native checks while learning locally. |

## 17. Completion checklist

Before calling a software increment complete, confirm:

- [ ] The project name and repository reference are correct.
- [ ] The current spec has all seven concrete sections.
- [ ] The plan describes small increments, risks, and verification.
- [ ] Every open todo has current upstream context in the Decision Graph.
- [ ] Every enabled check has a real earned-note and valid configuration.
- [ ] Every enabled check is linked to an artifact it verifies.
- [ ] The change stayed inside the spec and the current todo.
- [ ] The diff was inspected by a human.
- [ ] The check output/evidence was recorded.
- [ ] The todo completion carries the executing mission.
- [ ] Learnings and important architecture decisions were recorded.
- [ ] A fresh-context review found no unresolved high-severity issue.

## 18. Further reading

- [Getting Started](./GETTING-STARTED.md) — the broader Puppetmaster tour.
- [Workshop Decision Graph](./WORKSHOP-DECISION-GRAPH.md) — research gap, rationale, and implementation boundaries.
- [Architecture](./ARCHITECTURE.md) — persistence, roles, gates, workbench, and security boundaries.
- [AI-SDLC Integration Plan](./AI-SDLC-INTEGRATION-PLAN.md) — the phased product plan and remaining orchestration work.
- [Workshop failure-mode ledger](./WORKSHOP-FAILURE-MODES.md) — why specific gates and refusals exist.
- [ADR-001](./adr/001-workshop-naming-and-v1-scope.md) — naming, role/mode boundaries, and v1 scope.
