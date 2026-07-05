# Puppetmaster — Research-Driven Roadmap

**Date:** 2026-07-05 · **Status:** proposal awaiting owner review · **Method:** literature
survey (arXiv 2024–2026) first, then industry/ecosystem sources, mapped against the shipped
system (M0–M5 + audit + OIDC/webhook-signing on `claude/kickoff-prompt-continuation-cy021r`).

Each stage at the end is independently shippable and sized; **no stage is executed without an
explicit go-ahead from the owner.**

---

## 1. Research findings

### 1.1 Agent memory (scientific)

- Surveys of LLM-agent memory ([Memory for Autonomous LLM Agents](https://arxiv.org/html/2603.07670v1),
  [Evolution of LLM Agent Memory](https://arxiv.org/pdf/2605.06716)) converge on **tiered
  architectures** — short-term window, episodic (what happened), semantic (facts), and
  **procedural** (how to do things) — rather than a single flat store.
- [MemGPT](https://www.emergentmind.com/topics/memgpt-style-memory-management) established
  OS-style paging between context and archival storage; [A-Mem](https://arxiv.org/html/2502.12110v1)
  shows *linked, self-organizing* notes outperform flat stores; MemoryBank applies
  Ebbinghaus-style **decay**; [Adaptive Memory Admission Control](https://arxiv.org/pdf/2603.04549)
  shows *not everything should be written* — dedup/importance gating at save time matters.
- [LEGOMem](https://arxiv.org/pdf/2510.04851) is directly on-point for Puppetmaster:
  **modular procedural memory for workflow automation** — agents that remember *successful
  procedures* (which workflow/tool sequence worked) outperform ones that only remember facts.
- [SSGM](https://arxiv.org/pdf/2603.11768) warns that self-evolving memory needs governance
  (stability/safety rules) or it drifts.

### 1.2 Workflow generation & orchestration (scientific)

- [AFlow](https://arxiv.org/abs/2410.10762) (and successor [A²Flow](https://arxiv.org/pdf/2511.20693))
  frame workflow construction as **search over code-represented DAGs** with execution
  feedback — automated generation beats hand-built flows by ~5.7–19.5%. The practical
  takeaway for a product: **NL→draft-graph generation with execution feedback** is proven;
  full MCTS optimization is research-grade, drafting + critique is product-grade.
- [Rethinking the Value of Multi-Agent Workflow](https://www.arxiv.org/pdf/2601.12307) is a
  useful counterweight: a strong single agent with good tools often beats elaborate
  multi-agent topologies. Puppetmaster's bridge (agent↔workflow, nested missions) is the
  right primitive; deep agent-team hierarchies are not a priority.
- [GraphFlow](https://arxiv.org/pdf/2605.14968) argues for **formally checkable visual
  workflows** (lint/verify the DAG before running) as the reliability layer under agentic
  automation.

### 1.3 Safety, approvals, prompt injection (scientific + security industry)

- HITL research finds **approval fatigue** is the dominant failure mode: "excessive
  notifications cause habituation" ([Verifiably Safe Tool Use](https://arxiv.org/html/2601.08012v1)).
  Blanket write-gating (Puppetmaster today) is safe but fatiguing; the literature points to
  **policy-based gating** — auto-allow rules scoped to tool + argument constraints, with
  approval reserved for genuinely risky calls ([A Vision for Access Control in LLM-based
  Agent Systems](https://arxiv.org/pdf/2510.11108), Intent-Governed Tool Authorization).
- **Indirect prompt injection is the #1 documented attack** on tool-using agents: malicious
  instructions arrive *in tool results / fetched pages / MCP tool descriptions* (tool
  poisoning, [MCPTox findings](https://www.stackone.com/blog/prompt-injection-mcp-10-examples/),
  [Elastic Security Labs](https://www.elastic.co/security-labs/mcp-tools-attack-defense-recommendations),
  [Microsoft guidance](https://developer.microsoft.com/blog/protecting-against-indirect-injection-attacks-mcp)).
  Consensus defenses: (a) **structural separation** — mark tool-result content as untrusted
  data, never as instructions; (b) **gateway policy enforcement** on the action, not the
  prompt; (c) **pin/hash MCP tool descriptions** and alert on change; (d) egress allowlists.
  "Ignore instructions in data" system-prompt lines demonstrably do not work.

### 1.4 Reliability & durable execution (scientific + industry)

- The industry consensus (Temporal joining the Agentic AI Foundation, [durable-execution
  writing](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai))
  is that agentic systems need **event-sourced, replayable execution**: append-only step
  logs, deterministic resume, idempotent side effects.
- [Atomix](https://arxiv.org/pdf/2602.14849) (transactional tool use) and
  [Execution Lineage for Reproducible AI-Native Work](https://arxiv.org/pdf/2605.06365)
  formalize what's missing in most agent platforms: **idempotency keys for tool calls,
  cancellation, and lineage you can audit/replay**.

### 1.5 Evaluation & observability (scientific + industry)

- τ-bench-style evaluation — **DB-state-diff grading + pass^k over repeated runs** — is the
  de-facto standard for tool agents; newer work (["Corrupt success"](https://arxiv.org/pdf/2603.03116),
  [Characterizing False Success](https://arxiv.org/pdf/2606.09863)) shows *outcome-only*
  grading misses agents that succeed by doing the wrong thing, motivating **procedure-aware
  / trajectory judging**.
- [OpenTelemetry GenAI semantic conventions](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv/)
  are now the cross-vendor standard (Datadog/Honeycomb/New Relic/GCP/AWS support) for LLM +
  agent + tool spans, token usage, and cost. Emitting them makes Puppetmaster pluggable
  into any observability stack.

### 1.6 RAG (scientific + industry)

- [Best-practices studies](https://arxiv.org/html/2407.01219v1) and enterprise guides agree
  on the pipeline: **semantic/heading-aware chunking → hybrid retrieval (BM25 + vector) →
  rerank top-50 → top-5 → cite sources**, with reranking alone worth 15–30% quality.
  Postgres gives us BM25-ish full-text search natively, so hybrid retrieval is cheap here.

### 1.7 Competitive landscape (industry)

- [n8n 2.0](https://hatchworks.com/blog/ai-agents/n8n-vs-zapier/) ships LangChain-native
  agent nodes, HITL patterns, 400+ connectors; **Zapier Agents** spans 8,000+ apps;
  **Make "Maia"** builds scenarios from natural language; [Dify's](https://www.ayautomate.com/blog/n8n-vs-dify)
  differentiator is **native knowledge bases (RAG) as a first-class object**. Table stakes
  Puppetmaster lacks: document knowledge bases, NL→workflow drafting in the editor,
  connector breadth (mitigated by MCP), streaming responses.
- [MCP in 2026](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/):
  10,000+ public servers, **streamable HTTP is the dominant transport**, servers are OAuth
  resource servers (RFC 8707), an official **registry** exists, and **elicitation** lets
  servers ask users questions mid-call. Puppetmaster speaks only stdio today — remote MCP
  is where the ecosystem is.
- [Generative/adaptive UI research](https://arxiv.org/pdf/2508.19227) supports on-demand,
  model-composed panels, but the pragmatic near-term win is preference-learned layout +
  model-written summaries, not fully generated UI.

---

## 2. Gap analysis — Puppetmaster today vs. findings

| # | Area | Shipped today | Gap (evidence) |
|---|------|---------------|----------------|
| G1 | Prompt-injection defense | Tool results flow into agent context verbatim; MCP tool descriptions trusted; `http.get` unrestricted | No provenance separation, no tool-description pinning, no egress policy (§1.3) |
| G2 | Approval ergonomics | Every write/destructive call gates identically | Approval fatigue; no per-tool/arg auto-allow policies (§1.3) |
| G3 | Credentials | `credentials` table in ARCHITECTURE §4 never built; MCP env passed raw | No encrypted-at-rest vault, blocks OAuth MCP + real connectors (§1.7) |
| G4 | Durable execution | Resume-cursor works, but tool side effects re-execute on retry; no cancellation; failed missions are terminal | No idempotency keys, no retry-from-step, no cancel, no dead-letter (§1.4) |
| G5 | Knowledge/RAG | Agent memories only | PRD use-case 4 (knowledge/RAG over team data) unimplemented: no documents, chunking, hybrid retrieval, citations (§1.6, §1.7) |
| G6 | Memory depth | Flat facts + vector recall | No episodic mission summaries, no procedural memory (LEGOMem), no admission control/dedup, no decay/pinning (§1.1) |
| G7 | Evaluation | None | No golden tasks, no state-diff grading, no pass^k, no trajectory judging (§1.5) |
| G8 | Observability/cost | Per-mission token counts in trace; audit log | No OTel GenAI export; no workspace cost ledger or budgets (§1.5) |
| G9 | Workflow authoring aid | Manual canvas + agent-side `workflow.create_draft` | No NL→draft in the editor, no graph linter, no failure explainer (§1.2, §1.7) |
| G10 | MCP reach | stdio only, env-configured | No streamable-HTTP client, no OAuth, no registry browsing, no elicitation (§1.7) |
| G11 | Model router | No streaming, no fallbacks (ARCH §3.5 promises both) | Streaming is UX table stakes; fallbacks are reliability (§1.7) |
| G12 | Multi-agent | Bridge (agent↔workflow) | Agent→agent delegation absent — deliberately low priority per §1.2 counterpoint |

---

## 3. Capability additions & improvements (synthesis)

Grouped into a staged plan. Order optimizes risk-reduction first (security → reliability),
then product surface (knowledge → memory → evals → authoring), then ecosystem reach.
**Each stage ends with the standard loop: build green → e2e verify → docs → commit/push →
owner review.**

### Stage 1 — Security & trust hardening (G1, G2, G3) · size M
1. **Credentials vault**: `credentials` table, AES-256-GCM encrypted at rest with a
   `PUPPETMASTER_MASTER_KEY`; CRUD (admin+), injection into MCP server env by reference
   (`{{credential:NAME}}`), values never returned by the API after write.
2. **Injection defenses**: wrap all tool results and webhook payloads in explicit
   untrusted-data delimiters before they enter agent context; hash-pin MCP tool
   descriptions at first connect, surface + audit description drift; `http.get` egress
   allowlist env (`HTTP_ALLOWED_HOSTS`).
3. **Approval policies**: per-agent/workspace rules — `allow email.send when
   to endsWith "@acme.io"` style (tool + simple arg predicates) that auto-approve
   matching calls and audit them as `approval.auto`; everything else still gates. Reduces
   fatigue per §1.3 while keeping the audit trail complete.

### Stage 2 — Durable execution upgrades (G4) · size M
1. **Idempotency**: node-execution keys (`missionId:nodeId:attempt`) recorded before
   side-effectful tool calls; a retried mission skips already-committed executions.
2. **Cancellation**: `POST /api/missions/:id/cancel` → cooperative cancel flag checked
   between nodes/iterations; status `cancelled` (already in the enum).
3. **Retry-from-step**: re-enqueue a failed mission resuming from its cursor (UI button in
   trace panel); dead-letter listing for repeatedly failing missions.
4. **Lineage**: replay view — the step log already snapshots IO; add a "replay
   deterministically" dry-run that walks the recorded outputs (no side effects) for
   debugging, per §1.4.

### Stage 3 — Knowledge bases / RAG (G5) · size L
1. `documents` + `document_chunks(embedding vector)` tables; upload (md/txt first, pdf
   later), heading-aware chunking with metadata.
2. **Hybrid retrieval**: Postgres full-text (`tsvector`) + pgvector cosine, reciprocal-rank
   fusion; optional rerank hook when a reranker model is configured.
3. `kb.search` / `kb.read` tools in the shared catalog (read-tier); citations (doc + chunk
   anchors) rendered in Command chat and stored in steps.
4. KNOWLEDGE view: upload, browse, search-test, per-workspace.

### Stage 4 — Memory v2 (G6) · size M
1. **Episodic**: auto-summarize each finished mission into an episodic memory (model-written,
   mock-provider deterministic) linked to the mission.
2. **Procedural**: on approved/successful tool sequences, store "procedure" memories
   (LEGOMem-style: task → steps that worked) recalled when similar tasks arrive.
3. **Admission control**: near-duplicate detection at save (cosine > τ → merge), importance
   scoring, per-agent memory caps with decay; pin/unpin + edit/delete in the inspector
   (governance per SSGM).
4. **Hybrid recall** reusing Stage 3's fusion machinery.

### Stage 5 — Evals & observability (G7, G8) · size M
1. **Eval harness**: golden-task specs (input → expected DB-state-diff/output predicate) run
   against an ephemeral PGlite + mock/real models; pass^k; CLI `pnpm eval`; results stored +
   EVALS panel.
2. **Trajectory checks**: procedure-aware assertions (which tools may/must be called) to
   catch "corrupt success" per §1.5.
3. **OTel GenAI export**: spans for missions/steps/LLM calls/tool calls following
   `gen_ai.*` semantic conventions behind `OTEL_EXPORTER_OTLP_ENDPOINT`.
4. **Cost ledger + budgets**: aggregate step usage into a workspace ledger; per-workspace /
   per-agent monthly token budgets; budget-exceeded → gate ticks behind approval.

### Stage 6 — Workflow copilot (G9, G11-streaming) · size M
1. **NL→draft**: "describe your workflow" box in Canvas → model drafts a WorkflowGraph
   (reuses `workflow.create_draft` machinery) → rendered as an *editable draft*, never
   auto-saved (human-in-command per §1.2).
2. **Graph linter**: static checks (unreachable nodes, missing trigger, dangling edges,
   approval-less destructive actions, missing retries on network tools) surfaced in the
   editor, per GraphFlow.
3. **Failure explainer**: "explain this failure" on a failed mission → model reads the
   step trace and produces a diagnosis card.
4. **Streaming** assistant replies over the existing WS bus (`agent.message.delta`).

### Stage 7 — MCP 2026 reach (G10, G3-dependent) · size M
1. **Streamable-HTTP MCP client** alongside stdio; per-server auth headers from the
   credentials vault; OAuth resource-server flow where offered.
2. **Registry browsing**: search the public MCP registry from the Tools view; one-click
   add (config persisted per workspace, not env).
3. **Elicitation → approvals**: map server elicitation requests into the existing approval
   inbox (same pause/resume machinery).

### Stage 8 — Router & polish (G11 rest, G12-lite) · size S
1. Provider **fallback chains** (`model: "claude-…|openai/…"`) with failure accounting.
2. **Agent-as-tool** delegation (`agent.ask`) with depth cap 2, reusing nested missions —
   the scoped multi-agent step justified by §1.2.

Deferred indefinitely (revisit on demand): Tauri desktop (needs desktop toolchain), full
AFlow-style MCTS workflow optimization (research-grade), fully generative UI.

---

## 4. Sources

Scientific: [arXiv 2603.07670](https://arxiv.org/html/2603.07670v1) · [arXiv 2605.06716](https://arxiv.org/pdf/2605.06716) ·
[A-Mem 2502.12110](https://arxiv.org/html/2502.12110v1) · [LEGOMem 2510.04851](https://arxiv.org/pdf/2510.04851) ·
[SSGM 2603.11768](https://arxiv.org/pdf/2603.11768) · [Admission control 2603.04549](https://arxiv.org/pdf/2603.04549) ·
[AFlow 2410.10762](https://arxiv.org/abs/2410.10762) · [A²Flow 2511.20693](https://arxiv.org/pdf/2511.20693) ·
[Single-agent baseline 2601.12307](https://www.arxiv.org/pdf/2601.12307) · [GraphFlow 2605.14968](https://arxiv.org/pdf/2605.14968) ·
[Verifiably safe tool use 2601.08012](https://arxiv.org/html/2601.08012v1) · [Agent access control 2510.11108](https://arxiv.org/pdf/2510.11108) ·
[Atomix 2602.14849](https://arxiv.org/pdf/2602.14849) · [Execution lineage 2605.06365](https://arxiv.org/pdf/2605.06365) ·
[Corrupt success 2603.03116](https://arxiv.org/pdf/2603.03116) · [False success 2606.09863](https://arxiv.org/pdf/2606.09863) ·
[RAG best practices 2407.01219](https://arxiv.org/html/2407.01219v1) · [Generative interfaces 2508.19227](https://arxiv.org/pdf/2508.19227)

Industry: [MCP release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) ·
[WorkOS MCP 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026) ·
[StackOne MCP injection](https://www.stackone.com/blog/prompt-injection-mcp-10-examples/) ·
[Elastic MCP defenses](https://www.elastic.co/security-labs/mcp-tools-attack-defense-recommendations) ·
[Microsoft MCP injection guidance](https://developer.microsoft.com/blog/protecting-against-indirect-injection-attacks-mcp) ·
[Temporal durable AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai) ·
[OTel GenAI conventions](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv/) ·
[n8n vs Zapier 2026](https://hatchworks.com/blog/ai-agents/n8n-vs-zapier/) · [n8n vs Dify](https://www.ayautomate.com/blog/n8n-vs-dify)
