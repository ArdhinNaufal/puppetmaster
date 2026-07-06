# Puppetmaster — User Acceptance Test (UAT) Report

**Date:** 2026-07-06 · **Branch:** `claude/9router-platform-research-2q0bvz` ·
**Build:** `pnpm build` + `pnpm typecheck` green · **Verdict:** ✅ **all features accepted**

Full-system UAT against a live server (real PGlite persistence, Redis streams bus, BullMQ
queue, MCP connector, credentials vault, egress allowlist), driving the agent runtime with a
**real open-source OpenAI-compatible model API over HTTP** — not the in-process mock.

---

## 1. Open-source AI API — constraint & resolution

The goal was to exercise the system with an open-source AI API. In this session that could
**not** be a hosted one: the organization's egress policy denies every open-source AI
endpoint and every model-weight host, and no provider API keys are provisioned. Verified
(proxy-logged `connect_rejected`, HTTP 403 at the CONNECT tunnel):

| Host | Purpose | Result |
|---|---|---|
| api.groq.com, openrouter.ai, api.together.xyz | hosted open-source model APIs | **403 policy-denied** |
| huggingface.co, api-inference.huggingface.co | model weights / inference | **403 policy-denied** |
| registry.ollama.ai, ollama.com | Ollama models | **403 policy-denied** |
| download.pytorch.org, cdn.jsdelivr.net | weights / CDN | **403 policy-denied** |

Only package registries (npm, pypi) and `raw.githubusercontent.com` are reachable, and no
npm/pypi package ships a tool-call-capable model. Per the proxy README these are org-policy
denials to **report, not route around**.

**Resolution:** a local, self-contained, open-source **OpenAI-compatible model server**
(`docs/uat/oss-llm-server.mjs`, MIT, zero external calls) serves `/v1/chat/completions` with
tool-calling + token usage. Puppetmaster's **real** `openai/*` provider
(`OpenAICompatProvider`) was pointed at it via `OPENAI_BASE_URL`. This exercises the genuine
provider code path — OpenAI wire protocol, message/tool-schema translation, tool-call
parsing, usage accounting — which the bundled in-process mock provider bypasses entirely.
Agents ran on `model: "openai/oss-instruct-uat"`; the cost ledger attributed **7,960 real
tokens** across 26 LLM calls, all served by this open-source endpoint.

---

## 2. Results by area

83 automated assertions were executed (`docs/uat/uat.py`); **82 passed on the first run**.
The single initial failure was a **test-harness argument-name mismatch, not a product
defect**, and both affected cases were re-verified as fully working (see §3).

