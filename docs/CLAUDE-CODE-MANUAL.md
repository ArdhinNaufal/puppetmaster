# CLAUDE Code Feature Manual

## Use Anthropic/Claude Code or OpenAI/Aider safely inside Puppetmaster

This manual is for a junior programmer who wants to use the **CLAUDE** page, not merely
understand its architecture. It covers setup, the user interface, a complete Plan-to-Execute
workflow, provider differences, monitoring, cancellation, verification, and recovery.

The most important distinction is:

> **Anthropic sessions run Claude Code. OpenAI sessions run Aider.** OpenAI is an additive
> coding backend inside the same CLAUDE control plane; it does not make the Claude Code CLI use
> an OpenAI model.

The shortest safe workflow is:

1. Start Docker Desktop.
2. Build the two required workbench images.
3. Configure one provider and its allowed network host in the repository-root `.env`.
4. Run the API server on the host and the web app in a second terminal.
5. Create a project with a real, cloneable repository URL.
6. Open **CLAUDE**, create a **Plan / read-only** session, and review the plan.
7. Continue with **Execute / gated edits** only after narrowing the change.
8. Hold to authorize the Execute mission.
9. Review the transcript, test results, and **WORKBENCH DIFF** before any separate commit,
   push, or deployment.

Do not use an in-memory database for work you care about. Sessions are database-backed while
project files live in Docker volumes; losing only the database makes those resources difficult
to match safely.

---

## 1. What the CLAUDE feature does

The CLAUDE page is a durable control plane for AI-assisted coding. It connects a Puppetmaster
project to an isolated Docker workbench, starts a provider-specific coding CLI, persists the
turn and its events, and exposes the result in the existing mission and approval system.

```text
CLAUDE page
  -> durable session
  -> one turn and one mission
  -> isolated Docker workbench
  -> Anthropic/Claude Code OR OpenAI/Aider
  -> bounded persisted output, status, usage, and audit evidence
  -> approved copy-back of eligible scratch files for Execute
  -> workbench diff for human review
```

The page supports two modes:

| Mode | What the provider may do | Approval | File result |
| --- | --- | --- | --- |
| **Plan / read-only** | Inspect the repository and explain an approach | No write approval | No provider-generated edit is copied into the durable workbench; on first use, Puppetmaster may initialize an empty workbench by cloning `repoRef` |
| **Execute / gated edits** | Implement the requested change inside an attempt-owned scratch copy | One Puppetmaster write approval before the provider starts | Eligible successful scratch edits are authenticated and copied into the durable workbench |

Plan is read-only, but it is still a real provider request and can consume paid tokens.

### 1.1 What it does not do

- It does not execute captured or leaked system prompts.
- It does not run project code directly on the host.
- It does not offer `bypassPermissions`.
- It does not ask for a separate Puppetmaster approval for every internal provider tool call.
  Execute has one outer approval for the whole coding turn.
- Puppetmaster does not add a separate automatic commit, push, pull-request, or deployment step.
  Do not mistake that for a hard ban on provider-initiated Git commands: a prompt is not a security
  control. Inspect Git status and the diff, and do not forward Git-hosting credentials into the
  workbench.
- It does not support active-active CLAUDE execution across several Puppetmaster servers or
  Docker hosts.
- It does not currently provide a documented private-repository credential-forwarding flow.
  Start with a public HTTPS repository or a repository already present in the workbench.

---

## 2. Beginner vocabulary

| Term | Meaning in this feature |
| --- | --- |
| **Project** | The Puppetmaster record for one codebase. It owns a repository reference and a durable Docker workbench. |
| **Repository reference (`repoRef`)** | The source passed to `git clone` when CLAUDE prepares an empty workbench for the first time. For CLAUDE, use a real cloneable URL, not only a human label. |
| **Workbench** | A non-root, resource-limited Docker environment containing the project. Its files survive between turns. |
| **Provider** | The account/API family paying for and serving the model: `Anthropic` or `OpenAI`. |
| **Backend** | The coding CLI that runs in the workbench: Claude Code for Anthropic, Aider for OpenAI. |
| **Session** | A durable group of related turns for one project and one fixed provider. |
| **Turn / run** | One instruction submitted inside a session. A turn can be Plan or Execute. |
| **Mission** | Puppetmaster's operational record for one turn. It contains status, approval, cancellation, retry, and trace information. |
| **Approval** | The human decision required before an Execute provider process starts. |
| **Scratch copy** | A disposable copy used for provider edits. The provider does not receive the durable project as a writable mount. |
| **Copy-back** | The authenticated, journaled operation that applies a successful Execute result to the durable workbench. |
| **Event** | A persisted output or diagnostic record emitted during a turn. |
| **Egress allowlist** | The explicit list of network hostnames a workbench may reach through its proxy. |

### 2.1 Provider comparison

| Capability | Anthropic / Claude Code | OpenAI / Aider |
| --- | --- | --- |
| Backend in the image | Claude Code `2.1.205` | Aider `0.86.1` |
| Default model | `sonnet` | `openai/gpt-5.6` unless configured otherwise |
| Plan | Claude `plan` mode with the durable project mounted read-only | Aider `ask` mode against a sanitized disposable copy |
| Execute | Claude `acceptEdits` in a scratch copy after approval | Aider `code` in a scratch copy after approval |
| Native CLI session resume | Yes | No |
| Structured events | Yes | No; output is normalized from plain text |
| Effort selector | Yes, when supported by the selected model | Yes; forwarded as Aider reasoning effort |
| Maximum-turn control | Yes | No |
| Per-turn USD cap in this UI | Yes | No |
| Tool/task tabs | Populated when Claude emits recognized structured events | Often empty; use Transcript and Raw Events |

