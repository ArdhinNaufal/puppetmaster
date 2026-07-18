/**
 * Demo seeder — populate a database that reflects the full usage of the system,
 * dense enough that the NEXUS operation figure (docs/NEXUS.md §2.1) reads as a
 * full, live instrument rather than a sparse one. Every stratum of the figure
 * maps to real rows this seeder creates:
 *
 *   Agent orbit      → agents            (createAgent)          — many nodes
 *   Workflow lattice → workflows         (createWorkflow)       — varied graph sizes
 *   Knowledge shell  → documents/chunks  (kbIngest)             — fills the particle band
 *   Mission threads  → LIVE missions     (queued + awaiting_approval, capped 12)
 *   Memory halo/rim  → pending approvals + failed missions
 *
 * Runs the *real* kernel (mock model, in-memory bus, inline dispatch) so every
 * row is genuine, not hand-faked. Missions left `queued` (started, never
 * dispatched) and `awaiting_approval` (gated, undecided) persist as the figure's
 * live "puppet strings" — the server does not drain them on boot. Share the
 * store with the server via PGLITE_DATA_DIR (or DATABASE_URL):
 *
 *   PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server seed:demo
 *   PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server start
 */
import {
  appendAudit,
  backdateEntity,
  createAgent,
  createDb,
  createUser,
  createWorkflow,
  ensureDefaultWorkspace,
  getMission,
  listAgents,
  listApprovals,
  listDocuments,
  listMissions,
  listWorkflows,
  migrate,
  resolveApproval,
  updateWorkspace,
  upsertMembership,
  seedBuiltinTemplates,
  type Db,
} from "@puppetmaster/db";
import {
  AgentRuntime,
  BuiltinToolRegistry,
  InMemoryEventBus,
  ModelRouter,
  WorkflowExecutor,
  createAgentInvoker,
  createEmbedder,
  kbIngest,
  registerBridgeTools,
  registerKbTools,
  startAgentTick,
  startWorkflow,
  type KbDeps,
  type MissionDispatcher,
} from "@puppetmaster/kernel";
import { sql } from "drizzle-orm";
import { hashPassword } from "./auth.js";
import { createAuditSink } from "./audit.js";
import { BUILTIN_TEMPLATES } from "./seeds.js";

const PASSWORD = "demodemo123";

// --- Agent roster (orbit nodes; autonomy varies the tick glyph 1/2/3) --------
type Autonomy = "read_auto" | "write_approved" | "destructive_confirmed";
const AGENTS: { name: string; persona: string; autonomy: Autonomy; toolGrants?: string[] }[] = [
  { name: "Research Scout", autonomy: "write_approved", persona: "You are a diligent research assistant. Investigate questions, cite what you find, and save durable facts with memory__save so you can recall them later." },
  { name: "Ops Responder", autonomy: "write_approved", toolGrants: ["workflow.*", "util.*", "http.*"], persona: "You are an on-call operations agent. Triage issues, run the appropriate workflow with workflow.run, and track incident state in your scratchpad." },
  { name: "Support Concierge", autonomy: "write_approved", persona: "You are a friendly front-line support agent. Answer questions and remember customer preferences." },
  { name: "Data Librarian", autonomy: "read_auto", toolGrants: ["kb.*", "memory.*"], persona: "You curate the knowledge base. Answer strictly from indexed documents and always cite the source chunk." },
  { name: "Release Marshal", autonomy: "destructive_confirmed", toolGrants: ["workflow.*", "http.*"], persona: "You shepherd releases. Cut, tag, and roll out builds — every irreversible step pauses for a human confirm." },
  { name: "Security Sentinel", autonomy: "read_auto", toolGrants: ["kb.*", "http.*"], persona: "You watch for security regressions. Read logs and advisories, summarize risk, and never mutate state yourself." },
  { name: "Finance Analyst", autonomy: "write_approved", toolGrants: ["kb.*", "util.*"], persona: "You reconcile spend and forecast burn. Explain the numbers and flag anomalies for review." },
  { name: "Content Editor", autonomy: "write_approved", toolGrants: ["kb.*", "util.*"], persona: "You polish drafts for voice and clarity. Suggest edits and keep a house style guide in memory." },
  { name: "Incident Commander", autonomy: "destructive_confirmed", toolGrants: ["workflow.*", "http.*", "util.*"], persona: "You run major incidents. Coordinate the response, page owners, and authorize mitigations under confirm." },
  { name: "QA Sentinel", autonomy: "read_auto", toolGrants: ["kb.*", "util.*"], persona: "You audit quality. Read test output and specs, report failures by severity, and never edit the code under test." },
  { name: "Growth Scout", autonomy: "write_approved", toolGrants: ["http.*", "util.*", "memory.*"], persona: "You probe growth experiments. Summarize funnels, remember what converted, and propose the next test." },
  { name: "Infra Warden", autonomy: "destructive_confirmed", toolGrants: ["workflow.*", "http.*"], persona: "You keep infrastructure healthy. Scale, drain, and recycle nodes — destructive actions always confirm first." },
];

