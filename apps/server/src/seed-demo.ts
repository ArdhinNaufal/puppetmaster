/**
 * Demo seeder — populate a database that reflects the full usage of the system:
 * a branded workspace, users across all roles, agents + workflows cloned from
 * templates, missions in every status, pending and resolved approvals, embedded
 * long-term memories, and the audit trail that all of that activity produces.
 *
 * Runs the *real* kernel (mock model, in-memory bus, inline dispatch) so every
 * row is genuine, not hand-faked. Share the store with the server via
 * PGLITE_DATA_DIR (or DATABASE_URL):
 *
 *   PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server seed:demo
 *   PGLITE_DATA_DIR=./.pmdata pnpm --filter @puppetmaster/server start
 */
import {
  appendAudit,
  createAgent,
  createDb,
  createUser,
  createWorkflow,
  ensureDefaultWorkspace,
  getMission,
  listApprovals,
  listMissions,
  listTemplates,
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
  registerBridgeTools,
  startAgentTick,
  startWorkflow,
  type MissionDispatcher,
} from "@puppetmaster/kernel";
import { hashPassword } from "./auth.js";
import { createAuditSink } from "./audit.js";
import { BUILTIN_TEMPLATES } from "./seeds.js";

const PASSWORD = "demodemo123";

async function main(): Promise<void> {
  const handle = await createDb();
  await migrate(handle);
  const db: Db = handle.db;

  const workspaceId = await ensureDefaultWorkspace(db);
  await updateWorkspace(db, workspaceId, {
    name: "Acme Operations",
    branding: { brandName: "ACME OPS", accent: "#35d0e0" },
  });

  await seedBuiltinTemplates(db, BUILTIN_TEMPLATES);
  const templates = await listTemplates(db, workspaceId);
  const tpl = (name: string) => templates.find((t) => t.name === name)!;

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

  const dispatch: MissionDispatcher = async (missionId) => {
    const m = await getMission(db, missionId);
    if (!m) throw new Error(`mission ${missionId} missing`);
    return m.kind === "agent" ? runtime.runMission(missionId) : executor.runMission(missionId);
  };

  // --- Agents + workflows from templates --------------------------------------
  const scout = await instantiateAgent(db, workspaceId, tpl("Research Scout").spec);
  const ops = await instantiateAgent(db, workspaceId, tpl("Ops Responder").spec);
  const concierge = (await createAgent(db, {
    workspaceId,
    name: "Support Concierge",
    persona: "You are a friendly front-line support agent. Answer questions and remember customer preferences.",
    model: "mock",
    autonomy: "write_approved",
  })).id;

  const starter = await instantiateWorkflow(db, workspaceId, "Starter Pipeline", tpl("Starter: transform & echo").spec);
  const health = await instantiateWorkflow(db, workspaceId, "Nightly Health Check", tpl("Automation: HTTP health check").spec);
  const broadcast = await instantiateWorkflow(db, workspaceId, "Ops Broadcast", tpl("Ops: gated broadcast").spec);

  // --- Drive realistic activity ------------------------------------------------
  const runWorkflow = async (workflowId: string, input: unknown) => {
    const m = await startWorkflow(db, { workflowId, trigger: { mode: "manual" }, payload: input });
    await dispatch(m.id);
    return m.id;
  };
  const chat = async (agentId: string, message: string) => {
    const m = await startAgentTick(db, { agentId, trigger: { mode: "chat" }, payload: { message } });
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
    await dispatch(a.missionId); // resume the paused mission
  };

  // Succeeding workflow runs.
  await runWorkflow(starter, { name: "acme" });
  await runWorkflow(starter, { name: "world" });
  await runWorkflow(health, {});

  // Gated broadcast: one approved → succeeds, one left pending in the inbox.
  await runWorkflow(broadcast, {});
  await approveLatestPending(true);
  await runWorkflow(broadcast, {}); // stays awaiting_approval

  // Agent chats + memory.
  await chat(scout, "Hello, who are you?");
  await chat(scout, "remember: The production database is PostgreSQL 17 with pgvector");
  await chat(scout, "remember: Our primary cloud region is us-east-1 on AWS");
  await chat(scout, "remember: The on-call rotation resets every Monday at 09:00");
  await chat(concierge, "remember: Customer Globex prefers email over phone");

  // A gated agent tool call, approved → succeeds.
  await chat(scout, 'use email.send {"to":"team@acme.io","subject":"Daily digest","body":"All systems nominal"}');
  await approveLatestPending(true);

  // A gated agent tool call left pending in the inbox.
  await chat(ops, 'use email.send {"to":"oncall@acme.io","subject":"Escalation","body":"Please review"}');

  // --- Summary -----------------------------------------------------------------
  const missions = await listMissions(db, workspaceId, 100);
  const byStatus = missions.reduce<Record<string, number>>((acc, m) => {
    acc[m.status] = (acc[m.status] ?? 0) + 1;
    return acc;
  }, {});
  const pending = await listApprovals(db, "pending");
  console.log("── Demo seed complete ──────────────────────────────");
  console.log(`workspace:  Acme Operations (${workspaceId})`);
  console.log(`users:      ${people.length} (owner/admin/builder/member), password: ${PASSWORD}`);
  console.log(`agents:     Research Scout, Ops Responder, Support Concierge`);
  console.log(`workflows:  Starter Pipeline, Nightly Health Check, Ops Broadcast`);
  console.log(`missions:   ${missions.length} — ${JSON.stringify(byStatus)}`);
  console.log(`approvals:  ${pending.length} pending in the inbox`);
  console.log(`driver:     ${handle.driver}${process.env.PGLITE_DATA_DIR ? ` @ ${process.env.PGLITE_DATA_DIR}` : " (in-memory)"}`);
  console.log("────────────────────────────────────────────────────");

  await handle.close();
}

async function instantiateAgent(db: Db, workspaceId: string, spec: unknown): Promise<string> {
  const s = (spec ?? {}) as { name?: string; persona?: string; model?: string; autonomy?: string; toolGrants?: unknown; schedule?: string | null };
  const agent = await createAgent(db, {
    workspaceId,
    name: s.name ?? "Agent",
    persona: s.persona ?? "",
    model: s.model ?? "mock",
    autonomy: s.autonomy,
    toolGrants: Array.isArray(s.toolGrants) ? (s.toolGrants as string[]) : undefined,
    schedule: s.schedule ?? null,
  });
  return agent.id;
}

async function instantiateWorkflow(db: Db, workspaceId: string, name: string, spec: unknown) {
  const created = await createWorkflow(db, { workspaceId, name, graph: spec as never });
  return created.workflow.id;
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