Suggested model names are not a guarantee that your provider account can use them. A remote
provider can still reject a model because of account access, region, retirement, or billing.

---

## 3. Understand the safety boundary before using Execute

The feature uses several independent protections:

1. **Host-run control plane.** The Puppetmaster server controls Docker; project code does not
   become a host process.
2. **Disposable provider holder.** Each provider turn receives its own non-root container with
   memory, CPU, and process limits.
3. **Explicit egress.** The provider container reaches only hostnames in
   `WORKBENCH_EGRESS_ALLOW` through the egress proxy.
4. **Server-side credentials.** Provider secrets come from the server environment. The browser,
   project repository, base workbench environment, and persistent holder metadata do not store
   their values.
5. **Read-only Plan.** After Puppetmaster prepares the workbench, Anthropic Plan uses a
   read-only project mount. OpenAI Plan uses a sanitized disposable repository copy because
   Aider itself may create cache metadata. Preparing an empty workbench can first clone the
   project's `repoRef`; that initialization is not a model-generated edit.
6. **Outer Execute approval.** A builder must authorize the entire Execute turn before the
   provider starts.
7. **Scratch Execute.** Both providers edit an attempt-owned copy rather than a writable durable
   project mount.
8. **Signed copy-back.** Only a successful Execute result with valid execution identity and
   recovery evidence may cross into the durable workbench.
9. **Project serialization.** Only one active CLAUDE turn may own a project at a time, even if
   several sessions exist for that project.

These controls reduce risk; they do not make an instruction automatically correct. A provider
can still implement the wrong behavior, delete files inside its scratch copy, introduce a
security bug, or produce a change that passes weak tests. Review the resulting diff and run
deterministic checks.

Never put API keys, passwords, private tokens, or production data in a prompt. Prompts and bounded
or truncated provider output are persisted as session evidence; output limits reduce volume, not
sensitivity.

---

## 4. Before you begin

### 4.1 Required software

- Node.js 22 or newer
- Corepack and pnpm 10.x
- Git
- Docker Desktop or another working Docker daemon
- The Puppetmaster repository checked out locally
- A provider account and API credential for real model calls

Open PowerShell in the repository root and verify the tools:

```powershell
node --version
corepack --version
git --version
docker info --format '{{.ServerVersion}}'
```

If `docker info` cannot contact `docker_engine`, start Docker Desktop and wait until the engine
is ready.

### 4.2 Required Puppetmaster role

| Role | CLAUDE ability |
| --- | --- |
| **Member** | Read sessions, transcripts, events, references, and workbench inspection |
| **Builder** | Everything a member can do, plus create/continue/archive sessions, approve or deny Execute, cancel, and retry |
| **Admin / Owner** | Everything a builder can do, plus broader system administration |

If the page says **READ-ONLY ROLE**, ask an administrator to assign at least the Builder role.

### 4.3 Required repository state

For the first beginner run, use a public HTTPS repository that `git clone` can read without an
interactive sign-in, for example:

```text
https://github.com/your-account/your-public-repository.git
```

The repository host must also be in `WORKBENCH_EGRESS_ALLOW`.

Important limitations:

- Do not enter a shorthand label such as `acme/my-app` if you plan to use CLAUDE. The runtime
  passes the repository reference to `git clone` when the workbench is empty.
- Do not put a personal access token in the repository URL. The reference is durable project
  data and can appear in administrative views or logs.
- The current UI cannot edit `repoRef` after project creation. If it is blank or wrong, create
  a replacement project with the correct clone URL.
- A non-empty workbench that is not a Git repository is rejected rather than overwritten.

---

## 5. One-time local setup

The current Docker Compose API container is **not** a CLAUDE workbench host. It intentionally
does not have access to the host Docker daemon. Run the API server directly on the host for this
feature.

### 5.1 Install JavaScript dependencies

From the repository root:

```powershell
corepack enable
pnpm install
```

### 5.2 Build the required Docker images

The normal server checks for these images but does not build or pull them:

```powershell
docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
docker build -t puppetmaster-egress-proxy:spike -f docker/egress-proxy.Dockerfile docker
```

Rebuild the workbench image after changing:

- `docker/workbench.Dockerfile`
- `docker/workbench-sync.mjs`

Rebuild the proxy image after changing:

- `docker/egress-proxy.Dockerfile`
- `docker/egress-proxy.mjs`

You can confirm both images exist:

```powershell
docker image inspect puppetmaster-workbench:spike
docker image inspect puppetmaster-egress-proxy:spike
```

### 5.3 Create the repository-root `.env`

Create or edit `.env` in the same directory as the root `package.json`. The file is ignored by
Git. Do not commit it, paste it into an issue, or include it in screenshots.

Choose one of the examples below. Replace placeholder credentials with your own values.

#### Option A: Anthropic only

```dotenv
WORKBENCH_MODE=docker
ANTHROPIC_API_KEY=replace-with-your-anthropic-api-key
WORKBENCH_EGRESS_ALLOW=api.anthropic.com,github.com
```

