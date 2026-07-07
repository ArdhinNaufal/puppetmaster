# ADR-002 spike record

Protocol: `scripts/spike-adr002.sh` (generates a fresh toy repo per run; nothing committed).

| Date | Half | Environment | Result | Evidence |
|---|---|---|---|---|
| 2026-07-06 | Headless-CLI contract (host) | Claude Code remote dev container, claude CLI 2.1.202, node 22 | **PASS** | `cli_exit=0`, 17 incremental stream-json events (progress-streaming claim), `num_turns=6` within `--max-turns 6` (budget enforcement), `is_error=false` (clean exit), toy test green after run, diff confined to the named file (scope) |
| 2026-07-06 | Container half (`--container`) | Claude Code remote session — Docker **client** present, **no daemon** (`/var/run/docker.sock` absent) | **IMPLEMENTED, NOT YET RUN HERE** | The `--container` branch is now real (`scripts/spike-adr002.sh` + `docker/workbench.Dockerfile`), authored but not executable in this session. On a host where a user ran it, the daemon *was* reachable and the branch printed its (former) TODO stub — that stub is now replaced. **Awaiting a real run on a Docker-capable host** to record PASS/FAIL. |

**What the container half now validates** (5 assertions; exit 0 only if all hold, exit 3
only when no daemon — so it does real work on any Docker host):

1. Toolchain present in the image — `node`, `git`, `pnpm` (the substrate the verify
   checks need).
2. Non-root default user (uid 10001 `bench`) — no container process runs as root.
3. A deterministic check executes inside — the toy `test` fails on the planted bug and
   passes once fixed, run via `node --test` in the container (the exact mechanism WP3's
   shell-backed `CheckRunner` drives).
4. Network isolation by default — a `fetch()` to an external host under `--network none`
   is refused (ADR-005's default-closed egress; the assertion only fails if egress
   *demonstrably succeeds*).
5. Resource caps accepted — `--cpus` / `--memory` / `--pids-limit` are enforced by the
   runtime.

The live CLI-in-container call (`bench.delegate`) is deliberately **out of the spike**: it
needs the pinned CLI layer (ADR-002, commented in the Dockerfile) plus the egress proxy WP3
builds. The host half already proved the CLI contract itself on the same node runtime.

Notes for WP3: `--output-format stream-json --verbose` is the trace-feed contract;
`--max-turns` is the turn budget — the workbench must add wall-clock and token caps on
top (the CLI reports `usage`/cost in the terminal result event, usable for the ledger).
`--permission-mode acceptEdits` + an explicit `--allowedTools` list is the in-container
permission posture; push/git-write stays outside the CLI's allowed tools and goes through
`bench.git` gating instead.
