# The Complete Guide to Puppetmaster (No Experience Required)

This guide takes you from a blank computer to using **every capability** Puppetmaster has —
written so that someone who has never opened a terminal can follow it, but complete enough
to be your reference for the whole system.

It has three layers, so you can read as deep as you need:

- **Part 1 — Install & run.** Get it running on your own machine in about 15 minutes.
- **Part 2 — The big picture.** The handful of ideas everything else is built from.
- **Part 3 — Everything it can do.** A guided tour of all eleven screens and every feature,
  one section at a time, with screenshots.
- **Part 4 — Reference.** Two hands-on test drives, the demo dataset, making your data
  permanent, connecting real AI, the full settings list, troubleshooting, and a glossary.

> **What is Puppetmaster, in one paragraph?**
> It's a private control room for small teams that runs on your own computer or server
> instead of someone else's cloud. Inside it you build two kinds of helpers: **agents**
> (AI "employees" you can chat with, that remember things and use tools) and **workflows**
> (automatic checklists/flowcharts — "when X happens, do A, then B, then C"). The special
> part is **the bridge**: agents can start workflows and workflows can call agents, all on
> one system that shares one memory, one set of tools, one permission model, and one
> complete history. Anything risky — sending money, emailing a customer, deleting something —
> pauses and waits for a human to approve, like a manager signing off.

---

# Part 1 — Install & run

## Before you start

You need two free programs. Both work the same way on Windows, Mac, and Linux.

