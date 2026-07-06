Refactor the following: $ARGUMENTS

BEHAVIOR-PRESERVING CONTRACT — non-negotiable:
1. Run the FULL suite FIRST: `pnpm test` (and `pnpm eval` if the target is kernel/eval
   code). Record the results (pass/fail per test, total count) as the "before" results.
2. Check test coverage of the refactor target. If the target area is effectively
   uncovered: STOP — write characterization tests first (run the code, observe actual
   outputs, assert those outputs — current behavior, not desired behavior) in a separate
   preparatory commit. Only then refactor.
3. Refactor in small steps. Each step is a single nameable transformation, compiles
   (`pnpm typecheck`), and passes the full suite. No observable behavior change.
4. After ALL steps: rerun the suite. Results MUST match the "before" results exactly.
   If a previously-passing test fails, you changed behavior — revert the step, not the
   test.
5. NEVER edit test expectations in a refactor commit. A needed test change = a behavior
   change = a separate non-refactor commit. Only NEW characterization tests are exempt
   (step 2, preparatory commit).

SCOPE LOCK: modify only files in the named target. Issues noticed outside it go in a
"noticed but not changed" list at the end — do NOT fix them here. The target is exactly
what $ARGUMENTS names; if ambiguous, ask before starting.

Also run `./scripts/verify-arch.sh` after — a refactor must not change the dependency
matrix or arch-baseline.

After completing, show: before/after test results, the list of transformations applied
(one line each), and target coverage before/after.
