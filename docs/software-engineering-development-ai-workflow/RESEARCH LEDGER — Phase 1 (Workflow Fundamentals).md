A. Findings by source
1. Onboarding Claude Code like a new developer (Apr 28, 2026) — highest-value article so far
 
- Case: MacCoss Lab / Skyline, 700k-line C# codebase, 17 years old, 200k+ nightly tests. Brendan MacLean (Claude Developer Ambassador).
- Core methodology: treat Claude like a trainee — scoped first project → record what was learned as context → expand scope each iteration. This is the only article with a transferable process, not just feature usage.
- Architecture choice: context lives in a separate versioned repo (github.com/ProteoWizard/pwiz-ai) so it spans branches/time; CLAUDE.md = "lay of the land," skills = expertise. Skills follow "reference, don't embed" (point to a docs knowledgebase, don't duplicate).
- Critical skill design: debugging skill explicitly forces root-cause analysis to break "guess and test" mode; description field uses "ALWAYS load when…" triggers.
- Key quote-worthy principle: context is a project artifact — version it, grow it, maintain it. He claims this is "the part most developers skip, and why most developer success plateaus."
- Concrete outcomes claimed: 1-year-stalled feature finished in 2 weeks; 3-year-frozen Java module updated in <1 day; MCP servers written by Claude for test infra. Caveat: vendor case study, self-reported numbers, no controls. But the pwiz-ai repo is public — primary evidence we can verify in Phase 3.
 
2. Best practices for Opus 4.7 (Apr 16, 2026)
 
- Delegate, don't pair-program: full task spec in turn 1 (intent, constraints, acceptance criteria, file locations); batch questions; minimize user turns (each turn adds reasoning overhead/tokens).
- Effort levels: xhigh default/recommended; max overthinks; medium/low for scoped/cost-sensitive work. Adaptive thinking replaces fixed budgets; steer with prompts ("think carefully…" vs "respond quickly…").
- Positive examples beat "don't do X" instructions. Subagent spawning must now be requested explicitly.
- Critical note for our guide: much of this is model-version-specific and will rot. The durable extract is: front-load specification, minimize interaction turns, steer thinking explicitly. The guide must separate durable principles from version-specific knobs, or it dies with each model release.
 
3. Session management & 1M context (Apr 15, 2026) — core mental model
 
- Context rot: performance degrades as context grows; the model is at its least intelligent right when autocompact fires (end of window) — that's why bad compacts happen.
- Decision table per turn: Continue (context still load-bearing) / Rewind, double-Esc (wrong path — keep file reads, drop failed attempt, re-prompt with learnings) / /compact <hint> (bloated mid-task) / /clear (new task; you hand-write the carry-forward brief) / Subagent (next chunk produces output you only need the conclusion of).
- Rule of thumb: new task = new session. Subagent test: "will I need this tool output again, or just the conclusion?"
- Rewind > correction: rewinding to just-after-file-reads and re-prompting beats "that didn't work, try X."
- /usage exists for tracking limits — directly relevant to your Pro-session constraint.
 
4. How and when to use subagents (Apr 7, 2026)
 
- Subagent = isolated Claude with fresh context; returns only results. Built-ins: general-purpose, plan, explore.
- Use when: research-heavy (10+ files), 3+ independent sub-tasks (parallel), fresh/unbiased review, pre-commit verification, pipeline phases (design→implement→test, handoff via files).
- Don't use when: sequential dependent work, same-file edits (conflict risk), small tasks, too many custom specialists (dilutes auto-routing), agents that must talk to each other (→ agent teams instead).
- Escalation ladder for automation: conversational prompts → custom subagents (.claude/agents/*.md) → CLAUDE.md policy → skills → hooks. "Start conversational, automate later." This ladder is a ready-made progression axis for your three personas.
- Full working examples in article: security-reviewer agent file, deep-review skill, Stop-hook test gate (with infinite-loop guard via stop_hook_active).
 
5. Using CLAUDE.md files (Nov 25, 2025)
 
- CLAUDE.md = persistent context injected into every conversation's system prompt. Contains: project map (tree), dependencies/patterns, standards, common commands, custom tools/MCP usage rules, standard workflows (e.g., explore-plan-code-commit; 4 pre-change questions: investigate first? need plan? what's missing? how tested?).
- /init auto-generates a starter; treat as draft, iterate; # key appends repeated instructions over time. Commit to VCS.
- Keep it concise (it costs context every session); split into referenced sub-files if large. Never put secrets in it. "Each addition should solve a real problem you encountered, not theoretical concerns."
- Custom slash commands in .claude/commands/*.md with $ARGUMENTS; ask Claude to write them.
- Canonical upstream source cited: anthropic.com/engineering/claude-code-best-practices and effective-context-engineering-for-ai-agents — confirms my Phase 4 plan to read the engineering blog originals.
 
6. How to configure hooks (Dec 11, 2025)
 
- 8 lifecycle events: PreToolUse (block/validate/auto-approve), PermissionRequest, PostToolUse (formatters/linters/audit), PreCompact (back up transcript before lossy summarize — pairs directly with the "bad compact" problem in #3), SessionStart (inject git status/TODO as context), Stop (verify completion, force-continue via JSON), SubagentStop, UserPromptSubmit (inject sprint context per prompt).
- Config at 3 levels: .claude/settings.json (project, shared) / ~/.claude/settings.json (user) / .claude/settings.local.json (personal). Matchers: exact, pipe, wildcard, arg patterns Bash(npm test*). Exit 0 = ok, exit 2 = block w/ stderr as reason; structured JSON responses supported. 60s timeout; parallel execution.
- Security: hooks run arbitrary shell with your permissions; edits to hook config require /hooks menu review.
- Persona note: this is professional-engineer territory. A commoner configuring auto-approve hooks is a footgun (silently bypassing the permission system they rely on for safety).
 
7. Complete guide to building skills (Jan 29, 2026) — PENDING
 
- Landing page only. Real asset = PDF (URL above). Claims: skill structure, MCP+Skills patterns, testing/distribution, "15–30 min to first working skill with skill-creator." To read in Phase 2.
 
B. Cross-cutting synthesis (provisional)
 
1. One discipline unifies everything: context engineering. All seven sources reduce to "what is in the model's window, and who decided it." CLAUDE.md = static context, skills = on-demand context, subagents = context isolation, hooks = automated context injection/gating, sessions = context lifecycle. This should be the spine of your guide, not a feature-by-feature tour.
2. There's a natural maturity ladder (conversation → CLAUDE.md → commands/skills → subagents → hooks) that maps cleanly onto your three personas — but not one-to-one. A commoner needs CLAUDE.md and session discipline on day one; hooks possibly never. This is the branching structure that replaces your "for anyone without exception" claim with something defensible.
3. Evidence quality is mixed. Strongest: MacCoss (verifiable public repo). Weakest: all quantitative claims (vendor self-reports, zero controls). The guide should cite mechanisms (which are checkable) over outcomes (which are marketing).
4. Version rot is a real design constraint. Effort levels, defaults, even subagent spawn behavior changed between Opus 4.6→4.7. Your guide needs a "durable principles" layer and a "current knobs" appendix, or it's obsolete in one model cycle.