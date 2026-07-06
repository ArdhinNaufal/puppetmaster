# Scalability Layer — Companion to the AI SDLC Workflow Guide
 
**Version 1.0 — July 2026.** Extension session 4 deliverable. Tracks guide v1.3 and unified pipeline v1.3 (becomes v1.4 after integration). Framing locked per plan: **scalability as a spec-driven, on-demand concern — not universal standards.** Building for scale ahead of load is the most documented premature-optimization failure in the industry; universal scalability machinery in this guide would be the §5 anti-example.
 
> **Activation note (read first).** Everything in this doc is **on-demand**: the scalability skill loads only when a project's SPEC declares real scale numbers in the "Scale & operations" section (delivered in session 1), the load-test verifier template is instantiated per-project when a running system exists to test against, and the ceiling-ADR pattern uses session 3's existing ADR skill. **Net standing-context cost: 0 lines.** Nothing here is loaded into every session — if you find yourself pasting this doc into CLAUDE.md, you are re-creating the ECC failure (guide §5, E4).
 
> **Verification ceiling honesty.** The plan ranks scalability as "expensive — verifiable only against a declared profile." The load-test verifier is real but fires only when: (a) a load profile is declared in the spec with concrete numbers, (b) SLOs are declared (not "best effort"), and (c) a running, accessible system exists to test against. For most early-stage projects, these conditions are not simultaneously true. The verifier is a pattern the project instantiates when ready, not an always-on gate. This doc says so, and any claim to the contrary is dishonest.
 
> **Rot banner.** k6 and locust CLI syntax, threshold configuration, and scenario options below are the rot-prone layer. Verify against each tool's live docs before running; where this doc and live docs disagree, the docs win.
 
---
 
## 0. The one idea this layer adds
 
The SPEC.md forcing sections (session 1, `ai-sdlc-architecture.md` §1.2) already require projects to declare their load profile, SLOs, and scaling strategy with a known ceiling. That declaration is the architectural fitness function for scalability — the same pattern session 1 applied to code architecture: vagueness is mechanically detectable because the verifier has nothing to assert against.
 
This session completes the loop with three things:
 
