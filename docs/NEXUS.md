# NEXUS — the single-page operations theater

**Version:** 0.1 · **Status:** living spec + build log — designed to be stopped and resumed
at any phase boundary. Update the checkboxes in §10 as work lands; every phase states its
acceptance criteria so a cold reader (human or agent) can pick the work up mid-flight.

Extends `docs/DESIGN-LANGUAGE.md` v0.2 (SPECTRE FUI grammar). Read that first.

---

## 1. Intent (the product owner's brief, decomposed)

One dedicated page — the **NEXUS** — that is a *centralized, comprehensive system
operation surface*:

1. **Every task the system offers is providable and handleable from this one page.**
   "Task" = any operator action the platform supports: talk to an agent, run a workflow,
   grant/deny an authorization, inspect a mission dossier, search/ingest knowledge, browse
   the tool catalog, instantiate a template, run the eval suite, manage budgets/routing,
   administer members/branding, read the audit trail, watch the live signal feed.
2. **Tasks open in-page**, as *translucent, vague-background containers* ("panes") that
   can be **moved freely**, **stacked/overlapped** with one another (click brings to
   front), and each carries a **jump-to-the-task's-full-page** control that navigates to
   the dedicated view (Command / Canvas / Missions / …) with context preserved.
3. **The centerpiece and primary point of operation** is an **ultra-complex, intricate
   geometric figure** at the center of the page — the system's *avatar* — animated, and
   **responsive to the user's cursor**. It *is* the system rendered as instrumentation:
   its data, knowledge, workflows, agents, schema, live activity — combined into one
   readable organism. Interacting with the figure is the primary way to open tasks.
4. **The interaction model is ours to define** (§5) — it must follow the design language:
   real data only, motion = state change, ceremony for consequence, idle is calm,
   reduced-motion and keyboard access are hard requirements.

## 2. Concept — "the Construct"

Puppetmaster's avatar is **the Construct**: an armillary instrument — nested orbital
rings around a polygonal kernel — with **puppet threads**. The name-level metaphor is
literal: when the system works, *threads* run from the kernel core out to the acting
agent or workflow node, taut and flowing; the Puppetmaster is visibly *pulling strings*.
When the system is idle, the threads go slack and the instrument breathes slowly.

Why an armillary (and not a face, blob, or particle cloud):

- It is **an instrument, not a mascot** — consistent with "command center, not dashboard".
  Every ring is a readout; nothing is decorative (DESIGN-LANGUAGE principle 1).
- It is **infinitely extensible**: new subsystems = new strata, without redesign.
- It **degrades honestly**: with reduced motion it is a stately technical diagram, still
  fully interactive; nothing about it *requires* animation to be read.

### 2.1 Anatomy — every stratum maps to real data

Radii are relative to `R` (= min(stage w,h)/2 − margin). All counts/ids come from the
existing REST + WebSocket APIs (`apps/web/src/api.ts`); nothing is invented.

| Stratum | Radius | Geometry | Data source | Live behavior |
|---|---|---|---|---|
| **Kernel core** | 0 – 0.14R | 3 nested rotating polygons (triangle/hexagon/nonagon), vertex dots, inner "iris" | bus `connected`; every `BusEvent` | Iris vector tracks cursor (the Construct "watches" the operator). Each bus event = one flash-settle pulse ripple. Disconnected → iris hollow, polygons stop. |
| **Schema graticule** | 0.14 – 1.0R | Faint concentric arcs + radial degree ticks + coordinate microtype | static geometry, labels are real counts | The "paper" of the instrument. Parallax-tilts with cursor. |
| **Agent orbit** | 0.42R | One node per agent: ring glyph ◉ + autonomy tick (1/2/3 ticks = read/write/destructive), short name label on focus | `agentApi.list()` | Node angle = stable hash(agent.id). Agent active in last 20s (bus `agent.message`/mission events with its id) → node glows + orbit dot spins. Click → **AGENT CHANNEL** task. |
| **Workflow lattice** | 0.60R | One node per workflow: square rotated 45°, inner n-gon with n = node count of its graph, `v{n}` tag on focus | `api.listWorkflows()` (+ graph node counts lazily) | Click → **RUN WORKFLOW** task pre-selected. Running workflow mission → thread + node pulse. |
| **Knowledge shell** | 0.74R | Particle band: dots = chunks (capped 240), clustered per document; document majors as brighter motes | `kbApi.list()` (chunkCount per doc) | Click → **KNOWLEDGE SEARCH** task. Density is the readout: an empty shell is visibly sparse. |
| **Tool spokes** | 0.86R | One spoke per MCP server/namespace, tick marks along the spoke = tools in it, spoke label = server name | `api.tools()` grouped by server | Click spoke → **TOOL CATALOG** task filtered to that server. Offline workspace server → dashed spoke. |
| **Mission threads** | core → node | Quadratic bézier "strings" from kernel to the acting agent/workflow node; animated dash flow while running; **amber, taut (straight), vibrating** when `awaiting_approval` | `api.listMissions()` recent + bus `mission.*`, `approval.*` | The signature motion. Thread click → **MISSION DOSSIER** task for that mission. Approval-gated thread click → **AUTHORIZATIONS** task. |
| **Memory halo** | 1.0R rim | Rim ticks: pending authorizations (amber), failed missions last 24h (red), RX counter microtype | approvals list, missions list, signal RX | The rim is the instrument's warning bezel. |
| **Count readouts** | corners of stage | Micro stat lines: `AGENTS n · WORKFLOWS n · DOCS n/CHUNKS n · TOOLS n · MISSIONS 24H n` | same fetches | Tertiary type stratum, per density rules. |