// --- Knowledge base (the shell's particle band; ~chunk per heading) ----------
function doc(title: string, sections: [string, string][]): { title: string; content: string } {
  const body = sections.map(([h, p]) => `## ${h}\n\n${p}`).join("\n\n");
  return { title, content: `# ${title}\n\n${body}\n` };
}
const KB_DOCS = [
  doc("Runbook: Database Failover", [
    ["Overview", "Primary is PostgreSQL 17 with pgvector in us-east-1; a hot standby streams in us-west-2. This runbook covers a controlled and an emergency failover."],
    ["Preconditions", "Confirm replication lag under 5 seconds and that the standby has caught up to the primary's current LSN before promoting."],
    ["Controlled failover", "Drain writes, checkpoint the primary, promote the standby with pg_ctl promote, then repoint the pgbouncer upstream."],
    ["Emergency failover", "If the primary is unreachable, promote immediately and accept the small window of un-replicated writes recorded in the audit trail."],
    ["Reconnecting clients", "Rotate the connection secret and bounce the API pods; connections re-establish against the new primary within thirty seconds."],
    ["Rebuilding the old primary", "Re-seed the demoted node from a base backup and re-attach it as the new standby; never let it rejoin as a second primary."],
    ["Verification", "Run the smoke suite, confirm write latency is nominal, and check that the vector index answers a known query."],
    ["Rollback", "There is no rollback after promotion; the demoted node is rebuilt, not reverted."],
  ]),
  doc("Runbook: Incident Response", [
    ["Severity ladder", "SEV1 is customer-facing outage, SEV2 is degraded, SEV3 is internal-only. The severity sets the paging and comms cadence."],
    ["Roles", "Incident Commander owns decisions, Scribe owns the timeline, Comms owns status updates. One person never holds two roles."],
    ["First five minutes", "Acknowledge the page, open the incident channel, declare severity, and post the first status even if it only says 'investigating'."],
    ["Mitigation before diagnosis", "Restore service first; understand the root cause after. A rollback or feature-flag flip beats a perfect explanation."],
    ["Communication", "Status updates go out every fifteen minutes for SEV1, every thirty for SEV2, until resolved."],
    ["Handoff", "At shift change the outgoing Commander briefs the incoming one in the channel; the timeline is the source of truth."],
    ["Postmortem", "Blameless, within three business days, with at least one durable action item that changes a system, not a person."],
  ]),
  doc("Architecture: The Model Router", [
    ["Purpose", "One provider abstraction so any agent can run on Anthropic, OpenAI-compatible, Ollama, or a local runtime by setting its model string."],
    ["Selection", "The model string prefix routes: claude-* to Anthropic, openai/* and ollama/* to the OpenAI-compatible client, mock* to the scripted provider."],
    ["Fallback chains", "A pipe-separated model string tries each candidate in order and records which one served, so a provider outage routes around itself."],
    ["Router profiles", "A profile names a workspace chain with cost tiers and a floor; callers holding gated tools refuse to silently serve below the floor."],
    ["Health and cooldowns", "Consecutive failures cool a candidate down; quota errors honor retry-after; cooling candidates are deprioritized, never dropped."],
    ["Token accounting", "Every call accumulates input/output tokens for the usage ledger surfaced on the operations views."],
  ]),
  doc("Architecture: The Workshop", [
    ["Phases", "SPECIFY, PLAN, EXECUTE, VERIFY, and RECORD each map to an agent behavior or a deterministic gate — the software lifecycle as first-class objects."],
    ["Verify gates", "Deterministic checks (test, arch, refactor-gate, todo-sync, spec-sections, load) gate a mission and attach evidence; earned policies are off by default."],
    ["The workbench", "Each project gets an isolated container: non-root, default-closed egress via an allowlist proxy, resource caps, secrets from the vault only."],
    ["Delegation", "bench.delegate runs guarded coding work inside the workbench. Claude is the supported mutating delegate; OpenAI/Aider edits use the CLAUDE page's durable approval and copy-back path."],
    ["Knowledge mirror", "Accepted specs and learnings mirror into the knowledge base so retrieval and citations work over the project's own artifacts."],
    ["Independence", "Review runs on a fresh-context agent invoked separately, so the reviewer never shares the builder's conversation."],
  ]),
  doc("Onboarding: New Operators", [
    ["The NEXUS", "The operations theater is view one for every role: a single figure whose strata are the live agents, workflows, knowledge, tools, and missions."],
    ["Views", "Number keys one through nine switch views; the command palette opens with the mod key and K and drives every action by keyboard."],
    ["Roles", "Owner, admin, builder, and member see the same shell with permissions scoped to their role; approvals route to admins and owners."],
    ["Approvals", "Write-tier actions pause for a decision; destructive actions always confirm. The authorizations inbox is where you clear them."],
    ["Missions", "A mission is one run of a workflow or an agent tick; its status, steps, and evidence are the audit record of what happened."],
    ["Getting help", "Ask the Support Concierge or search the knowledge base; every runbook here is indexed and citable."],
  ]),
  doc("Policy: Data Handling", [
    ["Classification", "Data is public, internal, confidential, or restricted; the class sets retention, encryption, and who may read it."],
    ["Untrusted input", "Every tool result re-enters model context inside an untrusted-data envelope; instructions inside external data are never obeyed."],
    ["Secrets", "Credentials live in the vault and are injected at the workbench boundary; they never appear in prompts, logs, or artifacts."],
    ["Retention", "Confidential data is purged on a ninety-day cycle unless a legal hold pins it; the purge is audited."],
    ["Access review", "Membership and tool grants are reviewed quarterly; least privilege is the default and every grant names its reason."],
  ]),
  doc("Guide: Writing Workflows", [
    ["Anatomy", "A workflow is a graph of nodes and edges: triggers start it, code transforms, actions call tools, logic branches, and approvals gate."],
    ["Input resolution", "A non-trigger node reads its immediately-upstream node's output; only entry nodes see the mission payload directly."],
    ["Branching", "A logic node with a branch expression routes to different downstream edges based on the upstream result."],
    ["Gating", "Insert an approval node before any outbound or irreversible action to pause the run for a human decision."],
    ["Testing", "Run manually with a sample payload, watch the trace, and confirm each node's output before scheduling it on a trigger."],
  ]),
  doc("Reference: Tool Catalog", [
    ["Namespaces", "Tools are grouped by server: util, http, email, memory, workflow, agent, kb, project, and bench each expose a small verb set."],
    ["Tiers", "Every tool has a tier: read auto-runs, write pauses for approval, destructive always confirms — the tier is the danger dial."],
    ["The bridge", "workflow and agent tools let one automation drive another, which is how orchestration composes without a new boundary."],
    ["Bench tools", "The bench namespace drives a project's workbench: read, exec, write, git, and delegate, each tiered by how much it can break."],
    ["Adding servers", "Workspace MCP servers extend the catalog; an offline server shows as a dashed spoke until it reconnects."],
  ]),
  doc("Runbook: Certificate Rotation", [
    ["Inventory", "Track every TLS certificate with its expiry; a certificate that lapses is an outage that a calendar could have prevented."],
    ["Rotation window", "Rotate at least thirty days before expiry so a failed rotation still leaves a working certificate in place."],
    ["Procedure", "Issue the new certificate, stage it beside the old, reload the terminator, then retire the old certificate once traffic is clean."],
    ["Verification", "Confirm the served chain, the expiry, and that no client pins the retired certificate before removing it."],
    ["Automation", "The nightly health check flags certificates inside the rotation window so none is rotated by surprise."],
  ]),
  doc("Postmortem: The us-east Latency Spike", [
    ["Summary", "A connection-pool exhaustion caused elevated latency for eleven minutes; no data was lost and no writes were dropped."],
    ["Timeline", "Alert fired, commander declared SEV2, the pool ceiling was raised, latency recovered, and the incident closed within the hour."],
    ["Root cause", "A slow downstream query held connections longer than the pool assumed, starving new requests during a traffic peak."],
    ["What went well", "Mitigation preceded diagnosis; raising the ceiling restored service before the root cause was understood."],
    ["Action items", "Add a query-time budget, alert on pool saturation, and load-test the peak path with the real connection ceiling."],
  ]),
  doc("Guide: Approvals and Authorization", [
    ["Why gates exist", "Autonomy without a brake is how automation causes harm; the tier system makes the brake explicit and auditable."],
    ["Write tier", "A write-tier action pauses once for a yes or no; approving it resumes the exact mission where it stopped."],
    ["Destructive tier", "A destructive action always confirms, even for a trusted agent, because the cost of a mistake is irreversible."],
    ["Evidence", "An escalation carries the evidence that triggered it — check output, diffs, or the failing state — so the decision is informed."],
    ["Delegation", "Approvers can be scoped by role; an owner can always decide, an admin decides within their grant."],
  ]),
  doc("Reference: Glossary", [
    ["Agent", "A configured persona with a model, an autonomy tier, and a set of tool grants that runs as missions."],
    ["Workflow", "A graph automation that runs deterministically from a trigger through code, actions, logic, and approvals."],
    ["Mission", "One execution of a workflow or an agent tick, with a status, ordered steps, and attached evidence."],
    ["Approval", "A pause point where a human authorizes a gated action; the mission resumes on the decision."],
    ["Workspace", "The tenancy boundary: agents, workflows, knowledge, and missions all belong to exactly one workspace."],
    ["Construct", "The central NEXUS figure whose strata visualize the workspace's live operational state."],
  ]),
  doc("Runbook: Cache Warmup", [
    ["Why warm", "A cold cache after a deploy stampedes the database; warming the hot keys before shifting traffic avoids the thundering herd."],
    ["Hot key set", "Warm the top thousand product and session keys measured from the prior day's access log before cutover."],
    ["Procedure", "Prime the cache against the new pool, confirm the hit rate crosses ninety percent, then shift the load balancer."],
    ["Verification", "Watch origin request rate stay flat through the shift; a spike means the warm set missed real traffic."],
    ["Fallback", "If warming stalls, shift a small canary slice first so the cache fills from real requests without a full stampede."],
  ]),
  doc("Policy: On-Call", [
    ["Rotation", "The primary rotation resets every Monday at 09:00; the secondary is one week offset so no one is ever alone."],
    ["Response time", "Acknowledge a SEV1 page within five minutes and a SEV2 within fifteen; a missed ack escalates to the secondary."],
    ["Handoff", "The outgoing primary writes a handoff note covering open incidents, flaky alerts, and anything watched but not yet paged."],
    ["Compensation", "On-call weeks are tracked and compensated; carrying the pager is work, not a favor."],
    ["Alert hygiene", "Every page must be actionable; an alert that fires without a runbook is a bug filed against the alert, not the responder."],
  ]),
  doc("Guide: Debugging a Mission", [
    ["Start at the status", "A failed mission names the node that threw; a stuck one is usually waiting on an approval that no one has decided."],
    ["Read the trace", "The trace lists each step's input and output in order; the first surprising output is where reality diverged from the graph."],
    ["Evidence", "A gated escalation carries the check output or diff that triggered it — read the evidence before overriding the gate."],
    ["Reproduce", "Re-run the workflow manually with the same payload; deterministic nodes reproduce exactly, so a difference points at external state."],
    ["Idempotency", "A re-enqueued mission resumes from its cursor; steps already applied are not repeated, so a retry is safe."],
  ]),
  doc("Reference: The Event Bus", [
    ["Purpose", "The bus carries live events — mission, approval, and agent-message updates — to every connected operations surface."],
    ["Connection", "A disconnected bus puts the NEXUS figure into its dormant state: greyed strata, no motion, a hollow core."],
    ["Event kinds", "mission.* tracks lifecycle, approval.* tracks the inbox, agent.message carries streaming replies; each pulses the figure."],
    ["Backpressure", "The signal ticker counts received events; a sustained high rate is normal under load, not an error."],
    ["Reconnect", "On drop the client retries with backoff and refetches the snapshot, so the figure heals when the link returns."],
  ]),
];

