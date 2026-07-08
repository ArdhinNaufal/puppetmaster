# Candidate workbench image — ADR-002 / ADR-005 feasibility spike substrate.
#
# This is the base for per-project Workbenches (docs/adr/005-workbench-isolation.md):
# the toolchain the deterministic verify checks need (node/git/pnpm), run as a
# non-root user, inside a container the host launches with --network none,
# an egress proxy, and resource caps.
#
# The coding CLI layer (bench.delegate, ADR-002) is pinned below via the
# CLAUDE_CODE_VERSION build ARG — baking an unpinned CLI would violate "pinned
# in the image, upgraded deliberately". Override deliberately at build time:
#   docker build --build-arg CLAUDE_CODE_VERSION=<v> -f docker/workbench.Dockerfile .

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (bundled with node); no network install needed at build.
RUN corepack enable

# Non-root workbench user. The per-project volume mounts at /workbench (ADR-005:
# named volume, no host mounts); code the container runs never runs as root.
RUN useradd --create-home --uid 10001 bench

# /workbench must be owned by bench: a fresh named volume inherits the image
# mount-point's ownership on first mount. WORKDIR alone creates it root-owned,
# so the non-root user could not write there — checks that create files (e.g.
# `node --test` fixtures) would fail silently. Own it before the volume mounts.
RUN mkdir -p /workbench && chown bench:bench /workbench
WORKDIR /workbench

# --- Pinned coding CLI per ADR-002 (bench.delegate) --------------------------
# Pinned in the image, upgraded deliberately (ADR-002). The default is the
# version the ADR-002 spike ran successfully (docs/adr/spike-002-record.md);
# override with --build-arg CLAUDE_CODE_VERSION=<v>. Installed as root (global
# npm prefix), then we drop back to the non-root workbench user.
ARG CLAUDE_CODE_VERSION=2.1.202
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
# -----------------------------------------------------------------------------

USER bench

# Long-lived: the host drives work via `docker exec` (bench.exec/git/delegate),
# not via the entrypoint. Sleep keeps the container up between calls.
CMD ["sleep", "infinity"]
