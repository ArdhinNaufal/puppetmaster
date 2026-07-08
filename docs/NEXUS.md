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
| **Kernel core** | 0 – 0.15R | A lattice of pixels animated as a **constant radial wave** (ripples run outward forever; speed rises with running missions, capped 3×), bounding ring | bus `connected`; every `BusEvent`; running count | The system's heartbeat. Click → **DISCOVERY** task (§2.4). Hold ≥700ms → SYSTEM SNAPSHOT ceremony. Gated → outer pixel band + ring blink amber. Disconnected → grey static lattice, "LINK DOWN". |
| **Schema graticule** | 0.15 – 1.0R | Faint concentric arcs + radial degree ticks + orbit guides on populated rings | static geometry, labels are real counts | The "paper" of the instrument. Parallax-tilts with cursor. |
| **Agent orbit** | 0.42R | One **radial bar** per agent (v2.1 — rings of bars, not dots, per the reference plate); bar length = autonomy tier (1/2/3 = read/write/destructive) | `agentApi.list()` | Bars **evenly spread** on the orbit. Agent active in last 20s → bar glows accent + orbit dot spins. Click → **AGENT CHANNEL** task. |
| **Mission ring** | 0.52R | One **radial bar** per mission of the active stratum, live-first, cap 14 — long = live, short = settled; amber = gated, red = failed | `api.listMissions()` + bus `mission.*`, `approval.*` | Live missions grow threads (below); settled bars stay as history. Click → **MISSION DOSSIER** / **AUTHORIZATIONS** if gated. |
| **Workflow lattice** | 0.63R | One **radial bar** per workflow — length = node count of its graph; a small n-gon spins beside ≥3-node graphs | `api.listWorkflows()` (+ graph node counts lazily) | Evenly spread. Click → **RUN WORKFLOW** task pre-selected. |
| **Knowledge shell** | 0.76R | One **radial bar** per document — length = chunk weight — with its chunk particles clustered around it (capped 240 total) | `kbApi.list()` | Density is the readout. Click → **KNOWLEDGE SEARCH** task. |
| **Tool spokes** | 0.88R | One spoke per MCP server/namespace, tick marks along the spoke = tools in it | `api.tools()` grouped by server | Tool namespaces live on the **newest stratum** (they have no birthday). Click spoke → **TOOL CATALOG** filtered to that server. |
| **Mission threads** | core → rim | Strings from kernel to the bead's bearing; animated dash flow while running; **amber, taut (straight), vibrating** when `awaiting_approval` | live missions of the stratum | The signature motion. |
| **Memory halo** | 1.0R rim | Rim ticks (neatly sequenced): pending authorizations (amber), failed missions last 24h (red) | approvals list, missions list | Global — consequences transcend strata. |
| **Depth gauge** | bottom center | One chip per stratum (year + unit-count bar), active chip bracketed | `buildLayers()` | Click/Enter a chip → stratum shift (§2.3). Walkable by keyboard like any node. |
| **Count readouts** | corners of stage | Micro stat lines: `STRATUM y — AGENTS n · WORKFLOWS n · OPS n`, `DOCS n/CHUNKS n`, `TOOLS n · NS n`, `RX n · LIVE OPS n · GATED n` | same fetches | Tertiary type stratum, per density rules. |

**Complexity budget:** the figure is *intricate by strata*, not by noise — each layer is
individually legible; combined they read as one organism. Hard cap ~600 drawn primitives
per frame (see §8 performance).

### 2.2 States

| State | Trigger | Presentation |
|---|---|---|
| **DORMANT** | bus disconnected | Greyed strata, no motion, static grey kernel lattice, "LINK DOWN" microtype. |
| **PATIENT** (idle) | connected, no running mission, no cursor in stage | The pixel wave rolls at base speed; frame rate halves. Nearly still. |
| **ATTENTIVE** | cursor inside stage | Figure tilts toward cursor (§5.1), nearest-node reticle engages. |
| **WORKING** | ≥1 running mission | Threads drawn + flowing; the acting nodes pulse; the kernel wave quickens with running count (cap 3×). |
| **GATED** | ≥1 pending authorization | Amber taut thread(s) + rim ticks; the kernel's outer pixel band and ring blink amber every 3s. Takes visual priority over WORKING. |
| **ALARM** | a mission failed in last 60s | One red ripple from kernel to rim (once per failure event, not looping). |

### 2.3 Strata — the Construct stacked in time (v2)

