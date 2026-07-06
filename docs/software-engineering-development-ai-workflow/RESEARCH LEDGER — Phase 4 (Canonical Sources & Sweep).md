A. Findings by source
 
18. Best practices for Claude Code (canonical, live docs at code.claude.com/docs/en/best-practices) — read in full. The single most important document in the corpus.
 
- Framing principle, stated as the basis of "most best practices": the context window is the most important resource to manage; performance degrades as it fills. Track with a custom status line.
- First-listed best practice is verification: "Give Claude a check it can run… It's the difference between a session you watch and one you walk away from." Without a runnable check, you are the verification loop. This confirms the verifier spine from Phases 2–3 at canonical level.
- Verification escalation ladder (new, precise): (1) in-prompt "run the check and iterate" → (2) /goal condition re-checked by a separate evaluator every turn → (3) Stop hook as deterministic gate (Claude Code overrides after 8 consecutive blocks — important limit) → (4) verification subagent / dynamic workflow so "the agent doing the work isn't the one grading it." Have Claude show evidence (test output, screenshots), not assertions.
- Explore → Plan → Code → Commit with plan mode; Ctrl+G opens the plan in your editor for direct edits. Skip planning when "you could describe the diff in one sentence."
- CLAUDE.md include/exclude table (include: commands Claude can't guess, non-default style rules, repo etiquette, env quirks, gotchas; exclude: anything readable from code, standard conventions, frequently-changing info). Pruning test: "Would removing this cause Claude to make mistakes?" Explicit warning: bloated CLAUDE.md files cause Claude to ignore your actual instructions. @path/to/import syntax; placement hierarchy incl. ~/.claude/CLAUDE.md, ./CLAUDE.local.md (gitignored), parent/child dirs for monorepos.
- "Let Claude interview you" — the spec-first workflow: minimal prompt + "interview me using the AskUserQuestion tool… then write a complete spec to SPEC.md," then start a fresh session to execute the spec. "Time spent making the spec precise pays off more than time spent watching the implementation." This is the canonical version of what CrossBeam's lawyer did — and the single most teachable workflow for your commoner persona.
- Session mechanics confirmed current: checkpoints on every prompt (restore conversation/code/both; persist across sessions; not a git replacement), /rewind summarize-from-here, /btw for side questions that never enter context, /rename + claude --continue/--resume, rule of thumb: corrected twice on the same issue → /clear and re-prompt with learnings.
- Skills now absorb old slash commands ($ARGUMENTS, disable-model-invocation: true for manual side-effect workflows). Permissions triad current: auto mode / allowlists / claude --sandbox. Scale-out: claude -p headless for CI, git worktrees, desktop parallel sessions, agent teams, Writer/Reviewer two-session pattern. CLI tools (gh etc.) named the most context-efficient way to touch external services.
 
19. Effective context engineering for AI agents (anthropic.com/engineering, Sep 2025) — read in full. The theory layer.
 
- Context engineering defined as successor to prompt engineering: "what configuration of context is most likely to generate the desired behavior," curated every turn, not written once.
- Why context rot exists (mechanism, not anecdote): n² pairwise attention stretched thin as tokens grow; training distributions favor shorter sequences; result is a performance gradient, not a cliff. Context = "attention budget" with diminishing returns. Goal: "the smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome."
- System prompts at the "right altitude": between brittle hardcoded if-else logic and vague guidance that falsely assumes shared context. Minimal ≠ short.
- Tools: bloated, overlapping tool sets are a top failure mode — "if a human engineer can't definitively say which tool should be used, an agent can't be expected to do better." Few-shot: curate diverse canonical examples, don't stuff edge-case laundry lists.
- Just-in-time retrieval: keep lightweight identifiers (paths, queries, links) and load data at runtime, rather than pre-loading everything; file names/folder hierarchies/timestamps are signals. Claude Code is explicitly a hybrid: CLAUDE.md dropped in up front + glob/grep just-in-time. "Do the simplest thing that works."
- Three long-horizon techniques: compaction (safest form = tool-result clearing; tune for recall first, then precision), structured note-taking (NOTES.md / to-do lists / the Claude-plays-Pokémon memory example — exactly what pwiz-ai's todos/ directory implements), and sub-agent architectures (subagent burns 10k+ tokens exploring, returns 1–2k summary).
 
20. Running an AI-native engineering org (Jun 3, 2026) — via search extracts of Fiona Fung's Code w/ Claude talk + article
 
- Central thesis: when agentic coding becomes the org default, "the tool isn't the hard part — your processes are." Coding throughput stops being the constraint; the bottleneck migrates to verification, code review, security, cross-functional alignment, and maintainability. Third independent corroboration of the verification spine, now at org level.
- Role reshaping: PMs code; engineers take on content/design. Hiring indexes on (a) creative builders with product sense and (b) deep systems expertise — explicitly not raw throughput ("the models handle that").
- Disposition: full article fetch skipped — extracts captured the thesis; the talk video (YouTube IA5LWIGqnyM) exists if Phase 5 needs depth.
 
B. Sweep dispositions (every remaining article accounted for)
| Article | Disposition | Reasoning |
|----------|--------|--------|
| The founder's playbook (May 14) | Extract-only | Snippet shows a 4-stage framework (Idea/MVP/Launch/Scale) remapped for 2026 — useful skeleton for a startup-flavored persona track, but framework-level, no novel mechanism. |
| How three YC startups built (Nov 17) | Skipped | Persona evidence; superseded by stronger primary evidence (repos) from Phase 3. |
| COBOL modernization (Feb 23) | Skipped with caveat | Legacy is core to your "any state" claim, but the MacCoss 17-yr/900k-LOC case covers legacy with verifiable primary evidence; COBOL piece is a vendor cost-argument. If the guide makes mainframe-specific claims, revisit. |
| Cybersecurity team platform (May 12)| Skipped | Single internal case; verification/org patterns already triple-corroborated. |
| Bringing Code Review (Mar 9) | Skipped | Feature now covered in canonical docs (custom harnesses mention in #10). |
| Improving skill-creator (Mar 3) | Skipped | Testing content subsumed by Skills PDF ch. 3. |
| Intro to agentic coding (Oct 30) / How to create Skills (Nov 19) / Key benefits (Dec 1) / 8 trends (Jan 21) / remaining Tier 3 | Skipped | Introductory/SEO/announcement content; zero unique mechanisms vs. corpus. |
| Bun Zig→Rust X thread | Deferred | JS-walled; cite as "external claim, verifiable via Jarred Sumner's thread" rather than verified. |
 
 
Honest limitation of the whole corpus: ~90% Anthropic-published. The verifier counterweights are the two cloned repos (pwiz-ai, cc-crossbeam) and the Bun external claim. The guide must present vendor outcome numbers as claims, mechanisms as checkable, and the convergent architecture (synthesis #10) as the strongest evidence class.
 
C. Final synthesis additions
 
12. The two spines are now canonical, not just inferred: context management ("the most important resource") and verification ("the first best practice") are the top-level organizing principles in Anthropic's own canonical doc, matching what Phases 1–3 derived independently. The guide's architecture should be: Pillar 1 Context, Pillar 2 Verification, Pillar 3 the automation ladder, with persona tracks branching across all three.
13. Spec-first ("interview me → SPEC.md → fresh session") is the bridge between personas. It's the canonical workflow, it's what the lawyer actually did, and it's the commoner's entry point that scales unchanged to professional use.
14. Bottleneck migration is the professional persona's frame: orgs shouldn't optimize coding throughput (solved) but verification capacity, review process, and ownership norms.