| Tool | What it's for | Get it |
|---|---|---|
| **Node.js** (version 22 or newer) | The engine that runs the app | [nodejs.org](https://nodejs.org) — download the installer for your operating system and click through the defaults |
| **A terminal** | A text window where you type commands | **Windows:** search the Start Menu for "Terminal" or "PowerShell". **Mac:** open *Applications → Utilities → Terminal*. |

You do **not** need a database, Docker, or anything else to try Puppetmaster — the
quick-start path runs entirely on your machine with a built-in, temporary database. Part 4
covers making your data permanent when you're ready.

Check Node.js is installed by typing this in your terminal (then pressing Enter):

```bash
node -v
```

You should see something like `v22.11.0`. If you see "command not found", close and reopen
the terminal (or restart your computer) and try again.

## Step 1 — Download Puppetmaster

1. On the GitHub page, click the green **Code** button, then **Download ZIP**.
2. Unzip it somewhere easy to find, like your Desktop.
3. In your terminal, move into that folder, for example:

   ```bash
   cd Desktop/puppetmaster-main
   ```

   (If you have `git` installed: `git clone <repository-url> puppetmaster && cd puppetmaster`.)

## Step 2 — Install the building blocks

Copy and paste these two commands, one at a time:

```bash
corepack enable
pnpm install
```

The first turns on `pnpm` (the tool that manages Puppetmaster's parts — it ships with
Node.js). The second downloads and assembles everything, which takes a minute or two and
prints a lot of text. It's done when your prompt returns with no red "error" text.

## Step 3 — Start the app

Puppetmaster has two halves — a **server** (the brain) and a **web app** (what you see) —
each in its own terminal window. Both stay open while you use it.

**Terminal window 1** — the server:

```bash
pnpm --filter @puppetmaster/server dev
```

Wait for `Server listening at http://127.0.0.1:4000`, then leave it open.

**Terminal window 2** — open a *new* window and start the web app:

```bash
pnpm --filter @puppetmaster/web dev
```

Wait for `Local: http://localhost:3000/`.

> **Quick-trial mode.** With nothing else configured, the server keeps everything in memory —
> perfect for learning. Close it and the data resets. Part 4 shows how to make it permanent.

## Step 4 — Create your account

Open **http://localhost:3000**. Because no one has signed up yet, you'll see the first-run
screen:

![First-run screen asking to create the workspace owner account](img/getting-started/01-first-run.png)

The first account becomes the workspace **owner** (full control). Enter your name, an email
(any address works locally), and a password of 8+ characters, then click **INITIALIZE
WORKSPACE**. You're in.

---

# Part 2 — The big picture

Everything in Puppetmaster is built from eight ideas. Learn these and every screen makes
sense.

| Idea | Plain meaning |
|---|---|
| **Agent** | An AI "employee": a named persona with a job description, running on a model you choose, that can use tools and remember things. |
| **Workflow** | An automatic flowchart: a trigger starts it, then boxes run in order — transform data, call a tool, branch on a condition, pause for approval. |
| **Mission** | One *run* — of a workflow, or one turn of an agent. Every mission keeps a full step-by-step record (its "trace"), its cost, and its outcome. |
| **Tool** | A capability agents and workflows share — send an email, fetch a URL, search the knowledge base. Tools come from **MCP** servers (a standard way to plug capabilities in). |
| **Approval** | A pause where a human must say yes before something risky happens. The safety brake. |
| **The bridge** | The thing that makes Puppetmaster one system instead of two: agents can run workflows, and workflows can call agents — even nesting several levels deep. |
| **Workspace** | Your team's private space. Agents, workflows, knowledge, and history all belong to one workspace, skinned with your branding. |
| **Roles** | Who can do what. From least to most powerful: **member → builder → admin → owner**. |

**The permission model, in one line:** every tool is labeled by how dangerous it is —
**read** (auto-runs), **write** (pauses for approval), **destructive** (always confirms) —
and each agent has an *autonomy tier* that caps what it can do without asking.

**Roles at a glance:**

| Role | Can do |
| --- | ------ |
| `member` | Observe everything (missions, agents, tools) and chat with agents |
| `builder` | + build/run workflows, manage agents, resolve approvals, upload knowledge |
| `admin` | + manage members, branding, budgets, MCP servers, policies, evals |
| `owner` | Everything; set at first-run, cannot be demoted or removed |

---

# Part 3 — Everything it can do

## The eleven screens

Across the top of the app is a bar of eleven screens ("views"). Press its number (1–9, then
the last two) or click it. **Ctrl+K** (Mac: **Cmd+K**) opens a command bar that can reach
any of them by keyboard.

| # | Screen | What it's for |
|---|--------|---------------|
| 1 | **NEXUS** | The live operations dashboard — one figure showing your whole system in motion |
| 2 | **COMMAND** | Chat with agents |
| 3 | **CANVAS** | Build and run workflows visually |
| 4 | **WORKSHOP** | Build software under verifiable quality gates |
| 5 | **TEMPLATES** | Ready-made agents and workflows to clone |
| 6 | **KNOWLEDGE** | Upload documents your agents can search and cite |
| 7 | **MISSIONS** | The history and live status of every run |
| 8 | **AGENTS** | The roster; inspect and tune each agent |
| 9 | **TOOLS** | The tool catalog and MCP server management |
| 10 | **EVALS** | Quality tests, cost tracking, budgets, and the model router |
| 11 | **ADMIN** | Members, roles, branding, and the audit log |

The screenshots below come from the built-in **demo dataset** (a fictional "Acme
Operations" company) so you can see each screen full of realistic data. Part 4 shows how to
load it yourself.

## 1. NEXUS — the operations dashboard

![The NEXUS dashboard showing the live operations figure with orbiting agents and workflows](img/getting-started/09-nexus-populated.png)

NEXUS is the first screen everyone sees. The central figure is a live picture of your whole
workspace: orbiting marks are agents and workflows, the bands are your knowledge base, and
the moving threads are missions happening right now. The readout at the top counts agents,
workflows, and operations; the bottom lets you step through **strata** (your history stacked
by year). Along the very bottom is the **task tray** — quick-launch buttons for the common
actions (run a workflow, hail an agent, clear an approval, search knowledge, and so on),
which pop open as small floating panels right on the dashboard. The left rail always shows
your live **authorization inbox** and a **signal feed** of events as they happen.

You never *have* to use NEXUS — every action also has its own full screen — but it's the
cockpit that ties everything together.

## 2. COMMAND — chat with your agents

COMMAND is where you talk to agents. Pick one from the list (or click **＋** to create one),
type in the channel, and press **TRANSMIT**. Replies stream in live, token by token. When an
agent uses a tool you'll see the tool call and its result inline; if the tool is write-tier,
the mission pauses and the request appears in your approval inbox.

![An open chat channel with an agent](img/getting-started/07-agent-chat-channel.png)

Creating an agent asks you three things: a **name**, a **model** (type `mock` for the free
offline test model, or a real one like `claude-sonnet-5` — see Part 4), and a **persona**
(its job description in plain English).

## 3. CANVAS — build workflows visually

![The Canvas showing the node palette, copilot bar, and a multi-step approval-gated workflow](img/getting-started/10-canvas-node-palette.png)

CANVAS is a drag-and-connect editor for workflows. The **ADD** row gives you seven kinds of
box ("nodes"):

| Node | What it does |
|---|---|
| **⏵ Trigger** | Starts the workflow — manually, on a schedule, or from a webhook |
| **◆ Action** | Calls a tool (send email, HTTP GET, search knowledge, run another workflow…) |
| **⑂ Logic** | Branches — send the run one way or another based on a condition |
| **{ } Code** | Runs a small snippet of sandboxed JavaScript to transform data |
| **◉ Agent** | Hands a task to one of your AI agents and waits for its answer |
| **⚑ Approval** | Pauses for a human yes/no before continuing |
| **✓ Verify** | Runs a quality check and only continues if it passes (used in the Workshop) |

Other things on this screen:

- **COPILOT** — type a plain-English description ("daily: fetch a URL, summarize with an
  agent, email me") and click **DRAFT**; Puppetmaster proposes a workflow you can edit
  before saving. It's never saved automatically — you stay in control.
- **LINT** — checks your workflow for mistakes: a missing trigger, dangling connections,
  loops, a write-tier action with no approval in front of it, network calls with no retries,
  unknown tools, empty code nodes, and more.
- **SAVE / ▶ RUN** — every save creates a new **version**; RUN starts a mission with the
  JSON input in the box next to it. The right-hand **OPERATION** panel then shows the run
  tracing through your graph live.

## 4. WORKSHOP — build software under quality gates

![The Workshop project dossier showing the phase strip, spec-coverage meter, todo board, and artifacts](img/getting-started/16-workshop-dossier.png)

The WORKSHOP turns Puppetmaster into a place to build software where work has to pass
**deterministic gates** rather than an AI's word that it's done. A **project** moves through
phases — SPECIFY → PLAN → EXECUTE → VERIFY → RECORD — and owns versioned **artifacts**:

- **Spec** and **Plan** (a new version each time you rewrite them),
- **Todos** (backlog / active / completed — completing one records *which mission* did it, a
  permanent audit link),
- **Learnings** (an append-only log of what you found out),
- **ADRs** (architecture decision records: proposed → accepted; accepted ones are frozen).

The dossier shows a **spec-coverage meter** that insists your spec actually fills every
required section (in the screenshot it's flagging the missing ones — this is the "no
architecture theater" rule made mechanical), a **todo board**, and the artifact reader.

The **Decision Graph** below the dossier preserves why those artifacts exist. Link a spec to
its plan, a plan to the todos derived from it, and a todo to the check that verifies it; each
link requires a human-readable rationale. Trace coverage, orphan warnings, and the suggested
next move are advisory signals. They help find lost context after hand-offs or revisions but
never replace the deterministic gates.

For a complete beginner walkthrough with prompts, artifact examples, check configuration,
traceability, troubleshooting, and a full sample project, continue with the
[WORKSHOP Manual](./WORKSHOP.md).

**Verify checks** are the gates. They run a named check and return *evidence*, never a bare
"pass": `test`, `arch`, `refactor-gate` (blocks quietly editing test expectations during a
refactor), `todo-sync`, `spec-sections`, `load` (refuses to run without declared
performance targets), and `custom`. Checks are **earned policies** — off by default, and
turning one on requires writing down the failure that earned it. In **gated mode** a project
refuses to run at all until at least one check is enabled.

For the actual coding, agents get a **workbench** (an isolated container per project) and a
set of `bench.*` tools — read files, run commands, write files, commit, push — each labeled
by how much it can break. `bench.delegate` hands a coding task to a pluggable headless coding
CLI (Claude or Aider ship built-in) running inside that sandbox.

## 5. TEMPLATES — start from a ready-made helper

![The Templates screen showing first-party workflow and agent templates](img/getting-started/15-templates.png)

TEMPLATES are pre-built agents and workflows you can clone with one click (**USE THIS**).
Puppetmaster ships several first-party ones — a starter transform-and-echo workflow, an
HTTP health-check, a gated broadcast, and a set of Workshop agents. Builders can also
**publish** any of their own agents or workflows back to the catalog to share with the team.

## 6. KNOWLEDGE — give your agents a library

![The Knowledge screen with documents, a search-test box, and an upload panel](img/getting-started/14-knowledge-base.png)

KNOWLEDGE is your team's document store (a "RAG" knowledge base). Upload or paste Markdown/
text; Puppetmaster splits each document into passages, remembers the headings as
breadcrumbs, and indexes it. The **SEARCH TEST** box runs the exact same search agents use —
a **hybrid** of meaning-based and keyword search — and shows you the matching passages with
**citations** (`Title#chunk (breadcrumb)`) and scores. Agents reach the same library through
the `kb.search` and `kb.read` tools, so their answers can cite your real documents.

## 7. MISSIONS — the complete history

![The Missions screen showing the log of every run with statuses and durations](img/getting-started/11-missions-log.png)

MISSIONS lists every run — workflows and agent turns — with its status (running, awaiting
approval, succeeded, failed, cancelled), start time, and duration. The tiles up top summarize
totals and your success rate. Nested runs (a workflow that called an agent, say) show their
parent. Click any mission to open its full **trace**: every step's input and output in order.
For a failed mission you can ask for an **EXPLAIN** — a plain-language diagnosis of what went
wrong — or **RETRY** it from where it stopped, or **CANCEL** one that's still going.

## 8. AGENTS — the roster and inspector

![The Agents roster showing twelve agents each tagged with an autonomy tier](img/getting-started/12-agents-roster.png)

AGENTS is the roster. Each card shows the agent's model and its **autonomy tier** (READ /
WRITE / DESTRUCTIVE). Select one to open the **inspector**, where you can tune everything:

- its **persona** and **model**,
- its **autonomy tier** (how much it can do without asking),
- a **cron schedule** to wake it up automatically (e.g. `0 9 * * 1-5` = 9am weekdays),
- **tool grants** (which tools it may touch — empty means the full catalog),
- **context compaction** (on/off — trims big tool results before they reach the model),
- and its **memory**: browse what it remembers, search its memory semantically, and
  **pin**, **edit**, or **delete** individual memories.

## 9. TOOLS — the catalog and MCP servers

![The Tools screen showing the tool catalog grouped by namespace and MCP server management](img/getting-started/13-tools-catalog.png)

TOOLS shows every tool available, grouped by namespace, each tagged **READ / WRITE /
DESTRUCTIVE**. The built-in set includes `util.*` (echo, now, merge), `math.sum`, `http.get`,
`email.send`, `kb.search`/`kb.read`, `workflow.*`, `agent.ask`, `project.*`, and `bench.*`.
Admins can also **add MCP servers** — extra tool providers, over HTTP or local processes —
by URL, or **search the public MCP registry** and add one in a click. A server's auth header
can reference a secret from the vault (see Security), and removing a server unplugs its tools.

## 10. EVALS — quality, cost, budgets, and the router

![The Evals screen showing the golden test suite results and a token budget](img/getting-started/17-evals-suite.png)

EVALS is your governance cockpit (admin):

- **Golden suite** — a battery of automated tests (τ-bench style) that run several times each
  and check not just the outcome but the *path* the agent took (did it call the right tools,
  and only those?). **RUN SUITE** runs them; a run is green only if every repeat passed.
- **Cost ledger** — month-to-date token usage broken down by agent and model.
- **Monthly token budgets** — set a limit for the whole workspace or a single agent;
  exceeding it pauses new agent runs behind an approval so nothing runs away with your bill.
- **Router profiles** — named model fallback chains (see the Router section) with an optional
  quality floor.
- **Router health** — which models are healthy vs. temporarily cooling down after errors.

## 11. ADMIN — members, branding, and the audit log

![The Admin screen showing workspace branding, member roles, and the audit log](img/getting-started/18-admin-audit.png)

ADMIN (admin/owner) is where you:

- **Brand the workspace** — set the workspace name, the brand name shown on the rail, and an
  accent color; the whole shell re-skins for every member (white-labeling).
- **Manage members** — add people with a name/email/password and a role, change roles, or
  remove them.
- **Read the audit log** — an append-only record of *every* LLM call, tool call, and approval
  decision, plus logins and membership changes, filterable by action type. This is the
  ground truth of everything that has happened in your workspace.

---

## The feature deep-dive

The screens above are the "where." Here's the "what" — every capability, grouped by what you
want to do.

### Building & running workflows

- **Seven node types** (table in the CANVAS section) let you combine triggers, tool calls,
  branching logic, sandboxed code, agent hand-offs, approval gates, and verify checks.
- **Copilot draft** turns plain English into an editable workflow; **lint** catches mistakes
  before you run.
- **Versioning** — every save is a new version, so you can always see what changed.
- **Input resolution** — each non-trigger node reads the output of the node just before it;
  only the first node sees the run's input.

### Three kinds of trigger

- **Manual** — you press RUN (or call the API).
- **Webhook** — the workflow gets a URL and a secret. On a webhook workflow, CANVAS shows a
  **⚿ WEBHOOK** box with the URL and an HMAC secret; incoming calls must sign the body
  (`X-Puppetmaster-Signature: sha256=HMAC_SHA256(secret, body)`) or they're rejected. You can
  rotate the secret. This is how outside systems safely kick off your workflows.
- **Schedule (cron)** — runs on a timetable. (Scheduling needs the durable setup in Part 4,
  not the in-memory quick-trial.)

### Durable execution — nothing runs twice, nothing gets lost

Puppetmaster journals side-effectful steps, so if a run is retried it reuses work it already
did instead of, say, sending the same email twice. Missions support **cancel** (stop a
running one), **retry-from-cursor** (resume a failed one where it stopped, keeping its
history), a **dead-letter list** (runs that failed even after a retry), and **replay**
(re-walk a finished run over its recorded data with no side effects, to see exactly what
happened). Failed missions can be **explained** in plain language.

### AI agents — personas, models, autonomy, schedules

Create an agent with a persona and a model; tune it in the inspector (AGENTS section). The
key dial is the **autonomy tier**:

- **read_auto** — can run read-only tools freely; anything more pauses.
- **write_approved** — read-only is free; write actions pause for approval.
- **destructive_confirmed** — even trusted, destructive actions always confirm first.

Give an agent a **cron schedule** to run on its own, or **tool grants** to restrict which
tools it may use. Turn on **context compaction** and Puppetmaster trims oversized tool
results (pretty-printed JSON, repeated lines, huge blobs) before they reach the model — the
raw result is still stored, and the tokens saved are counted in EVALS.

### Agent memory that actually remembers

Agents have a real long-term memory, not just a chat log. It has three kinds:

- **fact** — things you told it to remember (`remember: …`),
- **episodic** — a one-line summary it writes after each successful run,
- **procedural** — "this task → these tool steps worked" patterns.

Memory is **admission-controlled** (a near-duplicate merges into the existing memory instead
of piling up), **capped per agent** (the least useful, oldest memories are evicted when
full — unless you **pin** them), and **recalled by meaning + keyword**. You can search, pin,
edit, and delete any memory from the agent inspector.

### The bridge — agents and workflows calling each other

This is the differentiator. Through shared tools:

- **Agent → workflow:** an agent can `workflow.run` (start one and wait for the result) or
  `workflow.create_draft` (draft a new one).
- **Workflow → agent:** an Agent node hands a task to an agent and waits for its structured
  answer.
- **Agent → agent:** `agent.ask` delegates to another agent (up to two hops deep;
  self-delegation refused).

Nested runs share one mission trace, so you always see the full story top to bottom.

### Tools & MCP

Every integration is an **MCP server** — a standard way to plug in capabilities that agents
and workflows use identically. The built-in catalog covers utilities, HTTP, email, the
knowledge base, workflow/agent bridging, Workshop project tools, and the coding workbench.
Admins add more from the **TOOLS** screen (by URL or from the public registry). A server that
needs a secret reads it from the vault as `{{credential:NAME}}`, resolved only at connect
time. If a tool's description silently changes between connections (a "tool poisoning"
canary), Puppetmaster logs it.

### Knowledge base / RAG

Upload Markdown/text; it's chunked on headings and indexed. Retrieval is **hybrid** (meaning
+ keyword, fused) and returns **citations**. Agents cite the same library through tools, and
every tool result — knowledge or otherwise — enters the agent's context inside an
"untrusted data" envelope so instructions hidden in a document are treated as data, never
obeyed.

### Approvals & governance

Write-tier actions pause; destructive ones always confirm. Pending requests appear in the
**authorization inbox** on the left rail of most screens. Approving uses a deliberate
**press-and-hold** button (a guarded switch, so nothing is approved by a stray click); or you
can **DENY**. Admins can also write **auto-allow policies** — rules like "let `email.send` to
`@acme.io` through without pausing" — with everything unmatched still gating, and every
auto-approval recorded in the audit log.

### Templates & adaptive suggestions

Clone ready-made agents/workflows from **TEMPLATES**, or publish your own to share. The
left-rail **SUGGESTED** panel learns from use and floats your most-run agents and workflows
to the top.

### The Workshop (software development)

Covered in the WORKSHOP section: projects, versioned artifacts (spec/plan/todo/learning/adr),
the spec-coverage meter, verify gates and earned-policy checks, the isolated per-project
workbench, tiered `bench.*` tools, and `bench.delegate` to a pluggable coding CLI. Accepted
specs and learnings also **mirror into the knowledge base**, so search and citations work
over a project's own documents.

### Model providers & the router

Any agent runs on any provider by setting its model string:

- `claude-*` → Anthropic
- `openai/*` → OpenAI (or any OpenAI-compatible server, e.g. vLLM)
- `ollama/*` → a local Ollama model
- `mock` → the free, offline, scripted test model
- `profile:NAME` → a named router profile

**Fallback chains:** a model string can list candidates with `|`
(`claude-sonnet-5|openai/gpt-5|mock`) — tried in order, so a provider outage routes around
itself. **Router profiles** (EVALS) name a chain once so editing it re-routes every agent
using it, with an optional **quality floor** that refuses to silently downgrade below a set
cost class for agents that can reach risky tools. **Health-aware routing** cools down a model
that's erroring and prefers healthy ones, without ever fully dropping a candidate.

### Evals & observability

The **golden suite** proves behavior (outcome + path). The **cost ledger** and **budgets**
track and cap spend. The **audit log** records everything. If you point
`OTEL_EXPORTER_OTLP_ENDPOINT` at a collector, every finished mission is also exported as an
OpenTelemetry trace with standard `gen_ai.*` attributes, so Puppetmaster drops into
observability tools you may already run.

### Security

- **Credentials vault** — secrets are encrypted at rest under a master passphrase, write-only
  (never shown again after saving), and injected into MCP servers only at connect time.
- **Egress allowlist** — set `HTTP_ALLOWED_HOSTS` and the `http.get` tool refuses any host
  not on the list.
- **Untrusted-data envelopes** — external content can't smuggle instructions into an agent.
- **Tool-description pinning** — a changed tool description is flagged.
- **Sign in with SSO (OIDC)** — connect your identity provider so people log in with your
  company account instead of a local password.

### Personalization

- **White-label branding** — name and accent color per workspace (ADMIN).
- **Role-based screens** — people see only what their role allows.
- **Arrangeable panels** — drag, pin, collapse, and hide the panels on your dashboard; your
  layout is saved per person.
- **Keyboard-first** — number keys switch screens; **Ctrl/Cmd+K** opens the command palette
  that can run any action.

---

# Part 4 — Reference

## Two hands-on test drives

The fastest way to feel how the pieces fit is to run these two on your own fresh workspace.

### Test drive A — an automated approval

Every business has a rule like *"anything over $500 needs a sign-off."* Puppetmaster calls
that an **approval gate**, and a ready-made example demonstrates one end to end.

1. Open **CANVAS**. In the **WORKFLOWS** panel, click **SAMPLE**. A flowchart appears:
   trigger → double a number → check "bigger than 5?" → (if big) **approval** → action.

   ![The sample workflow loaded on the canvas](img/getting-started/03-canvas-sample.png)

2. Click **▶ RUN**. Watch it run left to right and stop at the approval step, exactly like a
   real order awaiting a manager's okay:

   ![The workflow paused, waiting for approval](img/getting-started/04-run-paused-approval.png)

3. In the **AUTHORIZATIONS** panel, press and **hold** **HOLD TO AUTHORIZE** for about a
   second (the deliberate hold prevents accidental approvals), or click **DENY**:

   ![Pressing and holding the authorize button](img/getting-started/05-hold-to-authorize.png)

4. It finishes green. Open **MISSIONS** to see it recorded with a 100% success rate:

   ![The Missions view showing the completed run](img/getting-started/06-missions-succeeded.png)

That log is your audit trail — automatic, permanent, and impossible to quietly edit.

### Test drive B — an AI assistant with memory

1. Open **COMMAND**, click **＋** in the AGENTS panel, and answer the three prompts:
   - **Agent name** — e.g. `Bakery Assistant`
   - **Model** — `mock` (free, offline; no account needed)
   - **Persona** — *"You are a friendly assistant for a small neighborhood bakery. Answer
     questions about orders, hours, and recipes."*
2. Type a message and press **TRANSMIT** — the agent replies live.
3. Test its memory:

   ```
   remember: Maria always orders a dozen sourdough rolls every Friday for pickup at 8am
   ```

   You'll see the agent call its memory tool and confirm it saved:

   ![The agent saving a fact to long-term memory](img/getting-started/08-agent-memory-save.png)

   Ask about Maria later, even in a new conversation, and it still knows.

## Explore the full demo dataset

To browse a mature, fully-populated workspace (the "Acme Operations" company in this guide's
screenshots — 12 agents, 12 workflows, 16 documents, dozens of missions, live approvals),
stop your Step 3 server (**Ctrl+C**) and run:

```bash
pnpm build
PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server seed:demo
PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server start
```

The first command assembles the app; the second fills a saved-to-disk database with the
sample data (run once); the third serves it, keeping the data between restarts. Sign in at
`localhost:3000` with any of these (password `demodemo123` for all):

- **Owner:** `avery.owner@acme.io`
- **Admin:** `dana.admin@acme.io`
- **Builder:** `blair.builder@acme.io`
- **Member:** `morgan.member@acme.io`

Sign in as different roles to see how the screens and permissions change.

## Make your data permanent

Quick-trial mode resets when you stop the server. To keep data across restarts, run two small
support programs (a database and a message queue) with **Docker** — a free tool that runs
them in a self-contained box.

1. Install **Docker Desktop** from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop), then open it once so it's running.
2. From the puppetmaster folder, in its own terminal:

   ```bash
   docker compose -f docker/docker-compose.yml up postgres redis
   ```

