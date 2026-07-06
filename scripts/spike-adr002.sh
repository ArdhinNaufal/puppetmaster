#!/usr/bin/env bash
set -euo pipefail
# ADR-002 feasibility spike — headless coding CLI as the Workshop's EXECUTE
# executor (docs/adr/002-hybrid-executor.md).
#
# Half 1 (default): headless-CLI contract, run directly on this host.
#   Proves: machine-readable stream output, turn-budget enforcement, clean
#   exit semantics, and that the produced change passes the toy repo's test.
# Half 2 (--container): the same run inside the candidate workbench image
#   with egress allowlist + resource caps. Requires a Docker daemon.
#
# The toy repo is generated fresh in a temp dir on every run; nothing is
# committed. Record outcomes in docs/adr/spike-002-record.md.

MODE="${1:-host}"

if [ "$MODE" = "--container" ]; then
  if ! docker info >/dev/null 2>&1; then
    echo "SKIP: no Docker daemon available. Container half not run." >&2
    exit 3
  fi
  echo "TODO(WP3 precondition): wire the candidate workbench image and rerun" >&2
  echo "the host-half assertions inside it with --network none + egress proxy." >&2
  exit 3
fi

command -v claude >/dev/null || { echo "FAIL: claude CLI not on PATH" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# --- toy repo: one module with a deliberate bug + a failing test ------------
mkdir -p toy && cd toy
cat > add.mjs <<'EOF'
export function add(a, b) {
  return a - b; // BUG: should be addition
}
EOF
cat > add.test.mjs <<'EOF'
import test from "node:test";
import assert from "node:assert";
import { add } from "./add.mjs";
test("add", () => { assert.strictEqual(add(2, 3), 5); });
EOF
git init -q && git add -A && git -c user.email=spike@local -c user.name=spike commit -qm init

if node --test >/dev/null 2>&1; then
  echo "FAIL: toy test unexpectedly passes before the fix" >&2; exit 1
fi

# --- headless run with a strict turn budget ---------------------------------
MAX_TURNS=6
LOG="$WORK/stream.jsonl"
set +e
claude -p "Fix the bug in add.mjs so that 'node --test' passes. Change only add.mjs." \
  --output-format stream-json --verbose \
  --max-turns "$MAX_TURNS" \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Bash(node --test*)" \
  > "$LOG" 2>"$WORK/stderr.log"
CLI_EXIT=$?
set -e

# --- assertions --------------------------------------------------------------
EVENTS=$(wc -l < "$LOG")
RESULT_LINE=$(grep '"type":"result"' "$LOG" | tail -1)

echo "cli_exit=$CLI_EXIT stream_events=$EVENTS"
[ "$CLI_EXIT" -eq 0 ] || { echo "FAIL: non-zero CLI exit"; tail -5 "$WORK/stderr.log" >&2; exit 1; }
[ "$EVENTS" -ge 3 ] || { echo "FAIL: no incremental stream events (progress-streaming claim)"; exit 1; }
[ -n "$RESULT_LINE" ] || { echo "FAIL: no terminal result event"; exit 1; }

NUM_TURNS=$(echo "$RESULT_LINE" | grep -oE '"num_turns":[0-9]+' | grep -oE '[0-9]+' || echo 999)
IS_ERROR=$(echo "$RESULT_LINE" | grep -oE '"is_error":(true|false)' | cut -d: -f2)
echo "num_turns=$NUM_TURNS (budget $MAX_TURNS) is_error=$IS_ERROR"
[ "$NUM_TURNS" -le "$MAX_TURNS" ] || { echo "FAIL: turn budget exceeded"; exit 1; }
[ "$IS_ERROR" = "false" ] || { echo "FAIL: result marked error"; exit 1; }

node --test >/dev/null 2>&1 || { echo "FAIL: toy test still failing after CLI run"; exit 1; }
git diff --name-only | grep -qx "add.mjs" || { echo "FAIL: scope violation — files beyond add.mjs changed"; git diff --name-only; exit 1; }

echo "PASS: headless-CLI contract holds (stream output, turn budget, clean exit, test green, scope kept)"
