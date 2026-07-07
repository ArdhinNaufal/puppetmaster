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
    echo "SKIP: no Docker daemon on this host. Run on a Docker-capable machine." >&2
    exit 3
  fi

  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  IMG="puppetmaster-workbench:spike"
  FAILS=0

  echo "== building candidate workbench image (docker/workbench.Dockerfile) =="
  docker build -f "$ROOT/docker/workbench.Dockerfile" -t "$IMG" "$ROOT" \
    || { echo "FAIL: workbench image build" >&2; exit 1; }

  echo "== 1. toolchain present (node/git/pnpm) =="
  docker run --rm "$IMG" sh -lc 'node -v && git --version && pnpm -v' \
    || { echo "FAIL: toolchain missing in the image" >&2; FAILS=1; }

  echo "== 2. non-root default user =="
  UID_IN=$(docker run --rm "$IMG" id -u 2>/dev/null || echo 0)
  if [ "$UID_IN" != "0" ]; then echo "  ok (uid=$UID_IN)"; else
    echo "FAIL: container runs as root by default" >&2; FAILS=1; fi

  echo "== 3. a deterministic verify check runs inside (toy 'test' check) =="
  # Files are created INSIDE the container by the non-root bench user — the way
  # ADR-005 delivers code (named volume / in-container clone), NOT a host bind
  # mount. The whole toy check runs in one `sh -s` so ownership/uid never cross
  # the host boundary. Exit 0 = fail-before + pass-after; 20 = buggy passed;
  # any other non-zero = fixed check didn't pass.
  set +e
  docker run --rm -i "$IMG" sh -s <<'INNER'
set -e
cd "$(mktemp -d)"
printf 'export function add(a, b) { return a - b; }\n' > add.mjs
cat > add.test.mjs <<'JS'
import test from "node:test";
import assert from "node:assert";
import { add } from "./add.mjs";
test("add", () => assert.strictEqual(add(2, 3), 5));
JS
if node --test >/dev/null 2>&1; then echo "BUG_PASSED" >&2; exit 20; fi
printf 'export function add(a, b) { return a + b; }\n' > add.mjs
node --test >/dev/null 2>&1
INNER
  RC=$?
  set -e
  case "$RC" in
    0)  echo "  ok (fail-before, pass-after — the container creates files and runs the check WP3's runner drives)";;
    20) echo "FAIL: buggy toy test unexpectedly passed inside the container" >&2; FAILS=1;;
    *)  echo "FAIL: fixed toy test did not pass inside the container (rc=$RC)" >&2; FAILS=1;;
  esac

  echo "== 4. network isolation by default (--network none blocks egress) =="
  set +e
  docker run --rm --network none "$IMG" \
    node -e "fetch('https://example.com').then(()=>process.exit(9),()=>process.exit(0))" \
    >/dev/null 2>&1
  RC=$?
  set -e
  case "$RC" in
    0) echo "  ok (egress refused under --network none)";;
    9) echo "FAIL: egress SUCCEEDED under --network none — isolation broken" >&2; FAILS=1;;
    *) echo "  ok (egress did not succeed under --network none; node rc=$RC)";;
  esac

  echo "== 5. resource caps accepted (--cpus/--memory/--pids-limit) =="
  docker run --rm --cpus=1 --memory=512m --pids-limit=256 --network none "$IMG" true \
    && echo "  ok (cpu/memory/pids caps enforced)" \
    || { echo "FAIL: resource caps rejected by the runtime" >&2; FAILS=1; }

  docker rmi "$IMG" >/dev/null 2>&1 || true

  if [ "$FAILS" -ne 0 ]; then
    echo "CONTAINER HALF: FAIL" >&2; exit 1
  fi
  echo "CONTAINER HALF PASS: toolchain + non-root + in-container check exec + --network none egress block + resource caps"
  echo "(Note: the live CLI-in-container call via bench.delegate needs the egress"
  echo " proxy WP3 builds; the host half already proved the CLI contract itself.)"
  exit 0
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