3. Stop your server (**Ctrl+C**) and restart it pointed at the permanent database:

   ```bash
   DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster \
   REDIS_URL=redis://127.0.0.1:6379 \
   pnpm --filter @puppetmaster/server dev
   ```

Now everything survives restarts, **and** scheduled (cron) triggers work. There's also an
all-in-one `docker compose -f docker/docker-compose.yml up --build` that runs the API and its
database together.

## Connect real AI

The `mock` model is free and offline but scripted. For real answers, give the server a
provider key and set your agents' models accordingly (in the AGENTS inspector, or a template):

| To use… | Set this before starting the server | Agent model string |
|---|---|---|
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY=…` | `claude-sonnet-5` (and others) |
| **OpenAI / compatible** | `OPENAI_API_KEY=…` (and `OPENAI_BASE_URL=…` for a custom server) | `openai/gpt-5` |
| **Local Ollama** | `OLLAMA_BASE_URL=http://127.0.0.1:11434` | `ollama/llama3` |

## Full settings reference

The server is configured with environment variables (set them in your shell before starting,
or use the Docker setup). None are required for the quick trial. The most useful:

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | *(unset → in-memory)* | Postgres connection; makes data permanent |
| `REDIS_URL` | *(unset → in-memory)* | Redis connection; enables the queue and cron scheduling |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Server address |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables `claude-*` agents |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | *(unset)* | Enables `openai/*` agents (or any OpenAI-compatible server) |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Endpoint for `ollama/*` agents |
| `EMBEDDING_PROVIDER` | `mock` | Knowledge/memory embeddings: `mock` (keyless), `openai`, or `none` |
| `MCP_SERVERS` | *(unset)* | Extra MCP tool servers to launch at boot (JSON) |
| `PUPPETMASTER_MASTER_KEY` | *(unset → vault off)* | Passphrase that unlocks the credentials vault |
| `HTTP_ALLOWED_HOSTS` | *(unset → unrestricted)* | Comma-separated allowlist for the `http.get` tool |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | *(unset → SSO off)* | Enable "Sign in with SSO" |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset → off)* | Export finished missions as OpenTelemetry traces |
| `MEMORY_CAP` | `200` | Per-agent long-term memory limit before eviction |
| `COPILOT_MODEL` | `mock` | Model used for the workflow copilot and failure explanations |
| `WORKBENCH_MODE` | *(local)* | Set to `docker` to run each Workshop project in an isolated container |
| `PGLITE_DATA_DIR` | *(unset → in-memory)* | Save the keyless database to disk (used by the demo seeder) |

