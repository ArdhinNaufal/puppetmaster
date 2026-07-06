Here is what I'm building: $ARGUMENTS

Ignore the repository name and any existing folder/file names — treat my description
above as the ONLY source of truth for what this feature is. This repo has existing
structure: read the relevant parts of docs/PRD.md, docs/ARCHITECTURE.md, and the code it
names BEFORE interviewing me, so your questions are grounded in what exists.

Before asking me anything, restate in your own words what you understand this feature to
be, and wait for me to confirm or correct it.

Once I confirm, interview me using the AskUserQuestion tool. Dig into the hard parts I
might not have considered — domain rules, security tiers, approval gating, what counts as
"done" — and skip the obvious. Keep interviewing until you can concretely fill EVERY
required section below. If you can't yet write a section concretely, keep asking.

Then write specs/<feature-slug>.md with these required sections:
- Tech stack impact — new dependencies or services this feature needs (be exhaustive)
- Data model — new/changed tables and zod schemas, privacy/retention constraints
- Code architecture:
  * Which packages/apps this touches, and the ONE responsibility of anything new
  * Dependency direction — must satisfy .dependency-cruiser.cjs; name any matrix change
    needed (a matrix change is a reviewed decision + ADR, never a silent import)
  * Size budgets where relevant
- Kernel/bridge integration — events, tools, tiers, approval gating
- UI direction — views/panes affected, FUI grammar constraints (docs/DESIGN-LANGUAGE.md)
- Edge cases & failure handling
- Out of scope — what this feature explicitly will NOT do
- Verification (end-to-end) — concrete steps proving it works: the pnpm commands to run
  (test/typecheck/build/eval), golden-task additions, and behavioral checks
  ("after this, doing X shows Y")

Finally, create one task file per buildable increment in todos/active/ (smallest first),
and record any architecture/scaling decision as an ADR in docs/adr/ (next number,
Nygard format per ADR-000, "Reconsider when" required).