The instrument grows forever, so it is **stacked in layers grouped by creation
year** (`buildLayers` in `Construct.tsx`): every agent, workflow, document and
mission lives on the stratum of its `createdAt` year; tool namespaces (no
birthday) live on the newest stratum, which always exists. One stratum is
active at a time — its rings are interactive and neatly arranged (nodes evenly
spread per orbit). Adjacent strata are visible as faint ghost rings: the older
one small at the center (deeper in the tunnel), the newer one large beyond the
rim.

**Stratum shift** is a zoom ceremony (~480ms, cubic ease): diving to an older
year scales the active rings up and out (the camera passes through them) while
the older stratum grows from the center into place; surfacing plays the
reverse. Under reduced motion the swap is instant. Navigation paths:

- **wheel** over the stage (down = deeper/older, up = newer),
- **`[` / `]`** or **PageDown / PageUp** on the focused canvas,
- the **depth gauge** chips (click / keyboard walk + Enter),
- **DISCOVERY** (§2.4): next/prev, a year jump field, or selecting a hit that
  lives on another stratum.

During a shift only the chrome (kernel, depth gauge, auth rim) is interactive.

### 2.4 DISCOVERY — the kernel's gateway (v2)

Clicking the kernel opens the **DISCOVERY** pane: a search over **every unit
on the active stratum** (agents, workflows, documents, tool namespaces,
missions) **plus every task pane** the operator's role can reach. If nothing
matches on the active stratum the search silently widens to all strata (hits
carry a `⇢ year` tag). Selecting a hit closes the pane and:

- **task pane hit** → opens that pane;
- **construct unit hit** → shifts to its stratum if needed, then plays the
  **homing beacon**: a crosshair sweep from the stage edges plus a converging
  reticle shaped like the target's own geometry (agent → arcs, workflow →
  rotated square, knowledge → particle ring, tool → dashed spoke trace,
  mission → thread flash + diamond), settling into the magnet reticle with the
  label decoded.

DISCOVERY also lists the strata (deeper/newer steppers + one chip per year)
and a jump field accepting a year or stratum id.

## 3. Page layout

```
┌────────────────────────────────────────────────────────────────────┐
│ stage-head: 01 // NEXUS                     ⌘K COMMAND · 1–9 VIEWS │
├────────────────────────────────────────────────────────────────────┤
│ [pane spawns left]                          [pane spawns right]    │
│      ↘ then drags anywhere, stacks freely ↙                        │
│                        THE CONSTRUCT                               │
│                     (full-stage canvas)                            │
│                                                                    │
│                    STRATA // 2024 2025 [2026]                      │
├────────────────────────────────────────────────────────────────────┤
│ task tray: ◉ CHANNEL ▤ RUN ⚑ AUTH ≡ DOSSIER ⌕ KB … (registry)      │
└────────────────────────────────────────────────────────────────────┘
```

- The **Construct canvas fills the stage**; panes float *above* it, drag
  anywhere and stack/overlap freely — but every pane **emerges on a flank**
  (the emptier of left/right, light cascade), never over the figure's center.
- The **task tray** (bottom strip of the stage) lists every registry task as a chip —
  the guaranteed path to any task even if its stratum is empty (e.g. no agents yet).
  Chips show role-locked state for insufficient roles.
- NEXUS is **view 01 for every role** and runs **solo** (v2): the shell's left
  side panel and right OPERATION panel are hidden on this view — their content
  lives on as task panes (AUTHORIZATIONS, SIGNAL FEED, OPERATION LOG). The
  rail, ⌘K palette, WATCH strip and signal ticker stay. Palette gains
  `TASK //` entries for every registry task.

## 4. Task pane system

### 4.1 Pane anatomy (v2.1: free-floating, flank spawn)

```
╭──────────────────────────────────────╮  ← 1px stroke, corner brackets
│ ⣿ ◉ AGENT CHANNEL             ⇱  ✕  │  ← title rail = drag handle
│                                      │     ⇱ jump-to-full-page
│   (task body, compact module)        │     ✕ close
╰──────────────────────────────────────╯
```

- **Vague transparent background**: `background: color-mix(in srgb, var(--panel) 45%,
  transparent)` + `backdrop-filter: blur(9px)` + 1px stroke + brackets — deliberately
  *more* translucent than v1; the Construct stays present under every pane.
- **Free-floating**: panes drag anywhere on the stage (pointer capture on the rail,
  clamped to the stage) and **stack/overlap freely** — `pointerdown` anywhere raises
  (z = monotonic counter); the focused pane gets accent brackets.
- **Flank spawn**: a new pane *emerges* on the emptier flank of the stage (left or
  right, whichever holds fewer panes by current position) with a light cascade — the
  figure's center is never the spawn point. Explicit `ctx.x/ctx.y` overrides.
