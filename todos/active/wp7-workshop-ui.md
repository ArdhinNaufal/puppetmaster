# WP7 — Workshop UI surfaces

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP7 · **Size:** M
· **Status:** in progress — WP7a (read/manage surface) landed 2026-07-06

## Done (WP7a)

- [x] WORKSHOP view (`apps/web/src/Views.tsx`): project list + create (name,
      repoRef, gated toggle with its warning), dossier panel (phase strip, todo
      board active/backlog/completed with mission-link badges, artifact reader
      with version tags), verify-checks panel (admin enable requires the
      earned-note — the earned-policy rule in the UI). View registered for all
      roles; rail + palette pick it up automatically.
- [x] NEXUS `WORKSHOP` tray chip (registry.tsx, BUILD category, jumpOnly per
      the v0 convention — an in-pane body is P6-style follow-up work)
- [x] `projectApi` client (projects, artifacts, checks) in api.ts
- [x] Approval-inbox evidence panel (landed with WP4)
- [x] Lint endpoint accepts `projectId` → gated projects get the gated-mode
      linter rules (verified live: gated-without-verify +
      gated-agent-without-verify fire on a gated project's graph)
- [x] Live smoke test against a booted keyless server: setup → gated project →
      spec artifact (REST-path KB mirror confirmed) → check created disabled →
      enable-with-note → gated lint fires both rules

- [x] Research-led **Decision Graph / traceability** increment (2026-07-10):
      durable rationale-bearing artifact/check links, trace-coverage and orphan
      warnings over current artifact versions, advisory next-move/readiness panel,
      in-dossier artifact authoring, admin check creation, accessible project/artifact
      buttons, race-safe project loads, and visible partial-load errors. The graph
      deliberately does not auto-inherit links across spec/plan revisions. Research
      synthesis and deferred discovery-node scope live in
      `docs/WORKSHOP-DECISION-GRAPH.md`.

## Remaining

- [x] Canvas verify-node skin + config inspector: `verify` added to the frontend
      `NodeKind`, `NODE_META` (✓ glyph), `DEFAULT_CONFIG`, and a `.kind-verify`
      rail skin — verify nodes now render on the canvas and appear in the ADD
      palette. The inspector shows a structured form for verify nodes (project id,
      check picker over the check-name list, retries-before-escalate 1–20, optional
      fix-agent) instead of raw JSON. (`FlowNode.tsx`, `Canvas.tsx`, `api.ts`,
      `fui.css`.) Typecheck + web build clean; rendered skin/inspector verified.
- [~] Interview UX — **forcing-section progress meter landed** in the WORKSHOP
      dossier (`GET /api/projects/:id/spec-coverage` → present/thin/missing vs the
      gate's required list; bar + per-section markers). **Restate card deferred** to
      the Command-view interview session once it carries a project link (the
      phase-flow-actions item below).
- [ ] Phase-flow actions in the dossier (start interview / run next todo) —
      needs WP5's EXECUTE machinery (WP3)
- [ ] UAT script in docs/uat/ incl. keyboard/reduced-motion checks — once the
      full flows exist
