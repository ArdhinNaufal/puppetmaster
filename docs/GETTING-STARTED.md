# Getting Started with Puppetmaster (No Experience Required)

This guide walks you through installing Puppetmaster on your own computer and taking it for
a real test drive — building an automated approval workflow and chatting with an AI agent
that remembers things — even if you've never opened a terminal before.

Budget about **20–30 minutes**. No coding knowledge needed; you'll mostly be copying and
pasting a handful of commands.

> **What is Puppetmaster, in one paragraph?**
> It's a private control room for small teams that runs on your own computer or server
> instead of someone else's cloud. Inside it you build two kinds of helpers: **agents**
> (AI "employees" you can chat with, that remember things and use tools) and **workflows**
> (automatic checklists/flowcharts, like "when X happens, do A, then B, then C"). Agents and
> workflows can trigger each other, and anything risky — sending money, emailing a customer,
> deleting something — pauses and waits for a human to click **approve**, like a manager
> signing off.

---

## Before you start

You need two free programs. Both work the same way on Windows, Mac, and Linux.

| Tool | What it's for | Get it |
|---|---|---|
| **Node.js** (version 22 or newer) | The engine that runs the app | [nodejs.org](https://nodejs.org) — download the installer for your operating system and run it, clicking "Next" through the defaults |
| **A terminal** | A text window where you type commands | **Windows:** search the Start Menu for "Terminal" or "PowerShell". **Mac:** open *Applications → Utilities → Terminal*. |

You do **not** need to install a database, Docker, or anything else to try Puppetmaster —
the quick-start path below runs entirely on your own machine with a built-in, temporary
database. (There's an optional step near the end for making your data permanent.)

To check Node.js installed correctly, open your terminal and type:

```bash
node -v
```

You should see something like `v22.x.x` or higher. If you see "command not found", close
and reopen your terminal (or restart your computer) and try again.

---

## Step 1 — Download Puppetmaster

If you were given a link to this repository on GitHub, the easiest way is:

1. On the GitHub page, click the green **Code** button, then **Download ZIP**.
2. Unzip it somewhere easy to find, like your Desktop or Documents folder.
3. In your terminal, move into that folder. For example, if you unzipped it to your
   Desktop, type:

   ```bash
   cd Desktop/puppetmaster-main
   ```

   (If you have `git` installed, `git clone <repository-url> puppetmaster && cd puppetmaster`
   works too.)

---

## Step 2 — Install the app's building blocks

Copy and paste these two commands, one at a time, pressing Enter after each:

```bash
corepack enable
pnpm install
```

The first command turns on `pnpm`, the tool Puppetmaster uses to manage its pieces (it
ships with Node.js, so nothing extra to download). The second downloads and assembles
everything the app needs — expect it to take a minute or two and print a lot of text. That's
normal. When it's done you'll see your prompt again with no red "error" text.

---

## Step 3 — Start the app

Puppetmaster has two halves: a **server** (the brain) and a **web app** (what you see in
your browser). Each runs in its own terminal window, and both need to stay open while
you're using the app.

**Terminal window 1** — start the server:

```bash
pnpm --filter @puppetmaster/server dev
```

Wait until you see a line like:

```
Server listening at http://127.0.0.1:4000
```

That means it's ready. Leave this window open.

**Terminal window 2** — open a *new* terminal window/tab and start the web app:

```bash
pnpm --filter @puppetmaster/web dev
```

Wait for:

```
➜  Local:   http://localhost:3000/
```

Leave this window open too.

> This "quick trial" mode keeps everything in memory — perfect for learning and testing
> today. If you close the server, your data resets. Step 9 below shows how to make it
> permanent once you're ready to rely on it day to day.

---

## Step 4 — Open it in your browser

Go to **http://localhost:3000** in your browser (Chrome, Firefox, Safari, or Edge all work).
You'll see the first-run screen:

![First run screen asking to create the owner account](img/getting-started/01-first-run.png)

Since no one has signed up yet, this account becomes the workspace **owner** — the one
account with full control. Fill in:

- **Name** — your name
- **Email** — any email address (it doesn't need to be a real inbox for this local test)
- **Password** — 8 or more characters

Click **INITIALIZE WORKSPACE**. You're in.

---

## Step 5 — A quick tour

You'll land on the main dashboard, called **NEXUS**:

![The empty NEXUS dashboard right after signing up](img/getting-started/02-nexus-dashboard.png)

A few orientation notes:

- The bar across the top (**NEXUS, COMMAND, CANVAS, WORKSHOP, TEMPLATES, KNOWLEDGE,
  MISSIONS, AGENTS, TOOLS, EVALS, ADMIN**) are the app's main screens. Click any of them,
  or press the number shown next to its name (1–9, plus two more) to jump straight there.
- Pressing **Ctrl+K** (Mac: **Cmd+K**) opens a search-style command bar that can do almost
  anything without touching the mouse.
- It looks empty right now because your workspace is brand new — nothing built yet. Let's
  fix that.

---

## Step 6 — Real-world test #1: an automated approval

Every small business has a rule like *"anything over $500 needs a manager's sign-off before
it goes out."* Puppetmaster calls that an **approval gate**, and there's a ready-made example
workflow built in so you can see one work end to end without building anything yourself.

1. Click **CANVAS** in the top bar.
2. In the **WORKFLOWS** panel on the left, click **SAMPLE**. A small flowchart appears:
   a trigger, a step that doubles a number, a check ("is it bigger than 5?"), and — if it's
   big — an **approval** step before anything happens.

   ![The sample workflow loaded on the canvas](img/getting-started/03-canvas-sample.png)

3. Click **▶ RUN** at the top of the canvas.
4. Watch the flowchart run left to right in real time. Because the test number is big, it
   stops and waits at the approval step — exactly like it would if this were a real order
   needing a manager's okay:

   ![The workflow paused, waiting for approval](img/getting-started/04-run-paused-approval.png)

5. Look at the **AUTHORIZATIONS** panel in the top-left corner. There's a pending request:
   "Approve big value?" Press and **hold** the **HOLD TO AUTHORIZE** button for about a
   second (it's a deliberate press-and-hold, not a single click — the same safety idea as a
   guarded switch, so nothing gets approved by accident). Or click **DENY** to reject it.

   ![Pressing and holding the authorize button](img/getting-started/05-hold-to-authorize.png)

6. Once approved, the flowchart finishes and every step turns green. Click **MISSIONS** in
   the top bar to see the run recorded in your history, with a 100% success rate and how
   long it took:

   ![The Missions view showing the completed, successful run](img/getting-started/06-missions-succeeded.png)

That log is your audit trail — every run, every approval, forever, exactly like a manager's
sign-off sheet, except it's automatic and can never be lost or edited after the fact.

---

## Step 7 — Real-world test #2: give your business an AI assistant with memory

Now let's create an actual AI "employee" that can chat, answer questions, and remember
things you tell it — without needing any paid AI subscription, using the free built-in
test model.

1. Click **COMMAND** in the top bar.
2. In the **AGENTS** panel on the left, click **＋**.
3. Three small pop-ups appear, one after another:
   - **Agent name** — type something like `Bakery Assistant` (or whatever fits your
     business)
   - **Model** — type `mock`. This is a free, offline stand-in that needs no account or API
     key, perfect for trying things out. (Later, if you want real AI responses, you can put
     in `claude-*`, `openai/*`, or a local model instead — see `docs/INSTALL.md` for how to
     connect one.)
   - **Persona** — describe its job in plain English, e.g. *"You are a friendly assistant
     for a small neighborhood bakery. Answer questions about orders, hours, and recipes."*
4. A chat channel opens:

   ![An open chat channel with a newly created agent](img/getting-started/07-agent-chat-channel.png)

5. Type a message, e.g. *"Hi! What can you help me with?"*, and press **TRANSMIT** (or
   Enter). The agent replies right in the channel.
6. Now test its memory. Type something like:

   ```
   remember: Maria always orders a dozen sourdough rolls every Friday for pickup at 8am
   ```

   You'll see the agent actually use a memory tool to save that fact, and confirm it's
   stored:

   ![The agent saving a fact to its long-term memory](img/getting-started/08-agent-memory-save.png)

   From now on, that agent can recall this whenever it's relevant — the same way a human
   employee remembers a regular customer's usual order. (Under the hood this is a proper
   searchable memory, not just a chat log — ask it about Maria again later, in a new
   conversation, and it'll still know.)

That's the core of Puppetmaster in action: a flowchart that paused for a human decision, and
an AI assistant that remembers real details about your business — both running entirely on
your own machine.

---

## Step 8 (optional) — Explore a fully-populated example company

If you'd rather browse a realistic, already-built-out workspace instead of starting from
scratch, Puppetmaster ships a demo dataset modeled on a fictional company ("Acme
Operations") with 12 AI agents, 12 workflows, a knowledge base, and a mix of finished,
pending, and in-flight tasks — a good way to see what a mature setup looks like.

Stop your Step 3 server (click into that terminal and press **Ctrl+C**), then run:

```bash
pnpm build
PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server seed:demo
PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server start
```

The first command assembles the app; the second fills a saved-to-disk database with sample
data (this only needs to be run once); the third starts the server against that same data,
this time keeping it between restarts. Your web app terminal from Step 3 can keep running as-is.

Sign in at http://localhost:3000 with:

- **Owner:** `avery.owner@acme.io`
- **Admin:** `dana.admin@acme.io`
- **Builder:** `blair.builder@acme.io`
- **Member:** `morgan.member@acme.io`
- **Password (all accounts):** `demodemo123`

Each role sees a different slice of the app — try signing in as a couple of them to see how
permissions change what's visible and clickable.

---

## Step 9 (optional) — Make your data permanent

Everything above uses a temporary, in-memory database that resets whenever you stop the
server — great for learning, not for relying on day to day. To keep your data across
restarts, you run two small support programs (a database and a message queue) using
**Docker**, a free tool that runs them in a self-contained box without you needing to
install or configure them by hand.

1. Install **Docker Desktop**: [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)
   (download, install, then open it once so it's running in the background).
2. In a terminal, from the puppetmaster folder, run:

   ```bash
   docker compose -f docker/docker-compose.yml up postgres redis
   ```

   Leave this running in its own terminal window.
3. Stop your Step 3 server (**Ctrl+C**) and restart it, this time pointing at the
   permanent database:

   ```bash
   DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster \
   REDIS_URL=redis://127.0.0.1:6379 \
   pnpm --filter @puppetmaster/server dev
   ```

Now everything you build survives restarts. Full details, including all the optional
settings (connecting a real AI provider, email, etc.), are in `docs/INSTALL.md`.

---

## Shutting everything down

When you're done for the day: click into each terminal window and press **Ctrl+C**. If you
started Docker in Step 9, also run `docker compose -f docker/docker-compose.yml down` (this
keeps your saved data; add `-v` at the end only if you want to wipe it too).

---

## Troubleshooting

**"command not found: pnpm" or "command not found: node"**
Node.js didn't install correctly, or your terminal was open before you installed it. Close
the terminal completely, reopen it, and try `node -v` again. If it's still missing,
reinstall Node.js from nodejs.org and restart your computer.

**A command says a port is already in use (3000 or 4000)**
Something else on your computer is already using that address — often a previous copy of
Puppetmaster that didn't fully close. Close any other terminal windows running the app, or
restart your computer, then try again.

**The browser page is blank or won't load**
Check both terminal windows from Step 3 — they need to stay open and show no red error
text. If one shows an error, copy it and search `docs/` or ask for help with the exact
message.

**I forgot my password**
This version doesn't yet have a "forgot password" flow. Sign in as another admin/owner
account if you have one and create a new account for yourself, or stop the server, delete
the temporary data (just restart the quick-trial server — it resets automatically), and
sign up again as the owner.

**Docker Desktop won't start (Step 9 only)**
On Windows, Docker needs "virtualization" turned on, which is sometimes off by default —
Docker's own installer will tell you if this is the issue and link to instructions. Restart
your computer after installing Docker Desktop for the first time.

---

## A quick glossary

| Term | Plain-English meaning |
|---|---|
| **Agent** | An AI "employee": a persona you chat with that can remember things and use tools |
| **Workflow** | An automatic flowchart: trigger → steps → done |
| **Mission** | One run of a workflow or one agent conversation turn — the record of "what happened" |
| **Approval / Authorization** | A pause point where a human must say yes before something risky proceeds |
| **Workspace** | Your team's private space — agents, workflows, and data all belong to one workspace |
| **Owner / Admin / Builder / Member** | Roles with increasing levels of access; the first person to sign up becomes Owner |
| **Terminal** | A text window for typing commands to your computer, instead of clicking icons |
| **localhost** | A way of saying "this computer" — `localhost:3000` means "port 3000 on my own machine" |

---

Once you're comfortable, `docs/INSTALL.md` covers the full technical reference (every
environment variable, connecting real AI providers, and production deployment notes) and
`docs/PRD.md` explains the product vision in more depth.