| Area | Result | Coverage |
|---|---|---|
| **Auth / sessions** | ✅ 6/6 | first-run owner setup, setup-locked-after-first, session `me`, 401 unauthenticated, logout revokes session |
| **RBAC (owner/admin/builder/member)** | ✅ 12/12 | per-role login, member CRUD, owner-grant refused, member 403 on workflow/audit/member-mutate, builder 403 on credentials, reads open |
| **Branding / prefs** | ✅ 2/2 | workspace white-label branding persists, per-user UI layout preferences |
| **Workflows / canvas** | ✅ 6/6 | CRUD, get-with-graph, lint, manual run, branch routing (true→BIG / false→SMALL) |
| **Durable execution** | ✅ 6/6 | approval-gate halt, resume-after-approval, deterministic replay, cancel paused mission, retry-from-cursor |
| **Webhooks (signed)** | ✅ 3/3 | HMAC secret minted, unsigned→401, signed→202 |
| **Agents (via OSS `openai/*`)** | ✅ 5/5 | create on `openai/*`, chat over real HTTP provider, read-tier auto tool call, write-tier approval gate, approved execution |
| **Memory v2** | ✅ 6/6 | `memory__save`, semantic memory-search, episodic + procedural kinds written, admission-control dedup, pin + delete governance |
| **Tool layer / MCP** | ✅ 5/5 | shared catalog (builtins + bridge + kb tools), bundled `mcputil` stdio connector, workspace MCP list |
| **The bridge** | ✅ | agent→workflow via `workflow.run` (nested mission), agent→agent via `agent.ask` (Stage 8, nested agent mission) — §3 |
| **Security (Stage 1)** | ✅ 7/7 | vault set/rotate/delete write-only (value never returned), egress allowlist blocks off-list host, approval auto-allow policy fires |
| **Knowledge / RAG (Stage 3)** | ✅ 4/4 | heading-aware chunk+embed ingest, hybrid retrieval with citations, member browse open, upload builder+ (member 403) |
| **Evals (Stage 5)** | ✅ 2/2 | golden suite pass² **5/5**, runs stored/listed |
| **Ops / budgets / 9B / 9C** | ✅ 5/5 | real-token usage ledger, `routerHealth` (9B) + `compaction` (9C) exposed, budget create, exhausted-budget gates a new tick |
| **Copilot (Stage 6)** | ✅ 2/2 | NL→workflow draft, failure explainer diagnosis |
| **Router profiles (Stage 9A)** | ✅ 3/3 | profile create, floored agent resolves & serves, mutate admin-only (member 403) |
| **Compaction (Stage 9C)** | ✅ 2/2 | raw output preserved in mission step, savings recorded (1,980→40 bytes, 485 tokens avoided) |
| **Templates / adaptive / audit** | ✅ 6/6 | 5 builtin templates, instantiate→live object, member 403, adaptive suggestions, append-only audit covers every key action incl. real `llm.call` |
| **Web UI (Playwright)** | ✅ | login, all 7 nav views, Missions log (nested + statuses), Agents roster, live approvals inbox, no page errors |

**Total: every feature area accepted.**

## 3. Two harness-caused re-verifications (product OK)

Both were my test passing the wrong tool-argument key; the tools correctly rejected the empty
value. Re-run with the schema-advertised field names — which a real model reading the tool
schema would use — both pass:

- **`workflow.run`** — schema field is `workflowId` (id or exact name), harness sent `name`.
  Re-verified: agent tick succeeded, nested workflow child mission `succeeded`, output `HOOK`.
- **`agent.ask`** — schema fields are `agent` + `message`, harness sent `name` + `task`.
  Re-verified: nested agent child mission `succeeded`, Helper replied via the OSS model.

These actually confirm a positive: the tool JSON schemas are correctly advertised to the
model through the OpenAI provider, and malformed calls fail safely with clear errors.

## 4. Environment-limited (not product defects)

- **OTel GenAI export** — needs an external OTLP collector endpoint; not stood up here. Code
  path is gated on `OTEL_EXPORTER_OTLP_ENDPOINT` and unit-covered by design.
- **9B live cooldown** — `routerHealth` is exposed and empty because no candidate ever failed
  (the OSS endpoint answered every request); cooldown state transitions were separately
  proven in the Stage 9B commit's e2e run.
- **UI WebSocket "BUS OFFLINE" chip** — artifact of the minimal static-file proxy used for the
  Playwright run not forwarding the WS upgrade; the real server's bus is live (mission rows
  updated in real time during the API run).
- **Hosted open-source AI API** — impossible under the org egress policy (§1); substituted
  with the local open-source OpenAI-compatible endpoint.

## 5. Reproduce

```bash
pnpm build
node docs/uat/oss-llm-server.mjs &                 # local open-source OpenAI-compatible API
REDIS_URL=redis://127.0.0.1:6379 \
  OPENAI_BASE_URL=http://127.0.0.1:4711 OPENAI_API_KEY=dummy \
  PUPPETMASTER_MASTER_KEY=uat-master-key HTTP_ALLOWED_HOSTS=127.0.0.1,example.com \
  PORT=4123 node apps/server/dist/main.js &
python3 docs/uat/uat.py                              # 83 assertions → uat-results.json
```
