import vm from "node:vm";
import { randomUUID } from "node:crypto";
import {
  ActionConfig,
  AgentNodeConfig,
  ApprovalConfig,
  CodeConfig,
  VerifyNodeConfig,
  LogicConfig,
  ScienceManifest,
  ScienceRunState,
  WorkflowGraph,
  type MissionStatus,
  type StepStatus,
  type WorkflowNode,
} from "@puppetmaster/shared";
import {
  beginNodeExecution,
  claimScienceRunTerminalWorkflowWait,
  commitClaimedWorkflowWaitStatus,
  commitNodeExecution,
  createApproval,
  findApprovalForNode,
  findCommittedExecution,
  finishClaimedWorkflowWaitMission,
  getMission,
  getMissionSteps,
  getWorkflowWaitForMission,
  createEvidence,
  getWorkflowVersionById,
  insertStep,
  registerScienceRunTerminalWait,
  releaseWorkflowWaitClaim,
  renewWorkflowWaitClaim,
  updateMission,
  updateStep,
  type Db,
} from "@puppetmaster/db";
import type { EventBus } from "./bridge.js";
import type { AuditSink } from "./audit-sink.js";
import type { CheckRunner } from "./verify.js";
import { runCodeNode } from "./sandbox.js";
import { BuiltinToolRegistry, type ToolRegistry } from "./tools.js";
import { wrapUntrusted } from "./untrusted.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date();
const WORKFLOW_WAIT_CLAIM_LEASE_MS = 90_000;
const WORKFLOW_WAIT_HEARTBEAT_MS = 20_000;

const DEFERRED_SCIENCE_STATUS = Symbol("deferred-science-status");
interface DeferredScienceStatusResult {
  readonly [DEFERRED_SCIENCE_STATUS]: true;
  readonly runId: string;
  readonly state: typeof ScienceRunState._type;
  readonly manifestComplete: boolean;
  readonly result: unknown;
}

function isDeferredScienceStatusResult(value: unknown): value is DeferredScienceStatusResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<DeferredScienceStatusResult>)[DEFERRED_SCIENCE_STATUS] === true,
  );
}

interface ActiveWorkflowWaitClaim {
  waitId: string;
  nodeId: string;
  claimToken: string;
  generation: number;
  lost: boolean;
}

class WorkflowWaitOwnershipLostError extends Error {
  constructor() {
    super("durable workflow wait ownership was lost; continuation stopped for recovery");
    this.name = "WorkflowWaitOwnershipLostError";
  }
}

