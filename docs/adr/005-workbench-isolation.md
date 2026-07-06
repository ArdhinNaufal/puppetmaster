# ADR-005: Workbench isolation — one container per project, sibling-run, default-closed

## Status

Accepted (WP1 decision, 2026-07-06)

## Context

The workbench executes cloned third-party code, package installs, tests, and (per ADR-002)
a headless coding CLI — arbitrary code execution, the largest security surface in the
plan. Puppetmaster deploys local-first via Docker Compose on the team's own server
(PRD §8); the corpus's sandbox rule is filesystem **and** network isolation, since either
alone is escapable.

## Alternatives considered

- **Ephemeral container per exec** — rejected: loses incremental state (node_modules,
  build caches) making every test run cold-start slow; clone-per-exec hammers the remote.
- **Worker threads / chroot in the server process** — rejected: insufficient isolation for
  arbitrary code; one escape owns the kernel process and its vault key.
- **MicroVMs (Firecracker) / gVisor by default** — deferred: operationally heavy for
  small-team self-hosting; gVisor noted as an opt-in hardening runtime where installed.

## Decision

One long-lived container per project, launched as a **sibling container** via the host
Docker socket (the compose deployment grants the server a socket proxy limited to
create/start/stop/remove — never raw socket exposure to workbench code). Properties:

- **Network:** `--network none` by default; egress goes through a per-workbench proxy
  sidecar enforcing the project's declared allowlist (registry, VCS host). Default-closed.
- **Filesystem:** a named volume per project for the repo + caches; no host mounts.
- **Identity/limits:** non-root user, read-only root FS except the volume, CPU/mem/pids
  caps, wall-clock cap per `bench.exec`.
- **Secrets:** vault-resolved, workbench-scoped credentials injected at spawn only
  (`{{credential:NAME}}` — same contract as MCP servers); never written to the volume.
- **Lifecycle:** create on first EXECUTE; suspend (stop) when idle; `bench.destroy` is
  destructive-tier (always confirmed). Volume survives suspend, dies with destroy.
- **Image:** pinned Workshop image (node/git/pnpm + pinned coding CLI per ADR-002),
  versioned in the repo, rebuilt deliberately.

## Consequences

- Positive: warm caches make gated loops fast; the isolation story is auditable (socket
  proxy scope + compose file); matches the existing sidecar pattern for MCP connectors.
- Negative: requires the Docker socket proxy on the host — a documented deployment
  requirement; desktop/Tauri single-user mode needs a follow-up story (out of v1 scope).

## Reconsider when

- The container spike half of ADR-002 fails on the pinned image, or
- a security review/incident shows sibling-container isolation insufficient → escalate to
  gVisor/microVM runtime, or
- single-user desktop mode ships and needs a daemonless runtime (podman/containerd
  embedded) — revisit the socket-proxy assumption.
