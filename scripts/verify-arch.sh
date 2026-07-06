#!/usr/bin/env bash
set -uo pipefail
# Architecture fitness check with legacy ratchet
# (WP0.4, docs/AI-SDLC-INTEGRATION-PLAN.md; corpus: ai-sdlc-architecture.md §4).
#
# Runs dependency-cruiser against the allowed-imports matrix declared in
# .dependency-cruiser.cjs and fails only if the violation count INCREASES
# past the committed baseline in arch-baseline (ratchet: tolerate current
# count, block increases; burning the baseline down is backlog work).
#
# Current baseline: 0 — the repo started clean, so any violation fails.
#
# Exit codes: 0 = ok (count <= baseline), 1 = violations increased or the
# tool failed to run. Stderr is written for the acting agent to consume.

cd "$(dirname "$0")/.."

BASELINE_FILE="arch-baseline"
BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || echo 0)

OUTPUT=$(pnpm exec depcruise apps/server/src apps/web/src packages/*/src \
  --config .dependency-cruiser.cjs --output-type err 2>&1)
STATUS=$?

# depcruise exits with the number of errors (capped); parse the summary line
# for the real count, fall back to exit status semantics.
COUNT=$(echo "$OUTPUT" | grep -oE '[0-9]+ dependency violations' | grep -oE '^[0-9]+' | head -1)
if [ -z "$COUNT" ]; then
  if [ $STATUS -eq 0 ]; then COUNT=0; else
    echo "verify-arch: could not parse dependency-cruiser output:" >&2
    echo "$OUTPUT" | tail -20 >&2
    exit 1
  fi
fi

if [ "$COUNT" -gt "$BASELINE" ]; then
  echo "ARCH GATE: $COUNT dependency violation(s), baseline is $BASELINE." >&2
  echo "$OUTPUT" | grep -E "error " >&2
  echo "Fix the forbidden import(s) above, or — only with explicit review —" >&2
  echo "update .dependency-cruiser.cjs / arch-baseline (a verifier edit is a" >&2
  echo "reviewed decision, never a fix)." >&2
  exit 1
fi

echo "verify-arch: OK ($COUNT violation(s), baseline $BASELINE)"
exit 0
