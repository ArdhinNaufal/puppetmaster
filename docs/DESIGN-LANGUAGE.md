# Puppetmaster — FUI Design Language

**Version:** 0.2

Puppetmaster's interface takes its cues from **fictional/future user interfaces (FUI)** rather
than conventional SaaS chrome. Primary reference chosen by the product owner:

- **SPECTRE (007) MI6 UI by Rushes** — (https://www.hudsandguis.com/home/2015/12/7/spectre-007,
  https://vincentstudios.co.uk/portfolio/007-spectre/)
  Dark, technically authentic command-center panels; data-dense readouts; restrained color;
  a heightened sense of realism grounded in real technical detail. Rushes built 300+ screens
  across 23 scenes (Q's lab gadget schematics, the smart-blood tracking wall, the CNS
  surveillance grid) over 13 months, researching nanorobotics and military/medical systems so
  that every readout would be *plausible instrumentation*, not decoration.

## Reading the reference

What makes the SPECTRE screens work — and what this system copies deliberately:

1. **Data abstraction & visualization.** Every quantity is given a *spatial* form first —
   an arc, a trace, a bar, a ping on a field — with the numeral as its annotation. The
   visualization is the primary reading; the number confirms it. Nothing is charted that the
   system does not actually measure.
2. **Density as instrument, not noise.** Screens layer three strata of type: primary values
   (large, bright), operational labels (small caps, letter-spaced), and tertiary telemetry
   (tiny coordinates, ids, timestamps at the edge of legibility). Each panel earns its
   density from real data; whitespace is structure, not absence.
3. **Cinematic staging.** The interface has a *camera*: panels trace themselves on, type
   decodes in, state changes land with a flash-and-settle. Depth comes from atmosphere —
   vignette, faint scanlines, a coordinate grid under everything — never from skeuomorphic
   chrome.
4. **The process is the hero.** MI6 screens exist to *show work happening*: tracking,
   triangulating, decrypting — step by step, with progress, provenance and cost visible.
   Puppetmaster mirrors this: a mission renders as an **operation dossier** (timeline bars,
   per-step status, token telemetry, outputs, decisions), and a persistent **signal ticker**
   ensures nothing the kernel does happens off-screen.
5. **Unorthodox interaction grammar.** Consequence gets ceremony:
   - **Hold-to-authorize** — approvals and destructive actions are confirmed by *held* input
     (time as a confirmation dimension), not a second click.
   - **Decode-in typography** — text materializes through a short scramble-resolve, only on
     state change; idle text never animates.
   - **Trace-on linework** — panel strokes draw themselves on mount.
   - **Radar idiom** — liveness is a sweep; real bus events land as pings on the field.
   - **Operator's clock** — UTC time, session uptime and event counters are always visible:
     instrument panel, not page chrome.
6. **Idle is calm ("Patient").** Motion means *something is actually happening* — a mission
   running, an agent thinking, an event arriving. An idle screen is nearly still.

## Principles

1. **Command center, not dashboard.** The user is an operator overseeing live agents and
   missions. Density is a feature — but every readout must be real data, never decoration.
2. **Dark-first.** Near-black base, low-contrast panel strokes, one or two accent hues
   (signal cyan/teal for activity, amber for approvals pending, red for failures).
3. **Thin linework & precise type.** 1px strokes, corner ticks/brackets on focus, monospaced
   numerals for telemetry; generous letter-spacing on labels (small caps); a condensed
   grotesk for display and navigation.
4. **Motion = state change.** Subtle scanline/trace animations only when something is
   actually happening (mission running, agent thinking). Idle UI is calm.
5. **Legibility beats theatrics.** FUI styling must never cost usability: WCAG-AA contrast,
   full keyboard navigation, and a reduced-motion mode are hard requirements. Every
   animation in the system is gated behind `prefers-reduced-motion: no-preference`, and
   every animated element is fully legible with animation removed.
6. **Personal & adaptive.** Panels are draggable/pinnable per user; role presets define
   starting layouts; workspace branding (logo, accent hue) skins the shell without breaking
   the system.

## System

- **Tokens:** `--bg-void`, `--panel`, `--panel-hi`, `--stroke`, `--stroke-hi`, `--accent`
  (workspace-brandable), `--warn`, `--danger`, `--ok`, `--text-hi/--text-lo`, radius 2px
  (near-square), accent glow at 8–12%. Type: **Rajdhani** (display/labels, condensed
  grotesk) + **IBM Plex Mono** (data, telemetry, body) — both self-hosted via Fontsource,
  local-first.
- **Motion vocabulary (all gated on reduced-motion):** `trace-on` (border/line draw, mount
  only), `decode` (type scramble-resolve, state change only), `pulse` (running dots),
  `sweep` (radar / running-node scanline), `flash-settle` (event arrival), `flow` (edge
  dashes while a mission runs).
- **Core components:** Panel (corner brackets + indexed title rail), Telemetry stat
  (+ sparkline), Gauge (radial arc + ticks), MeterBar (segmented), Sparkline, Decode text,
  Mission timeline (per-step gantt from live bus timing), Agent card (status ring, model,
  autonomy tier), Approval card (hold-to-authorize), Signal ticker (live log stream), Radar
  (event pings), Canvas node skins matching the panel language.
- **Layout:** shell grid (side rail / stage / dossier), panels snap and reorder per user;
  command palette (⌘K) as the fast path; number keys switch views; a persistent bottom
  signal rail carries the ticker, clock and connection state.
- **Interaction ceremony:** approve = hold 700 ms (progress rendered in the control);
  reject/cancel = single click (declining is always cheap); focus = accent outline with
  bracket corners; every interactive element reachable by keyboard.
