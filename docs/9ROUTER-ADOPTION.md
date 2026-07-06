# 9Router Concept Study — Adoption Analysis for Puppetmaster

**Date:** 2026-07-06 · **Status:** Stages 9A ✅ + 9B ✅ executed & e2e-verified; 9C awaiting
owner go-ahead (one stage per explicit command, same loop as RESEARCH-ROADMAP.md: build
green → e2e verify → docs → commit/push → owner review) · **Branch:** `claude/9router-platform-research-2q0bvz`

---

## 1. What 9Router is

[9Router](https://github.com/decolua/9router) (decolua/9router, ~19.8k★, MIT, Node 20 +
Next.js 16 + SQLite) is a **local AI routing proxy** for coding tools. Claude Code, Codex,
Cursor, Cline, etc. point at one OpenAI-compatible endpoint (`/v1/chat/completions`), and
9Router routes each request across **40+ providers / 100+ models**.

Core concepts:

| # | Concept | Mechanism |
|---|---------|-----------|
| C1 | **Unified proxy endpoint** | One OpenAI-compatible API; N×N format translation (OpenAI ↔ Claude ↔ Gemini ↔ Vertex ↔ Ollama …) |
| C2 | **3-tier cost-aware fallback** | Subscription (Claude/Codex/Copilot OAuth) → Cheap (GLM/MiniMax ~$0.2–0.6/1M) → Free (Kiro, OpenCode). Cascade on quota exhaustion or error |
| C3 | **Combos** | Named, reusable model stacks with explicit fallback order (`premium-coding: cc/opus → glm/glm-5.1 → kr/sonnet`) selectable as a "model" |
| C4 | **Quota/health tracking** | Per-provider usage, reset countdowns (5h/daily/weekly/monthly), exhausted providers skipped until reset |
| C5 | **RTK Token Saver** | Compresses tool outputs (git diff, grep, ls, logs) with type-specific filters before they reach the model; claimed 20–40% input-token savings; failed compression falls back to raw |
| C6 | **Multi-account rotation** | Load-balancing across multiple OAuth accounts/API keys per provider |
| C7 | **Prompt-side savers** | "Caveman mode" (terse-output prompt injection, −65% output tokens), "Ponytail" (YAGNI coding-style enforcement) |

## 2. Flaws & gaps in 9Router itself