`ANTHROPIC_AUTH_TOKEN` is also supported for direct Anthropic authentication. An optional
`ANTHROPIC_BASE_URL` changes the endpoint but does not provide authentication.

#### Option B: OpenAI only

```dotenv
WORKBENCH_MODE=docker
OPENAI_API_KEY=replace-with-your-openai-api-key
WORKBENCH_EGRESS_ALLOW=api.openai.com,github.com
CLAUDE_CODE_OPENAI_MODEL=openai/gpt-5.6
```

#### Option C: both providers

```dotenv
WORKBENCH_MODE=docker
ANTHROPIC_API_KEY=replace-with-your-anthropic-api-key
OPENAI_API_KEY=replace-with-your-openai-api-key
WORKBENCH_EGRESS_ALLOW=api.anthropic.com,api.openai.com,github.com
CLAUDE_CODE_OPENAI_MODEL=openai/gpt-5.6
```

The allowlist contains **hostnames only**. Do not write `https://`, a path, or an API key in
`WORKBENCH_EGRESS_ALLOW`. Replace `github.com` when the repository is hosted elsewhere.

### 5.4 Make session data persistent

For a small local installation, add a PGlite directory:

```dotenv
PGLITE_DATA_DIR=./.pmdata
```

For the more complete development setup, run Postgres and Redis:

```powershell
docker compose -f docker/docker-compose.yml up -d postgres redis
```

Then add:

```dotenv
DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster
REDIS_URL=redis://127.0.0.1:6379
```

Use either persistent PGlite or Postgres. If `DATABASE_URL` is set, PostgreSQL is used instead
of PGlite.

### 5.5 Start the host server and web app

Use two PowerShell terminals in the repository root.

Terminal 1 - API server:

```powershell
pnpm --filter @puppetmaster/server dev
```

The server package's `dev` and `start` commands load the root `.env`. After changing `.env`,
stop and restart the server; refreshing the browser is not enough.

An expected startup message includes:

```text
workbench: docker executor enabled
```

Check the public health endpoint:

```powershell
Invoke-RestMethod http://localhost:4000/api/health
```

Expected fields include `ok: true` and `service: puppetmaster-server`.

Terminal 2 - web app:

```powershell
pnpm --filter @puppetmaster/web dev
```

