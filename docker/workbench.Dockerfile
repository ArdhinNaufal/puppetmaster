# Candidate workbench image — ADR-002 / ADR-005 feasibility spike substrate.
#
# This is the base for per-project Workbenches (docs/adr/005-workbench-isolation.md):
# the toolchain the deterministic verify checks need (node/git/pnpm), run as a
# non-root user, inside a container the host launches with --network none,
# an egress proxy, and resource caps.
#
# The pinned coding CLI layer (bench.delegate, ADR-002) is added in WP3 — baking
# an unpinned CLI here would violate "pinned in the image, upgraded deliberately".
# The commented block below is the exact shape WP3 fills once the version is chosen.

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
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
USER bench

# --- WP3, pinned per ADR-002 (do not enable in the spike image) --------------
# USER root
# RUN npm install -g @anthropic-ai/claude-code@<PINNED_VERSION>
# USER bench
# -----------------------------------------------------------------------------

# Long-lived: the host drives work via `docker exec` (bench.exec/git/delegate),
# not via the entrypoint. Sleep keeps the container up between calls.
CMD ["sleep", "infinity"]