// --- Workflow graphs (lattice nodes; node count sets the inner n-gon) --------
const trig = (x = 60) => ({ id: "t", kind: "trigger", label: "Manual", config: { mode: "manual" }, position: { x, y: 120 } });
const echo = (id: string, value: string, x: number, y = 120) => ({ id, kind: "action", label: id, config: { server: "util", tool: "echo", args: { value } }, position: { x, y } });
const code = (id: string, source: string, x: number) => ({ id, kind: "code", label: id, config: { source }, position: { x, y: 120 } });

const WORKFLOWS: { name: string; graph: unknown }[] = [
  {
    name: "Nightly Reconciliation",
    graph: {
      nodes: [trig(), code("norm", "return { n: (input.n ?? 3) * 2 };", 260), echo("a", "step-a", 460), echo("b", "step-b", 660), echo("done", "reconciled", 860)],
      edges: [{ from: "t", to: "norm" }, { from: "norm", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "done" }],
    },
  },
  {
    name: "Deploy Pipeline",
    graph: {
      nodes: [
        trig(), echo("build", "build", 240), echo("test", "test", 420),
        { id: "gate", kind: "approval", label: "Approve prod", config: { prompt: "Ship to production?", tier: "destructive_confirmed" }, position: { x: 600, y: 120 } },
        echo("ship", "shipped", 800),
      ],
      edges: [{ from: "t", to: "build" }, { from: "build", to: "test" }, { from: "test", to: "gate" }, { from: "gate", to: "ship" }],
    },
  },
  {
    name: "Customer Onboarding",
    graph: {
      nodes: [
        trig(), code("mk", "return { account: `acct-${input.name ?? 'new'}` };", 240),
        echo("provision", "provisioned", 440), echo("welcome", "welcome-sent", 640),
        { id: "b", kind: "logic", label: "enterprise?", config: { op: "branch", expression: "out.account.length > 12" }, position: { x: 840, y: 120 } },
        echo("csm", "assigned-csm", 1040, 40), echo("self", "self-serve", 1040, 210),
      ],
      edges: [{ from: "t", to: "mk" }, { from: "mk", to: "provision" }, { from: "provision", to: "welcome" }, { from: "welcome", to: "b" }, { from: "b", to: "csm", condition: "out === true" }, { from: "b", to: "self", condition: "out === false" }],
    },
  },
  {
    name: "Uptime Monitor",
    graph: {
      nodes: [
        trig(), { id: "g", kind: "action", label: "GET", config: { server: "http", tool: "get", args: { url: "https://example.com" } }, position: { x: 260, y: 120 } },
        { id: "b", kind: "logic", label: "healthy?", config: { op: "branch", expression: "out.ok === true" }, position: { x: 480, y: 120 } },
        echo("ok", "HEALTHY", 700, 40), echo("bad", "PAGE-ONCALL", 700, 210),
      ],
      edges: [{ from: "t", to: "g" }, { from: "g", to: "b" }, { from: "b", to: "ok", condition: "out === true" }, { from: "b", to: "bad", condition: "out === false" }],
    },
  },
  {
    name: "Weekly Digest",
    graph: {
      nodes: [trig(), code("sum", "return { items: (input.items ?? 7) };", 260), echo("render", "rendered", 460), echo("send", "digest-sent", 660)],
      edges: [{ from: "t", to: "sum" }, { from: "sum", to: "render" }, { from: "render", to: "send" }],
    },
  },
  {
    name: "Ledger Reconcile (flaky)",
    graph: {
      nodes: [trig(), code("pull", "throw new Error('upstream ledger returned 502');", 260), echo("post", "posted", 460)],
      edges: [{ from: "t", to: "pull" }, { from: "pull", to: "post" }],
    },
  },
  {
    name: "Data Export",
    graph: {
      nodes: [
        trig(), code("q", "return { rows: 1200 };", 240), echo("extract", "extracted", 440),
        { id: "gate", kind: "approval", label: "Approve export", config: { prompt: "Export 1200 rows to the partner bucket?", tier: "write_approved" }, position: { x: 640, y: 120 } },
        echo("push", "exported", 840),
      ],
      edges: [{ from: "t", to: "q" }, { from: "q", to: "extract" }, { from: "extract", to: "gate" }, { from: "gate", to: "push" }],
    },
  },
  {
    name: "Lead Scoring",
    graph: {
      nodes: [
        trig(), code("score", "return { score: (input.signals ?? 5) * 9 };", 240),
        { id: "b", kind: "logic", label: "hot?", config: { op: "branch", expression: "out.score > 40" }, position: { x: 460, y: 120 } },
        echo("route", "routed-to-sales", 680, 40), echo("nurture", "nurture-track", 680, 210),
      ],
      edges: [{ from: "t", to: "score" }, { from: "score", to: "b" }, { from: "b", to: "route", condition: "out === true" }, { from: "b", to: "nurture", condition: "out === false" }],
    },
  },
  {
    name: "Backup Verify",
    graph: {
      nodes: [trig(), echo("restore", "restored-to-scratch", 260), echo("checksum", "checksum-ok", 460), echo("teardown", "torn-down", 660)],
      edges: [{ from: "t", to: "restore" }, { from: "restore", to: "checksum" }, { from: "checksum", to: "teardown" }],
    },
  },
  {
    name: "Churn Watch",
    graph: {
      nodes: [
        trig(), code("risk", "return { risk: (input.inactiveDays ?? 10) * 4 };", 240),
        { id: "b", kind: "logic", label: "at risk?", config: { op: "branch", expression: "out.risk > 30" }, position: { x: 460, y: 120 } },
        echo("save", "retention-play", 680, 40), echo("watch", "keep-watching", 680, 210),
      ],
      edges: [{ from: "t", to: "risk" }, { from: "risk", to: "b" }, { from: "b", to: "save", condition: "out === true" }, { from: "b", to: "watch", condition: "out === false" }],
    },
  },
  {
    name: "Invoice Sweep",
    graph: {
      nodes: [
        trig(), code("collect", "return { invoices: (input.count ?? 20) };", 240), echo("validate", "validated", 440),
        { id: "gate", kind: "approval", label: "Approve charge", config: { prompt: "Charge the validated invoices?", tier: "write_approved" }, position: { x: 640, y: 120 } },
        echo("charge", "charged", 840), echo("receipt", "receipts-sent", 1040),
      ],
      edges: [{ from: "t", to: "collect" }, { from: "collect", to: "validate" }, { from: "validate", to: "gate" }, { from: "gate", to: "charge" }, { from: "charge", to: "receipt" }],
    },
  },
  {
    name: "Access Review",
    graph: {
      nodes: [trig(), code("enumerate", "return { grants: (input.grants ?? 40) };", 260), echo("flag", "flagged-stale", 460), echo("report", "review-posted", 660)],
      edges: [{ from: "t", to: "enumerate" }, { from: "enumerate", to: "flag" }, { from: "flag", to: "report" }],
    },
  },
];