Open [http://localhost:3000](http://localhost:3000).

Use a desktop-width browser window when operating CLAUDE. At 760 pixels or narrower, the current
responsive shell hides the global authorization and trace side panels. You can inspect sessions on
a narrow screen, but switch to a wider window before approving or denying an Execute turn. Full
interactive narrow-screen acceptance has not been verified.

Do not start a second API server against the same Docker daemon for CLAUDE work. The recovery
and filesystem ownership model currently supports one active Puppetmaster server per Docker
daemon.

### 5.6 Create or sign in to the workspace

On a new database, the first visit shows **FIRST RUN · CREATE OWNER**:

1. Enter your name.
2. Enter a local email address.
3. Enter a password of at least eight characters.
4. Select **INITIALIZE WORKSPACE**.

The first account is the Owner and can operate CLAUDE.

---

## 6. Create a CLAUDE-ready project

1. Open **WORKSHOP** in the main navigation.
2. In **PROJECTS**, enter a clear project name.
3. Enter the real public HTTPS clone URL in **Repository reference**.
4. Leave **GATED MODE** off for your first project. CLAUDE Execute already has its own approval
   boundary; Workshop gated mode controls a separate project workflow behavior.
5. Select **CREATE PROJECT**.

Example:

```text
Project name: Junior Todo API
Repository reference: https://github.com/your-account/junior-todo-api.git
Mode: supervised
```

On the first CLAUDE turn, the runtime:

1. creates the named workbench and lock volumes;
2. checks whether the workbench is already a Git repository;
3. if it is empty, clones `repoRef` into it;
4. if it is non-empty but not Git, stops and reports an error rather than overwriting files.

The first turn can therefore take longer than later turns.

---

## 7. Read the CLAUDE page before starting a turn

Open **CLAUDE** in the main navigation. The page has six top tabs:

| Tab | Purpose |
| --- | --- |
| **OPERATE** | Create sessions, submit turns, read transcripts, inspect events, and view diffs |
| **MODELS** | Browse the curated Anthropic model catalog and aliases |
| **TOOLS** | Browse documented Claude Code tool vocabulary and historical name mappings |
| **EXTENSIONS** | Read about CLAUDE.md, skills, MCP, hooks, plugins, and other extension surfaces |
| **PERMISSIONS** | Understand Claude permission modes and Puppetmaster's two-layer policy |
| **SOURCES** | See official reference sources and the unverified provenance manifest |

At the top of the page, check runtime state:

- **ANTHROPIC + OPENAI READY** means both provider-specific readiness checks passed.
- **ANTHROPIC READY** means only the Anthropic credential, endpoint allowlist, proxy image,
  workbench image, and Claude CLI probe passed local readiness checks.
- **OPENAI READY** means only the OpenAI credential, endpoint allowlist, proxy image, workbench
  image, and Aider probe passed local readiness checks.
- **DOCKER RUNTIME CONFIGURED** means Docker mode exists, but one or both providers can still be
  unavailable. Read the provider-specific warning.
- **DOCKER RUNTIME OFFLINE** means `WORKBENCH_MODE=docker` was not active when the server started.

Readiness proves local configuration. It does not prove that a remote provider will accept the
credential, model, account, or billing state.

---

## 8. First walkthrough: create a read-only Plan session

Start with Plan. It is the safest way to learn what the model thinks the repository contains
before giving it permission to edit.

### 8.1 Open the composer

1. Select **OPERATE**.
2. Expand **+ NEW SESSION**.

The fields are:

| Field | What to enter |
| --- | --- |
| **PROVIDER** | `Anthropic / Claude Code` or `OpenAI / Aider` |
| **PROJECT** | The active project created in WORKSHOP |
| **SESSION TITLE OPTIONAL** | A short purpose such as `Plan validation for login fix`; if blank, the first prompt becomes the title |
| **INITIAL INSTRUCTION** | The task, context, constraints, and requested evidence |
| **MODE** | Start with `Plan / read-only` |
| **MODEL** | Anthropic alias such as `sonnet`, or OpenAI model such as `openai/gpt-5.6` |
| **EFFORT** | Model default for routine work; raise only for a task that needs more reasoning |
| **MAX TURNS** | Anthropic only; 1-100 CLI turns |
| **BUDGET USD** | Anthropic only; a per-turn CLI spending cap |

The current UI initializes Anthropic **MAX TURNS** to `24` and **BUDGET USD** to `5`. Those are
caps, not expected costs, but a beginner should deliberately lower them for a small trial.
OpenAI/Aider has no turn or spend cap in this UI; use provider-account budget controls.

### 8.2 Use an evidence-oriented Plan prompt

Copy and adapt this template:

```text
Inspect this repository without changing files.

Goal:
Add validation so a todo title cannot be blank.

Please return:
1. The current behavior and the exact files that implement it.
2. Existing tests related to todo creation.
3. Risks, edge cases, and assumptions that need confirmation.
4. A small implementation plan in independently testable stages.
5. The exact commands that should verify the change.

Constraints:
- Do not edit files.
- Do not expand the task into unrelated refactoring.
- Distinguish facts observed in the repository from recommendations.
```

### 8.3 Queue and monitor the Plan

1. Confirm the provider status says ready.
2. Select **QUEUE PLAN**.
3. The new durable session appears in the left session rail.
4. The turn moves through `QUEUED` and `RUNNING`.
5. Select **TRACK MISSION** to inspect its operational trace.
6. Return to CLAUDE and read **TRANSCRIPT** when the turn reaches `SUCCEEDED`, `FAILED`, or
   `CANCELLED`.

Plan does not request a write approval. If a Plan mission is waiting for an Execute-style
authorization, treat that as a bug or stale UI state and inspect the mission before proceeding.

### 8.4 Review the Plan critically

Before Execute, verify:

- cited files actually exist;
- the model understood current behavior;
- the plan addresses the requested goal and not a larger rewrite;
- the test commands match the repository's package manager and scripts;
- assumptions are visible rather than presented as facts;
- **WORKBENCH DIFF** shows no Plan-created durable edit.

Do not execute a vague plan. Ask a follow-up Plan turn to resolve unclear details.

---

## 9. Execute a reviewed change

Use Execute only after the Plan is narrow enough to review.

### 9.1 Continue the same session

1. Select the session in the left rail.
2. Scroll to **NEXT TURN**.
3. Notice **PROVIDER LOCKED FOR THIS SESSION**. Provider is immutable.
4. Change **MODE** to `Execute / gated edits`.
5. Keep or change the model within the same provider.
6. Enter a bounded implementation instruction.

If you need the other provider, create a new session. Do not try to enter an OpenAI model in an
Anthropic session or an Anthropic model in an OpenAI session.

### 9.2 Use a bounded Execute prompt

```text
Implement only Stage 1 of the reviewed plan: reject a blank todo title.

Requirements:
- Preserve the existing API response shape.
- Add or update the smallest relevant test.
- Run the focused test first, then the repository's standard typecheck.
- Do not refactor unrelated files.
- Do not commit, push, publish, or deploy.

At the end, report:
1. Files changed and why.
2. Commands run with pass/fail results.
3. Any remaining risk or unverified assumption.
```

Select **REQUEST EXECUTION**.

### 9.3 Authorize or deny the mission

Execute enters `AWAITING APPROVAL` before the provider starts.

1. Find **AUTHORIZATIONS** in the application side rail.
2. Read the project, provider/backend, model, and requested authority.
3. If the request matches what you intend, press and hold **HOLD TO AUTHORIZE** until it
   completes.
4. If anything is wrong, select **DENY**.

Denial is a safe terminal result: the turn becomes cancelled and the provider process does not
start. It is not an error that needs repair.

One approval covers the whole Execute turn. Internal edits and commands are not separately
approved by Puppetmaster. This is why the prompt must be narrow and why the result must be
reviewed afterward.

### 9.4 What happens after authorization

1. The runtime claims an exact execution generation.
2. It prepares a provider-specific scratch repository.
3. The provider edits only the scratch copy.
4. Output streams into durable events.
5. If the provider succeeds, the trusted helper verifies execution identity and copies eligible
   resulting files into the durable workbench.
6. The run, session, mission, usage, audit, and copy-back ledger are committed.
7. Scratch and recovery artifacts are cleaned after acknowledgement.

If provider execution fails before successful copy-back, its unapproved or incomplete scratch
edits are not treated as a durable project result.

### 9.5 Review the result

After `SUCCEEDED`:

1. Read **TRANSCRIPT** for the summary and command results.
2. Open **WORKBENCH DIFF**.
3. Read **GIT STATUS** for changed and untracked files.
4. Read **DIFF STAT** for change size.
5. Read **PATCH** line by line.
6. Confirm tests actually ran. A claim that tests passed without command output is weak evidence.
7. Submit another focused Plan or Execute turn if repair is needed.
8. Commit, push, review, or deploy through a separate deliberate process after human review.

The workbench diff is the current repository state, not a guarantee that every displayed change
came from the latest turn. A project can contain earlier changes.

---

## 10. Continue, switch, archive, and restore sessions

### 10.1 Continue a session

Use **NEXT TURN** for related work on the same project and provider. A turn in `QUEUED`,
`AWAITING APPROVAL`, or `RUNNING` state locks its session and project; only one active CLAUDE turn
can own the project across all sessions.

For Anthropic, the Claude Code CLI can resume its external session. For OpenAI/Aider, the
Puppetmaster session and transcript remain durable, but Aider has **NO CLI SESSION RESUME**.
Repeat essential context and decisions in each OpenAI continuation prompt. Aider can see the
current repository but does not receive an automatic native conversation resume.

### 10.2 Switch provider

Provider cannot be changed after session creation. To compare providers:

1. leave the existing session intact;
2. create a new session for the same project;
3. choose the other provider;
4. start with a read-only Plan;
5. remember that project locking still allows only one active turn at a time.

### 10.3 Archive and restore

- Select **ARCHIVE** to close an inactive session without deleting its history.
- Archived sessions cannot accept another turn.
- Select **RESTORE** to make the session active again.
- Archive/restore is disabled while a turn is active.

Archiving a session does not delete its project workbench or persisted events.

---

## 11. Monitor a running turn

### 11.1 Run statuses

| Status | Meaning | What to do |
| --- | --- | --- |
| `QUEUED` | The turn is waiting for the runner | Wait briefly; inspect the mission if it does not advance |
| `AWAITING APPROVAL` | Execute is waiting for a builder decision | Authorize or deny it in **AUTHORIZATIONS** |
| `RUNNING` | The provider or trusted copy-back is active | Watch Transcript/Raw Events or track the mission |
| `SUCCEEDED` | The turn completed; successful Execute copy-back reached durable state | Review transcript, tests, and diff |
| `FAILED` | Provider, repository preparation, runtime, or copy-back reported a terminal failure | Read **RUN ERROR**, Raw Events, and mission trace before retrying |
| `CANCELLED` | A user cancelled, denied authorization, or cancellation recovery completed | Confirm no work remains active; retry only after reviewing the cause |

### 11.2 Session detail tabs

| Tab | How to use it |
| --- | --- |
| **TRANSCRIPT** | Main human-readable prompt/result view. It also shows token counts, cost when known, duration, and CLI turns. |
| **TOOL CALLS** | Decoded Claude structured tool inputs/results. Empty is normal for OpenAI/Aider plain output. |
| **AGENTS / TASKS** | Decoded Claude subagent or task activity when the CLI emits a recognized event. |
| **RAW EVENTS** | Lowest-level persisted output for diagnosis. It may contain prompts and repository details; handle it as sensitive operational data. |
| **WORKBENCH DIFF** | Read-only Git status, diff stat, and patch for the durable project workbench. |

The UI keeps a bounded recent event window. If older events exist:

- select **LOAD EARLIER** to move backward;
- select **RETURN TO LATEST** to resume the live tail.

Older records remain durable even when they are not all rendered at once.

### 11.3 Cancel a turn

1. Select **TRACK MISSION**.
2. In the mission dossier, select **✕ CANCEL**.
3. Wait for the run to reach `CANCELLED` or another honest terminal state.

Cancellation can return before Docker termination has fully settled. Do not immediately start a
new project turn just because the button returned. Wait for the durable status to update.

### 11.4 Retry a failed or cancelled turn

Retry is valid only for the latest turn in its session and only when no other turn for the project
is `QUEUED`, `AWAITING APPROVAL`, or `RUNNING`. Otherwise, wait for active work to settle and
submit a new turn instead.

1. Read the run error and mission trace.
2. Correct configuration or narrow the prompt first.
3. Select **↻ RETRY** from the mission controls.
4. An Execute retry requires a fresh approval. A previous authorization is not reusable.

Do not repeatedly retry authentication, egress, or image errors without correcting their cause;
that only creates more failed evidence and may still incur provider traffic.

---

## 12. Use the reference tabs correctly

### 12.1 MODELS

This tab is a curated Anthropic model and alias reference. It shows identifiers, context/output
limits, thinking capabilities, latency guidance, and pricing metadata.

It is not an OpenAI model marketplace, and displayed pricing is not a billing guarantee. Verify
current provider pricing and account access before a costly run.

### 12.2 TOOLS

This tab explains the current Claude Code tool vocabulary and whether a tool normally prompts
inside Claude Code. The historical crosswalk is reference material, not runtime authority.

Seeing a tool in the catalog does not prove that the selected provider/backend exposes it in the
current environment.

### 12.3 EXTENSIONS

This tab describes extension surfaces such as `CLAUDE.md`, skills, hooks, MCP, and plugins. The
managed runtime deliberately disables or constrains repository-controlled settings, hooks, and
undeclared MCP behavior at the provider boundary. A catalog entry is not permission to bypass
those controls.

### 12.4 PERMISSIONS

This tab explains Claude Code permission modes inside Puppetmaster's outer container, mission,
and approval boundary. The exposed product flow is read-only Plan or approved Execute.
`bypassPermissions` is prohibited.

### 12.5 SOURCES

Official Anthropic documentation is the current behavior authority. The requested GitHub corpus
is shown only as an unverified provenance manifest; captured prompt text does not execute.

---

## 13. Advanced provider configuration

Skip this section for your first direct Anthropic or OpenAI run.

### 13.1 OpenAI-compatible endpoint

Use `OPENAI_API_BASE` as the primary Aider endpoint setting. `OPENAI_BASE_URL` is also supported
and is mirrored to Aider when `OPENAI_API_BASE` is absent.

```dotenv
WORKBENCH_MODE=docker
OPENAI_API_KEY=replace-with-compatible-provider-key
OPENAI_API_BASE=https://llm.example.com/v1
WORKBENCH_EGRESS_ALLOW=llm.example.com,github.com
CLAUDE_CODE_OPENAI_MODEL=openai/your-model-name
```

Rules:

- `localhost`, `127.0.0.1`, `::1`, and `0.0.0.0` are rejected because they refer to the
  disposable provider container, not the host.
- For a service running on Docker Desktop's host, use an explicitly mapped URL such as
  `http://host.docker.internal:8000/v1` and allowlist `host.docker.internal`.
- A remote endpoint should use HTTPS.
- `CLAUDE_CODE_ALLOW_INSECURE_OPENAI_BASE_URL=1` permits a trusted plaintext remote endpoint.
  Do not use it as a general networking workaround.
- `OPENAI_ORGANIZATION` and `OPENAI_PROJECT` are forwarded only to the selected OpenAI process
  when configured.

OpenAI model input is normalized to `openai/<model>`. A slash-qualified value for another
provider is rejected instead of silently routing elsewhere.

### 13.2 Anthropic through Amazon Bedrock

Enable only one Anthropic cloud transport flag.

```dotenv
WORKBENCH_MODE=docker
CLAUDE_CODE_USE_BEDROCK=1
AWS_BEARER_TOKEN_BEDROCK=replace-with-bearer-token
AWS_REGION=us-east-1
WORKBENCH_EGRESS_ALLOW=bedrock-runtime.us-east-1.amazonaws.com,github.com
```

Instead of the bearer token, Bedrock readiness also accepts an
`AWS_ACCESS_KEY_ID` plus `AWS_SECRET_ACCESS_KEY` pair. `AWS_SESSION_TOKEN` is supported for
temporary credentials.

### 13.3 Anthropic through Foundry

```dotenv
WORKBENCH_MODE=docker
CLAUDE_CODE_USE_FOUNDRY=1
ANTHROPIC_FOUNDRY_API_KEY=replace-with-foundry-key
ANTHROPIC_FOUNDRY_BASE_URL=https://your-foundry-host.example.com
WORKBENCH_EGRESS_ALLOW=your-foundry-host.example.com,github.com
```

### 13.4 Vertex status

`CLAUDE_CODE_USE_VERTEX` is recognized, but this release intentionally reports Vertex as
unavailable because disposable workbenches do not forward and verify Google Application Default
Credentials. Use direct Anthropic, Bedrock, or Foundry.

Setting more than one of Bedrock, Foundry, and Vertex is an invalid configuration.

---

## 14. Verification commands

Run these from the repository root after installation or after changing the runtime.

### 14.1 Deterministic, keyless checks

```powershell
pnpm test
pnpm -r typecheck
```

`pnpm test` builds fresh generated output, then checks architecture, routes, persistence,
provider separation, parsing, cancellation, secret transport, copy-back recovery, tamper guards,
and runner lifecycle. It does not need a real provider key and should not consume provider tokens.

### 14.2 No-cost Docker boundary aggregate

```powershell
pnpm verify:docker
```

This verifies the real workbench, resource/network boundary, names-only secret transport,
cancellation and cleanup, Claude Execute scratch/copy-back behavior, the egress proxy, offline
OpenAI Plan isolation, and dummy-key Anthropic control-plane terminalization. It does not prove a
successful OpenAI Execute copy-back. Mocked OpenAI Execute/copy-back plumbing is covered by
`pnpm test`.

It requires Docker and outbound access for the egress check, but it deliberately does not prove
a successful paid provider response.

Prefer the package aliases after source changes because they rebuild generated `dist` output.
For example, use `pnpm verify:workbench` instead of running
`node scripts/verify-workbench.mjs` against possibly stale output.

### 14.3 Paid OpenAI provider proof

```powershell
pnpm verify:openai-live
```

This command is intentionally opt-in. It loads `.env`, makes a real OpenAI Plan request, consumes
provider tokens, and fails unless the provider returns a successful terminal result. It does not
test approved Execute.

### 14.4 Understand the similarly named Claude verifier

```powershell
node scripts/verify-claude-live.mjs
```

By default, this is a dummy-key control-plane terminalization check. It can prove that a run
queues, enters the Docker runtime, and terminates honestly, but a provider-authentication failure
is not paid-provider success.

A paid Anthropic success check has no package alias. Run it only when token spending is
explicitly intended:

```powershell
$env:CLAUDE_LIVE_PROVIDER = 'anthropic'
$env:CLAUDE_LIVE_REQUIRE_SUCCESS = '1'
node --env-file=.env scripts/verify-claude-live.mjs
```

Remove those temporary shell variables afterward or close that terminal.

---

## 15. Troubleshooting by exact symptom

### `DOCKER RUNTIME OFFLINE` or `requires WORKBENCH_MODE=docker`

Cause: Docker mode was absent when the API server started.

Fix:

1. put `WORKBENCH_MODE=docker` in the root `.env`;
2. confirm Docker Desktop is running;
3. stop and restart the host API server;
4. reload the CLAUDE page.

### `Unable to find image 'puppetmaster-workbench:spike' locally`

Cause: the normal runtime does not build or pull the required local image.

Fix:

```powershell
docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
docker build -t puppetmaster-egress-proxy:spike -f docker/egress-proxy.Dockerfile docker
```

### Docker reports `npipe:////./pipe/docker_engine` missing

Cause: Docker Desktop is stopped or not ready.

Fix: start Docker Desktop, wait for the engine, then run:

```powershell
docker info
```

### `OpenAI provider authentication is not configured`

Cause: `OPENAI_API_KEY` was absent from the server environment at startup.

Fix: add it to root `.env`, restart the API server, and reload the page. Local readiness does
not prove the remote service will accept the key.

### `Claude Code provider authentication is not configured`

Cause: no valid direct or selected cloud-transport Anthropic credential was configured.

Fix: configure `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, or finish exactly one Bedrock or
Foundry configuration. Restart the server.

### Provider API host is not allowed

Cause: the effective endpoint hostname is missing from `WORKBENCH_EGRESS_ALLOW`.

Fix: add only the hostname, for example:

```dotenv
WORKBENCH_EGRESS_ALLOW=api.anthropic.com,api.openai.com,github.com
```

Do not add full URLs. Do not weaken `WORKBENCH_NETWORK` or use a broad allowlist merely to make
the error disappear.

### `Egress proxy image unavailable`

Cause: a non-empty egress allowlist requires the local proxy image.

Fix:

```powershell
docker build -t puppetmaster-egress-proxy:spike -f docker/egress-proxy.Dockerfile docker
```

### Claude or Aider CLI is unavailable in the workbench image

Cause: the image is absent, stale, or was built from a different Dockerfile.

Fix: rebuild the workbench image. A direct Aider version check is:

```powershell
docker run --rm --pull=never --network=none --entrypoint aider puppetmaster-workbench:spike --version
```

### `No projects available`

Cause: there is no active project in the workspace.

Fix: as a Builder, create a project in WORKSHOP with a valid clone URL.

### Project has an empty workbench and no `repoRef`

Cause: the project was created without a repository reference.

Fix: the current UI cannot edit `repoRef`. Create a replacement project with the correct public
clone URL and use that project for a new CLAUDE session.

### `failed to clone project ...`

Check all of the following:

- the URL is a real `git clone` target;
- it does not need interactive private-repository credentials;
- the repository hostname is in `WORKBENCH_EGRESS_ALLOW`;
- the proxy can resolve and reach that host;
- the repository still exists and the URL has no typo.

Do not solve private cloning by embedding a token in `repoRef`.

### Workbench is non-empty but is not a Git repository

The runtime refuses to overwrite ambiguous files. Do not manually force a clone on top of them.
Ask an administrator to preserve and inspect the volume, or create a replacement project from the
trusted repository.

### `another turn is already queued or running`

Cause: the session or project already has active work.

Fix: wait for it, resolve its approval, or cancel it. A second session does not bypass the
project lock.

### Session is archived

Select **RESTORE**, then submit the next turn. Restore is unavailable while active work exists.

### Execute stays at `AWAITING APPROVAL`

Open **AUTHORIZATIONS** and choose **HOLD TO AUTHORIZE** or **DENY**. A Member cannot resolve it;
use a Builder or higher role.

### Execute was denied and now says `CANCELLED`

That is the intended result. The provider did not start. Submit a new turn if requirements change.

### `another turn` appears after cancellation

Cancellation begins exact process termination but can finish asynchronously. Wait for the mission
and run to reach a terminal status, then refresh before submitting another turn.

### OpenAI says `NO CLI SESSION RESUME`

This is a capability disclosure, not a setup error. Continue the durable Puppetmaster session,
but repeat key context in the next prompt or start a new session.

### OpenAI rejects `maxTurns` or `maxBudgetUsd`

Those controls are not supported by the Aider backend. Use the UI as rendered; do not send those
fields through a custom API client. Configure provider-side spending limits.

### `NO TOOL CALLS DECODED`

For OpenAI/Aider, this is usually expected because events are plain output rather than Claude's
structured tool schema. Read Transcript and Raw Events.

For Anthropic, inspect Raw Events to see whether the CLI emitted an unfamiliar or malformed schema.

### `WORKBENCH ... / STALE`

The latest read-only inspection failed, so the page is showing the last successful snapshot.
Check Docker/server logs, fix the workbench issue, and reload. Do not assume a stale diff reflects
the newest file state.

### Provider returns `401`, model-not-found, quota, or billing errors

Local readiness checks only configuration. Confirm the credential, organization/project, selected
model, account permissions, credit, and provider status. Lowering effort does not repair invalid
authentication.

### Queue handoff failed with HTTP `503`

The API persists the session/run/mission and marks the mission failed rather than leaving it
queued forever. Open the returned or selected session, inspect the mission, repair the runner
configuration, then use Retry.

### Port 3000 or 4000 is already in use

Stop the previous web/API process. Do not run two Puppetmaster API servers for CLAUDE against the
same Docker daemon.

### PowerShell rejects `NAME=value command`

That is POSIX shell syntax. In PowerShell, use:

```powershell
$env:NAME = 'value'
your-command
```

Prefer the root `.env` for normal local provider configuration. Avoid `setx` for API keys unless
you intentionally want a persistent plaintext user environment variable.

---

## 16. Safe recovery and shutdown

### 16.1 Normal shutdown

1. Do not start new turns.
2. Let active Execute/copy-back work settle, or cancel it and wait for a terminal state.
3. Press `Ctrl+C` in the web terminal.
4. Press `Ctrl+C` in the API terminal. The server stops intake, aborts active provider attempts,
   and drains runtime work before closing persistence dependencies.
5. If Postgres/Redis were started with Compose, stop them without deleting volumes:

```powershell
docker compose -f docker/docker-compose.yml down
```

Do not add `-v` unless deleting database data is explicitly intended.

### 16.2 Failed or cancelled turn

Read the transcript, **RUN ERROR**, Raw Events, mission trace, and workbench diff. Correct the
cause before retrying. A cancelled or failed Execute that did not cross authenticated copy-back
should not be treated as a durable code change.

### 16.3 Quarantined copy-back

A quarantined ledger means the runtime could not authenticate or safely interpret recovery
evidence. It deliberately blocks new project mutation.

Do not:

- change only the database state to `cleaned`;
- delete scratch or project volumes;
- start a new Execute on the affected project;
- guess whether the file swap committed.

Instead:

1. stop the server;
2. back up the database;
3. preserve the affected `pm-workbench-vol-*` and `pm-exec-*` volumes;
4. inspect the evidence read-only with an experienced operator;
5. create a replacement project from the trusted `repoRef` unless a reviewed full-state restore
   reconciles the run, mission, session, ledger, and Docker volumes together.

See [INSTALL.md](./INSTALL.md) for the operator SQL query and expanded recovery boundary.

### 16.4 Do not manually delete workbench resources as routine troubleshooting

Project, lock, configuration, scratch, and recovery volumes have different trust roles. Deleting
one object can destroy evidence while leaving the database in an incompatible state. Use the
verified executor cleanup paths or an operator-reviewed recovery procedure.

---

## 17. A complete junior workflow checklist

### Setup checklist

- [ ] Docker Desktop is running and `docker info` succeeds.
- [ ] Node 22+, pnpm, and Git are installed.
- [ ] `pnpm install` completed.
- [ ] Both workbench and egress-proxy images were built.
- [ ] Root `.env` contains `WORKBENCH_MODE=docker`.
- [ ] The selected provider credential is configured.
- [ ] The provider API hostname is allowlisted.
- [ ] The repository hostname is allowlisted.
- [ ] PGlite is persistent or PostgreSQL is configured.
- [ ] Only one host API server controls this Docker daemon.
- [ ] The user has Builder or higher role.

### Plan checklist

- [ ] The project has a real cloneable repository URL.
- [ ] Provider status says ready.
- [ ] Plan mode is selected.
- [ ] The prompt says not to edit files.
- [ ] Scope, constraints, and required evidence are explicit.
- [ ] Anthropic turn/budget caps were reviewed.
- [ ] The plan cites real files and existing behavior.
- [ ] Workbench diff shows no unexpected Plan edit.

### Execute checklist

- [ ] The Plan is narrow and reviewed.
- [ ] Execute prompt says what not to change.
- [ ] Required tests are named.
- [ ] Commit/push/deploy are explicitly excluded from the prompt, without treating that request as
  hard enforcement.
- [ ] The authorization prompt matches the project, provider, model, and intended scope.
- [ ] The mission reaches an honest terminal status.
- [ ] Transcript and test output were reviewed.
- [ ] Workbench diff was reviewed line by line.
- [ ] Any commit, push, review, or deployment happens as a separate deliberate step.

### Before reporting “done”

- [ ] A deterministic test or check passed.
- [ ] Typecheck/build status is known when relevant.
- [ ] No unrelated file changed.
- [ ] Remaining risks and skipped checks are written down.
- [ ] Paid-provider and browser acceptance are not claimed unless actually run.

---

## 18. Where to read next

- [Installing Puppetmaster](./INSTALL.md) - full environment and deployment reference
- [Puppetmaster Complete Guide](./GETTING-STARTED.md) - first-run account and all product areas
- [WORKSHOP Manual](./WORKSHOP.md) - specifications, plans, todos, checks, and traceability
- [Claude Code planning record](./CLAUDE-CODE-PLAN.md) - intended scope and architecture decisions
- [Claude Code implementation record](./CLAUDE-CODE-IMPLEMENTATION.md) - implemented stages and
  verified versus pending evidence
- [Architecture](./ARCHITECTURE.md) - system boundaries and deployment model

The current implementation has passed deterministic and no-cost Docker acceptance. A paid live
provider request and full interactive browser UAT are separate evidence and must not be inferred
from those checks.
