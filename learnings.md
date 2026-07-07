# Learnings — discovered the hard way (append-only)

Convention (docs/AI-SDLC-INTEGRATION-PLAN.md, WP0): append entries as they are earned;
never rewrite history. Each entry states the gotcha and what to do instead. If an entry
graduates into an enforced rule, note the verifier that now covers it.

## 2026-07-06 — Tool-prefix collisions with core entity names

The Workshop plan v1.0 named workbench tools `ws.*`, which reads as "workspace" — a core
Puppetmaster entity. Renamed to `bench.*` before any code existed. Lesson: before naming a
tool namespace, check it against the PRD §4 glossary (agent, workflow, tool, mission,
approval, workspace). Same reasoning rejected "pipeline" (collides with workflow).

## 2026-07-06 — Number ADRs by creation order; never renumber

The integration plan reserved ADR-001..005 for Workshop decisions before ADR-000 and the
retroactive ADRs existed, so the retros became ADR-006/007 despite documenting older
decisions. Lesson: ADR numbers are creation-ordered identifiers, not a chronology of the
decisions themselves — mark retroactive ADRs as such and never renumber to "fix" ordering
(links break silently).

## 2026-07-06 — The SDLC corpus references two absent companions

`ai-sdlc-workflow-guide.md` cites `ai-sdlc-worked-examples.md` and `ai-sdlc-pipelines.md`;
neither exists in `docs/software-engineering-development-ai-workflow/`. Do not cite them
as sources. Only the B-track (unified) pipeline is present.

## 2026-07-06 — pnpm add -w does not link workspace packages

`pnpm add -D -w <pkg>` installed only the root importer; `packages/*/node_modules` stayed
missing, which breaks anything resolving `@puppetmaster/*` (dependency-cruiser included).
Run a full `pnpm install` after fresh clones before running tooling that resolves
workspace imports. Also: `@puppetmaster/*` resolve to `dist/` (`main: dist/index.js`), so
`pnpm build` must precede cross-package resolution checks on a fresh clone.

## 2026-07-06 — Workflow node input = upstream OUTPUT, not the mission payload

A non-trigger node's `{{input.*}}` templates resolve against the immediately upstream
node's output — only entry nodes see the mission payload. A chain `trigger → A → B`
gives B the output of A, so B's args can't reference payload fields. Idiom: add a direct
`trigger → B` edge declared BEFORE the `A → B` edge — input resolution takes the first
satisfied edge's upstream output (the payload), while the second edge still enforces
ordering. Verifier: pinned by the `workshop-artifact-lifecycle` golden task.

## 2026-07-06 — Undefined CSS custom properties fail silently

`var(--line)` compiled and rendered without any error — the design system's border token
is `--stroke` (see fui.css `:root`). Neither tsc nor Vite validates CSS variable names.
Check new rules against the tokens actually defined in fui.css; an invalid var() just
computes to nothing at runtime.

## 2026-07-06 — Eval predicates go through repo functions, not raw tables

Importing `drizzle-orm` in apps/server (for eval DB-state predicates) fails: the server
doesn't depend on drizzle directly and must not — table access belongs to
@puppetmaster/db. The fix that keeps the dependency direction honest: add the tiny query
helper (`listChildMissions`) to the db package and call it from the eval.

## 2026-07-06 — Escaping stacks up when generating code through heredocs

A spec fixture written via a Python heredoc used `\\n`, which lands in the TypeScript
source as `\n`-the-two-characters, not a newline — the markdown headings never started a
line and the spec-sections gate correctly refused a "complete" spec. The gate caught the
fixture bug, which is the system working; the lesson is about tooling: when a generator
script writes string literals into source code, count escaping levels per layer
(shell → python → TS), and prefer real newlines in the generator over escape sequences.

## 2026-07-06 — This session has a Docker client but no daemon

