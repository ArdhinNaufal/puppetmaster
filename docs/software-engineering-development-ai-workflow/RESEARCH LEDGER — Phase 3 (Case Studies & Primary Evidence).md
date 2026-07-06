A. Findings by source
 
14. Non-technical PM case: Kostiantyn Vlasenko / Respiro (May 1, 2026)
 
- Claim: zero code experience → iOS app live on App Store, hundreds of users, 15+ specialized subagents (TCA architect, Swift dev, Metal specialist, code reviewer), built in 72h hackathon then ~6 weeks to App Store.
- Transferable techniques for the commoner persona: (a) screenshot-driven navigation of complex UIs ("what should I press here?") — vision as the unlock for non-developers; (b) PM skills transfer directly to agent orchestration ("managing agents like people"); (c) painless pivot — React Native → Swift rewrite in hours, meaning early tech choices are no longer fatal for novices; (d) Claude guided App Store submission, Sentry, Amplitude, Meta API setup — the non-coding shipping work.
- Critical caveats: "Non-technical" is overstated — 10 years PM at a game company, already used Claude for work automation, watched his engineering team use Claude Code daily. He had high process maturity and domain adjacency. Also internal tension in the article: "built in 72 hours" vs "just under six weeks" idea-to-store (the 72h was the hackathon MVP). Use him as evidence for "process-skilled non-coder," NOT "anyone without exception." A true zero-context commoner lacks his scaffolding.
 
15. Hackathon winners, Built with Opus 4.6 (Apr 20, 2026)
 
- Winners: CrossBeam (Mike Brown, personal injury lawyer — permit-correction agents, 1st), Elisa (Jon McBee, professional SWE — block-based kid IDE, 30h/76 commits/39k LOC/1,500 tests), PostVisit.ai (Michał Nedoszytko, cardiologist), TARA (Kyeyune Kazibwe, Uganda Ministry of Works — dashcam→infrastructure appraisal), Conductr (Asep Bagja Priandana, musician — real-time MIDI bandmate).
- Headline claim: "4 out of 5 winners were not professional developers." Critical correction: the cardiologist has been building healthcare software for 20 years and previously shipped a deployed product. Functionally, at least 2 of 5 are developers. The defensible claim is "domain experts without traditional SWE job titles," which is weaker but real.
- Repos for verification: mikeOnBreeze/cc-crossbeam, zoidbergclawd/elisa, Kye256/tara-transport-assessment, nanassound/conductr.
- Notable workflow detail: Mike Brown — "prompt Claude Code, then have Claude create the tests… I didn't write a single line of code. I didn't even read a line of code."
 
16. PRIMARY EVIDENCE: pwiz-ai repo inspection (cloned, June 12 2026) — blog claims verified, plus findings the blog omits
 
- Structure confirmed: 15 skills, 41 slash commands, 3 hooks, plus CLAUDE.md, MEMORY.md, CRITICAL-RULES.md, STYLEGUIDE.md, WORKFLOW.md, and a todos/ directory (15 active / 51 completed).
- debugging skill frontmatter exactly as blogged: description: ALWAYS load when investigating bugs, failures, or unexpected behavior - ensures root cause analysis before attempting fixes. Body includes a cycle-time strategy table (<1 min → printf/bisection; 1–60 min → batch diagnostics) and "First Questions" (reproducible? cycle time? reducible? confidence?).
- Finding the blogs never mention — the repo's stated core principle, repeated in multiple files: "Trust comes from verifiers, not from the LLM. Every rule below is intended to be enforced by a build, a test, or an inspection — not by the model reading and remembering. When a rule's verifier is weak, the rule will drift; strengthen the verifier rather than the wording." This independently corroborates the Phase 2 "verification is the second spine" synthesis, from a non-Anthropic practitioner.
- Second omitted finding: the todos/ directory is a versioned, persistent task system (active/backlog/completed + STARTUP.md). The session-management blog said plans don't persist across sessions; MacLean's answer was to make them repo artifacts. 51 completed todo files = an audit trail of AI-assisted work.
- Third: hooks include Inject-PathBasedSkill.ps1 — auto-injecting the right skill based on which file paths are touched (skill routing by location, not just description matching) — and Deny-DirectBuildTest.ps1 (forcing builds through sanctioned scripts).
- CLAUDE.md content surprise: it's dominated by environment mechanics (Git Bash vs pwsh quirks, Windows path mangling), not project lore. Project knowledge lives in MEMORY.md; bare constraints in CRITICAL-RULES.md ("NO async/await", CRLF, .resx localization). Layered context files, each with one job.
- Discrepancy: MEMORY.md says 900k LOC / 8 developers; blog said 700k. Repo is more current; treat blog numbers as stale.
 
17. PRIMARY EVIDENCE: cc-crossbeam repo inspection (cloned, June 12 2026)
 
- The lawyer's repo contains 16 dev-side skills in .claude/skills/ (incl. frontend-design, react-best-practices, long-running-agent, skill-creator, cc-guide) and 9 domain skills in server/skills/ (adu-corrections-flow, california-adu, city-specific skills) — i.e., skills shipped as the product's runtime logic, not just dev tooling. That's a pattern none of the blogs describe: skills as application architecture.
- Skill descriptions are sophisticated and orchestration-aware (e.g., adu-city-research declares three modes and different behavior "when invoked by an orchestrator").
- docs/ contains spec.md, plans/, learnings-agents-sdk.md, learnings-sandbox-testing.md, a DESIGN-BIBLE.md, and design-directions/ with 13 iterated design screenshots.
- Critical implication: "I didn't read a line of code" is literally true and strategically misleading. Brown didn't read code — he wrote specifications, skills, design bibles, and learnings documents. The commoner persona's real work is spec-and-context engineering, not prompting. This is the single most important calibration for your "anyone without exception" goal: the floor isn't coding skill, it's the ability to write precise structured English and iterate systematically.
 
B. Updated cross-cutting synthesis
 
9. The "non-technical" success stories all share hidden prerequisites: process discipline (PM/legal/medical professionals), domain expertise, and willingness to produce written artifacts (specs, skills, todos). The guide's commoner track must teach artifact discipline, not prompting tricks — that's the actual replicable mechanism across Vlasenko, Brown, and MacLean.
10. Convergent architecture across all primary evidence: every successful project, from the 17-year 900k-LOC lab to the 72-hour hackathon app, ends up with the same shape — versioned context files + skill library + persistent task/todo artifacts + verification gates. This convergence (arrived at independently) is stronger evidence than any single case study.
11. Verifier principle now has independent corroboration (pwiz-ai's "trust comes from verifiers" + Anthropic's verification-skills claim + dynamic workflows' adversarial patterns). This should be elevated to a first-class pillar of the guide.