- **F1 — ToS violation at the core.** The "subscription tier" works by harvesting OAuth
  tokens from Claude Code / Codex / Copilot and replaying them programmatically. Providers
  detect and ban this ([issue #365](https://github.com/decolua/9router/issues/365) "disabled
  for violation of Terms of Service", [issue #375](https://github.com/decolua/9router/issues/375)
  "Is Anthropic banning proxy usage?"; parallel bans at
  [CLIProxyAPI #2244](https://github.com/router-for-me/CLIProxyAPI/discussions/2244)).
  Reported ban latency for rotated accounts: under a day.
- **F2 — Credential-bearing infrastructure with weak defaults.** It stores OAuth sessions,
  API keys, and request logs in local SQLite; default dashboard password is `123456`;
  `REQUIRE_API_KEY` is opt-in for exposed deployments. No RBAC, no audit trail, no
  encryption-at-rest story.
- **F3 — Silent quality substitution.** A request "for" Opus may be served by a free Qwen
  variant with no caller-visible contract. Fine for hobby coding; unacceptable where the
  model tier is part of a trust decision (e.g. an agent authorized for write actions).
- **F4 — Treadmill maintenance.** Provider protocols, model IDs, streaming formats, and
  OAuth paths change continuously; the N×N translation matrix must be patched forever.
- **F5 — Lossy compression without provenance.** RTK rewrites tool outputs before the model
  sees them; there is no audit of what was removed, which collides with any
  reproducibility/eval requirement.

## 3. Fit against Puppetmaster

Puppetmaster is not a proxy — it is a local-first agent-OS + workflow platform with its own
Model Router (ARCHITECTURE.md §3.5) that already covers a chunk of 9Router's surface:

| 9Router concept | Puppetmaster today | Verdict |
|---|---|---|
| C1 proxy endpoint / format translation | Internal provider abstraction (Anthropic/OpenAI-compat/Ollama/vLLM/mock); no external endpoint needed | **Skip** — we consume models, we don't front them. N×N translation is F4 treadmill |
| C2 ordered fallback | Stage 8 fallback chains (`"claude-sonnet-5\|openai/gpt-5\|mock"`), per-model failure counts, `servedBy` audit | **Partially shipped.** Missing: cost-class semantics + quota-aware skip (see C4) |
| C3 combos | Chains are inline strings copy-pasted per agent/workflow | **Adopt** — named workspace-level *router profiles* (Stage 9A) |
| C4 quota/health tracking | Failures counted, but every call still retries dead providers serially; budgets gate on our own spend, not provider quota state | **Adopt** — health/cooldown-aware candidate skip (Stage 9B) |
| C5 RTK token saver | Tool results enter agent context verbatim (inside untrusted-data envelopes); large MCP outputs burn context | **Adopt with provenance fix** — compact into context, keep raw in the step trace (Stage 9C) |
| C6 multi-account rotation | — | **Reject** — only exists to evade per-account limits (F1) |
| OAuth subscription harvesting | Vault holds real API keys | **Reject** — ToS violation, ban risk, reputational poison for a team product with an audit trail |
| C7 prompt savers | Personas are owner-authored | **Skip** — a persona snippet, not a platform feature |

## 4. Pros & cons of adoption

**Pros**
- Named profiles kill chain-string duplication and give admins one place to set routing
  policy (incl. cost posture) for the whole workspace.
- Health-aware skip converts "try dead provider, wait for timeout, then fall back" into an
  instant route-around — directly improves tick latency during provider outages, and makes
  the Stage 8 failure accounting actionable instead of merely visible.
- Tool-output compaction attacks the single biggest token cost in tool-using agents; unlike
  9Router we can do it **without losing audit** because mission steps already snapshot IO.
- All three are small, dependency-free extensions of shipped machinery (model-router,
  usage ledger, agent runtime) — no new services, no new attack surface.

**Cons / risks**
- Silent substitution risk (F3) imports directly if profiles are naive → mitigation:
  per-profile **floor** (`minTier`/`pinned` flag) so agents with write/destructive grants
  never silently downgrade below an approved class; `servedBy` already audits what answered.
- Compression is behaviorally observable (model sees different bytes) → mitigation: opt-in
  per agent, deterministic filters only, raw output always in the trace, eval harness runs
  with it off by default.
- Health state adds a cache that can go stale → mitigation: short cooldowns (30–120s),
  half-open probe on expiry, never fail-closed (an all-unhealthy chain still tries in order).
- Opportunity cost: none of this unblocks a PRD use case; it is efficiency/reliability
  polish. Priced accordingly (S/S/M below).

**Verdict: worth adopting — selectively.** The proxy/ToS-evasion core of 9Router is
rejected outright; the three routing-ergonomics ideas (profiles, health-aware routing,
audited compaction) are cheap, aligned with §1.4 reliability findings, and strengthen the
existing router rather than replacing it.

## 5. Staged plan (execute only on explicit owner command, one stage per command)

### Stage 9A — Router profiles ("combos, done right") · size S · ✅ EXECUTED 2026-07-06
1. `router_profiles` table (workspace-scoped): name, description, ordered candidates
   `[{model, costClass}]`, `minClassForGatedTools`. Cost classes shipped as
   **`premium|cheap|local|free`** — "subscription" was renamed `premium` because
   Puppetmaster holds real API keys, not harvested OAuth sessions (§3 rejection).
2. Agents/workflows may set `model: "profile:NAME"`; the router resolves the profile to its
   chain at call time (changing a profile re-routes every consumer, no per-agent edits).
   Unknown/disabled profiles fail loudly; profile candidates cannot nest profiles or chains.
3. CRUD `/api/router/profiles` — mutations admin (RBAC rule), listing member-open so
   builders can reference profiles by name; ROUTER PROFILES panel shipped in the EVALS
   (ops) view. `llm.call` audit records `profile` + `servedBy`, and the usage ledger now
   accrues cost to the **serving** candidate rather than the requested model string.
4. Enforcement (implemented pre-call, stronger than the original wording): for agents that
   can reach write/destructive tools, below-floor candidates are excluded from the attempt
   list; if only below-floor candidates could answer, the router throws `ModelFloorError`
   and the tick pauses behind a `router-floor` approval (audited `router.floor.gate`) —
   approve = downgrade for that mission, reject = tick fails. Nothing is ever served first
   and questioned later.

   *Verified e2e (keyless, PGlite + inline runner + Playwright):* floored profile with a
   failing premium candidate gates instead of silently serving mock; approve → tick succeeds
   on mock with `profile`/`servedBy` audited; reject → tick fails; read-only-granted agent
   bypasses the floor; member gets 403 on mutation; golden eval suite stays green (4/4
   pass²); ROUTER PROFILES panel creates/renders profiles in the browser.

### Stage 9B — Health- & quota-aware routing · size S · ✅ EXECUTED 2026-07-06
1. Per-candidate health map with `cooldownUntil`: a quota/429 error cools immediately
   (retry-after parsed from the error when present, capped at `ROUTER_COOLDOWN_MAX_MS`);
   other errors cool after `ROUTER_FAILURE_THRESHOLD` consecutive failures for
   `ROUTER_COOLDOWN_MS`, doubling per repeat cycle. **In-memory only** (deviation from the
   original "persisted" wording): cooldowns are seconds-scale, so persisting them would
   outlive their usefulness across any realistic restart.
2. Chain resolution **deprioritizes** cooling candidates rather than removing them —
   healthy first, cooling as last resort — which subsumes both "skip" and "never
   fail-closed" in one rule. Expiry is the half-open probe: the failure counter survives,
   so a failed probe re-arms the (doubled) cooldown on the very next miss.
3. `GET /api/usage` gains `routerHealth`; the EVALS view gained a ROUTER HEALTH panel
   (state, cooldown expiry, total + consecutive failures, last error) beside the ledger.
4. Cooling **transitions** (not every failure) are audited as `router.cooldown` with
   reason `quota|failures`, count, expiry, and the triggering error.

   *Verified e2e (keyless, threshold=2 + 8s cooldown env overrides, a stub 429 endpoint
   as OPENAI_BASE_URL, dead `ollama/phantom` as the failure path):* 2 consecutive failures
   cool the candidate (audited); a chat inside the window skips it entirely
   (`routerFailures` stays flat) and serves on the healthy fallback; the post-expiry probe
   fails and re-cools at once (audited again, doubled window); one 429 cools immediately
   with reason `quota` and the 6s retry-after hint honoured; a raw single-candidate chain
   is still attempted while cooling (mission fails with the provider error — never
   fail-closed); golden eval suite stays green (4/4 pass²); ROUTER HEALTH panel renders
   both candidates in the browser.

### Stage 9C — Tool-output compaction (RTK, with provenance) · size M
1. Deterministic compactors in the kernel (no model calls): whitespace/blank-run collapse,
   repeated-line dedup with counts, head/tail smart-truncate with an elision marker, JSON
   pretty→compact — applied to tool results larger than a threshold before they enter agent
   context (inside the untrusted-data envelope).
2. **Raw output always persisted in the mission step**; the step records
   `{rawBytes, sentBytes, compactor}` so savings are auditable and replay/evals use raw.
3. Opt-in per agent (`context_compaction: on|off`, default off); savings surfaced in the
   usage view (tokens-avoided estimate).
4. Eval harness runs a golden task with compaction on to pin behavior (no "corrupt
   success" via over-truncation — trajectory assertions unchanged).

**Rejected permanently** (revisit only if the owner overrules): subscription-OAuth
harvesting, multi-account rotation, external OpenAI-compatible ingress proxy, N×N format
translation, caveman/ponytail prompt injectors.

## 6. Sources

[9Router GitHub](https://github.com/decolua/9router) · [9router.com](https://9router.com/) ·
[9Router deep dive (knightli)](https://knightli.com/en/2026/05/08/9router-ai-coding-router-token-saver/) ·
[agentpedia guide](https://agentpedia.codes/blog/9router-free-ai-router-token-saver-guide) ·
[ToS disablement issue #365](https://github.com/decolua/9router/issues/365) ·
[Anthropic proxy-ban issue #375](https://github.com/decolua/9router/issues/375) ·
[CLIProxyAPI ban discussion #2244](https://github.com/router-for-me/CLIProxyAPI/discussions/2244) ·
[opensourcealternatives.to entry](https://www.opensourcealternatives.to/item/9router) ·
[everydev.ai tool page](https://www.everydev.ai/tools/9router)