- **Jump** (⇱): navigates the shell to the task's dedicated view and carries context
  (e.g. selected agent → Command view; mission → tracked dossier). The pane closes on
  jump (the full page supersedes it).
- **Keyboard** (rail focused): arrows nudge ±16px (Shift = 1px), Escape closes. Every
  control is tabbable.

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
| `operation.log` | ⌖ | Operation log (v2) | tracked mission's live dossier + cancel/retry/explain | missions | member (act: builder) |
| `construct.discovery` | ◈ | Discovery (v2, §2.4) | stratum search + strata navigation | (none — live) | member |
| `evals.run` | ✓ | Eval suite | run + last result summary | evals | admin |
| `budgets` | ¤ | Budgets & usage | jumpOnly v0 | evals | admin |
| `router` | ⇌ | Router profiles/health | jumpOnly v0 | evals | admin |
| `mcp.add` | ＋ | Add MCP server | jumpOnly v0 | tools | admin |
| `members` | ⚇ | Members & roles | jumpOnly v0 | admin | admin |
| `branding` | ◧ | Workspace branding | jumpOnly v0 | admin | admin |
| `audit` | ☰ | Audit log | jumpOnly v0 | admin | admin |

*jumpOnly v0* rows are still on the page (tray + palette + rim affordances) — they open
their full view; converting them to in-pane bodies is Phase P6 work, one row at a time.

### 4.3 Auto-hail (the system opens panes at you — v2 cadence)

Attention items surface **one at a time on a fixed cadence** (2.8s apart), each
emerging on the emptier flank, so the operator is hailed, not buried:

- **Urgent**: pending authorizations → the AUTHORIZATIONS pane.
- **Need follow-up**: each mission failed in the last 24h (cap 5) → its MISSION
  DOSSIER pane.
- Each item hails **once per session**; closing a hailed pane is a decision the
  system respects (no re-hail until the trigger clears and fires again).
- **Operation log on action**: tracking a mission from this page (launching a
  workflow, hailing an agent) opens/raises the OPERATION LOG pane, emerging on
  the emptier flank.
- The cadence timer is render-independent (refs), so shell re-renders never
  reset it.

### 4.4 Persistence

`ui_preferences.layout.nexus` (server already stores arbitrary layout JSON):

```jsonc
{
  "nexus": {
    "panes": [ { "task": "agent.channel", "x": 820, "y": 120,
                 "ctx": { "agentId": "…" }, "z": 3 } ]
  }
}
```

Debounced 500ms; restored on entry; panes for since-deleted subjects drop
silently. Interim dock-era layouts (a `side` with no `x`/`y`) land on that
flank's default position on restore.

## 5. Interaction model — the cursor and the Construct

### 5.1 Cursor physics (ATTENTIVE state)

- **Tilt/parallax**: pointer offset from center `(dx, dy)` → figure-space transform:
  outer strata translate `−(dx,dy) · 0.012·(r/R)`, inner strata `+0.006` opposite — a
  gentle counter-rotation that reads as depth. Eased with critically-damped spring
  (stiffness 120, damping 20); max excursion 14px. No 3D matrices — 2D offsets per
  stratum (cheap, deterministic).
- **Kernel pixel wave** (v2, replaces the iris): the kernel is a lattice of pixels whose
  brightness follows a radial sine wave — a constant, calm heartbeat that quickens with
  running missions and shifts amber at the rim when gated. The lattice is precomputed on
  resize; the wave costs one `sin` per pixel per frame.
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
| click | knowledge doc node | open KNOWLEDGE SEARCH pane |
| click | tool spoke | open TOOL CATALOG pane (server filter) |
| click | mission bead/thread | open MISSION DOSSIER pane (mission tracked) |
| click | amber (gated) bead / auth rim node | open AUTHORIZATIONS pane |
| click | kernel core | open **DISCOVERY** pane (§2.4) |
| hold ≥700ms | kernel core | **ceremony**: SYSTEM SNAPSHOT — one pane with the full count readout + link state + month tokens (an "all-clear sweep") |
| wheel | stage | **stratum shift**: down = deeper (older year), up = newer (§2.3) |
| click / Enter | depth-gauge chip | shift to that stratum |
| `[` `]` / PageDown PageUp | focused canvas | shift stratum deeper / newer |
| click | empty stage | nothing (no accidental spawns) |
| Tab | page | canvas is one tab stop; then **↑/↓/←/→ walk strata/nodes** (kernel → rings → auth rim → depth gauge) with the same reticle + labels; Enter = click. Full keyboard parity with cursor targeting. |

