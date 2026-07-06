# Research Ledger — Extension Session 4: Scalability
 
**Session date:** July 2026. Tracks `ai-sdlc-extension-plan.md` §7. Sources per plan's source list; no user-supplied materials.
 
**Scope reminder:** This session delivers only the remainder after session 1 carried the spec sections. The spec-interview forcing sections (load profile, SLOs, scaling strategy + known ceiling) are already in `ai-sdlc-architecture.md` §1.2 and wired into the unified pipeline's `/spec` command. This session produces: (1) a scalability on-demand skill, (2) a load-test verifier template, (3) a scaling-ceiling ADR pattern connecting to session 3's ADR mechanism.
 
---
 
## 1. Per-source findings
 
### 1.1 Kleppmann, *Designing Data-Intensive Applications* — E2c (training-recall, cross-referenced with fetched summaries and excerpts)
 
**Key mechanisms extracted:**
 
1. **Describing load before describing performance.** Kleppmann's Chapter 1 structure is: define load parameters first (requests/second, read/write ratio, concurrent user count, data volume), then measure performance against those parameters, then choose scaling approaches. This maps directly to the spec section's "load profile" field — the numbers must come before the strategy (E2c training-recall).
2. **Scaling is not a single attribute.** Scalability is a strategic approach to identifying and addressing growth challenges, not a property a system "has" or "doesn't have." The question is always "if the system grows in a specific way, what are the options for coping?" — never "is this system scalable?" in the abstract (E2c training-recall).
3. **The vertical/horizontal pragmatic mixture.** Kleppmann frames the vertical-vs-horizontal dichotomy as often false in practice: good architectures use a pragmatic mixture — several fairly powerful machines can be simpler and cheaper than many small VMs. This directly supports the skill's YAGNI counterweight: start with the simplest design (often a single powerful machine) and declare the point it breaks (E2c fetched — gist excerpt of Ch.1).
4. **Load-dependent architecture.** Architectures must be designed around specific load parameters; incorrect assumptions lead to wasted effort. 100,000 requests of 1 KB/sec and 3 requests of 2 GB/min are the same throughput but demand different scaling strategies. This makes the spec section's "numbers or explicit 'unknown'" requirement non-negotiable — without knowing the shape of the load, any scaling decision is speculation (E2c training-recall, confirmed by fetched reading-notes sources).
5. **Percentile-based performance measurement.** Kleppmann warns against averaging percentiles (mathematically meaningless) and advocates for histogram-based aggregation. For the verifier template, this means k6 thresholds should use `p(95)` / `p(99)` syntax, not `avg` — the tooling directly supports this (E2c training-recall).
6. **Partitioning and replication as the two fundamental distribution mechanisms.** All horizontal scaling ultimately reduces to replication (same data on multiple nodes, for read throughput and fault tolerance) and partitioning/sharding (different data on different nodes, for write throughput and storage capacity). The skill's strategy mapping uses these as the two terminal branches after "single machine" is outgrown (E2c training-recall).
**Disposition:** Core vocabulary and framing source. The "describe load → measure performance → choose approach" sequence structures the skill's load-profile-to-strategy mapping. The "pragmatic mixture" finding anchors the YAGNI counterweight. Outcome claims about specific architectures' performance are treated as E3-grade — mechanisms used, numbers discarded.
 
### 1.2 Google SRE Book — SLOs, error budgets — E2c (fetched: sre.google/sre-book/ and sre.google/workbook/)
 
**Key mechanisms extracted:**
 
