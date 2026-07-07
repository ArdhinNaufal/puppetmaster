import { getVerifyCheckByName, listArtifacts, type Db } from "@puppetmaster/db";
import type { EvidenceKind, VerifyCheckName } from "@puppetmaster/shared";

/**
 * Deterministic verification gates (Workshop WP4, docs/AI-SDLC-INTEGRATION-PLAN.md).
 *
 * A CheckRunner executes one named check for a project and returns evidence,
 * never a bare verdict. The executor's verify node drives it: pass → the edge
 * opens; fail → bounded fix loop, then escalation to a human approval.
 *
 * Config errors (check missing, disabled, unsupported here) THROW — a gated
 * pipeline must fail closed, loudly, rather than pass by absence. Skips are
 * only legal where the check itself defines them (e.g. load without declared
 * SLOs — WP3+ territory).
 */

export interface CheckRunContext {
  projectId: string;
  check: VerifyCheckName;
  missionId: string;
}

export interface CheckRunResult {
  ok: boolean;
  /** One-line verdict for prompts/traces. */
  summary: string;
  /** What the agent should do about a failure — becomes the fix-loop message. */
  instruction?: string;
  evidenceKind: EvidenceKind;
  /** Machine-readable detail persisted as evidence content. */
  detail?: unknown;
}

export interface CheckRunner {
  run(ctx: CheckRunContext): Promise<CheckRunResult>;
}

/**
 * The workbench-independent runner: executes checks that are pure DB
 * assertions. Shell-backed checks (test, arch, refactor-gate, load, custom)
 * need a project workbench (WP3) and are refused here by name — an honest
 * refusal, not a silent pass.
 */
export function createBuiltinCheckRunner(deps: { db: Db }): CheckRunner {
  return {
    async run(ctx: CheckRunContext): Promise<CheckRunResult> {
      const check = await getVerifyCheckByName(deps.db, ctx.projectId, ctx.check);
      if (!check) {
        throw new Error(
          `verify check "${ctx.check}" is not configured for this project — checks are earned policies; create it first`,
        );
      }
      if (!check.enabled) {
        throw new Error(
          `verify check "${ctx.check}" is disabled — earned policies are off by default; enable it on the project before gating on it`,
        );
      }

      if (ctx.check === "todo-sync") return runTodoSync(deps.db, ctx.projectId);

      throw new Error(
        `verify check "${ctx.check}" requires a project workbench (WP3) — no shell-capable check runner is wired in this deployment`,
      );
    },
  };
}

/** The corpus's require-todo-sync gate as a DB assertion: if the newest spec
 *  version postdates every todo touch, the spec changed without the task
 *  state following — block until todos catch up. */
async function runTodoSync(db: Db, projectId: string): Promise<CheckRunResult> {
  const specs = await listArtifacts(db, projectId, { kind: "spec" });
  if (specs.length === 0) {
    return {
      ok: true,
      summary: "todo-sync: no spec artifacts yet; nothing to sync",
      evidenceKind: "state-assert",
      detail: { specs: 0 },
    };
  }
  const latestSpec = specs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const todos = await listArtifacts(db, projectId, { kind: "todo" });
  const latestTouch = todos.reduce<Date | null>((acc, t) => {
    const touched = t.updatedAt > t.createdAt ? t.updatedAt : t.createdAt;
    return acc && acc > touched ? acc : touched;
  }, null);

  const inSync = latestTouch !== null && latestTouch >= latestSpec.createdAt;
  const detail = {
    latestSpec: { id: latestSpec.id, title: latestSpec.title, version: latestSpec.version, at: latestSpec.createdAt },
    todos: todos.length,
    latestTodoTouch: latestTouch,
  };
  if (inSync) {
    return { ok: true, summary: "todo-sync: todos touched since the last spec change", evidenceKind: "state-assert", detail };
  }
  return {
    ok: false,
    summary: `todo-sync: spec "${latestSpec.title}" v${latestSpec.version} changed but no todo was created, updated, or completed since`,
    instruction:
      `The spec "${latestSpec.title}" (v${latestSpec.version}) changed but the project's todos were not updated. ` +
      `Review the spec change and create, update, or complete the affected todos so the task state reflects it, then finish.`,
    evidenceKind: "state-assert",
    detail,
  };
}