### 5.3 Reduced motion (`prefers-reduced-motion: reduce`)

No RAF loop. The Construct renders **once per data/cursor change**: static diagram, no
drift/pulse/flow; the kernel lattice is a still pattern; threads drawn solid; stratum
shifts are instant (no zoom ceremony); DISCOVERY's locate focuses the target directly
(no homing animation); reticle/labels appear instantly; panes appear without entrance
animation. Everything remains clickable and keyboard-walkable. (Gated threads still
differ by *color + straightness*, never by motion alone.)

## 6. Architecture

```
apps/web/src/nexus/
  Nexus.tsx        page: stage, pane state (flank spawn), strata state, discovery
                   index, auto-hail cadence, tray, persistence
  Construct.tsx    canvas figure: buildLayers, layout pass, RAF painter, stratum
                   shift, pixel-wave kernel, homing beacon, cursor, hit-test
  TaskWindow.tsx   draggable translucent pane frame (rail, ⇱ ✕, z-raise)
  registry.tsx     task registry (table §4.2) + compact task bodies + NX contract
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
3. Construct zoom strata? **Shipped in v2 (§2.3)** — as time strata (one layer per
   creation year) with a wheel/keys/gauge/DISCOVERY zoom ceremony, not per-ring dives.
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
- [x] **P7 — v2 overhaul (this pass).** Time strata + zoom ceremony (§2.3); docked pane
  flanks replacing free-floating panes (§4.1); auto-hail cadence for urgent/follow-up
  + OPERATION LOG on action (§4.3); pixel-wave kernel + DISCOVERY (§2.4); shell runs
  NEXUS solo (§3). Remaining P7 ideas (pane resize, marquee threads) stay open.

**Resume protocol:** find the first unchecked phase above; its acceptance criteria are
the definition of done; `apps/web/src/nexus/` + this doc are the only places state
lives. If code and doc disagree, the doc is intent, code is fact — reconcile and note it
here.

**Build log:**
- 2026-07-08 · **v2.1 (owner feedback)**: panes float freely again — drag anywhere,
  stack/overlap, z-raise — but every pane *emerges* on the emptier flank of the stage
  (light cascade), never over the figure's center; dock columns removed; persistence
  back to `x`/`y` with dock-era `side` layouts migrated on restore. Orbit content marks
  changed from dots/glyphs to **radial bars** (reference plate look): agent bar length =
  autonomy tier, workflow bar = graph node count, document bar = chunk weight, mission
  bar = live/settled with amber gated / red failed, auth rim node = widest warn bar.
- 2026-07-08 · **v2 overhaul (P7)**: NEXUS runs solo (shell side/OPERATION panels hidden
  on view 01 — their content became task panes); Construct stacked into year strata with
  a zoom-shift ceremony, ghost rings, depth gauge, wheel/`[` `]`/PageUp/Down navigation,
  neat evenly-spread ring arrangement, per-document knowledge nodes, mission bead ring;
  kernel core replaced by a constant pixel-wave lattice whose click opens the new
  DISCOVERY pane (stratum search with all-strata fallback, task-pane hits, homing-beacon
  locate with kind-shaped reticles, strata steppers + year jump); panes dock to
  left/right flanks (drag re-dock, ⇥/⇤, keyboard reorder, emptier-flank placement,
  45%-panel translucency) with legacy x/y layouts migrated; auto-hail cadence (2.8s,
  render-independent) hails pending authorizations then failed-mission dossiers once per
  session; OPERATION LOG pane (tracked mission dossier + cancel/retry/explain)
  auto-opens on launch/track; demo seeder backdates a slice of agents/workflows/docs/
  missions across two prior years so the strata read; Playwright-verified end to end.
- 2026-07-06 · P0–P5 landed in one pass (this commit): full spec; NEXUS view for all
  roles (palette + `1` shortcut + tray); 16-task registry (8 live bodies, 8 jumpOnly);
  draggable translucent panes with stack/raise/jump/minimize-free chrome, cascade
  spawn, arrow-key nudge, Escape close; Construct v1 with kernel/graticule/orbit/
  lattice/shell/spokes/rim/readouts, tilt + iris gaze + magnet reticle + ripple,
  mission threads with amber gating, event pulses, auto-hail authorizations,
  hold-kernel SYSTEM SNAPSHOT, keyboard walk + live region, reduced-motion static
  mode; layout persisted to `ui_preferences.layout.nexus`; Playwright-verified.