1. **SLI → SLO → SLA hierarchy.** SLI is the quantitative measure (latency, error rate, throughput). SLO is the target value or range for that SLI. SLA is the contractual commitment with consequences. Most projects in this guide's audience have SLOs but not SLAs — and the SRE book explicitly supports this: SLOs without SLAs are entirely valid, they just have no contractual consequence for missing them (E2c fetched, sre.google/sre-book/service-level-objectives/).
2. **Error budget = 1 − SLO.** A 99.9% SLO gives 0.1% error budget. The error budget is the mechanism that converts "we should focus on reliability" from opinion into organizational fact. When the budget is exhausted, feature releases halt; when it's healthy, the team ships (E2c fetched, sre.google/sre-book/embracing-risk/ and sre.google/workbook/error-budget-policy/).
3. **"100% is never the right target."** Over-investing in reliability has real costs: inflexibility, slow innovation, expensive over-provisioning. The SRE book explicitly warns against unspoken 100% uptime goals. This directly supports the spec section's "none — best effort" as a valid SLO declaration — silence is the anti-pattern, not the absence of a target (E2c fetched, sre.google/sre-book/embracing-risk/).
4. **Start simple, tighten over time.** The SRE workbook's practical advice: don't pick a target based on current performance, start with a slightly lower target than measured, run for a quarter, then tighten. This maps to the skill's guidance: declare honest numbers in the spec, refine after real load data exists (E2c fetched, sre.google/workbook/implementing-slos/).
5. **User-centric SLOs via critical user journeys.** SLOs should center on user-facing actions, not infrastructure metrics. A critical user journey (sequence of tasks that is a core part of the user's experience) is the unit of SLO definition. This matters for the load-test verifier: the k6/locust script should test user journeys, not raw endpoint throughput (E2c fetched, sre.google/workbook/implementing-slos/).
6. **Error budget policy as organizational machinery.** The policy document (who decides when to halt releases, what counts as "consuming" budget, what's exempt) is the mechanism, not just the math. For this guide's small-team audience, the full policy is overkill, but the core mechanism (SLO violation → slow down releases) is the actionable piece (E2c fetched, sre.google/workbook/error-budget-policy/).
**Disposition:** The SLI/SLO/error-budget mechanism is the industry's strongest consensus framework for making reliability decisions. Used for: the skill's SLO-to-threshold mapping (SLO → k6 threshold), the "none — best effort" validation in the spec section, and the YAGNI counterweight (100% is never right). The error budget policy machinery (quarterly reviews, deployment gating, burn-rate alerting) is documented as available-but-scoped-to-need — the guide doesn't prescribe it for small projects without declared SLOs.
 
### 1.3 12-Factor App — E2c (training-recall, cross-referenced with fetched retrospectives)
 
**Per-factor assessment (the plan requires marking stale parts):**
 
| Factor | Status in 2026 | Session-4 use |
|---|---|---|
| I. Codebase | Consensus. Unchanged. | Not scalability-specific |
| II. Dependencies | Consensus. Containers have made this more natural. | Not scalability-specific |
| III. Config | Core idea (config ≠ code) is consensus. Env-vars-only is too prescriptive — Kubernetes secrets-as-files, GitOps config repos are valid alternatives (E4 fetched, tibobeijen.nl). | Scaling strategy often involves config changes (replica counts, connection pool sizes) — the principle "config outside code" matters |
| IV. Backing services | Consensus. Treat as attached resources. | Directly relevant: scaling often means swapping a local backing service for a managed one. The ceiling declaration should name which backing services change at the scaling boundary. |
| V. Build, release, run | Consensus. Hard to violate in containerized workflows. | Not scalability-specific |
| VI. Processes | Core idea (stateless, share-nothing) is consensus. The strongest scalability factor. | **Directly load-bearing for horizontal scaling.** If processes hold state, you cannot add replicas. The skill's strategy mapping gates horizontal scaling on statelessness. |
| VII. Port binding | **Stale for serverless/event-driven.** Still valid for containerized HTTP services. | Partially relevant: the load-test verifier assumes an addressable endpoint. Serverless targets need different invocation patterns. Mark as contested. |
| VIII. Concurrency | Consensus. Scale via process model (horizontal replicas). | Directly relevant: the process-model scaling is the "horizontal" branch of the strategy mapping. |
| IX. Disposability | Consensus. Fast startup, graceful shutdown. | Directly relevant: scaling events (adding/removing replicas) depend on disposable processes. |
| X. Dev/prod parity | Consensus. "Shift left." | Relevant for load testing: the verifier template should run against an environment resembling production, not just localhost. |
| XI. Logs | Core idea (logs as event streams) is consensus. **Incomplete for 2026:** no mention of metrics, traces, or observability. | The SLO monitoring mechanism needs metrics, not just logs. Mark as "consensus core, incomplete scope." |
| XII. Admin processes | Consensus. | Not scalability-specific |
| (Proposed 13th) | Forward/backward compatibility during rolling deploys (E4 fetched, tibobeijen.nl). Not in original. | Directly relevant: scaling events involve rolling deploys. The ceiling ADR's "reconsider when" should note compatibility constraints. |
 
**The aging assessment:** The 12-factor methodology was open-sourced in November 2024 for community-driven updates (E4 fetched, pyyne.com). Most factors have become default practice in containerized environments. The three stale parts for this session's purposes: (a) env-vars as the only config mechanism, (b) port binding as universal (serverless breaks it), (c) logs without observability. The 2026 retrospectives (E4 fetched, daily.dev, tibobeijen.nl) converge on "most hold up; a few show age."
 
**Disposition:** Factor VI (stateless processes) is the load-bearing factor for horizontal scalability and enters the skill's strategy mapping as a gate condition. Factors IV, VIII, IX, X are supporting. The contested portions are marked per the E2c rules. The 12-factor methodology is not cited as a compliance requirement — consistent with the guide's "constraints, not patterns" framing — but Factor VI's mechanism (statelessness as a prerequisite for horizontal scaling) is a constraint, not a pattern preference.
 
### 1.4 k6 — E2 (fetched: grafana.com/docs/k6/)
 
**Key mechanisms for the verifier template:**
 
1. **Thresholds as SLO codification.** k6's `thresholds` option directly encodes SLOs: `http_req_duration: ['p(95)<500']` (95th percentile under 500ms), `http_req_failed: ['rate<0.01']` (error rate under 1%). Thresholds determine the exit code — non-zero on failure, making them CI-gate-compatible (E2 fetched, grafana.com/docs/k6/latest/using-k6/thresholds/).
2. **Checks vs. thresholds.** Checks are soft assertions (don't affect exit code); thresholds are hard gates (affect exit code). The verifier template uses thresholds for SLO assertions and checks for response validation (E2 fetched).
3. **Scenario-based load modeling.** k6 supports multiple concurrent scenarios with different executors (constant-vus, ramping-vus, constant-arrival-rate, ramping-arrival-rate). The verifier template uses `ramping-vus` for the standard load profile and `ramping-arrival-rate` for throughput-based profiles — chosen per the spec's declared load shape (E2 fetched).
4. **`abortOnFail` for breakpoint testing.** A threshold can abort the test early when breached. Useful for finding the system's actual ceiling: ramp up until the SLO threshold is crossed, record the breaking point. This is the mechanism for validating the spec's "known ceiling" declaration (E2 fetched).
5. **JavaScript/TypeScript scripting.** Tests are written in JS/TS, making them accessible to the guide's primary audience (web-stack developers). k6 is not Node.js-based — it has its own Go-based runtime — but the syntax is standard ES6 modules (E2 fetched).
6. **CLI-first, CI-friendly.** `k6 run script.js` from the command line; exit code reflects threshold pass/fail. No UI required for gated use. This fits the pipeline's `scripts/verify-*.sh` pattern (E2 fetched).
### 1.5 Locust — E2 (fetched: locust.io, github.com/locustio/locust)
 
**Key mechanisms for the verifier template:**
 
1. **Python-native scripting.** Tests are plain Python classes with `@task`-decorated methods. For Python-stack projects, this removes the language-switching friction k6 introduces (E2 fetched, locust.io).
2. **Greenlet-based concurrency.** Each virtual user is a gevent greenlet — lightweight enough to run thousands per process (E2 fetched).
3. **No built-in threshold/gate mechanism.** Unlike k6, locust does not have a threshold system that produces non-zero exit codes. For CI gating, the verifier template must parse locust's CSV/JSON output and assert against declared SLOs in a wrapper script. This is a meaningful difference: k6 has built-in SLO gating; locust requires wrapping (E2 fetched).
4. **Distributed testing.** Locust supports master-worker distribution across machines for higher load generation (E2 fetched).
**k6 vs. locust selection table (for the `/stack`-style rule):**
 
| Criterion | k6 | locust |
|---|---|---|
| Script language | JavaScript/TypeScript | Python |
| Built-in SLO gating (exit code) | Yes — thresholds | No — requires wrapper script |
| CI integration | Native (exit code) | Requires parsing output |
| Protocol support | HTTP, WebSocket, gRPC, browser | HTTP primary; extensible via Python |
| **Selection rule** | **Default for JS/TS stacks and any project where CI gating matters** | **Preferred for Python stacks where team has no JS familiarity** |
 
---
 
## 2. Cross-cutting synthesis
 
1. **The spec sections (session 1) and the skill (this session) form a complete loop.** The spec forces the declaration of concrete numbers (load profile, SLOs, scaling strategy, ceiling). The skill activates only when those numbers exist and are non-trivial. The verifier template asserts against those numbers. Without declared numbers, the skill refuses and the verifier has nothing to assert — and that refusal is the correct behavior, structurally preventing the plan's anticipated "load tests asserting against invented numbers" failure mode.
2. **The YAGNI counterweight is the most important content in the skill.** Kleppmann, Google SRE ("100% is never right"), and 12-factor (the process model, not the infrastructure model, comes first) all converge on the same point: premature scaling is the most documented waste in the industry. The skill must state this inside itself — not as a preamble the model skips, but as a negative trigger and a gotcha — because an AI agent given a "scalability skill" will eagerly over-apply scaling patterns to every project.
3. **Verification ceiling honesty.** The plan ranks scalability as "expensive — verifiable only against a declared profile." The load-test verifier is real but only fires when: (a) a profile is declared in the spec, (b) SLOs are declared (not "best effort"), and (c) a running, accessible system exists to test against. For most early-stage projects, conditions (a) and (c) together are rare. The verifier template is a pattern the project instantiates when ready, not an always-on gate.
4. **The scaling-ceiling ADR is a usage pattern, not a new template.** Session 3's ADR skill already has the "Reconsider when" field — which is exactly where the ceiling trigger goes. Adding a new template would violate session 3's design. The deliverable is a triggering rule addition and an acceptance example.
5. **No E2c conflicts found.** Kleppmann, Google SRE, and 12-factor are complementary, not contradictory. One tension exists (vertical-first vs. horizontal-first as default), but Kleppmann himself resolves it ("pragmatic mixture" favoring simplicity), consistent with Google SRE ("start with a loose target"). This is a per-project decision already handled by the spec section's "scaling strategy" field. No tradeoff table required — the tension is resolved by the existing per-project decision hook, not silently.
---
 
## 3. Dispositions
 
| Source | Disposition |
|---|---|
| Kleppmann, *DDIA* | Core vocabulary and framing. "Describe load → measure performance → choose approach" structures the skill. "Pragmatic mixture" anchors YAGNI counterweight. Per-claim: mechanisms used; outcome claims discarded. E2c (training-recall, cross-referenced with fetched summaries). |
| Google SRE book (sre.google) | SLI/SLO/error-budget framework used for spec section validation and verifier template thresholds. "100% is never right" is the anti-premature-optimization anchor. Error budget policy documented as available, scoped-to-need. E2c (fetched). |
| 12-Factor App (12factor.net) | Factor VI (stateless processes) used as gate condition in strategy mapping. Per-factor assessment: 9 consensus, 3 contested. No factors used as compliance rules — mechanisms only. E2c (training-recall, cross-referenced with fetched 2024–2026 retrospectives). |
| k6 (grafana.com/docs/k6/) | Default load-testing tool in verifier template. Thresholds as SLO codification. CI-native exit codes. E2 (fetched, live docs). |
| Locust (locust.io) | Alternative for Python stacks. Requires wrapper script for CI gating. Selected per `/stack` rule. E2 (fetched). |
| 12-factor retrospectives (tibobeijen.nl, daily.dev, pyyne.com) | Per-factor aging assessment. E4 (fetched, practitioner reports). |
 
Research pass closed. Deliverables: `ai-sdlc-scalability.md` + integration diffs to `ai-sdlc-unified-pipeline.md` (v1.3 → v1.4).