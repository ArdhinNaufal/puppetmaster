# ADR-002 spike record

Protocol: `scripts/spike-adr002.sh` (generates a fresh toy repo per run; nothing committed).

| Date | Half | Environment | Result | Evidence |
|---|---|---|---|---|
| 2026-07-06 | Headless-CLI contract (host) | Claude Code remote dev container, claude CLI 2.1.202, node 22 | **PASS** | `cli_exit=0`, 17 incremental stream-json events (progress-streaming claim), `num_turns=6` within `--max-turns 6` (budget enforcement), `is_error=false` (clean exit), toy test green after run, diff confined to the named file (scope) |
| 2026-07-06 | Container half (`--container`) | Claude Code remote session — Docker **client** present, **no daemon** | **IMPLEMENTED, NOT RUN HERE** | Authored but not executable in this session. Superseded by the run below. |
| 2026-07-06 | Container half — run 1 | Owner's Docker host (node 22.23.1, git 2.39.5, pnpm 11.10.0 — looks like Docker Desktop/macOS) | **4/5 — one harness artifact, no isolation finding** | ✅ toolchain present · ✅ non-root (uid 10001) · ✅ `--network none` egress refused · ✅ resource caps accepted · ❌ **assertion 3** ("check runs inside") failed. Root cause: the harness delivered toy files via a **host `:ro` bind mount** read by the non-root `bench` user — the "other"-read permission fails under Docker Desktop's VirtioFS. This is a scaffold bug, **not** an ADR-005 finding: ADR-005 delivers code via a named volume / in-container clone owned by `bench`, never a host mount. Both runs failed identically (read-permission signature), consistent with the diagnosis. |
| 2026-07-06 | Container half — harness fix | — | **CORRECTED** | Assertion 3 rewritten to create the toy files **inside** the container as `bench` (one `sh -s` heredoc, no host mount, no uid crossing) — the WP3-representative delivery path. |
| 2026-07-06 | Container half — run 2 | Owner's Docker host (same as run 1) | **PASS (5/5)** | `CONTAINER HALF PASS`: toolchain present · non-root (uid 10001) · in-container check exec (fail-before, pass-after) · `--network none` egress refused · `--cpus`/`--memory`/`--pids-limit` accepted. **ADR-002 container half validated; ADR-005 isolation posture confirmed. WP3 unblocked.** |

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