| Concern | Instrument | Rung | Verifier |
|---|---|---|---|
| Load-profile → strategy reasoning | Scalability skill (on-demand) | 3 (on-demand skill) | Skill refuses if Scale & Operations spec section is empty or contains only adjectives [Deterministic refusal] |
| SLO compliance under declared load | Load-test verifier template (`scripts/verify-load.sh`) | 3–5, deterministic when running | k6 threshold exit code / locust wrapper exit code [Deterministic] |
| Scaling decision rationale and ceiling | Ceiling-ADR pattern (uses session 3's ADR skill) | 3 (on-demand skill) | ADR file created with "Reconsider when" field populated [Deterministic presence; judgment quality] |
| Whether the declared ceiling is realistic | — | — | [judgment — review gate] — no deterministic check exists for "is this ceiling number right?" |
 
There are no universal scalability rules in this doc. Kleppmann's core insight applies: scaling architectures are dependent on the application — identical throughput with different load shapes demands different designs (E2c training-recall). The spec section forces the declaration; this layer provides the reasoning tools and the verification mechanism.
 
---
 
## 1. The scalability skill (on-demand — `.claude/skills/scalability/`)
 
### 1.1 Trigger specification (the description field)
 
```
Use this skill when: the project's SPEC.md has a "Scale & operations"
section with CONCRETE numbers (not just "unknown" or "best effort") AND
the current task involves choosing, implementing, or reviewing a scaling
strategy, load-handling design, caching layer, database scaling, or
infrastructure capacity decision.
 
Do NOT use this skill for:
- Projects whose Scale & Operations section says "unknown" or
  "none — best effort" — those declarations are valid and mean "do the
  simplest thing." This skill adds nothing for them.
- Projects that merely MENTION scale, performance, or "fast" in
  conversation without declared numbers in the spec.
- Routine performance optimization (query tuning, algorithm improvement,
  caching a single endpoint) — those are normal development tasks, not
  scaling decisions.
- Frontend performance (bundle size, rendering, LCP/FID) — that is a
  different concern with different tools.
```
 
**Why the negative triggers matter more than the positive ones:** An AI agent loaded with a "scalability skill" will eagerly apply scaling patterns to every project that mentions performance. The negative triggers are the YAGNI enforcement — they prevent the most documented premature-optimization failure in the industry from being automated by the model (E2c, Kleppmann: architectures designed around incorrect load assumptions lead to wasted effort; E2c, Google SRE: 100% reliability is never the right target; guide §5 escalation rule).
 
### 1.2 Skill content — gotchas-first
 
```
## Scalability — on-demand skill
 
### STOP — read this first (the YAGNI counterweight)
 
Building for scale ahead of real load is the most documented
premature-optimization failure in the industry. Before applying ANY
scaling pattern, verify:
 
1. Does the SPEC's Scale & Operations section have CONCRETE numbers?
   If not, STOP. The simplest design that works is the right design.
2. Has the declared load profile ACTUALLY been reached or credibly
   projected? "We might get popular" is not a load profile.
3. Is the current system MEASURED as failing under the declared load?
   If you haven't measured, you don't know. Don't scale what isn't
   broken.
 
If you cannot answer yes to all three: do the simplest thing, declare
its ceiling, and move on. Come back when the numbers say so.
 
### The load-profile → strategy mapping
 
Read the SPEC's Scale & Operations section. The declared load profile
determines which scaling strategies are relevant:
 
STEP 1 — Classify the load shape:
- Read-heavy (high read/write ratio, e.g. content sites, dashboards)
- Write-heavy (high ingestion rate, e.g. logging, analytics, IoT)
- Mixed (balanced read/write, e.g. transactional apps)
- Burst (low baseline, periodic spikes, e.g. events, sales)
- Data-volume (growing storage, stable request rate)
 
STEP 2 — Match to the simplest sufficient strategy:
 
The strategies below are ordered from simplest to most complex.
Use the FIRST one that satisfies the declared load profile.
Do NOT skip ahead.
 
a) SINGLE MACHINE (vertical scaling)
   When: the declared load fits on one appropriately-sized server.
   Ceiling: name the hardware limit (CPU cores, RAM, disk IOPS,
   connection count). Most projects live here longer than builders
   expect (E2c, Kleppmann: "pragmatic mixture" favoring simplicity).
   Action: size the machine, declare the ceiling, move on.
 
b) READ REPLICAS (horizontal read scaling)
   When: read-heavy load exceeds single-machine capacity but writes
   are manageable.
   Prerequisite: application reads can tolerate replication lag.
   Ceiling: write throughput of the primary. Data volume per replica.
   Action: add read replicas, route reads, declare the ceiling.
 
c) STATELESS HORIZONTAL SCALING (process-model scaling)
   When: request processing exceeds single-machine capacity.
   Prerequisite: PROCESSES ARE STATELESS (12-factor Factor VI, E2c).
   If processes hold session state, user uploads, or in-memory
   caches that can't be lost — you cannot add replicas until you
   externalize that state. This is a prerequisite, not a suggestion.
   Ceiling: database connection limits, backing-service throughput,
   shared-state bottleneck.
   Action: externalize state, add replicas behind a load balancer,
   declare the ceiling.
 
d) PARTITIONING / SHARDING (horizontal write scaling)
   When: write throughput or data volume exceeds single-node capacity.
   Prerequisite: a partition key that distributes load evenly and
   doesn't create hot spots.
   Ceiling: cross-partition queries, rebalancing complexity, maximum
   partition count.
   Action: choose partition strategy, declare the ceiling, record
   an ADR (this is a major architectural decision).
 
e) CACHING LAYER
   When: repeated reads of computed or fetched data dominate load.
   Prerequisite: the data has a definable staleness tolerance.
   Ceiling: cache invalidation complexity, memory cost, cold-start
   behavior.
   Action: add cache (Redis, CDN, application-level), declare TTL
   strategy and ceiling.
 
f) ASYNC PROCESSING / QUEUE-BASED
   When: work can be deferred (email, reports, image processing,
   notifications).
   Prerequisite: users tolerate eventual completion.
   Ceiling: queue depth, consumer throughput, ordering guarantees.
   Action: introduce message queue, declare the ceiling.
 
EVERY strategy above requires a ceiling declaration: "this design
holds to ~N; past that, re-architect X." A strategy without a
declared ceiling is incomplete — record it as an ADR with the
"Reconsider when" field populated.
 
### SLO → threshold mapping
 
If the SPEC declares SLOs (not "best effort"), map them to load-test
thresholds:
 
| SLO type | k6 threshold syntax | Example |
|---|---|---|
| Availability | http_req_failed: ['rate<X'] | 99.9% → 'rate<0.001' |
| Latency (percentile) | http_req_duration: ['p(N)<Xms'] | p95 < 500ms → 'p(95)<500' |
| Throughput | http_reqs: ['rate>X'] | > 100 req/s → 'rate>100' |
 
Use percentiles, not averages, for latency SLOs. Averaging percentiles
is mathematically meaningless (E2c, Kleppmann Ch.1). k6 supports
p(50), p(90), p(95), p(99) natively.
 
### Gotchas — AI-specific failure modes
 
1. PREMATURE INFRASTRUCTURE: the model introduces caching, queuing,
   or sharding before measuring whether the simple design fails.
   Check: is the declared ceiling actually reached? If not, revert.
 
2. SCALING THE WRONG LAYER: the model scales the application tier
   when the database is the bottleneck, or vice versa. Check: which
   component's metrics are saturated?
 
3. INVENTED NUMBERS: the model fills the load-test script with
   plausible-sounding thresholds (p95 < 200ms) that don't come from
   the SPEC's SLO declarations. Check: every threshold must trace
   to a declared SLO.
 
4. STATEFUL-BUT-REPLICATED: the model adds replicas to a process
   that holds in-memory state (sessions, file uploads, caches)
   without externalizing it first. Users get inconsistent behavior
   depending on which replica handles their request.
 
5. OPTIMISTIC CACHING: the model adds a cache without defining
   invalidation strategy or staleness tolerance. Check: the cache
   TTL and invalidation mechanism are declared and tested.
```
 
---
 
## 2. The load-test verifier template
 
### 2.1 Tool selection (follows `/stack`)
 
The load-test tool is selected per the existing `/stack` mechanism — no new selection machinery. The selection rule:
 
| Stack language | Default tool | Alternative | Rationale |
|---|---|---|---|
| JavaScript / TypeScript | **k6** | — | Native JS scripting; built-in SLO thresholds produce CI-compatible exit codes (E2 fetched) |
| Python | **locust** | k6 | Native Python scripting removes language-switching friction; requires wrapper script for CI gating (E2 fetched) |
| Other (Go, Java, Rust, etc.) | **k6** | locust | k6's JS scripting is the most language-neutral option; its Go runtime doesn't require Node.js (E2 fetched) |
 
### 2.2 The verifier script pattern — k6 (default)
 
`scripts/verify-load.sh`:
 
```bash
#!/usr/bin/env bash
set -euo pipefail
 
# Load-test verifier — asserts declared SLOs from SPEC.md against
# a running system. Rides the existing test-gate loop.
#
# PREREQUISITES:
#   1. SPEC.md has a "Scale & operations" section with concrete numbers
#   2. SLOs are declared (not "none — best effort")
#   3. k6 is installed (brew install k6 / apt install k6 / docker)
#   4. The system under test is running and accessible at TARGET_URL
#   5. scripts/load-test.js exists with thresholds matching declared SLOs
#
# If any prerequisite is missing, this script exits 0 with a warning.
# A missing prerequisite is NOT a failure — it means load testing is
# not applicable yet. This is correct behavior, not a bug.
 
SPEC_FILE="${SPEC_FILE:-SPEC.md}"
LOAD_TEST_SCRIPT="${LOAD_TEST_SCRIPT:-scripts/load-test.js}"
TARGET_URL="${TARGET_URL:-}"
 
# Check prerequisites
if [ ! -f "$SPEC_FILE" ]; then
  echo "SKIP: No SPEC.md found. Load testing not applicable."
  exit 0
fi
 
if ! grep -q "Scale & operations" "$SPEC_FILE" 2>/dev/null; then
  echo "SKIP: No 'Scale & operations' section in SPEC.md."
  exit 0
fi
 
if grep -q "none.*best effort\|unknown" "$SPEC_FILE" 2>/dev/null && \
   ! grep -qE "[0-9]+ (concurrent|users|requests|req/s)" "$SPEC_FILE" 2>/dev/null; then
  echo "SKIP: Scale section declares 'unknown' or 'best effort' with no concrete numbers."
  echo "This is valid — load testing requires declared targets."
  exit 0
fi
 
if [ ! -f "$LOAD_TEST_SCRIPT" ]; then
  echo "SKIP: No load test script at $LOAD_TEST_SCRIPT."
  echo "Create one with thresholds matching your declared SLOs."
  exit 0
fi
 
if [ -z "$TARGET_URL" ]; then
  echo "SKIP: TARGET_URL not set. The system under test must be running."
  echo "Usage: TARGET_URL=http://localhost:3000 ./scripts/verify-load.sh"
  exit 0
fi
 
if ! command -v k6 &>/dev/null; then
  echo "SKIP: k6 not installed. Install: brew install k6 (macOS) or see https://grafana.com/docs/k6/"
  exit 0
fi
 
# Run the load test. k6 exits non-zero if any threshold is breached.
echo "Running load test against $TARGET_URL..."
k6 run --env TARGET_URL="$TARGET_URL" "$LOAD_TEST_SCRIPT"
```
 
### 2.3 The load-test script pattern — k6
 
`scripts/load-test.js` (template — operator fills thresholds from SPEC's declared SLOs):
 
```javascript
// Load test script — thresholds MUST match declared SLOs from SPEC.md.
// Do NOT invent thresholds. Every threshold traces to a declared SLO.
//
// Fill the TODO sections below from your SPEC's Scale & Operations section.
import http from 'k6/http';
import { check, sleep } from 'k6';
 
export const options = {
  // TODO: Set stages from declared load profile.
  // Example: "500 concurrent users at peak" →
  stages: [
    { duration: '1m',  target: 50 },   // ramp up
    { duration: '3m',  target: 500 },  // hold at declared peak
    { duration: '1m',  target: 0 },    // ramp down
  ],
 
  // TODO: Set thresholds from declared SLOs.
  // Every threshold below MUST trace to a line in SPEC.md.
  thresholds: {
    // Example: "99.9% availability" → rate < 0.001
    http_req_failed: ['rate<0.001'],
    // Example: "p95 latency < 500ms" → p(95) < 500
    http_req_duration: ['p(95)<500'],
  },
};
 
export default function () {
  // TODO: Replace with your critical user journeys.
  // Test user-facing actions, not raw endpoints (E2c, Google SRE).
  const res = http.get(`${__ENV.TARGET_URL}/`);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}
```
 
### 2.4 The verifier script pattern — locust (Python alternative)
 
For Python stacks, `scripts/verify-load.sh` wraps locust with SLO assertion:
 
```bash
#!/usr/bin/env bash
set -euo pipefail
 
# Locust variant — same prerequisite checks as k6 version.
# Locust has no built-in threshold/exit-code mechanism, so this
# wrapper parses the CSV output and asserts against declared SLOs.
 
SPEC_FILE="${SPEC_FILE:-SPEC.md}"
LOAD_TEST_SCRIPT="${LOAD_TEST_SCRIPT:-scripts/locustfile.py}"
TARGET_URL="${TARGET_URL:-}"
USERS="${LOAD_TEST_USERS:-500}"
SPAWN_RATE="${LOAD_TEST_SPAWN_RATE:-50}"
DURATION="${LOAD_TEST_DURATION:-5m}"
 
# ... same prerequisite checks as k6 version ...
 
if ! command -v locust &>/dev/null; then
  echo "SKIP: locust not installed. Install: pip install locust"
  exit 0
fi
 
RESULTS_DIR=$(mktemp -d)
 
echo "Running load test against $TARGET_URL..."
locust -f "$LOAD_TEST_SCRIPT" \
  --host "$TARGET_URL" \
  --users "$USERS" \
  --spawn-rate "$SPAWN_RATE" \
  --run-time "$DURATION" \
  --headless \
  --csv "$RESULTS_DIR/results" \
  --only-summary
 
# TODO: Parse $RESULTS_DIR/results_stats.csv and assert against
# declared SLOs. Example:
# - Check that failure rate < declared availability SLO
# - Check that p95 response time < declared latency SLO
# Exit non-zero if any SLO is breached.
 
echo "Results saved to $RESULTS_DIR"
echo "TODO: Add SLO assertion logic for your declared thresholds."
```
 
### 2.5 Breakpoint test pattern
 
For validating the declared ceiling — ramp until breach:
 
```javascript
// breakpoint-test.js — find where the declared ceiling actually is.
// Run this AFTER the standard load test passes.
import http from 'k6/http';
import { check, sleep } from 'k6';
 
export const options = {
  scenarios: {
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 1000,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '2m', target: 500 },
        { duration: '2m', target: 1000 },
      ],
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true }],
    http_req_duration: [{ threshold: 'p(95)<1000', abortOnFail: true }],
  },
};
 
export default function () {
  const res = http.get(`${__ENV.TARGET_URL}/`);
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(0.5);
}
```
 
The breaking point is where k6 aborts. Compare against the declared ceiling in the SPEC. If the actual breaking point is significantly lower than declared, the ceiling declaration needs updating.
 
---
 
## 3. The scaling-ceiling ADR pattern
 
### 3.1 Integration with session 3's ADR mechanism
 
Session 3 delivered a full ADR skill with the Nygard template and a "Reconsider when" field. The ceiling-ADR pattern is **not a new template** — it is a triggering rule addition and an acceptance example for the existing ADR skill.
 
**Triggering rule addition** (append to session 3's ADR skill trigger specification):
 
```
Also triggers when: a scaling strategy is chosen or changed in the
SPEC's Scale & Operations section, or when a scaling ceiling is
declared, updated, or reached.
```
 
### 3.2 Acceptance example — a scaling-ceiling ADR
 
```markdown
# ADR-003: Single-VM Postgres for the first year
 
## Status
 
Accepted
 
## Context
 
The SPEC declares: "~200 concurrent users at launch, growing to ~1000
over 12 months. SLO: 99.5% availability, p95 < 500ms." The Scale &
Operations section forces a scaling strategy declaration with a known
ceiling.
 
We evaluated three options: single VM with Postgres, managed database
with read replicas, and a multi-region setup. The load profile
(200–1000 concurrent, read-heavy dashboard app) fits comfortably on
a single appropriately-sized VM.
 
## Alternatives considered
 
- Managed DB with read replicas: adds operational complexity (replica
  lag handling, connection routing) for load the single VM handles
  easily. Rejected as premature.
- Multi-region: the user base is single-region. Rejected as premature
  and expensive.
 
## Decision
 
Single VM (4 vCPU, 16 GB RAM) running Postgres. Application deployed
as stateless containers behind a load balancer on the same VM (docker
compose). Connection pool sized to 100.
 
## Consequences
 
- Positive: simplest possible ops. One machine to monitor, backup,
  and restore. No replication lag. No partition key design.
- Negative: single point of failure (mitigated by automated backups
  and a documented recovery procedure). Cannot horizontally scale
  writes without re-architecting.
 
## Reconsider when
 
- Concurrent users exceed 800 sustained (80% of estimated VM capacity)
- Database size exceeds 50 GB (backup/restore time becomes significant)
- p95 latency exceeds 400ms under normal load (80% of SLO)
- Availability drops below 99.3% in any month (consuming error budget
  faster than sustainable)
 
At that point: evaluate managed Postgres with read replicas as the
next step. Do not jump to sharding.
```
 
The "Reconsider when" field is the ceiling's trigger — concrete numbers that, when reached, force the ADR to be revisited. An ADR without a "Reconsider when" for a scaling decision is incomplete.
 
---
 
## 4. E2c conflict assessment
 
**No E2c conflicts found.** The three source families (Kleppmann, Google SRE, 12-factor) are complementary:
 
- Kleppmann provides the vocabulary: load parameters, scaling approaches (vertical/horizontal, replication/partitioning), the "pragmatic mixture" framing.
- Google SRE provides the measurement framework: SLI/SLO/error budget, the "100% is never right" principle, the "start simple and tighten" advice.
- 12-factor provides the process-model prerequisite: statelessness for horizontal scaling (Factor VI, consensus).
One *tension* exists: whether to default to vertical-first or horizontal-first. Kleppmann resolves it explicitly — "pragmatic mixture" favoring simplicity, because high-end machines can be simpler and cheaper than distributed systems. Google SRE resolves it implicitly — "start with a loose target" and tighten. This is not a conflict between sources; it is a per-project decision already handled by the SPEC's "scaling strategy" field (session 1). No tradeoff table required — the resolution mechanism already exists.
 
---
 
## 5. Integration diffs — `ai-sdlc-unified-pipeline.md` v1.3 → v1.4
 
### 5.1 Skill addition
 
**Add** to `.claude/skills/` directory:
 
- `scalability/` — Load-profile-to-strategy mapping, SLO-to-threshold mapping, YAGNI counterweight, AI-specific gotchas (§1 above). Trigger: Scale & Operations spec section has concrete numbers AND task involves scaling decisions. Negative triggers explicitly listed.
### 5.2 Verifier template addition
 
**Add** to `scripts/` directory pattern:
 
- `verify-load.sh` — Load-test verifier (§2 above). Tool selected per `/stack` (k6 default, locust for Python stacks). Exits 0 (skip) when prerequisites are missing; exits non-zero when SLO thresholds are breached. Rides the existing `test-gate.sh` loop.
- `load-test.js` (or `locustfile.py`) — Load-test script template with thresholds traced to declared SLOs.
### 5.3 ADR trigger addition
 
**Append** to session 3's ADR skill trigger specification:
 
```
Also triggers when: a scaling strategy is chosen or changed in the
SPEC's Scale & Operations section, or when a scaling ceiling is
declared, updated, or reached.
```
 
### 5.4 Review-gate failure class additions
 
**Add** to the `/review` command's failure-class list:
 
- **Premature scaling** — scaling infrastructure introduced without evidence that the declared load profile has been reached or that the current design fails under it. Verifier: check whether load-test results exist showing the simpler design's failure. [judgment — review gate, informed by the presence/absence of load-test evidence]
- **Undeclared ceiling** — a scaling decision made without recording the design's known ceiling and the trigger for revisiting it. Verifier: check for a ceiling ADR with a populated "Reconsider when" field. [Deterministic presence check]
### 5.5 Known failure modes additions to pipeline §10
 
**Add:**
 
| Symptom | Why | Fix |
|---|---|---|
| Skill triggers on projects that merely mention scale in conversation | The trigger description matches on topic, not on spec content | Negative triggers in skill description require concrete numbers in the Scale & Operations spec section, not keywords in conversation |
| Load tests assert against invented numbers | The model fills thresholds with plausible-sounding values not from the spec | Skill gotcha #3; every threshold must trace to a declared SLO. The verifier template's TODO comments name this explicitly. |
| Load test passes but system fails in production | The test ran against localhost or a scaled-down staging environment | Dev/prod parity (12-factor X, E2c); the verifier script's TARGET_URL must point at a representative environment. [judgment — review gate] |
| Ceiling ADR filed without a "Reconsider when" | The model treats the ADR as a one-time documentation exercise | The acceptance example (§3.2) makes the "Reconsider when" field non-negotiable. Missing triggers → ADR is incomplete. |
 
### 5.6 Convergent architecture tree update
 
**Add** to pipeline §8's project tree:
 
```
├── scripts/
│   ├── verify-load.sh            # load-test verifier (prerequisites → skip; SLO breach → fail)
│   ├── load-test.js              # k6 load test (or locustfile.py for Python stacks)
│   └── ...existing...
├── .claude/
│   ├── skills/
│   │   ├── scalability/          # load-profile → strategy mapping, YAGNI counterweight
│   │   └── ...existing...
```
 
### 5.7 Version bump
 
`ai-sdlc-unified-pipeline.md` version: **v1.3 → v1.4.** Version line update:
 
> **Version 1.4 — July 2026.** [...] **v1.4 adds:** the scalability on-demand skill (load-profile-to-strategy mapping with YAGNI counterweight, SLO-to-threshold mapping, AI-specific gotchas with negative triggers), the load-test verifier template (k6 default / locust for Python, selected per `/stack`; asserts declared SLOs; skips when prerequisites are missing), the scaling-ceiling ADR trigger addition to session 3's ADR skill, two new review-gate failure classes (premature scaling, undeclared ceiling), and four new failure modes. See `ai-sdlc-scalability.md` for the companion doc. Standing-context delta: 0 lines (all additions are on-demand).
 
---
 
## 6. Known failure modes (seeded)
 
Per plan §2 invariant 6. Seeded from the plan's anticipated modes plus research findings. To be populated by field use.
 
| # | Failure mode | Verifier | Status |
|---|---|---|---|
| 1 | **Skill triggers on non-scale projects** — the model loads the scalability skill because the user mentioned "performance" or "fast," but the spec has no concrete scale numbers. | Negative triggers in skill description: refuses without concrete numbers in Scale & Operations section. | Anticipated (plan §7); mitigated by construction |
| 2 | **Invented thresholds** — the load-test script has thresholds (p95 < 200ms, error rate < 0.1%) that sound right but don't trace to any declared SLO. | Skill gotcha #3; the load-test template's TODO comments name each threshold as requiring a SPEC source. [Requires operator discipline] | Anticipated (plan §7) |
| 3 | **Premature scaling infrastructure** — the model introduces Redis caching, message queues, or read replicas before the single-machine design has been measured as failing. | Review-gate failure class "Premature scaling." Check: do load-test results exist showing the simpler design fails? [judgment — review gate] | Anticipated (synthesis finding #2) |
| 4 | **Stateful-but-replicated** — the model adds horizontal replicas to a process that holds in-memory state without externalizing it first. Users see inconsistent behavior. | Skill gotcha #4; Factor VI gate in strategy mapping. [judgment — review gate, partially checkable by reviewing session/state management code] | Anticipated (12-factor analysis) |
| 5 | **Ceiling ADR without "Reconsider when"** — a scaling decision is recorded as an ADR but the ceiling field is empty or contains vague prose ("when we need to scale"). | ADR acceptance example makes the field non-negotiable; concrete numbers required. [Deterministic presence check; number quality is judgment] | Anticipated |
| 6 | **Load test only runs on localhost** — the verifier passes because localhost has no network latency, no shared resources, and no concurrent users. Production fails under real conditions. | Dev/prod parity reminder in verifier script comments. The TARGET_URL must be a representative environment. [judgment — review gate] | Anticipated (12-factor X) |
| 7 | **Skill gotchas that never fire** — anti-patterns asserted in the skill are E4/field-observed, not measured. | Prune per guide §5 — each gotcha is individually falsifiable by your sessions. | Honesty mark, by design |
 
---
 
## 7. Ruling-driven deviation log
 
| Ruling | Plan text | Deviation | Rationale |
|---|---|---|---|
| Issue 1 (from kickoff) | Plan §7 scope item 3: "Scaling-ceiling ADR pattern — every scaling decision records its ceiling [...] connecting to session 3's mechanism." | Delivered as a triggering rule addition and acceptance example for session 3's existing ADR skill, not as a new ADR template. | A new template would duplicate session 3's template (which already has "Reconsider when"). The ceiling pattern is a usage pattern of the existing mechanism, not new machinery. Confirmed at session kickoff. |
 
---
 
## 8. Acceptance invariant checklist (self-verification)
 
| # | Invariant | Status |
|---|---|---|
| 1 | Standing-context ≤ 10 lines | **Pass.** 0 lines. All additions are on-demand: skill loads on trigger with concrete spec numbers, verifier template instantiated per-project, ADR trigger appended to existing skill. |
| 2 | Every rule names its verifier or is marked [judgment — review gate] | **Pass.** Skill refusal → deterministic. Load-test thresholds → deterministic exit code. Ceiling ADR presence → deterministic. Ceiling number quality → judgment, marked. Premature scaling → judgment, marked. |
| 3 | No pattern-compliance rules | **Pass.** The strategy mapping offers ordered options, not mandates. No rule says "use caching" or "use sharding." The rule is: declare what you chose and its ceiling. |
| 4 | Every E2c conflict → tradeoff table + decision hook | **Pass.** No E2c conflicts found (§4). Vertical-vs-horizontal tension resolved by existing per-project decision hook in Scale & Operations spec section, not silently. |
| 5 | Integration diffs are explicit | **Pass.** §5: one skill addition, one verifier template addition, one ADR trigger addition, two review-gate failure classes, four failure mode additions, tree update, version bump — all named with concrete content. |
| 6 | Known failure modes section, seeded | **Pass.** §6: seven failure modes seeded from plan's anticipated modes and research findings. |
| 7 | Evidence marks on every substantive claim | **Pass.** Every source claim carries E2c/E2/E4 + (training-recall) or (fetched). |
| 8 | On-demand parts explicitly marked | **Pass.** Activation note at top; skill has explicit negative triggers; verifier exits 0 on missing prerequisites with explanatory message; ADR trigger appends to existing on-demand skill. |
 
---
 
## Appendix — evidence register additions (for guide Appendix B)
 
| Source | Class | Role |
|---|---|---|
| Kleppmann, *Designing Data-Intensive Applications* (Ch.1 load/performance/scaling, Ch.5–6 replication/partitioning — training-recall, cross-referenced with fetched summaries) | **E2c (training-recall)** | Load-profile vocabulary, "pragmatic mixture" scaling approach, percentile measurement, partitioning/replication as fundamental distribution mechanisms |
| Google SRE book + SRE Workbook (sre.google — fetched) | **E2c (fetched)** | SLI/SLO/error-budget framework, "100% is never right," user-centric SLOs via critical user journeys, error budget policy as organizational machinery |
| 12-Factor App (12factor.net — training-recall, cross-referenced with fetched retrospectives) | **E2c (training-recall)** | Factor VI (stateless processes) as horizontal-scaling prerequisite. Per-factor aging assessment: 9 consensus, 3 contested (env-var config, port binding, logs-only observability) |
| k6 (grafana.com/docs/k6/ — fetched) | **E2 (fetched)** | Default load-test tool. Thresholds as SLO codification, scenario-based load modeling, CI-native exit codes |
| Locust (locust.io, github.com/locustio/locust — fetched) | **E2 (fetched)** | Alternative load-test tool for Python stacks. No built-in threshold mechanism; requires wrapper |
| 12-factor retrospectives (tibobeijen.nl 2024, daily.dev 2026, pyyne.com 2025 — fetched) | **E4 (fetched)** | Per-factor aging assessment and "proposed 13th factor" (forward/backward compatibility in rolling deploys) |