The complete list, with every embedding, router, and workbench option, is in `docs/INSTALL.md`.

## Shutting everything down

Click into each terminal window and press **Ctrl+C**. If you started Docker, also run
`docker compose -f docker/docker-compose.yml down` (this keeps your saved data; add `-v` only
to wipe it too).

## Troubleshooting

**"command not found: pnpm" or "node"** — Node.js isn't installed, or the terminal was open
before you installed it. Close it completely, reopen, and try `node -v`. Still missing?
Reinstall Node.js and restart your computer.

**A port is already in use (3000 or 4000)** — something else (often a previous copy of the
app) holds that address. Close other terminals running the app, or restart your computer.

**The browser page is blank** — check both Step 3 terminals are open with no red error text.
Copy any error you see before asking for help.

**I forgot my password** — there's no reset flow yet. Sign in as another admin/owner and make
yourself a new account, or (in quick-trial mode) just restart the server, which resets the
data, and sign up again.

**Docker Desktop won't start** — on Windows it needs virtualization enabled; the installer
will tell you. Restart your computer after installing it for the first time.

## Glossary

| Term | Plain meaning |
|---|---|
| **Agent** | An AI "employee": a persona you chat with that remembers things and uses tools |
| **Workflow** | An automatic flowchart: trigger → steps → done |
| **Mission** | One run of a workflow or agent turn — the record of what happened |
| **Node** | One box in a workflow (trigger, action, logic, code, agent, approval, verify) |
| **Tool** | A capability agents and workflows share, provided by an MCP server |
| **MCP** | The open standard Puppetmaster uses to plug in tools |
| **Approval / Authorization** | A pause where a human must say yes before something risky proceeds |
| **Autonomy tier** | How much an agent can do without asking: read / write / destructive |
| **The bridge** | Agents running workflows and workflows calling agents, on one system |
| **RAG / Knowledge base** | A searchable document library agents can cite |
| **Workspace** | Your team's private space; everything belongs to one |
| **Role** | Owner / admin / builder / member — increasing levels of access |
| **Verify check / gate** | A pass-or-block quality test in the Workshop |
| **Router profile** | A named list of models to try in order |
| **Vault** | Encrypted storage for secrets like API keys |
| **Terminal** | A text window for typing commands instead of clicking icons |
| **localhost** | "This computer" — `localhost:3000` is port 3000 on your own machine |

---

Once you're comfortable here, `docs/INSTALL.md` is the full technical reference,
`docs/ARCHITECTURE.md` explains how the kernel is built, and `docs/PRD.md` lays out the
product vision.