**Complexity budget:** the figure is *intricate by strata*, not by noise — each layer is
individually legible; combined they read as one organism. Hard cap ~600 drawn primitives
per frame (see §8 performance).

### 2.2 States

| State | Trigger | Presentation |
|---|---|---|
| **DORMANT** | bus disconnected | Greyed strata, no motion, iris hollow, "LINK DOWN" microtype. |
| **PATIENT** (idle) | connected, no running mission, no cursor in stage | Slow breathing: ring drift ≤ 0.02 rad/s, kernel rotation ≤ 0.05 rad/s. Nearly still. |
| **ATTENTIVE** | cursor inside stage | Figure tilts toward cursor (§5.1), iris tracks, nearest-node reticle engages. |
| **WORKING** | ≥1 running mission | Threads drawn + flowing; the acting nodes pulse; kernel rotation quickens with running count (cap 3×). |
| **GATED** | ≥1 pending authorization | Amber taut thread(s) + rim ticks; kernel iris blinks amber every 3s. Takes visual priority over WORKING. |
| **ALARM** | a mission failed in last 60s | One red ripple from kernel to rim (once per failure event, not looping). |

## 3. Page layout

```
┌────────────────────────────────────────────────────────────────────┐
│ stage-head: 01 // NEXUS                     ⌘K COMMAND · 1–9 VIEWS │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│   [floating pane]                              [floating pane]     │
│                                                                    │
│                        THE CONSTRUCT                               │
│                     (full-stage canvas)                            │
│                                                                    │
│              [floating pane, overlapping another]                  │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ task tray: ◉ CHANNEL ▤ RUN ⚑ AUTH ≡ DOSSIER ⌕ KB … (registry)      │
└────────────────────────────────────────────────────────────────────┘
```

- The **Construct canvas fills the stage**; panes float *above* it (the translucency is
  what keeps the figure present under the work).
- The **task tray** (bottom strip of the stage) lists every registry task as a chip —
  the guaranteed path to any task even if its stratum is empty (e.g. no agents yet).
  Chips show role-locked state for insufficient roles.
- NEXUS is **view 01 for every role**; the shell (rail, ⌘K palette, signal ticker,
  operation dossier aside) stays. Palette gains `TASK //` entries for every registry task.

## 4. Task pane system

### 4.1 Pane anatomy

```
╭──────────────────────────────────────╮  ← 1px stroke, corner brackets
│ ⣿ ◉ AGENT CHANNEL          ⇱  −  ✕  │  ← title rail = drag handle
│                                      │     ⇱ jump-to-full-page
│   (task body, compact module)        │     − minimize to tray chip badge
│                                      │     ✕ close
╰──────────────────────────────────────╯
```

- **Vague transparent background**: `background: color-mix(in srgb, var(--panel) 72%,
  transparent)` + `backdrop-filter: blur(6px)` + 1px stroke + brackets. The Construct
  stays visible through every pane.
- **Move**: pointer-drag on the title rail (pointer capture; `touch-action: none`);
  position clamped to the stage; no grid snap (free stacking is the point).
