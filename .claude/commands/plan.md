Plan mode only — read, do not modify anything. Task: $ARGUMENTS

Read the relevant spec in specs/ (or docs/AI-SDLC-INTEGRATION-PLAN.md for Workshop work),
the directories the task touches, and answer: where does this change live, what's the
existing pattern to follow (name the file to imitate, don't describe it), and what could
break. Check the dependency matrix in .dependency-cruiser.cjs before proposing any new
cross-package import.

Then write the implementation plan to PLAN.md as an ordered task list. I will edit
PLAN.md before you touch code.

Skip rule (do not ceremony trivial work): if the diff can be described in one sentence,
say so and skip the plan.