/** Evaluate an edge/branch expression in a locked-down vm context. */
function evalExpression(expr: string, out: unknown, context: Record<string, unknown>): unknown {
  try {
    return vm.runInNewContext(`(${expr})`, { out, context }, { timeout: 100 });
  } catch {
    return false;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Kahn topological sort; throws on cycles (workflows must be DAGs). */
function topoSort(nodes: WorkflowNode[], edges: { from: string; to: string }[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: WorkflowNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of adj.get(id)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new Error("workflow graph has a cycle");
  return order;
}

/** Bridge (workflow → agent): dispatch a task to an agent and await its result.
 *  Wired by the host after both engines exist, to avoid a construction cycle. */
export type AgentInvoker = (input: {
  agentId: string;
  message: string;
  parentMissionId: string;
}) => Promise<{ missionId: string; status: MissionStatus; output: unknown }>;

export interface ExecutorDeps {
  db: Db;
  bus: EventBus;
  tools?: ToolRegistry;
  audit?: AuditSink;
  /** Executes verify-node checks (Workshop WP4). Absent → verify nodes fail closed. */
  checkRunner?: CheckRunner;
}

/**
 * Deterministic, resumable DAG executor (docs/ARCHITECTURE.md §3.2). Walks nodes
 * in topological order, snapshots every node's IO into `mission_steps`, honours
 * per-node retries/timeouts, and halts at approval gates — persisting a resume
 * cursor so `runMission` can be re-invoked to continue after a decision.
 */
export class WorkflowExecutor {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly tools: ToolRegistry;
  private readonly audit: AuditSink | null;
  private readonly checkRunner: CheckRunner | null;
  private agentInvoker: AgentInvoker | null = null;
  private readonly waitClaims = new Map<string, ActiveWorkflowWaitClaim>();

  constructor(deps: ExecutorDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.tools = deps.tools ?? new BuiltinToolRegistry();
    this.audit = deps.audit ?? null;
    this.checkRunner = deps.checkRunner ?? null;
  }

  /** Best-effort audit; never let a logging failure break execution. */
  private async recordAudit(entry: Parameters<AuditSink>[0]): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit(entry);
    } catch {
      /* audit is advisory */
    }
  }

  /** Wire the workflow → agent bridge (docs/ARCHITECTURE.md §3.3). */
  setAgentInvoker(invoker: AgentInvoker): void {
    this.agentInvoker = invoker;
  }

  async runMission(missionId: string): Promise<MissionStatus> {
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      return await this.runMissionBody(missionId, (claim) => {
        this.waitClaims.set(missionId, claim);
        heartbeat = setInterval(() => {
          void renewWorkflowWaitClaim(this.db, {
            waitId: claim.waitId,
            claimToken: claim.claimToken,
            claimExpiresAt: new Date(Date.now() + WORKFLOW_WAIT_CLAIM_LEASE_MS),
          }).then((owned) => {
            if (!owned) claim.lost = true;
          }).catch(() => {
            claim.lost = true;
          });
        }, WORKFLOW_WAIT_HEARTBEAT_MS);
        heartbeat.unref?.();
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.waitClaims.delete(missionId);
    }
  }

  private async runMissionBody(
    missionId: string,
    onWaitClaim: (claim: ActiveWorkflowWaitClaim) => void,
  ): Promise<MissionStatus> {
    const mission = await getMission(this.db, missionId);
    if (!mission) throw new Error(`mission ${missionId} not found`);
    if (["succeeded", "failed", "cancelled"].includes(mission.status)) {
      return mission.status as MissionStatus;
    }
    if (!mission.workflowVersionId) throw new Error(`mission ${missionId} has no workflow version`);

    const versionRow = await getWorkflowVersionById(this.db, mission.workflowVersionId);
    if (!versionRow) throw new Error(`workflow version ${mission.workflowVersionId} not found`);
    const graph = WorkflowGraph.parse(versionRow.graph);

    const durableWait = await getWorkflowWaitForMission(this.db, missionId);
    let claimedWait: ActiveWorkflowWaitClaim | null = null;
    if (durableWait && ["pending", "ready", "claimed"].includes(durableWait.state)) {
      const claimToken = randomUUID();
      const claimed = await claimScienceRunTerminalWorkflowWait(this.db, {
        missionId,
        claimToken,
        claimExpiresAt: new Date(Date.now() + WORKFLOW_WAIT_CLAIM_LEASE_MS),
      });
      if (!claimed) throw new Error("workflow wait disappeared before claim");
      if (claimed.status === "pending") return "waiting";
      if (claimed.status === "busy") return "running";
      if (claimed.status === "cancelled") return "cancelled";
      if (claimed.status === "terminal") {
        const terminal = await getMission(this.db, missionId);
        return (terminal?.status ?? "failed") as MissionStatus;
      }
      if (claimed.status === "consumed") {
        throw new Error("an active workflow wait unexpectedly became consumed while claiming");
      }
      claimedWait = {
        waitId: claimed.wait.id,
        nodeId: claimed.wait.nodeId,
        claimToken,
        generation: claimed.wait.generation,
        lost: false,
      };
      onWaitClaim(claimedWait);
    }

    const resuming = mission.status === "awaiting_approval" || claimedWait !== null;
    if (!resuming) {
      await updateMission(this.db, missionId, { status: "running", startedAt: now() });
      await this.bus.publish({
        type: "mission.started",
        missionId,
        workflowVersionId: mission.workflowVersionId,
        at: now().toISOString(),
      });
    } else {
      await updateMission(this.db, missionId, { status: "running" });
    }

    // Webhook-triggered missions carry external payloads: agent nodes wrap
    // them in untrusted-data delimiters before they enter model context.
    const triggerMode = ((mission.trigger ?? {}) as { mode?: string }).mode ?? null;

    // Seed state from the resume cursor (nodeId -> output of completed nodes).
    const outputs: Record<string, unknown> = { ...((mission.cursor as Record<string, unknown>) ?? {}) };
    const completed = new Set(Object.keys(outputs));
    const skipped = new Set<string>();

    const existingSteps = await getMissionSteps(this.db, missionId);
    const stepIdByNode = new Map(existingSteps.map((s) => [s.nodeId, s.id]));

    const order = topoSort(graph.nodes, graph.edges);
    const incoming = new Map<string, { from: string; condition: string | null }[]>();
    for (const n of graph.nodes) incoming.set(n.id, []);
    for (const e of graph.edges) incoming.get(e.to)?.push({ from: e.from, condition: e.condition });

    const persistCursor = () => updateMission(this.db, missionId, { cursor: outputs });

    for (const node of order) {
      if (completed.has(node.id) || skipped.has(node.id)) continue;

      if (claimedWait) {
        await this.assertWorkflowWaitOwnership(claimedWait, node.timeoutMs ?? 30_000);
      }

      // Cooperative cancellation (Stage 2): honour a cancel request between
      // nodes — the granularity at which the cursor is durable.
      const fresh = await getMission(this.db, missionId);
      if (fresh?.cancelRequested) {
        await persistCursor();
        return this.finishMission(missionId, "cancelled", null, "cancelled by operator");
      }

      // Activation: triggers are entry points; other nodes need a satisfied edge.
      const inEdges = incoming.get(node.id) ?? [];
      let active = node.kind === "trigger" || inEdges.length === 0;
      let nodeInput: unknown = node.kind === "trigger" || inEdges.length === 0 ? mission.input : undefined;
      for (const edge of inEdges) {
        if (skipped.has(edge.from) || !completed.has(edge.from)) continue;
        const upstreamOut = outputs[edge.from];
        const passes = edge.condition == null || Boolean(evalExpression(edge.condition, upstreamOut, outputs));
        if (passes) {
          active = true;
          if (nodeInput === undefined) nodeInput = upstreamOut;
        }
      }

      if (!active) {
        await this.recordStep(missionId, node, "skipped", 0, nodeInput ?? null, null, null, stepIdByNode);
        skipped.add(node.id);
        continue;
      }

      // Approval gate — halt and persist, or resume past a decided approval.
      if (node.kind === "approval") {
        const cfg = ApprovalConfig.parse(node.config);
        let approvalPrompt: string;
        try {
          approvalPrompt = resolveApprovalPrompt(cfg.prompt, nodeInput);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordStep(missionId, node, "failed", 0, nodeInput ?? null, null, message, stepIdByNode);
          return this.finishMission(missionId, "failed", null, message);
        }
        const existing = await findApprovalForNode(this.db, missionId, node.id);
        if (existing && existing.prompt !== approvalPrompt) {
          const message = "approval prompt no longer matches the durable node input";
          await this.recordStep(missionId, node, "failed", 0, nodeInput ?? null, null, message, stepIdByNode);
          return this.finishMission(missionId, "failed", null, message);
        }
        if (!existing || existing.status === "pending") {
          const approval = existing ?? (await createApproval(this.db, {
            missionId,
            nodeId: node.id,
            prompt: approvalPrompt,
            tier: cfg.tier,
          }));
          await this.recordStep(missionId, node, "awaiting_approval", 0, nodeInput ?? null, null, null, stepIdByNode);
          await persistCursor();
          await updateMission(this.db, missionId, { status: "awaiting_approval" });
          await this.bus.publish({
            type: "approval.requested",
            missionId,
            nodeId: node.id,
            approvalId: approval.id,
            prompt: approvalPrompt,
            at: now().toISOString(),
          });
          return "awaiting_approval";
        }
        if (existing.status === "rejected") {
          await this.recordStep(missionId, node, "failed", 0, nodeInput ?? null, null, "approval rejected", stepIdByNode);
          return this.finishMission(missionId, "failed", null, "approval rejected");
        }
        // approved -> pass the input through and continue.
        outputs[node.id] = nodeInput ?? null;
        completed.add(node.id);
        await this.recordStep(missionId, node, "succeeded", 0, nodeInput ?? null, nodeInput ?? null, null, stepIdByNode);
        await persistCursor();
        continue;
      }

      // Verify gate (Workshop WP4): a deterministic check gates the edge.
      // Fail → bounded fix loop via the agent bridge (the check's failure
      // output is the agent's instruction), then escalation to a human
      // approval with evidence attached — the corpus's 8-block override as
      // policy. Approve = override recorded; reject = mission fails.
      if (node.kind === "verify") {
        const cfg = VerifyNodeConfig.parse(node.config);
        const projectId = resolveTemplate(cfg.projectId, nodeInput);
        const fixAgentId = cfg.fixAgentId ? resolveTemplate(cfg.fixAgentId, nodeInput) : null;

        const existing = await findApprovalForNode(this.db, missionId, node.id);
        if (existing) {
          if (existing.status === "pending") {
            await this.recordStep(missionId, node, "awaiting_approval", 0, nodeInput ?? null, null, null, stepIdByNode);
            await persistCursor();
            await updateMission(this.db, missionId, { status: "awaiting_approval" });
            return "awaiting_approval";
          }
          if (existing.status === "rejected") {
            await this.recordStep(missionId, node, "failed", 0, nodeInput ?? null, null, "verify gate rejected", stepIdByNode);
            return this.finishMission(missionId, "failed", null, `verify gate "${cfg.check}" rejected by operator`);
          }
          // Approved = the human overrode the failing gate. Record that
          // honestly: the check did NOT pass; the gate was overridden.
          const output = { check: cfg.check, passed: false, overridden: true, approvalId: existing.id };
          outputs[node.id] = output;
          completed.add(node.id);
          await this.recordStep(missionId, node, "succeeded", 0, nodeInput ?? null, output, null, stepIdByNode);
          await this.recordAudit({
            workspaceId: mission.workspaceId,
            actorKind: "system",
            actorLabel: "verify-gate",
            missionId,
            action: "verify.override",
            target: cfg.check,
            detail: { node: node.id, approvalId: existing.id },
          });
          await persistCursor();
          continue;
        }

        if (!this.checkRunner) {
          const msg = `verify node "${node.id}": no check runner configured — gated execution is unavailable in this deployment`;
          await this.recordStep(missionId, node, "failed", 0, nodeInput ?? null, null, msg, stepIdByNode);
          return this.finishMission(missionId, "failed", null, msg);
        }

        const maxAttempts = fixAgentId && this.agentInvoker ? cfg.retriesBeforeEscalate : 1;
        const runs: { attempt: number; ok: boolean; summary: string; fixMissionId?: string }[] = [];
        let result: Awaited<ReturnType<CheckRunner["run"]>>;
        let attempt = 0;
        try {
          for (;;) {
            attempt++;
            result = await this.checkRunner.run({ projectId, check: cfg.check, missionId });
            const run: (typeof runs)[number] = { attempt, ok: result.ok, summary: result.summary };
            runs.push(run);
            if (result.ok || attempt >= maxAttempts) break;
            // Fix loop: the check's failure instruction becomes the agent's task,
            // run as a nested child mission (trace nests; tiers still gate).
            const fix = await this.agentInvoker!({
              agentId: fixAgentId!,
              message: result.instruction ?? result.summary,
              parentMissionId: missionId,
            });
            run.fixMissionId = fix.missionId;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.recordStep(missionId, node, "failed", attempt, nodeInput ?? null, null, msg, stepIdByNode);
          return this.finishMission(missionId, "failed", null, msg);
        }

        if (result.ok) {
          const output = { check: cfg.check, passed: true, attempts: attempt, summary: result.summary };
          outputs[node.id] = output;
          completed.add(node.id);
          await this.recordStep(missionId, node, "succeeded", attempt, nodeInput ?? null, output, null, stepIdByNode);
          const stepId = stepIdByNode.get(node.id);
          if (stepId) {
            await createEvidence(this.db, {
              stepId,
              kind: result.evidenceKind,
              content: { check: cfg.check, runs, detail: result.detail ?? null },
            });
          }
          await persistCursor();
          continue;
        }

        // Exhausted (or no fix agent): escalate to a human approval with the
        // evidence attached. The inbox shows what failed and how many times.
        const approval = await createApproval(this.db, {
          missionId,
          nodeId: node.id,
          prompt:
            `Verify gate "${cfg.check}" failed after ${attempt} attempt(s): ${result.summary}. ` +
            `Approve to OVERRIDE the gate and continue; reject to fail the mission.`,
          tier: "write_approved",
        });
        await createEvidence(this.db, {
          approvalId: approval.id,
          kind: result.evidenceKind,
          content: { check: cfg.check, runs, detail: result.detail ?? null },
        });
        await this.recordStep(missionId, node, "awaiting_approval", attempt, nodeInput ?? null, null, null, stepIdByNode);
        await persistCursor();
        await updateMission(this.db, missionId, { status: "awaiting_approval" });
        await this.recordAudit({
          workspaceId: mission.workspaceId,
          actorKind: "system",
          actorLabel: "verify-gate",
          missionId,
          action: "verify.escalated",
          target: cfg.check,
          detail: { node: node.id, attempts: attempt, approvalId: approval.id },
        });
        await this.bus.publish({
          type: "approval.requested",
          missionId,
          nodeId: node.id,
          approvalId: approval.id,
          prompt: approval.prompt,
          at: now().toISOString(),
        });
        return "awaiting_approval";
      }

      // Execute with per-node retries + timeout.
      const retries = node.retries ?? 0;
      let attempt = 0;
      let lastError: string | null = null;
      let output: unknown;
      let ok = false;
      for (; attempt <= retries; attempt++) {
        if (claimedWait) {
          await this.assertWorkflowWaitOwnership(claimedWait, node.timeoutMs ?? 30_000);
        }
        await this.recordStep(missionId, node, "running", attempt, nodeInput ?? null, null, null, stepIdByNode);
        try {
          const candidate = await withTimeout(
            this.executeNode(node, nodeInput, outputs, missionId, triggerMode, attempt),
            node.timeoutMs ?? 30_000,
            `node ${node.id}`,
          );
          if (claimedWait) {
            await this.assertWorkflowWaitOwnership(claimedWait, node.timeoutMs ?? 30_000);
          }
          output = candidate;
          ok = true;
          break;
        } catch (err) {
          if (err instanceof WorkflowWaitOwnershipLostError) throw err;
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (ok && isDeferredScienceStatusResult(output)) {
        const deferred = output;
        if (!["succeeded", "failed", "cancelled"].includes(deferred.state)) {
          if (claimedWait) {
            await releaseWorkflowWaitClaim(this.db, {
              missionId,
              claimToken: claimedWait.claimToken,
            });
          } else {
            const registered = await registerScienceRunTerminalWait(this.db, {
              missionId,
              nodeId: node.id,
              targetRunId: deferred.runId,
            });
            if (registered.cancelled) {
              await this.bus.publish({
                type: "mission.step",
                missionId,
                nodeId: node.id,
                kind: node.kind,
                status: "skipped",
                attempt,
                error: "cancelled by operator",
                at: now().toISOString(),
              });
              await this.bus.publish({
                type: "mission.finished",
                missionId,
                status: "cancelled",
                at: now().toISOString(),
              });
              return "cancelled";
            }
          }
          await this.recordStep(
            missionId,
            node,
            "waiting",
            claimedWait?.generation ?? attempt,
            nodeInput ?? null,
            null,
            null,
            stepIdByNode,
          );
          return "waiting";
        }
        if (deferred.state !== "succeeded") {
          ok = false;
          lastError = `Science run ${deferred.runId} ended ${deferred.state}`;
        } else if (!deferred.manifestComplete) {
          ok = false;
          lastError = `Science run ${deferred.runId} succeeded without a complete manifest`;
        } else {
          output = deferred.result;
          if (claimedWait) {
            const persistedOutput = output ?? null;
            const nextCursor = { ...outputs, [node.id]: persistedOutput };
            await commitClaimedWorkflowWaitStatus(this.db, {
              missionId,
              nodeId: node.id,
              claimToken: claimedWait.claimToken,
              cursor: nextCursor,
              output: persistedOutput,
              attempt: claimedWait.generation,
              claimExpiresAt: new Date(Date.now() + WORKFLOW_WAIT_CLAIM_LEASE_MS),
            });
            outputs[node.id] = persistedOutput;
            completed.add(node.id);
            await this.bus.publish({
              type: "mission.step",
              missionId,
              nodeId: node.id,
              kind: node.kind,
              status: "succeeded",
              attempt: claimedWait.generation,
              at: now().toISOString(),
            });
            await this.recordAudit({
              workspaceId: mission.workspaceId,
              actorKind: "system",
              actorLabel: "workflow",
              missionId,
              action: "tool.call",
              target: "science.run.status",
              detail: { node: node.id, status: "succeeded", deferred: true },
            });
            continue;
          }
        }
      }

      if (!ok) {
        await this.recordStep(missionId, node, "failed", attempt, nodeInput ?? null, null, lastError, stepIdByNode);
        return this.finishMission(missionId, "failed", null, lastError);
      }

      outputs[node.id] = output ?? null;
      completed.add(node.id);
      await this.recordStep(missionId, node, "succeeded", attempt, nodeInput ?? null, output ?? null, null, stepIdByNode);
      if (node.kind === "action") {
        const c = node.config as { server?: string; tool?: string };
        await this.recordAudit({
          workspaceId: mission.workspaceId,
          actorKind: "system",
          actorLabel: "workflow",
          missionId,
          action: "tool.call",
          target: c.server && c.tool ? `${c.server}.${c.tool}` : node.id,
          detail: { node: node.id, status: "succeeded" },
        });
      }
      await persistCursor();
    }

    // Terminal nodes (no outgoing edges) define the mission output.
    const hasOutgoing = new Set(graph.edges.map((e) => e.from));
    const terminals = order.filter((n) => !hasOutgoing.has(n.id) && completed.has(n.id));
    const result =
      terminals.length === 1
        ? outputs[terminals[0]!.id]
        : Object.fromEntries(terminals.map((n) => [n.id, outputs[n.id]]));
    return this.finishMission(missionId, "succeeded", result, null);
  }

  private async assertWorkflowWaitOwnership(
    claim: ActiveWorkflowWaitClaim,
    boundedOperationMs: number,
  ): Promise<void> {
    if (claim.lost) throw new WorkflowWaitOwnershipLostError();
    const leaseMs = Math.max(
      WORKFLOW_WAIT_CLAIM_LEASE_MS,
      boundedOperationMs + WORKFLOW_WAIT_CLAIM_LEASE_MS,
    );
    try {
      const owned = await renewWorkflowWaitClaim(this.db, {
        waitId: claim.waitId,
        claimToken: claim.claimToken,
        claimExpiresAt: new Date(Date.now() + leaseMs),
      });
      if (!owned) {
        claim.lost = true;
        throw new WorkflowWaitOwnershipLostError();
      }
    } catch (error) {
      claim.lost = true;
      if (error instanceof WorkflowWaitOwnershipLostError) throw error;
      throw new WorkflowWaitOwnershipLostError();
    }
  }

  private async executeNode(
    node: WorkflowNode,
    input: unknown,
    outputs: Record<string, unknown>,
    missionId: string,
    triggerMode: string | null,
    attempt: number,
  ): Promise<unknown> {
    switch (node.kind) {
      case "trigger":
        return input ?? null;
      case "action": {
        const cfg = ActionConfig.parse(node.config);
        const args = resolveWorkflowActionArgs(cfg.args, input, outputs);
        if (cfg.defer) {
          const info = this.tools.info(cfg.server, cfg.tool);
          if (
            cfg.defer.kind !== "science_run_terminal" ||
            cfg.server !== "science" ||
            cfg.tool !== "run.status" ||
            info?.tier !== "read_auto"
          ) {
            throw new Error(
              "durable workflow defer is restricted to the registered read-only science.run.status tool",
            );
          }
          const runId = args.runId;
          if (typeof runId !== "string" || !runId.trim()) {
            throw new Error("deferred science.run.status requires an exact runId argument");
          }
          // Deliberately bypass the side-effect ledger: this exact tool is a
          // repeatable read, and a non-terminal observation must never become
          // a committed output that suppresses the terminal re-read.
          const result = await this.tools.callTool(cfg.server, cfg.tool, args, { input, missionId });
          const resultRecord = result && typeof result === "object"
            ? result as Record<string, unknown>
            : null;
          const runRecord = resultRecord?.run && typeof resultRecord.run === "object"
            ? resultRecord.run as Record<string, unknown>
            : null;
          if (!runRecord || runRecord.id !== runId) {
            throw new Error("science.run.status returned a different or missing run identity");
          }
          const state = ScienceRunState.safeParse(runRecord.state);
          if (!state.success) {
            throw new Error("science.run.status returned an invalid run state");
          }
          return {
            [DEFERRED_SCIENCE_STATUS]: true,
            runId,
            state: state.data,
            manifestComplete: (() => {
              const parsedManifest = ScienceManifest.safeParse(runRecord.manifest);
              return state.data === "succeeded" &&
                parsedManifest.success &&
                parsedManifest.data.complete;
            })(),
            result,
          } satisfies DeferredScienceStatusResult;
        }
        // Idempotency (Stage 2, G4): a retried mission reuses the committed
        // output of a side-effectful call instead of re-executing it. The
        // ledger row is written *before* the call so a crash mid-call is
        // distinguishable (uncommitted) from completed work (committed).
        const committed = await findCommittedExecution(this.db, missionId, node.id);
        if (committed) return committed.output;
        const exec = await beginNodeExecution(this.db, { missionId, nodeId: node.id, attempt });
        // missionId in the tool context: bridge tools nest child missions under
        // this one, and project.todo.complete records it as the audit link.
        const result = await this.tools.callTool(cfg.server, cfg.tool, args, { input, missionId });
        await commitNodeExecution(this.db, exec.id, result);
        return result;
      }
      case "logic": {
        const cfg = LogicConfig.parse(node.config);
        if (cfg.op === "wait") {
          await sleep(Math.min(cfg.ms ?? 0, node.timeoutMs ?? 30_000));
          return input ?? null;
        }
        if (cfg.op === "branch") {
          return cfg.expression ? Boolean(evalExpression(cfg.expression, input, outputs)) : input ?? null;
        }
        return input ?? null;
      }
      case "code": {
        const cfg = CodeConfig.parse(node.config);
        return runCodeNode(cfg.source, outputs, input, cfg.timeoutMs);
      }
      case "agent": {
        // The bridge, workflow → agent: dispatch a task and await the result.
        if (!this.agentInvoker) throw new Error("agent nodes require the agent runtime (bridge not wired)");
        const cfg = AgentNodeConfig.parse(node.config);
        // Webhook payloads are attacker-controllable: delimit them as
        // untrusted data before they become part of an agent's task.
        const rendered = typeof input === "string" ? input : JSON.stringify(input ?? null);
        const interpolated = triggerMode === "webhook" ? wrapUntrusted("webhook", rendered) : rendered;
        const message = cfg.message.replace(/\{\{\s*input\s*\}\}/g, () => interpolated);
        const result = await this.agentInvoker({
          agentId: cfg.agentId,
          message,
          parentMissionId: missionId,
        });
        if (result.status !== "succeeded") {
          throw new Error(`agent mission ${result.missionId} ended ${result.status}`);
        }
        return { agentMissionId: result.missionId, result: result.output };
      }
      default:
        throw new Error(`unsupported node kind: ${node.kind}`);
    }
  }

  private async finishMission(
    missionId: string,
    status: MissionStatus,
    output: unknown,
    error: string | null,
  ): Promise<MissionStatus> {
    const claim = this.waitClaims.get(missionId);
    if (claim && ["succeeded", "failed", "cancelled"].includes(status)) {
      await finishClaimedWorkflowWaitMission(this.db, {
        missionId,
        claimToken: claim.claimToken,
        status: status as "succeeded" | "failed" | "cancelled",
        output,
        error,
      });
    } else {
      await updateMission(this.db, missionId, {
        status,
        output: output === undefined ? null : output,
        error,
        finishedAt: now(),
      });
    }
    await this.bus.publish({ type: "mission.finished", missionId, status, at: now().toISOString() });
    return status;
  }

  private async recordStep(
    missionId: string,
    node: WorkflowNode,
    status: StepStatus,
    attempt: number,
    input: unknown,
    output: unknown,
    error: string | null,
    stepIdByNode: Map<string, string>,
  ): Promise<void> {
    const terminal = ["succeeded", "failed", "skipped"].includes(status);
    const existingId = stepIdByNode.get(node.id);
    if (existingId) {
      await updateStep(this.db, existingId, {
        status,
        attempt,
        input: input === undefined ? null : input,
        output: output === undefined ? null : output,
        error,
        finishedAt: terminal ? now() : null,
      });
    } else {
      const row = await insertStep(this.db, {
        missionId,
        nodeId: node.id,
        kind: node.kind,
        status,
        attempt,
        input: input === undefined ? null : input,
        output: output === undefined ? null : output,
        error,
        startedAt: now(),
        finishedAt: terminal ? now() : null,
      });
      stepIdByNode.set(node.id, row.id);
    }
    await this.bus.publish({
      type: "mission.step",
      missionId,
      nodeId: node.id,
      kind: node.kind,
      status,
      attempt,
      at: now().toISOString(),
      ...(error ? { error } : {}),
    });
  }
}

/** Resolve one templatable string (verify-node config fields). */
function resolveTemplate(value: string, input: unknown): string {
  const resolved = resolveWorkflowActionArgs({ v: value }, input, {}).v;
  return resolved == null ? "" : String(resolved);
}

const EXACT_DYNAMIC_APPROVAL_PROMPT = "{{input.approvalPrompt}}";
const MAX_DYNAMIC_APPROVAL_PROMPT_CHARACTERS = 1_024;
const MAX_DYNAMIC_APPROVAL_PROMPT_BYTES = 2_048;
const APPROVAL_PROMPT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * Resolve the one deliberately supported dynamic approval prompt. Requiring
 * the entire value to be `{{input.approvalPrompt}}` prevents mixed template
 * text from disguising what the operator is approving. Static prompts are
 * returned byte-for-byte for backward compatibility.
 */
export function resolveApprovalPrompt(prompt: string, input: unknown): string {
  if (!prompt.includes("{{") && !prompt.includes("}}")) return prompt;
  if (prompt !== EXACT_DYNAMIC_APPROVAL_PROMPT) {
    throw new Error(
      "dynamic approval prompt must be exactly {{input.approvalPrompt}}",
    );
  }

  const resolved = resolveWorkflowActionArgs({ prompt }, input, {}).prompt;
  if (typeof resolved !== "string" || resolved.length === 0 || resolved.trim().length === 0) {
    throw new Error("dynamic approval prompt must resolve to a nonempty plain string");
  }
  if (resolved.length > MAX_DYNAMIC_APPROVAL_PROMPT_CHARACTERS) {
    throw new Error(
      `dynamic approval prompt exceeds ${MAX_DYNAMIC_APPROVAL_PROMPT_CHARACTERS} characters`,
    );
  }
  if (Buffer.byteLength(resolved, "utf8") > MAX_DYNAMIC_APPROVAL_PROMPT_BYTES) {
    throw new Error(`dynamic approval prompt exceeds ${MAX_DYNAMIC_APPROVAL_PROMPT_BYTES} UTF-8 bytes`);
  }
  if (APPROVAL_PROMPT_CONTROL_CHARACTERS.test(resolved)) {
    throw new Error("dynamic approval prompt contains forbidden control characters");
  }
  return resolved;
}

const WORKFLOW_REFERENCE = /^\{\{\s*(input|steps\.([A-Za-z0-9_-]+))(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?\s*\}\}$/;
const UNSAFE_REFERENCE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ACTION_ARG_DEPTH = 32;
const MAX_ACTION_ARG_VALUES = 10_000;

function ownPath(root: unknown, path: string | undefined, label: string): unknown {
  if (!path) return root;
  let current = root;
  for (const segment of path.split(".")) {
    if (UNSAFE_REFERENCE_SEGMENTS.has(segment)) {
      throw new Error(`workflow reference ${label} contains a forbidden path segment`);
    }
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      throw new Error(`workflow reference ${label} does not exist`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    // Tool results are JSON values. Refuse prototypes and accessors rather
    // than invoking code while resolving a workflow definition.
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`workflow reference ${label} does not exist`);
    }
    current = descriptor.value;
  }
  return current;
}

function resolveWorkflowReference(
  value: string,
  input: unknown,
  steps: Readonly<Record<string, unknown>>,
): { matched: boolean; value: unknown } {
  const match = value.match(WORKFLOW_REFERENCE);
  if (!match) {
    if (/^\{\{\s*steps\./.test(value)) {
      throw new Error(
        "invalid workflow step reference; use {{steps.<node-id>.<property>}} " +
          "with letters, numbers, underscores, or hyphens",
      );
    }
    return { matched: false, value };
  }
  if (match[1] === "input") {
    // Preserve the legacy input-placeholder behavior: a missing optional
    // input field resolves to undefined and the called tool's schema decides
    // whether it is required.
    try {
      return { matched: true, value: ownPath(input, match[3], `input${match[3] ? `.${match[3]}` : ""}`) };
    } catch (error) {
      if (error instanceof Error && / does not exist$/.test(error.message)) {
        return { matched: true, value: undefined };
      }
      throw error;
    }
  }

  const nodeId = match[2]!;
  if (!Object.prototype.hasOwnProperty.call(steps, nodeId)) {
    throw new Error(`workflow reference steps.${nodeId} is not a completed prior step`);
  }
  const root = Object.getOwnPropertyDescriptor(steps, nodeId);
  if (!root || !("value" in root)) {
    throw new Error(`workflow reference steps.${nodeId} is not a data property`);
  }
  return {
    matched: true,
    value: ownPath(root.value, match[3], `steps.${nodeId}${match[3] ? `.${match[3]}` : ""}`),
  };
}

/**
 * Resolve action arguments without evaluating expressions. Exact
 * `{{input...}}` and `{{steps.<node-id>...}}` placeholders retain their JSON
 * type, including nested arrays and objects. Literal strings are unchanged.
 *
 * Resolution recursively clones the JSON argument tree, refuses accessors and
 * prototype traversal, and fails closed when a referenced prior step/property
 * is absent. The bounded traversal prevents a hostile workflow definition
 * from expanding executor work without limit.
 */
export function resolveWorkflowActionArgs(
  args: Record<string, unknown>,
  input: unknown,
  steps: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let values = 0;
  const active = new WeakSet<object>();

  const visit = (value: unknown, depth: number, resolveReferences = true): unknown => {
    values++;
    if (values > MAX_ACTION_ARG_VALUES) {
      throw new Error(`workflow action arguments exceed ${MAX_ACTION_ARG_VALUES} values`);
    }
    if (depth > MAX_ACTION_ARG_DEPTH) {
      throw new Error(`workflow action arguments exceed depth ${MAX_ACTION_ARG_DEPTH}`);
    }
    if (typeof value === "string" && resolveReferences) {
      const resolved = resolveWorkflowReference(value, input, steps);
      return resolved.matched
        ? visit(resolved.value, depth + 1, false)
        : value;
    }
    if (value === null || typeof value !== "object") return value;
    if (active.has(value)) throw new Error("workflow action arguments contain a cycle");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) => visit(entry, depth + 1, resolveReferences));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("workflow action arguments must contain only JSON objects");
      }
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (UNSAFE_REFERENCE_SEGMENTS.has(key)) {
          throw new Error("workflow action arguments contain a forbidden object key");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("workflow action arguments must not contain accessors");
        }
        output[key] = visit(descriptor.value, depth + 1, resolveReferences);
      }
      return output;
    } finally {
      active.delete(value);
    }
  };

  return visit(args, 0) as Record<string, unknown>;
}
