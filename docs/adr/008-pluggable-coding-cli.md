# ADR-008: Pluggable coding CLI for bench.delegate

## Status

Accepted (2026-07-08)

## Context

ADR-002 chose a headless coding CLI (Claude Code) for the EXECUTE phase and recorded the
vendor dependency as a known negative — one of its "reconsider when" triggers was literally
"a customer segment requires fully local execution with no external CLI." That trigger has
arrived: the product must be able to drive the EXECUTE phase with a variety of AI providers,
not only the Anthropic API.

The rest of the stack is already provider-agnostic. The **Model Router** (ARCHITECTURE §3.5,
`packages/kernel/src/model-router.ts`) abstracts Anthropic, OpenAI-compatible (OpenAI /
Ollama / vLLM), and mock behind one interface, with fallback chains and cost-tier profiles —
so every native agent (Interviewer, Planner, Foreman, Reviewer) already runs on any of those
providers by setting its `model` string. The *only* Claude-locked surface was `bench.delegate`,
which hardcoded the `claude` CLI invocation and its stream-json parser.

## Alternatives considered

- **Configurable backend (base-URL passthrough)** — keep the Claude Code CLI, point it at an
  Anthropic-API-compatible gateway (LiteLLM etc.) via `ANTHROPIC_BASE_URL`/token. Cheapest,
  but still "the Claude CLI," and it leans on a translation proxy whose fidelity varies. Kept
  as a complementary option (a deployment can still do this to the `claude` adapter) but not
  the answer to "variety of AI API."
- **Native router path only** — promote the router-driven Foreman + `bench.*` tools to the
  EXECUTE engine and drop the external CLI. Fully provider-agnostic, zero lock, but lower raw
  coding capability than a purpose-built CLI today. Remains the long-term direction (ADR-002's
  own reconsider-trigger) and is not foreclosed by this ADR — it becomes another adapter-or-none
  choice, not a rewrite.
- **Pluggable coding CLI (chosen)** — abstract `bench.delegate` over a small adapter interface
  so *which* CLI is a per-call/per-deployment choice.

## Decision

`bench.delegate` resolves a **`CodingCliAdapter`** (`packages/kernel/src/coding-cli.ts`) by name
instead of hardcoding one CLI. An adapter is two pure functions: `buildCommand(task, {maxTurns})`
→ the headless shell invocation, and `parse(stdout, {code, stderr})` → a common `DelegateResult`
(`{ cli, ok, numTurns?, usage?, result, costUsd?, filesChanged?, reason? }`). Everything else
about delegate is unchanged — same `write_approved` tier gate, same `CommandExecutor.run()` seam,
same wall-clock budget, same honest-refusal-when-no-executor.

Two adapters ship:

- **`claude`** (default) — Claude Code, `--output-format stream-json`; the parser reads the
  terminating `result` event (turns/usage/cost). Anthropic.
- **`aider`** — provider-agnostic (OpenAI / Anthropic / Gemini / Ollama / local); the model is
  chosen at call time via the `DELEGATE_MODEL` env (aider's `--model`), and the provider key
  rides the same ADR-005 secrets path. aider's output is human text, not JSON, so its parser
  reads the footer lines it prints (`Applied edit to …`, `Tokens: … Cost: $…`); it fills fewer
  `DelegateResult` fields (no turn count) rather than faking them.

Adapter differences are expected and honest: `DelegateResult`'s optional fields let a
less-structured CLI report less, and `maxTurns` is advisory (honoured by CLIs that have a turn
cap, ignored by those that don't). The deployment default adapter is overridable via `DELEGATE_CLI`.

The workbench image installs each CLI behind a pinned version ARG and an install toggle
(`INSTALL_CLAUDE_CODE`, `INSTALL_AIDER`) so a deployment can slim the image to just the CLI it
uses. Git-write stays outside every adapter (push/commit go through `bench.git.*`, ADR-002).

## Consequences

- Positive: "variety of AI API" for EXECUTE without giving up the mature-CLI capability;
  no lock to one vendor; adding a third CLI is one adapter file + one image layer, not a
  refactor. Selecting a CLI never bypasses the tier gate (golden-pinned).
- Negative: more than one CLI to keep pinned/upgraded; per-adapter output parsing to maintain;
  the aider layer adds Python to the image when enabled (toggle to skip).

## Verification

The adapter parsers are pure and unit-verified for free (no Docker, no key) by
`scripts/verify-delegate-parse.mjs` — canned claude stream-json and aider footer transcripts.
`scripts/verify-delegate.mjs` is the paid Docker-host check for the Claude adapter. Aider execution
through the CLAUDE page is verified deterministically by `scripts/verify-openai-coding-runtime.mjs`;
its optional paid provider check is `scripts/verify-openai-live.mjs`.

### 2026-07-17 execution-owner amendment

The adapter remains available for parsing and read-only planning, but mutating
`bench.delegate(aider)` is disabled until workflow nodes have a durable execution owner that can
participate in the signed copy-back ledger. The supported OpenAI mutation path is CLAUDE page
Execute, which supplies an immutable run ID and generation, requires the write approval, and
atomically reconciles file and database commits. This narrows the original per-call decision rather
than weakening the workbench boundary to preserve it.

## Reconsider when

- A third provider needs first-class support and the two-adapter shape shows a seam it can't fit
  cleanly (e.g. a CLI whose budgets/streaming don't map to `buildCommand`/`parse`), **or**
- the native router path reaches coding parity on the WP9 golden suite — then it becomes the
  default adapter-or-none and the external CLIs move to opt-in.
