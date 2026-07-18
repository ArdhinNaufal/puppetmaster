# Puppetmaster workbench runtime image — ADR-002 / ADR-005 isolation boundary.
#
# This is the base for per-project Workbenches (docs/adr/005-workbench-isolation.md):
# the toolchain the deterministic verify checks need (node/git/pnpm), run as a
# non-root user and with resource caps. The default network is none; provider
# turns that need network access use an internal network plus an allowlisting
# egress proxy.
#
# Both coding CLI layers are pinned below. Baking unpinned CLIs would violate
# "pinned in the image, upgraded deliberately". Override deliberately with the
# CLAUDE_CODE_VERSION or AIDER_VERSION build arguments.

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl util-linux \
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
RUN mkdir -p /workbench /home/bench/.puppetmaster /puppetmaster-lock /puppetmaster-state \
 && chown bench:bench /workbench /home/bench/.puppetmaster /puppetmaster-lock /puppetmaster-state
WORKDIR /workbench

# Journaled, rollback-capable repository copy-back used by the OpenAI/Aider
# execution profile. Node is already part of the base image.
COPY docker/workbench-sync.mjs /usr/local/bin/puppetmaster-sync
RUN chmod 0755 /usr/local/bin/puppetmaster-sync

# --- Pluggable coding CLIs per ADR-002 + ADR-008 (bench.delegate) ------------
# Each CLI is a bench.delegate adapter (packages/kernel/src/coding-cli.ts);
# which one a call uses is a runtime choice. Both are pinned in the image and
# upgraded deliberately (ADR-002), and each install is toggleable so a
# deployment can slim the image to just the CLI it uses.

# claude (Anthropic). Default engine. The current deployment pin is upgraded
# deliberately; override with --build-arg. Installed as root into the global
# npm prefix.
ARG INSTALL_CLAUDE_CODE=true
ARG CLAUDE_CODE_VERSION=2.1.205
RUN if [ "$INSTALL_CLAUDE_CODE" = "true" ]; then \
      npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}; \
    fi

# aider (provider-agnostic: OpenAI / Anthropic / Gemini / Ollama / local). The
# CLAUDE page supplies its persisted session model; DELEGATE_MODEL remains the
# legacy bench.delegate fallback. Installed into an isolated venv (Debian's
# PEP-668 externally-managed env forbids a bare pip install) and symlinked onto
# PATH. Toggle off with --build-arg INSTALL_AIDER=false to skip Python + aider.
ARG INSTALL_AIDER=true
ARG AIDER_VERSION=0.86.1
RUN if [ "$INSTALL_AIDER" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 python3-venv \
      && rm -rf /var/lib/apt/lists/* \
      && python3 -m venv /opt/aider \
      && /opt/aider/bin/pip install --no-cache-dir "aider-chat==${AIDER_VERSION}" \
      && ln -s /opt/aider/bin/aider /usr/local/bin/aider; \
    fi
# -----------------------------------------------------------------------------

USER bench

# The base project container stays available for deterministic checks and
# ordinary bench.exec/git operations. Provider turns use this same image in
# disposable profile containers with an explicit command overriding this CMD.
CMD ["sleep", "infinity"]
