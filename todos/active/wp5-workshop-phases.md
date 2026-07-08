# WP5 — Workshop phases as agent behaviors

**Source:** docs/AI-SDLC-INTEGRATION-PLAN.md §6/WP5 · **Size:** M · **Needs:** WP2–WP4
· **Status:** in progress — WP5a (workbench-free increment) landed 2026-07-06

## Done (WP5a)

- [x] **Theater refusal as a deterministic gate:** `spec-sections` check (DB-native,
      second builtin check) — the newest spec version must contain every required
      section with concrete content; missing/thin sections fail the gate with the
      section list as evidence and a re-interview instruction. Required sections
      default to the corpus list, overridable per project via the check's `command`
      (JSON array). Golden evals: theater-refusal + pass-and-mirror (pass^3).
- [x] **KB mirror (ADR-004):** spec + learning artifacts mirror into the KB on write
      (tool path and REST path), one live document per project+kind+title keyed by
      `source`, replaced on each new version. Best-effort — a mirror failure never
      loses the artifact write. Eval pins exactly-one-mirror-at-v2.
- [x] **Builtin Workshop agents seeded** (category `workshop`): Interviewer
      (restate-first contract, forcing sections, done = spec-sections passes),
      Foreman (one todo at a time, artifact sync duties, never edits verifiers),
      Reviewer (fresh context via agent.ask, named failure classes, read_auto).

## Remaining (needs WP3 workbench and/or real-model sessions)

- [~] Command-view interview UX — **forcing-section progress meter landed** (WORKSHOP
      dossier; live coverage from the newest spec vs the same required list the
      spec-sections gate uses, via `sectionCoverage`/`resolveRequiredSections` shared
      out of `runSpecSections` so meter and gate never disagree). **Restate card
      deferred**: its home is the Command-view interview session, which needs the
      project↔conversation link (WP7 phase-flow actions, blocked on EXECUTE) — a
      name-matched card now would be speculative.
- [x] PLAN phase (read-only workbench explore → editable plan artifact; skip affordance) —
      **landed 2026-07-08.** `Workshop Planner` builtin agent seeded (category `workshop`,
      between Interviewer and Foreman): reads the spec first, explores the repo read-only
      (least-privilege grants — `project.*` + only `bench.read`/`git.status`/`git.diff`,
      never a mutating bench tool), writes an editable `plan` artifact (Approach / Increments
      in build order / Risks & unknowns / Verification), and carries the skip affordance
      (trivial change ⇒ one-line plan + skip rationale, refuse planning theater). Foreman
      updated to read the plan and follow its increment order (diverge ⇒ back to PLAN, not
      improvise). Golden task `workshop-plan-artifact-editable-versioned` pins the plan
      lifecycle (v1→v2 supersede chain, newest current) and locks that plan is *not*
      KB-mirrored (ADR-004 stays spec+learning — no semantic-search consumer yet). Suite
      23→24 at pass^3. Judgment quality (does it plan *well*) needs real-model sessions —
      deferred with the other agent-behavior evals, same as Interviewer/Foreman/Reviewer.
- [ ] EXECUTE supervised template (`/next` contract via `bench.delegate`)
- [ ] EXECUTE gated template (`/loop` contract; mode chooser asks the pass@k/pass^k
      question; refuses without enabled verify checks — linter rule exists, wire the mode)
- [ ] RECORD orchestration (learnings + todo completion + ADR-on-accept mirror +
      skill-extraction proposal into procedural memory)
- [ ] Refactor project variant (coverage precondition, characterization route)
- [ ] End-to-end golden scenario with independence trajectory-asserted (builder ≠
      reviewer agent id) — needs the real EXECUTE path