- **Stack**: panes may overlap arbitrarily. `pointerdown` anywhere on a pane raises it
  (z = monotonic counter). Focused pane gets accent brackets.
- **Jump** (⇱): navigates the shell to the task's dedicated view and carries context
  (e.g. selected agent → Command view; mission → tracked dossier; workflow → Canvas).
  The pane closes on jump (the full page supersedes it).
- **Spawn placement**: cascade from stage center-right (+24px x/y per open pane), so new
  panes never bury the kernel.
- **Keyboard**: panes are focusable; arrow keys nudge (±16px, ±1px with Shift) when the
  rail has focus; Escape closes the focused pane. Every control is tabbable.

### 4.2 Task registry (the "all tasks" contract)

One module — `apps/web/src/nexus/registry.tsx` — is the single source of truth mapping
**every operator task** to: `id`, `glyph`, `title`, `category`, `minRole`, `jumpView`,
and a `body` renderer (compact module) *or* `jumpOnly: true` (v0: opens the full page
directly). Adding a system capability ⇒ add a registry row; the tray, palette, and
Construct hit-targets all derive from it.

| id | glyph | task | body v0 | jump target | minRole |
|---|---|---|---|---|---|
| `agent.channel` | ◉ | Agent channel (chat) | picker + full `Command` module | command | member |
| `workflow.run` | ▶ | Run workflow | picker + JSON input + launch + live status | canvas (builder) / missions | member |
| `authorizations` | ⚑ | Authorizations | pending list + HoldButton ceremony | missions | member (decide: builder) |
| `mission.dossier` | ≡ | Mission dossier | recent picker + `TraceDossier` | missions | member |
| `knowledge.search` | ⌕ | Knowledge search | query + hits (citations, scores) | knowledge | member |
| `knowledge.ingest` | ⇪ | Ingest document | title + paste/file + ingest | knowledge | builder |
| `tools.catalog` | ⚙ | Tool catalog | grouped list w/ tier badges (server filter) | tools | member |
| `template.use` | ▤ | Templates | list + USE THIS | templates | member (use: builder) |
| `signal.feed` | ⊚ | Signal feed | radar + recent entries list | (none — live) | member |
| `evals.run` | ✓ | Eval suite | run + last result summary | evals | admin |
| `budgets` | ¤ | Budgets & usage | jumpOnly v0 | evals | admin |
| `router` | ⇌ | Router profiles/health | jumpOnly v0 | evals | admin |
| `mcp.add` | ＋ | Add MCP server | jumpOnly v0 | tools | admin |
| `members` | ⚇ | Members & roles | jumpOnly v0 | admin | admin |
| `branding` | ◧ | Workspace branding | jumpOnly v0 | admin | admin |
| `audit` | ☰ | Audit log | jumpOnly v0 | admin | admin |

*jumpOnly v0* rows are still on the page (tray + palette + rim affordances) — they open
their full view; converting them to in-pane bodies is Phase P6 work, one row at a time.

### 4.3 Auto-hail (the system opens panes at you)

- `approval.requested` bus event → if no AUTHORIZATIONS pane is open, one **materializes**
  (flash-settle) — consequence demands presence. Never duplicated, never re-raised while
  the operator is actively dragging.
- A mission started *from this page* opens/raises its MISSION DOSSIER pane.
- Auto-hail is capped: at most 1 auto-opened pane per event type at a time.

### 4.4 Persistence

`ui_preferences.layout.nexus` (server already stores arbitrary layout JSON):

```jsonc
{
  "nexus": {
    "panes": [ { "task": "agent.channel", "x": 820, "y": 120, "w": 380,
                 "ctx": { "agentId": "…" }, "z": 3, "min": false } ],
    "zSeq": 7
  }
}
```

Debounced 500ms; restored on entry; panes for since-deleted subjects drop silently.

## 5. Interaction model — the cursor and the Construct

### 5.1 Cursor physics (ATTENTIVE state)

- **Tilt/parallax**: pointer offset from center `(dx, dy)` → figure-space transform:
  outer strata translate `−(dx,dy) · 0.012·(r/R)`, inner strata `+0.006` opposite — a
  gentle counter-rotation that reads as depth. Eased with critically-damped spring
  (stiffness 120, damping 20); max excursion 14px. No 3D matrices — 2D offsets per
  stratum (cheap, deterministic).
