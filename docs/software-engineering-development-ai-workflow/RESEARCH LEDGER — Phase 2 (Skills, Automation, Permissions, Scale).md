A. Findings by source
 
8. The Complete Guide to Building Skills (PDF, Jan 2026) — read in full
 
- Skill = folder: SKILL.md (required) + scripts/ + references/ + assets/. Three design principles: progressive disclosure (3 levels: YAML frontmatter always in system prompt → SKILL.md body loaded when relevant → linked files read on demand), composability, portability (same skill works in Claude.ai, Claude Code, API).
- The description field is the single highest-leverage element — must contain WHAT + WHEN (trigger phrases users actually say). Pattern: [What it does] + [When to use it] + [Key capabilities]. Debugging trick: ask Claude "when would you use skill X?" — it quotes the description back.
- Hard rules: exact SKILL.md filename, kebab-case folder names, no XML brackets in frontmatter (injection risk — frontmatter enters system prompt), no "claude"/"anthropic" prefixes, description ≤1024 chars, SKILL.md under ~5,000 words, keep simultaneously enabled skills under ~20–50.
- Testing triad: triggering tests (fires on paraphrases, doesn't fire on unrelated), functional tests, baseline comparison (with-skill vs without: tokens, tool calls, corrections). Honest caveat in the doc itself: success criteria are "aspirational… element of vibes-based assessment."
- Key workflow insight: iterate on a single hard task until Claude succeeds, then extract the winning approach into a skill — skills are crystallized in-context learning.
- 5 patterns: sequential orchestration, multi-MCP coordination, iterative refinement w/ validation scripts, context-aware tool selection, domain-specific intelligence (compliance-before-action). Notable: "Code is deterministic; language interpretation isn't" — bundle validation scripts, not validation prose.
- Undertrigger fix: enrich description keywords. Overtrigger fix: negative triggers ("Do NOT use for…").
 
9. Lessons from building Claude Code: How we use skills (Jun 3, 2026) — Anthropic internal practice, Thariq Shihipar
 
- Hundreds of skills in internal use. 9-category taxonomy: (1) library/API reference, (2) product verification, (3) data fetching/analysis, (4) business-process automation, (5) scaffolding/templates, (6) code quality/review, (7) CI/CD & deployment, (8) runbooks, (9) infrastructure ops. Best skills fit ONE category; straddlers confuse the agent.
- "Verification skills have had the most measurable impact on Claude's output quality internally. It can be worth having an engineer spend a week just making your verification skills excellent." ← This is the strongest single workflow claim in the entire corpus so far. Examples: headless-browser signup-flow drivers, Stripe-test-card checkout verifiers, tmux drivers for TTY apps; have Claude record video of what it tested; programmatic state assertions.
- Writing tips: don't state the obvious (Claude already knows standard syntax — encode only what pushes it off-default, e.g., frontend-design skill bans Inter font/purple gradients); the Gotchas section is the highest-signal content (append-only tables, field-name aliases across services, staging-returns-200-lies); avoid railroading (over-specific instructions break reuse); descriptions are trigger specs for the model, not summaries for humans.
- Advanced mechanics: skills can hold memory (append-only logs, JSON, SQLite; ${CLAUDE_PLUGIN_DATA}), bundled script libraries Claude composes ("spend turns on composition, not boilerplate"), on-demand hooks active only while the skill runs (/careful blocks rm -rf/DROP TABLE/force-push; /freeze restricts edits to one directory), config.json + AskUserQuestion for setup.
- Distribution: check into ./.claude/skills (small teams) → plugin marketplace at scale (every checked-in skill costs context). Governance at Anthropic: organic, sandbox-folder → traction → PR to marketplace; no central committee. Measurement: PreToolUse hook logging skill usage (public gist).
- Evolution model: "Most of our best skills began as a few lines and a single gotcha."
 
10. A harness for every task: dynamic workflows (Jun 2, 2026) — the substance behind your Boris Cherny doc
 
- Claude Code now writes its own JS orchestration harness on the fly (released ~late May 2026; trigger word "ultracode"). This is exactly the "I write loops now" capability from your project file — your Cherny quote now has a documented mechanism.
- Why: single-context execution fails on long/parallel/adversarial tasks via three named failure modes: agentic laziness (declares done at 35/50 items), self-preferential bias (favors own output when judging), goal drift (lossy compaction erodes constraints).
- 6 composable patterns: classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament (pairwise judging — "comparative judgment is more reliable than absolute scoring"), loop-until-done.
- Use cases with real evidence: Bun rewritten Zig→Rust using workflows (external, verifiable via Jarred Sumner's thread — rare non-Anthropic data point); /deep-research skill; CLAUDE.md rule-mining from past sessions; root-cause panels; triage with quarantine pattern (agents reading untrusted content barred from high-privilege actions — prompt-injection defense).
- Costs/controls: significantly more tokens; explicit token budgets promptable ("use 10k tokens"); resumable after interruption; save with "s" → ~/.claude/workflows or distribute via skill (treat as template, not verbatim script). Combine with /loop + /goal.
- Honest counterweight in the article itself: "most traditional coding tasks do not need a panel of 5 reviewers." For your Pro-plan constraint this is critical — workflows are a token furnace.
 
11. Auto mode (Mar 24, 2026)
 
- Permission spectrum now: default (approve everything) → auto mode (classifier reviews each tool call, blocks destructive/exfiltration/malicious, escalates to human on repeated blocks) → --dangerously-skip-permissions (only in isolated environments).
- Auto mode reduces but does not eliminate risk; Anthropic still recommends isolated environments; classifier has false positives and false negatives; small token/latency overhead. Plan-gated (Team/Enterprise/Max research preview — availability will have changed; verify before writing the guide).
 
12. Beyond permission prompts / sandboxing (Oct 8, 2025) — published draft, treat specifics with caution
 
- Core principle worth keeping: real sandboxing requires both filesystem isolation AND network isolation — either alone is escapable (no network iso → exfiltrate SSH keys; no FS iso → escape and gain network). OS-level: Linux bubblewrap, macOS Seatbelt. claude --sandbox.
- Claude Code on the web: cloud sandbox where git credentials never enter the sandbox (proxy holds scoped tokens). Approval fatigue named as the failure mode of pure permission prompts.
 
13. Scaling agentic coding across an engineering org (Oct 15, 2025)
 
- Rollout: 20–50 super-user pilot → hackathon launch → internal champions over external training. Pilot deliverables: slash commands, CLAUDE.md files, automation inventory, support channel.
- Measurement menu: sprint throughput, task-completion time, migration velocity, dev satisfaction, onboarding duration, cross-functional dependency reduction; built-in Activity Metrics. Honest line: lines-of-code "captures activity but not necessarily value."
- TDD as scoping discipline for new users: write tests defining success → implement incrementally → review each step. Prompting habits section is generic but serviceable for the commoner persona (specific errors, env details, expected-vs-actual, sequential prompts, reference earlier work).
- Critical assessment: ~40% of this article is filler (the prompting-habits content repeats universal advice). The pilot→hackathon→champions arc and metrics menu are the extractable value.
 
B. Updated cross-cutting synthesis
 
5. Verification is the second spine of the guide, alongside context. Phase 1 gave us "manage what's in the window"; Phase 2 adds "never trust output without an independent check" — verification skills (most-measurable-impact claim), adversarial-review subagents, Stop-hook test gates, tournament judging, quarantine. Durable principle: Claude checking its own work in the same context is structurally unreliable (self-preferential bias); independence comes from fresh contexts.
6. The automation ladder now has a top rung: conversation → CLAUDE.md → skills/commands → subagents → hooks → dynamic workflows. Your Cherny doc's "write loops, not prompts" is the top of this ladder, not a separate philosophy. But rungs have costs: each step up = more tokens + more setup + more blast radius. Pro-plan users (your stated constraint) should live on rungs 1–4; workflows are Max/API territory for high-value tasks.
7. Persona mapping sharpens: Commoner = rungs 1–2 + default permissions + sandboxed environments (never --dangerously-skip-permissions, arguably never auto mode unsupervised). Developer = rungs 1–4 + verification skills + TDD scoping. Professional = full ladder + org rollout playbook + marketplace governance + metrics.
8. Evidence upgrade: Bun's Zig→Rust rewrite is the first external, verifiable, non-Anthropic workflow success story in the corpus. Add to Phase 3 verification list alongside pwiz-ai.