`docker` is on PATH but `/var/run/docker.sock` is absent, so `docker info`/`build`/`run`
all fail here. Container-dependent work (the ADR-002 container-half spike, WP3's workbench)
can be *authored* in this session but must be *run* on a Docker-capable host. The spike
script distinguishes the two: exit 3/SKIP when no daemon, real assertions otherwise —
so the same script does genuine work wherever a daemon exists. Don't confuse "the script
printed its no-op branch" with "the mechanism was validated".

## 2026-07-06 — Spike file-delivery must match the system it validates

The ADR-002 container spike failed assertion 3 (a check running inside the workbench) — but
only because the harness delivered files via a host `:ro` bind mount read by the non-root
container user, whose "other"-read permission fails under Docker Desktop's VirtioFS. That
is NOT how the system works: ADR-005 delivers code via a named volume / in-container clone
owned by the workbench user, never a host mount. The three real isolation assertions
(non-root, --network none egress block, resource caps) all passed. Lesson: a feasibility
spike must exercise the *actual* mechanism (files created/owned inside the container), not a
convenient stand-in — a bind-mount shortcut tests a code path the design explicitly avoids
and manufactures a false negative. Fix: create the toy files inside the container as the
workbench user.

## 2026-07-07 — Don't use example.com as a reachability probe; DNS may sinkhole it

The WP3b.5 egress acceptance used `example.com` as the allowlisted host and failed on a real
Docker host with proxy 502 / curl 56 — but the proxy was fine. A diagnostic (TCP to 1.1.1.1
by IP = ok; `dns.lookup example.com` = `ok 5.6.7.8`) showed the host's network **sinkholes
example.com to a placeholder IP (5.6.7.8)**, so the proxy allowlisted it, resolved it to
garbage, and `connect()` failed. Lesson: a reachability probe host must be one the target
network resolves *truthfully* — example.com/example.org are commonly filtered or placeholder'd.
Use `one.one.one.one` (→ 1.1.1.1, cert matches) and make it env-overridable. Separately: the
deny-path test needs no working DNS (the proxy 403s the CONNECT by hostname before resolving),
which is why it passed throughout. Also, on Git Bash for Windows, `docker exec … cat
/etc/resolv.conf` gets its path mangled to `C:/Program Files/Git/etc/resolv.conf` — prefix
with `MSYS_NO_PATHCONV=1` (a diagnostic artifact, not a real error).

## 2026-07-07 — Default-closed egress needs a network wall, not just HTTP_PROXY env

WP3b.5's egress proxy is enforced at TWO layers, and the network layer is the one that
actually secures it. The workbench joins a Docker `--internal` network (no gateway to the
internet), shared with an allowlisting proxy sidecar; the proxy is ALSO attached to `bridge`
for its own outbound. So the workbench's only route out is the proxy — a process that ignores
`HTTP(S)_PROXY` simply can't reach anything (default-closed by construction), while
proxy-aware tools (git, curl, npm) reach exactly the allowlist. Relying on HTTP_PROXY env
alone would be porous (any direct-socket call escapes). Also: the proxy resolves the target
host, not the workbench — with `HTTPS_PROXY` set, curl/git send `CONNECT host:443` to the
proxy and never resolve the host themselves, so the internal network needs no external DNS,
only Docker's embedded DNS to resolve the proxy's container name. Verifier:
`scripts/verify-egress.mjs` (Docker host). The proxy's own allow/deny/tunnel logic is
pure Node and unit-testable without Docker (spawn it, CONNECT to a local origin allowlisted
vs a denied host — deny=403, allow=real byte tunnel).

## 2026-07-07 — Screenshotting UI here: use the Chromium binary directly, not `playwright`

The `playwright`/`playwright-core` npm package is NOT in this repo's `node_modules`, so
`import { chromium } from "playwright-core"` fails (`ERR_MODULE_NOT_FOUND`). But Chromium IS
pre-installed at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Drive it directly:
`chrome --headless --disable-gpu --no-sandbox --force-device-scale-factor=2
--window-size=W,H --hide-scrollbars --screenshot=out.png file://<abs>.html` (the dbus
"Failed to connect to the bus" errors are harmless). Also: the server does NOT serve
`apps/web/dist` statically and `/api` is session-gated, so a *live* app screenshot needs a
Vite preview + `/api/auth/setup` bootstrap + proxy — heavy. For presentational UI, a static
render of the real markup + `fui.css` tokens over the real data shape is faster honest
evidence (label it as a static render, not a live capture). The FUI token values live in the
built CSS, not a grep-able `:root` in src: `--ok:#4cd18e --warn:#e2ac3f --accent:#45d6e6
--stroke:#1c2c34 --text-lo:#7d95a0 --text-hi:#d9e6ea --panel:#081014`.

## 2026-07-07 — Tool autonomy tiers are enforced in the agent runtime, not workflow nodes

Workflow `action` nodes call `tools.callTool(...)` directly regardless of the tool's tier
(`executor.ts`) — a workflow gates only via explicit `approval` nodes the graph author
inserts. The per-call tier gate (read auto-runs; write/destructive pause behind an approval)
lives in the **agent runtime** (`agent-runtime.ts`). Consequence for testing a tool's tier:
a golden *workflow* task proves the tool *executes* but says nothing about its tier; to prove
"write/destructive pauses" you need a golden *agent* task (mock message `use <server.tool>
{args}` → mission ends `awaiting_approval`, the pending approval's `tier`/`prompt` assert the
gate). WP3b.3's bench tests use both: workflow tasks for execution (read/write/exec/git),
agent tasks for the write/push tier gates.

## 2026-07-07 — The mock provider's `use` scripting dropped multi-segment tool names

`MockProvider` parsed `use <server.tool> {args}` with `name.split(".")` and destructured the
first two segments — so a dotted tool like `bench.git.push` or `project.artifact.write` lost
everything after the second segment (emitted `bench__git`, not `bench__git.push`). Any eval
that scripts an agent to call a sub-namespaced tool would silently call the wrong (or a
non-existent) tool. Fixed to split on the *first* dot only (`server = before`, `tool = after`);
single-dot calls are unchanged. Lesson: tool names are `server` + a possibly-dotted `tool`
path (the registry key is `${server}.${tool}`, the wire name `${server}__${tool}`); split on
the first separator, never greedily.

## 2026-07-07 — A fresh named volume inherits the image mount-point's ownership

WP3b.1's host acceptance failed only its file-writing assertion (`before=0, after=0` on the
fail-before/pass-after check) while every read-only assertion passed. Root cause: the ADR-005
per-project **named volume** mounts at `/workbench`, and Docker seeds a fresh empty named
volume with the *ownership and permissions of the image's directory at that path*. `WORKDIR
/workbench` creates that directory **root-owned**, but the container runs as non-root `bench`
(uid 10001) — so `bench` could not write to `/workbench`, the fixture's `printf > add.mjs`
failed silently (the setup step's exit code wasn't checked), `node --test` found no tests and
exited 0 both times. Fix: `RUN mkdir -p /workbench && chown bench:bench /workbench` before
`USER bench` so the fresh volume inherits bench ownership. Lesson: this is the *same*
permission class learnings already flagged for bind-mounts (2026-07-06), but it also bites the
named volume the design deliberately chose — a non-root container that writes to a mounted
volume must own the mount-point in the image, not just the WORKDIR. Also: a setup/`arrange`
step whose exit code is ignored can turn a real failure into a confusing null result — when a
"pass-after" check yields the pass value on *both* sides, suspect the arrange step never ran.
Verifier: `scripts/verify-workbench.mjs` (its in-container check assertion now covers this).

## 2026-07-07 — The verify-workbench ritual must build the image first

The WP3b resume instructions said `pnpm --filter … build && node scripts/verify-workbench.mjs`
but omitted `docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .`.
`DockerCommandExecutor` defaults to the **local** image tag `puppetmaster-workbench:spike`
(`workbench.ts` DEFAULTS.image), so with no local build `docker run` tries to *pull* it and
dies with `pull access denied … repository does not exist or may require 'docker login'` — a
confusing error that reads like an auth/registry problem, not a missing local build. Lesson:
when a script depends on a locally-built image, the build step is part of the ritual, not a
prerequisite the reader is assumed to know. The RESUME POINT now lists both commands in order.

## 2026-07-06 — WP3b resume point (Docker-host verification pending)

DockerCommandExecutor (packages/kernel/src/workbench.ts) is authored, typechecks, and
builds here, but its acceptance can only run on a Docker host — this session has no daemon.
To verify: on a Docker-capable host, `pnpm build && node scripts/verify-workbench.mjs`
(exit 0 = ensure/idempotent/non-root/exit-codes/in-container-check/destroy all hold; exit
3 = no daemon). Only after that PASS should WP3b.2 (server wiring behind WORKBENCH_MODE)
and WP3b.3 (bench.* tools) proceed. Same discipline as the ADR-002 spike: author here,
verify on the host, record the PASS before building on top.