- **Iris gaze**: kernel iris (a short chord) points along `atan2(dy, dx)` with 150ms lag.
  The Construct *watches*; this is the single most "alive" cue and costs one line.
- **Magnet reticle**: nearest interactive node within 48px of the cursor snaps a
  corner-bracket reticle onto itself; its label **decodes in** (≤160ms); its thread(s)
  brighten. One node at a time; leaving radius releases with a 90ms fade. Cursor becomes
  `pointer` only while a node is locked — the reticle *is* the hover state.
- **Proximity ripple**: strata locally bow away from the cursor within 90px (max 6px
  displacement) — the figure yields to the operator's hand.

### 5.2 Operating grammar

| Gesture | On | Effect |
|---|---|---|
| click | agent node | open AGENT CHANNEL pane (agent pre-selected) |
| click | workflow node | open RUN WORKFLOW pane (workflow pre-selected) |
| click | knowledge shell | open KNOWLEDGE SEARCH pane |
| click | tool spoke | open TOOL CATALOG pane (server filter) |
| click | mission thread | open MISSION DOSSIER pane (mission tracked) |
| click | amber (gated) thread / rim tick | open AUTHORIZATIONS pane |
| click | kernel core | open SIGNAL FEED pane (the system's own voice) |
| hold ≥700ms | kernel core | **ceremony**: SYSTEM SNAPSHOT — one pane with the full count readout + link state + month tokens (an "all-clear sweep") |
| click | empty stage | nothing (no accidental spawns); double-click empty stage → open task tray focus |
| `T` | page | focus the task tray (then ←/→/Enter) |
| Tab | page | canvas is one tab stop; then **↑/↓/←/→ walk strata/nodes** with the same reticle + labels; Enter = click. Full keyboard parity with cursor targeting. |

### 5.3 Reduced motion (`prefers-reduced-motion: reduce`)

No RAF loop. The Construct renders **once per data/cursor change**: static diagram, no
drift/pulse/flow; threads drawn solid; reticle/labels appear instantly; panes appear
without entrance animation. Everything remains clickable and keyboard-walkable. (Gated
threads still differ by *color + straightness*, never by motion alone.)

## 6. Architecture

```
apps/web/src/nexus/
  Nexus.tsx        page: stage, panes state, tray, auto-hail, persistence
  Construct.tsx    canvas figure: layout pass, RAF painter, cursor, hit-test
  TaskWindow.tsx   draggable translucent pane frame (rail, ⇱ − ✕, z-raise)
  registry.tsx     task registry (table §4.2) + compact task bodies
  useConstructData.ts  one hook: fetch + bus-refresh the figure's data snapshot
```

- **Rendering**: Canvas 2D, single `<canvas>`, DPR-aware. Geometry computed each frame
  from a **layout pass** (pure function `layout(data, size) → nodes[]`) so hit-testing
  and keyboard walking share the *same* node table the painter uses. No hidden DOM.
- **Data flow**: `Nexus` receives `agents, workflows, approvals, signals, connected,
  onNavigate, onTrack` from the shell (already fetched there); fetches missions/kb/tools
  itself; bus events arrive via the existing `signals` prop (no second WebSocket).
- **Hit-testing**: nearest-node search over the layout table (≤ a few hundred entries —
  linear scan is fine at 60Hz).
- **State**: pane list is plain React state in `Nexus`; the figure is stateless per frame
  (data snapshot + clock + cursor in refs — no per-frame React renders).

## 7. Accessibility (hard requirements, same bar as the shell)

- Canvas has `role="application"`, an `aria-label` summarizing live counts, and a
  **visually-hidden live region** announcing reticle target changes ("AGENT MONEYPENNY —
  ENTER TO OPEN CHANNEL").
- Full keyboard walk (§5.2) — parity with every cursor affordance.
- Panes: labelled dialogs (`role="dialog"`, `aria-label`), focus moves into a pane on
  spawn *only* for auto-hail authorization panes (consequence), otherwise focus is not
  stolen.
- All pane text on translucent ground keeps AA contrast: body text sits on an inner
  `--panel`-solid content well when text-dense (tables/inputs), translucency lives at
  the pane margins.

## 8. Performance budget

- ≤ 4ms/frame paint on a mid laptop; hard primitive cap 600/frame (knowledge particles
  clamp at 240, threads at 12, rim ticks at 48).
- RAF paused when: tab hidden, view ≠ nexus, DORMANT, or reduced motion.
- PATIENT state may drop to 30fps (frame-skip) — idle is calm *and* cheap.
- No allocation in the frame loop (layout arrays reused); text layout memoized per label.

## 9. Open questions (decide at leisure; defaults chosen so work can proceed)

1. Pane resize handles? **Default: fixed widths per task (360–460px), body scrolls.**
2. Should NEXUS become `ROLE_HOME` (landing view) for some roles? **Default: yes for
   member, others keep current homes.** Revisit after use.
3. Construct zoom strata (wheel to dive into a ring as a full sub-instrument)? **Deferred
   to P7 — the flat instrument must earn its keep first.**
4. Multi-select threads (marquee) to open several dossiers? **Deferred.**
5. Sound (event ticks)? **Out of scope — silent instrument.**

## 10. Execution plan & build log  ← *update this section as phases land*

- [x] **P0 — This document.** Acceptance: concept, anatomy, interactions, architecture,
  phases all specified; resumable by a cold reader.
- [x] **P1 — Scaffold + panes.** `nexus/` dir; NEXUS view (01) for all roles wired into
  App + palette + stage-head; `TaskWindow` (drag, stack/raise, close, jump, cascade
  spawn, Escape/arrow keys); task tray from registry; registry with all 16 rows (8 live
  bodies: channel, run, authorizations, dossier, kb-search, tools, templates, signal;
  8 jumpOnly). Acceptance: open ≥3 panes, drag them into an overlap, raise by click,
  jump navigates with context, role locks respected.
- [x] **P2 — Construct v1 (structure).** Canvas + layout pass + painter: kernel, graticule,
  agent orbit, workflow lattice, knowledge shell, tool spokes, rim ticks, corner count
  readouts; DORMANT/PATIENT states; reduced-motion static mode. Acceptance: figure
  renders true counts from a live server; resize-safe; no RAF when hidden/reduced.
- [x] **P3 — Cursor life.** Tilt springs, iris gaze, magnet reticle + decode labels,
  proximity ripple, click-to-open per §5.2 grammar, keyboard walk + live region.
  Acceptance: every §5.2 row demonstrable; reticle keyboard-parity.
- [x] **P4 — Threads & events.** Mission threads (flow while running; amber taut when
  gated), kernel event pulses from bus signals, ALARM ripple, WORKING/GATED states,
  auto-hail authorization pane, hold-the-kernel SYSTEM SNAPSHOT ceremony. Acceptance:
  run the sample gated workflow from the page and watch launch → thread → amber gate →
  hold-to-authorize → completion, all without leaving NEXUS.
- [x] **P5 — Persistence + polish + verify.** Pane layout persisted/restored
  (`layout.nexus`); spawn cascade; Playwright drive (open/drag/stack/jump/authorize)
  with screenshots; typecheck + build green. Acceptance: reload restores panes; shots
  archived; CI-grade build clean.
- [ ] **P6 — Body completion.** Convert `jumpOnly` rows to live pane bodies (budgets,
  router, mcp.add, members, branding, audit, knowledge.ingest UI affordances beyond v0).
  One row per commit; registry row flips `jumpOnly: false`.
- [ ] **P7 — Depth (optional).** Wheel-zoom strata dive; pane resize; marquee threads;
  Construct-driven layout suggestions ("arrange panes around the working stratum").

**Resume protocol:** find the first unchecked phase above; its acceptance criteria are
the definition of done; `apps/web/src/nexus/` + this doc are the only places state
lives. If code and doc disagree, the doc is intent, code is fact — reconcile and note it
here.

**Build log:**
- 2026-07-06 · P0–P5 landed in one pass (this commit): full spec; NEXUS view for all
  roles (palette + `1` shortcut + tray); 16-task registry (8 live bodies, 8 jumpOnly);
  draggable translucent panes with stack/raise/jump/minimize-free chrome, cascade
  spawn, arrow-key nudge, Escape close; Construct v1 with kernel/graticule/orbit/
  lattice/shell/spokes/rim/readouts, tilt + iris gaze + magnet reticle + ripple,
  mission threads with amber gating, event pulses, auto-hail authorizations,
  hold-kernel SYSTEM SNAPSHOT, keyboard walk + live region, reduced-motion static
  mode; layout persisted to `ui_preferences.layout.nexus`; Playwright-verified.
