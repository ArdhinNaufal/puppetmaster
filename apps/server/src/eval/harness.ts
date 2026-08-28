import {
  createAgent,
  createDb,
  createWorkflow,
  ensureDefaultWorkspace,
  getMission,
  getMissionSteps,
  migrate,
} from "@puppetmaster/db";
import {
  AgentRuntime,
  BuiltinToolRegistry,
  createAgentInvoker,
  createEmbedder,
  InMemoryEventBus,
  createBuiltinCheckRunner,
  LocalCommandExecutor,
  ModelRouter,
  registerBenchTools,
  registerProjectTools,
  startAgentTick,
  startWorkflow,
  WorkflowExecutor,
} from "@puppetmaster/kernel";
import { WorkflowGraph } from "@puppetmaster/shared";
import { GOLDEN_TASKS, type GoldenTask } from "./golden-tasks.js";

/**
 * Eval harness (Stage 5, G7): runs each golden task k times, each run against
 * a fresh ephemeral PGlite + the deterministic mock provider. pass^k (τ-bench)
 * = a task passes only when all k runs pass; trajectory assertions run on the
 * recorded step log so "corrupt success" (right output, wrong actions) fails.
 */

export interface TaskResult {
  id: string;
  description: string;
  passes: boolean[];
  pass: boolean;
  trajectoryOk: boolean;
  notes: string[];
}

export interface SuiteResult {
  suite: string;
  k: number;
  passed: number;
  total: number;
  results: TaskResult[];
}

/** Tool identities actually called during a mission, from the step log. */
function calledTools(steps: { kind: string; nodeId: string; status: string }[]): string[] {
  return steps
    .filter((s) => s.kind === "action" && s.status === "succeeded")
    .map((s) => s.nodeId.replace("__", "."));
}

async function runTaskOnce(task: GoldenTask): Promise<{ pass: boolean; trajectoryOk: boolean; note?: string }> {
  const handle = await createDb({ ephemeral: true });
  try {
    await migrate(handle);
    const db = handle.db;
    const workspaceId = await ensureDefaultWorkspace(db, "eval");
    const tools = new BuiltinToolRegistry();
    const bus = new InMemoryEventBus();
    const router = new ModelRouter({});
    const embedder = createEmbedder({});
    registerProjectTools(tools, { db, workspaceId, kb: { db, workspaceId, embedder } });
    registerBenchTools(tools, { db, workspaceId, executor: new LocalCommandExecutor() });
    const executor = new WorkflowExecutor({ db, bus, tools, checkRunner: createBuiltinCheckRunner({ db, executor: new LocalCommandExecutor() }) });
    const runtime = new AgentRuntime({ db, bus, router, tools, embedder });
    executor.setAgentInvoker(createAgentInvoker({ db, workspaceId, runtime }));

    let subjectId: string;
    let missionId: string;
    if (task.kind === "agent") {
      const agent = await createAgent(db, {
        workspaceId,
        name: `eval-${task.id}`,
        persona: "You are an eval agent.",
        model: "mock",
        contextCompaction: task.agent?.contextCompaction ?? false,
      });
      subjectId = agent.id;
      const mission = await startAgentTick(db, {
        workspaceId,
        agentId: agent.id,
        trigger: { mode: "eval" },
        payload: { message: task.message ?? "" },
      });
      missionId = mission.id;
      await runtime.runMission(mission.id);
    } else {
      const graph = WorkflowGraph.parse(task.graph);
      const created = await createWorkflow(db, { workspaceId, name: `eval-${task.id}`, graph });
      subjectId = created.workflow.id;
      const seeded = task.setup ? await task.setup(db, { workspaceId }) : {};
      const mission = await startWorkflow(db, {
        workspaceId,
        workflowId: created.workflow.id,
        trigger: { mode: "eval" },
        payload: { ...(task.input as Record<string, unknown> | undefined), ...seeded },
      });
      missionId = mission.id;
      await executor.runMission(mission.id);
    }

    const mission = await getMission(db, missionId);
    const steps = await getMissionSteps(db, missionId);
    const notes: string[] = [];

    const wantStatus = task.expectStatus ?? "succeeded";
    let pass = mission?.status === wantStatus;
    if (!pass) notes.push(`status=${mission?.status} (wanted ${wantStatus}): ${mission?.error ?? ""}`);
    if (pass && task.expectOutput && !task.expectOutput(mission!.output)) {
      pass = false;
      notes.push(`output predicate failed: ${JSON.stringify(mission!.output)?.slice(0, 120)}`);
    }
    if (pass && task.expectState && !(await task.expectState(db, { workspaceId, subjectId, missionId }))) {
      pass = false;
      notes.push("state predicate failed");
    }

    let trajectoryOk = true;
    if (task.trajectory) {
      const called = calledTools(steps);
      for (const must of task.trajectory.mustCall ?? []) {
        if (!called.includes(must)) {
          trajectoryOk = false;
          notes.push(`trajectory: ${must} was never called`);
        }
      }
      if (task.trajectory.mayCallOnly) {
        const allowed = new Set(task.trajectory.mayCallOnly);
        for (const c of called) {
          if (!allowed.has(c)) {
            trajectoryOk = false;
            notes.push(`trajectory: unexpected call ${c}`);
          }
        }
      }
    }

    return { pass: pass && trajectoryOk, trajectoryOk, note: notes.join("; ") || undefined };
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function runSuite(k = 3, tasks: GoldenTask[] = GOLDEN_TASKS): Promise<SuiteResult> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const passes: boolean[] = [];
    const notes: string[] = [];
    let trajectoryOk = true;
    for (let i = 0; i < k; i++) {
      const run = await runTaskOnce(task);
      passes.push(run.pass);
      trajectoryOk = trajectoryOk && run.trajectoryOk;
      if (run.note) notes.push(`run${i + 1}: ${run.note}`);
    }
    results.push({
      id: task.id,
      description: task.description,
      passes,
      pass: passes.every(Boolean),
      trajectoryOk,
      notes,
    });
  }
  return {
    suite: "golden",
    k,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
}
