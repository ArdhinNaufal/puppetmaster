# Puppetmaster — FUI Design Language

**Version:** 0.1 (draft)

Puppetmaster's interface takes its cues from **fictional/future user interfaces (FUI)** rather
than conventional SaaS chrome. Primary references chosen by the product owner:

- **SPECTRE (007) MI6 UI by Rushes** — (https://www.hudsandguis.com/home/2015/12/7/spectre-007, https://vincentstudios.co.uk/portfolio/007-spectre/)
  Dark, technically authentic command-center panels; data-dense readouts; restrained color;
  a heightened sense of realism grounded in real technical detail.

## Principles

1. **Command center, not dashboard.** The user is an operator overseeing live agents and
   missions. Density is a feature — but every readout must be real data, never decoration.
2. **Dark-first.** Near-black base, low-contrast panel strokes, one or two accent hues
   (signal cyan/teal for activity, amber for approvals pending, red for failures).
3. **Thin linework & precise type.** 1px strokes, corner ticks/brackets on focus, monospaced
   or grotesk numerals for telemetry; generous letter-spacing on labels (small caps).
4. **Motion = state change.** Subtle scanline/trace animations only when something is
   actually happening (mission running, agent thinking). Idle UI is calm, like "Patient".
5. **Legibility beats theatrics.** FUI styling must never cost usability: WCAG-AA contrast,
   full keyboard navigation, and a reduced-motion mode are hard requirements.
6. **Personal & adaptive.** Panels are draggable/pinnable per user; role presets define
   starting layouts; workspace branding (logo, accent hue) skins the shell without breaking
   the system.

## System sketch

- **Tokens:** `bg-void`, `panel`, `stroke`, `accent`, `warn`, `danger`, `text-hi/lo`,
  radius (2px — near-square), glow (accent at 8–12% blur).
- **Core components:** Panel (with corner brackets + title rail), Telemetry stat, Mission
  timeline, Agent card (status ring, model, autonomy tier), Approval card, Live log stream,
  Canvas node skins matching the panel language.
- **Layout:** 12-col grid shell; panels snap to grid; command palette (⌘K) as the fast path.

A visual prototype of this shell is a planned milestone (M4 in ARCHITECTURE.md); an early
HTML mock will be produced to lock tokens before component build-out.
