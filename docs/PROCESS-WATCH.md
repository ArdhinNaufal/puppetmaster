# PROCESS WATCH — real-time log & resource watch on every page

**Version:** 0.1 · **Status:** analysis + build log. Companion to
`docs/DESIGN-LANGUAGE.md` v0.2 and `docs/NEXUS.md`. Purpose: **insight** — the
operator should always be able to see *what the system is doing right now* and
*what it costs*, from any page, without navigating away.

## 1. Analysis — what runs, and who needs to see it where

Puppetmaster's kernel runs five processes an operator actually reasons about:

| # | Process | What it is | Real-time signal available |
|---|---|---|---|
| P-MODEL | **LLM calls** | model router picks a candidate, calls it, records tokens/latency; cooldowns on failure | kernel AuditSink `llm.call` entries (now broadcast as `audit.appended`) |
| P-TOOL | **Tool calls** | MCP catalog invocations by agents and workflow action nodes, tiered by policy | kernel AuditSink `tool.call` entries (now broadcast) |
| P-MISSION | **Mission execution** | the workflow runner: step transitions, retries, gates | native bus `mission.started/step/finished` |
| P-AGENT | **Agent turns** | chat/tick loops: user msg → assistant msg (+ streaming deltas) | native bus `agent.message`, `agent.message.delta` |
| P-AUTH | **Authorization ceremonies** | approvals requested/resolved | native bus `approval.requested/resolved` |
| R-VITALS | **Kernel resources** | the server process itself: CPU, RSS/heap, event-loop lag, uptime, live sockets, live/queued missions | **new** `ops.vitals` bus sample every 2.5s + `GET /api/ops/vitals` history |

Everything above is real measurement; nothing is synthesized client-side.

### Which process deserves the watch on which page

The insight need differs by page — the watch defaults to the process the page
is *about* (the operator can always widen to ALL):

| Page | Primary process(es) | Why this one here |
|---|---|---|
| 01 NEXUS | ALL | the theater — the whole organism is the subject |
| 02 COMMAND | P-AGENT + P-MODEL + P-TOOL | a chat turn *is* llm.call + tool.calls; seeing them stream demystifies "thinking" |
| 03 CANVAS | P-MISSION | builders watch step transitions while testing graphs |
| 04 TEMPLATES | P-MISSION | instantiate → first run; the interesting part is the run |
| 05 KNOWLEDGE | P-TOOL + P-MODEL | kb.search is a tool call; embedding/citation flows ride model+tool calls |
| 06 MISSIONS | P-MISSION | the runner's own page |
| 07 AGENTS | P-AGENT | roster page: whose turn loops are firing |
| 08 TOOLS | P-TOOL | catalog page: which tools actually get called, by whom |
| 09 EVALS | P-MODEL | router behavior, per-call cost, cooldown causes |
| 10 ADMIN | ALL | governance wants the unfiltered stream |

**Resource watch (R-VITALS) is unconditional on every page** — cost and health
have no "right page"; they are the bezel of the whole instrument.

## 2. Design — the WATCH strip

One shell-level instrument, present on **every** authenticated page, between
the stage and the signal ticker:

```
collapsed (32px, always on):
┌────────────────────────────────────────────────────────────────────────────┐
│ WATCH // CPU 3.1% ▁▂▁▃  RSS 214MB  HEAP 96MB  LAG 0.6ms  WS 1  OPS 1  ▴    │
└────────────────────────────────────────────────────────────────────────────┘
expanded (+220px drawer):
┌──────────────────────────────┬─────────────────────────────────────────────┐
│ VITALS (last 5 min)          │ PROCESS LOG        [ALL][MODEL][TOOL]       │
│  CPU %      ~sparkline~      │ 14:07:03 MODEL llm-1 · mock · 20 tok       │
│  RSS MB     ~sparkline~      │ 14:07:03 TOOL util.echo · agent:Moneypenny │
│  HEAP MB    ~sparkline~      │ 14:07:02 MISSION b1 RUNNING                │
│  LOOP ms    ~sparkline~      │ …view preset decides the initial filter…   │
└──────────────────────────────┴─────────────────────────────────────────────┘
```

- **Vitals**: streamed `ops.vitals` samples kept in a ring buffer (~120 ≈ 5
  min); sparklines + current numerals; loop-lag and CPU color-shift to warn/
  danger at real thresholds (lag > 50ms, CPU > 80%). Initial paint backfills
  from `GET /api/ops/vitals`.
- **Process log**: merged stream of native bus events + `audit.appended`
  (llm.call/tool.call) summaries, newest first, capped 200. Filter chips ALL /
  MODEL / TOOL / MISSION / AGENT / AUTH; the **active page sets the preset**
  (table §1); switching pages re-presets only if the operator hasn't pinned a
  filter this session.
- The strip does not duplicate the signal ticker: the ticker stays the
  one-line ambient feed; the WATCH drawer is the *inspection* surface (richer
  rows: actor, target, latency/tokens where the audit entry carries them).
- Open/closed state persists per user (`ui_preferences.layout.watch`).
- Reduced motion: sparklines are static redraws per sample (SVG, no CSS
  animation); nothing pulses.
- Privacy: `audit.appended` carries **summary fields only** (action, actor,
  target, mission id, model/tokens/latency numbers) — never prompt text,
  tool arguments, or results. Full detail stays in the audit table behind
  the admin page.

## 3. Implementation map

- `packages/kernel/src/bridge.ts` — `BusEvent` gains `ops.vitals` and
  `audit.appended` variants (additive; all existing subscribers switch on
  `event.type` and ignore unknowns).
- `apps/server/src/main.ts` — WS client counter; 2.5s vitals sampler
  (cpuUsage delta, memoryUsage, loop-lag via timer drift, uptime, ws count,
  mission status counts via `listMissions`); ring buffer (120) +
  `GET /api/ops/vitals`; sampler publishes to the bus only when sockets are
  connected (idle server stays silent).
- `apps/server/src/audit.ts` — `createAuditSink` additionally publishes the
  safe `audit.appended` summary (llm.call carries model + tokens + latency
  from entry.detail when present; tool.call carries server.tool + tier).
- `apps/web/src/api.ts` — event types + `opsApi.vitals()`.
- `apps/web/src/Watch.tsx` — the strip (collapsed readout + drawer).
- `apps/web/src/App.tsx` — routes `ops.vitals` → vitals buffer and
  `audit.appended` → process feed (neither enters the signal ticker nor RX);
  renders `<Watch/>` on every view; persists open state.

## 4. Status log

- 2026-07-06 · v0.1 — analysis + design written; implemented end-to-end
  (kernel event variants, server sampler + vitals API + audit broadcast,
  WATCH strip with per-page presets, persistence, Playwright-verified).
  Future: per-row expand (drill into audit detail for admins), budget-burn
  marker on the vitals lane, Redis-bus fan-in when multi-process.