async function clearPublicTables(db: Db): Promise<void> {
  await db.execute(sql.raw(`
    DO $$
    DECLARE stmt text;
    BEGIN
      SELECT
        CASE
          WHEN COUNT(*) = 0 THEN NULL
          ELSE 'TRUNCATE TABLE ' ||
            string_agg(format('%I.%I', schemaname, tablename), ', ') ||
            ' RESTART IDENTITY CASCADE'
        END
      INTO stmt
      FROM pg_tables
      WHERE schemaname = 'public';

      IF stmt IS NOT NULL THEN
        EXECUTE stmt;
      END IF;
    END $$;
  `));
}

async function main(): Promise<void> {
  const handle = await createDb();
  await migrate(handle);
  const db: Db = handle.db;

  await clearPublicTables(db);

  const workspaceId = await ensureDefaultWorkspace(db);
  await updateWorkspace(db, workspaceId, {
    name: "Acme Operations",
    // No accent override: the workspace rides the theme's monochrome accent
    // (branding.accent remains available for tenants that want a color).
    branding: { brandName: "ACME OPS" },
  });

  await seedBuiltinTemplates(db, BUILTIN_TEMPLATES);

  // --- Users across every role -------------------------------------------------
  const people: { email: string; name: string; role: "owner" | "admin" | "builder" | "member" }[] = [
    { email: "avery.owner@acme.io", name: "Avery Stone", role: "owner" },
    { email: "dana.admin@acme.io", name: "Dana Reyes", role: "admin" },
    { email: "blair.builder@acme.io", name: "Blair Okafor", role: "builder" },
    { email: "morgan.member@acme.io", name: "Morgan Li", role: "member" },
  ];
  const passwordHash = await hashPassword(PASSWORD);
  for (const p of people) {
    const user = await createUser(db, { email: p.email, name: p.name, passwordHash });
    await upsertMembership(db, { userId: user.id, workspaceId, role: p.role });
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: user.id, actorLabel: p.email,
      action: p.role === "owner" ? "workspace.setup" : "member.create",
      target: p.email, detail: { role: p.role },
    });
  }

  // --- Kernel wiring (mock model, inline dispatch) -----------------------------
  const tools = new BuiltinToolRegistry();
  const bus = new InMemoryEventBus();
  const router = new ModelRouter({});
  const embedder = createEmbedder({ provider: "mock" });
  const audit = createAuditSink(db);
  const executor = new WorkflowExecutor({ db, bus, tools, audit });
  const runtime = new AgentRuntime({ db, bus, router, tools, embedder, audit });
  executor.setAgentInvoker(createAgentInvoker({ db, runtime }));
  registerBridgeTools(tools, { db, workspaceId, executor });
  const kb: KbDeps = { db, workspaceId, embedder };
  registerKbTools(tools, kb);

  const dispatch: MissionDispatcher = async (missionId) => {
    const m = await getMission(db, missionId);
    if (!m) throw new Error(`mission ${missionId} missing`);
    return m.kind === "agent" ? runtime.runMission(missionId) : executor.runMission(missionId);
  };

  // --- Knowledge base: ingest the document corpus (fills the shell) -----------
  let chunkTotal = 0;
  for (const d of KB_DOCS) {
    const { chunkCount } = await kbIngest(kb, { title: d.title, content: d.content, source: `seed:${d.title}` });
    chunkTotal += chunkCount;
  }

  // --- Agents (orbit) ----------------------------------------------------------
  const agentIds: Record<string, string> = {};
  for (const a of AGENTS) {
    const agent = await createAgent(db, {
      workspaceId, name: a.name, persona: a.persona, model: "mock",
      autonomy: a.autonomy, toolGrants: a.toolGrants ?? [],
    });
    agentIds[a.name] = agent.id;
  }

  // --- Workflows (lattice) -----------------------------------------------------
  const workflowIds: Record<string, string> = {};
  for (const w of WORKFLOWS) {
    const created = await createWorkflow(db, { workspaceId, name: w.name, graph: w.graph as never });
    workflowIds[w.name] = created.workflow.id;
  }

  // --- Activity drivers --------------------------------------------------------
  const runWorkflow = async (name: string, input: unknown) => {
    const m = await startWorkflow(db, { workflowId: workflowIds[name]!, trigger: { mode: "manual" }, payload: input });
    await dispatch(m.id);
    return m.id;
  };
  /** Start but DO NOT dispatch — leaves the mission `queued` = a live thread. */
  const queueWorkflow = async (name: string, input: unknown) => {
    await startWorkflow(db, { workflowId: workflowIds[name]!, trigger: { mode: "manual" }, payload: input });
  };
  const queueAgent = async (name: string, message: string) => {
    await startAgentTick(db, { agentId: agentIds[name]!, trigger: { mode: "chat" }, payload: { message } });
  };
  const chat = async (name: string, message: string) => {
    const m = await startAgentTick(db, { agentId: agentIds[name]!, trigger: { mode: "chat" }, payload: { message } });
    await dispatch(m.id);
    return m.id;
  };
  const approveLatestPending = async (approve: boolean) => {
    const pending = await listApprovals(db, "pending");
    const a = pending[0];
    if (!a) return;
    await resolveApproval(db, a.id, approve);
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: null, actorLabel: "dana.admin@acme.io",
      missionId: a.missionId, action: "approval.decision", target: a.nodeId, detail: { approved: approve },
    });
    await dispatch(a.missionId);
  };

  // Succeeded runs — history + the MISSIONS 24H readout.
  for (const n of [3, 5, 8]) await runWorkflow("Nightly Reconciliation", { n });
  await runWorkflow("Weekly Digest", { items: 12 });
  await runWorkflow("Customer Onboarding", { name: "globex-enterprise-co" });
  await runWorkflow("Customer Onboarding", { name: "sky" });
  await runWorkflow("Lead Scoring", { signals: 6 });
  await runWorkflow("Lead Scoring", { signals: 2 });
  await runWorkflow("Backup Verify", {});
  await runWorkflow("Uptime Monitor", {});
  await runWorkflow("Churn Watch", { inactiveDays: 12 });
  await runWorkflow("Churn Watch", { inactiveDays: 3 });
  await runWorkflow("Access Review", { grants: 52 });

  // Failed runs — the ALARM ripple + red rim ticks.
  await runWorkflow("Ledger Reconcile (flaky)", {});
  await runWorkflow("Ledger Reconcile (flaky)", {});

  // Gated workflow runs left awaiting_approval — amber taut threads + inbox.
  for (let i = 0; i < 4; i++) await runWorkflow("Deploy Pipeline", { build: i });
  for (let i = 0; i < 3; i++) await runWorkflow("Data Export", { batch: i });
  for (let i = 0; i < 2; i++) await runWorkflow("Invoice Sweep", { count: 20 + i });
  // Approve three of them so the inbox is a mix of decided + pending.
  await approveLatestPending(true);
  await approveLatestPending(true);
  await approveLatestPending(true);

  // Agent chats + long-term memory.
  await chat("Research Scout", "Hello, who are you?");
  await chat("Research Scout", "remember: The production database is PostgreSQL 17 with pgvector");
  await chat("Research Scout", "remember: Our primary cloud region is us-east-1 on AWS");
  await chat("Growth Scout", "remember: The pricing-page experiment lifted signups 8 percent");
  await chat("Content Editor", "remember: House style prefers active voice and short sentences");
  await chat("Support Concierge", "remember: Customer Globex prefers email over phone");

  // Gated agent tool calls left pending — more amber threads.
  await chat("Ops Responder", 'use email.send {"to":"oncall@acme.io","subject":"Escalation","body":"Please review"}');
  await chat("Release Marshal", 'use email.send {"to":"release@acme.io","subject":"Cut 2.4.0?","body":"Approve the release"}');

  // Live queued missions — cyan flowing "puppet strings" (never dispatched).
  await queueWorkflow("Deploy Pipeline", { build: "hotfix" });
  await queueWorkflow("Data Export", { batch: "adhoc" });
  await queueWorkflow("Uptime Monitor", {});
  await queueWorkflow("Nightly Reconciliation", { n: 9 });
  await queueAgent("Incident Commander", "Investigate the latency alert on the checkout path.");
  await queueAgent("Security Sentinel", "Summarize today's dependency advisories.");
  await queueAgent("Data Librarian", "What is our certificate rotation window?");

  // --- Backdate a slice of history across years --------------------------------
  // The NEXUS Construct stacks its strata by creation year (docs/NEXUS.md §2),
  // so the demo spans four of them: three years of history (Y-3 founding,
  // Y-2 expansion, Y-1 build-out) plus the live present. Live threads,
  // pending approvals and recent failures all stay in the present stratum.
  const Y = new Date().getFullYear();
  const on = (yearsBack: number, month: number, day: number) => new Date(Date.UTC(Y - yearsBack, month, day, 12));
  const AGENT_VINTAGE: [string, number][] = [
    ["Data Librarian", 3], ["Support Concierge", 3],
    ["Finance Analyst", 2], ["Content Editor", 2], ["QA Sentinel", 2],
    ["Ops Responder", 1], ["Release Marshal", 1], ["Growth Scout", 1],
  ];
  for (const [i, [name, back]] of AGENT_VINTAGE.entries()) {
    await backdateEntity(db, "agent", agentIds[name]!, on(back, i % 9, 4 + i * 3));
  }
  const WORKFLOW_VINTAGE: [string, number][] = [
    ["Nightly Reconciliation", 3], ["Backup Verify", 3],
    ["Access Review", 2], ["Weekly Digest", 2], ["Invoice Sweep", 2],
    ["Uptime Monitor", 1], ["Churn Watch", 1], ["Lead Scoring", 1],
  ];
  for (const [i, [name, back]] of WORKFLOW_VINTAGE.entries()) {
    await backdateEntity(db, "workflow", workflowIds[name]!, on(back, (i * 2) % 11, 8 + i));
  }
  const allDocs = await listDocuments(db, workspaceId);
  for (const [i, doc] of allDocs.slice(0, 3).entries()) await backdateEntity(db, "document", doc.id, on(3, 3 + i, 11));
  for (const [i, doc] of allDocs.slice(3, 7).entries()) await backdateEntity(db, "document", doc.id, on(2, 1 + i * 2, 19));
  for (const [i, doc] of allDocs.slice(7, 11).entries()) await backdateEntity(db, "document", doc.id, on(1, 2 + i * 2, 7));
  const settled = (await listMissions(db, workspaceId, 200)).filter((m) => m.status === "succeeded");
  for (const [i, m] of settled.slice(0, 3).entries()) await backdateEntity(db, "mission", m.id, on(3, 6 + i, 9));
  for (const [i, m] of settled.slice(3, 7).entries()) await backdateEntity(db, "mission", m.id, on(2, 4 + i, 12));
  for (const [i, m] of settled.slice(7, 12).entries()) await backdateEntity(db, "mission", m.id, on(1, 2 + i, 14));

  // --- Summary -----------------------------------------------------------------
  const agents = await listAgents(db, workspaceId);
  const workflows = await listWorkflows(db, workspaceId);
  const docs = await listDocuments(db, workspaceId);
  const missions = await listMissions(db, workspaceId, 200);
  const byStatus = missions.reduce<Record<string, number>>((acc, m) => {
    acc[m.status] = (acc[m.status] ?? 0) + 1;
    return acc;
  }, {});
  const live = missions.filter((m) => ["running", "queued", "awaiting_approval"].includes(m.status)).length;
  const pending = await listApprovals(db, "pending");
  console.log("── Demo seed complete ──────────────────────────────");
  console.log(`workspace:  Acme Operations (${workspaceId})`);
  console.log(`users:      ${people.length} (owner/admin/builder/member), password: ${PASSWORD}`);
  console.log(`agents:     ${agents.length} (orbit nodes)`);
  console.log(`workflows:  ${workflows.length} (lattice nodes)`);
  console.log(`knowledge:  ${docs.length} documents / ${chunkTotal} chunks (shell density)`);
  console.log(`missions:   ${missions.length} — ${JSON.stringify(byStatus)}`);
  console.log(`live ops:   ${live} (mission threads, figure caps 12)`);
  console.log(`approvals:  ${pending.length} pending in the inbox (amber rim)`);
  console.log(`driver:     ${handle.driver}${process.env.PGLITE_DATA_DIR ? ` @ ${process.env.PGLITE_DATA_DIR}` : " (in-memory)"}`);
  console.log("────────────────────────────────────────────────────");

  await handle.close();
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
