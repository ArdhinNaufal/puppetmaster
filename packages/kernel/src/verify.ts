import { getVerifyCheckByName, listArtifacts, type Db } from "@puppetmaster/db";
import type { EvidenceKind, VerifyCheckName } from "@puppetmaster/shared";
import type { CommandExecutor } from "./command-runner.js";

/**
 * Deterministic verification gates (Workshop WP4, docs/AI-SDLC-INTEGRATION-PLAN.md).
 *
 * A CheckRunner executes one named check for a project and returns evidence,
 * never a bare verdict. The executor's verify node drives it: pass → the edge
 * opens; fail → bounded fix loop, then escalation to a human approval.
 *
 * Config errors (check missing, disabled, unsupported here) THROW — a gated
 * pipeline must fail closed, loudly, rather than pass by absence. The `load`
 * check without declared SLOs is such a refusal (S2: an invented threshold is
 * the failure mode, so the numbers must be declared — it never passes by
 * absence).
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
 * The builtin runner. DB-assertion checks (todo-sync, spec-sections) always
 * run. Workbench-backed checks (test, arch, custom, refactor-gate, load) run
 * only when a CommandExecutor is wired (WP3) — otherwise they are refused by
 * name (an honest refusal, not a silent pass). refactor-gate reads git diff;
 * load runs a declared load command against declared SLOs.
 */
export function createBuiltinCheckRunner(deps: { db: Db; executor?: CommandExecutor }): CheckRunner {
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
      if (ctx.check === "spec-sections") return runSpecSections(deps.db, ctx.projectId, check.command);

      if (
        ctx.check === "test" ||
        ctx.check === "arch" ||
        ctx.check === "custom" ||
        ctx.check === "refactor-gate" ||
        ctx.check === "load"
      ) {
        if (!deps.executor) {
          throw new Error(
            `verify check "${ctx.check}" needs a workbench command executor — none is wired in this deployment (WP3b: the container executor)`,
          );
        }
        if (ctx.check === "refactor-gate") return runRefactorGate(deps.executor, ctx, check.command);
        if (ctx.check === "load") return runLoad(deps.executor, ctx, check.command);
        return runShellCheck(deps.executor, ctx, check.command);
      }

      throw new Error(`verify check "${ctx.check}" is not implemented`);
    },
  };
}

/** Generic shell check (WP3a): run the check's declared command in the
 *  project's workspace; exit 0 = pass, anything else gates. The command's own
 *  output is the evidence — the deterministic gate the corpus's Invariant 2
 *  demands (a build/test/inspection, not the model's word). */
async function runShellCheck(
  executor: CommandExecutor,
  ctx: CheckRunContext,
  command: string | null,
): Promise<CheckRunResult> {
  if (!command || !command.trim()) {
    throw new Error(
      `verify check "${ctx.check}" has no command configured — a shell check must declare what to run`,
    );
  }
  const res = await executor.run({ projectId: ctx.projectId, command });
  const tail = (s: string) => s.split("\n").slice(-20).join("\n").trim();
  const detail = {
    command,
    code: res.code,
    timedOut: res.timedOut,
    stdout: tail(res.stdout),
    stderr: tail(res.stderr),
  };
  if (res.code === 0 && !res.timedOut) {
    return {
      ok: true,
      summary: `${ctx.check}: \`${command}\` passed (exit 0)`,
      evidenceKind: "test-output",
      detail,
    };
  }
  const why = res.timedOut ? "timed out" : `exited ${res.code}`;
  const output = tail(res.stderr) || tail(res.stdout) || "(no output)";
  return {
    ok: false,
    summary: `${ctx.check}: \`${command}\` ${why}`,
    instruction:
      `The ${ctx.check} check \`${command}\` ${why}. Output:\n${output}\n` +
      `Fix the cause so the command exits 0, then finish.`,
    evidenceKind: "test-output",
    detail,
  };
}

/** Behavior-preserving refactor gate (ai-sdlc-refactoring §7; failure mode P14):
 *  a refactor must not edit test expectations, so any *modified* (not added)
 *  test file in the working tree vs the last commit blocks. Adding tests is
 *  fine — `--diff-filter=M` excludes additions. Test-path patterns default to
 *  the common conventions; `command` overrides them (JSON array of regexes). */
const DEFAULT_TEST_PATTERNS = [
  "\\.test\\.",
  "\\.spec\\.",
  "_test\\.",
  "(^|/)tests?/",
  "(^|/)__tests__/",
  "(^|/)spec/",
];

async function runRefactorGate(
  executor: CommandExecutor,
  ctx: CheckRunContext,
  command: string | null,
): Promise<CheckRunResult> {
  let patternSrc = DEFAULT_TEST_PATTERNS;
  if (command) {
    try {
      const parsed = JSON.parse(command);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string") && parsed.length > 0) {
        patternSrc = parsed;
      }
    } catch {
      /* not JSON — keep defaults */
    }
  }
  let patterns: RegExp[];
  try {
    patterns = patternSrc.map((s) => new RegExp(s));
  } catch (err) {
    throw new Error(
      `refactor-gate: invalid test-path pattern in config — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const res = await executor.run({
    projectId: ctx.projectId,
    command: "git diff --diff-filter=M --name-only HEAD",
  });
  if (res.code !== 0) {
    throw new Error(
      `refactor-gate: \`git diff\` failed (exit ${res.code}) — is the workbench a git repo with a commit? ${res.stderr.trim()}`,
    );
  }
  const modified = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const modifiedTests = modified.filter((f) => patterns.some((p) => p.test(f)));
  const detail = { base: "HEAD", modified, modifiedTests, patterns: patternSrc };
  if (modifiedTests.length === 0) {
    return {
      ok: true,
      summary: `refactor-gate: no test files modified (${modified.length} tracked file(s) changed; tests only added or left untouched)`,
      evidenceKind: "state-assert",
      detail,
    };
  }
  return {
    ok: false,
    summary: `refactor-gate: ${modifiedTests.length} test file(s) modified during a refactor — ${modifiedTests.join(", ")}`,
    instruction:
      `A refactor must preserve behavior, so it must not change test expectations. These test files were modified: ${modifiedTests.join(", ")}. ` +
      `Revert the test edits. If a test is genuinely wrong, that is a behavior change — do it as its own task (two-hats), not inside the refactor.`,
    evidenceKind: "state-assert",
    detail,
  };
}

/** Load-test gate (ai-sdlc-scalability §7; failure mode S2). Config is JSON:
 *  `{ "slos": [...], "run": "k6 run script.js" }`. No declared SLOs ⇒ refuse
 *  (throw) — a threshold must trace to a real SLO, never be invented to make a
 *  gate pass. With SLOs, the declared command runs in the workbench and exit 0
 *  = the SLOs held. */
async function runLoad(
  executor: CommandExecutor,
  ctx: CheckRunContext,
  command: string | null,
): Promise<CheckRunResult> {
  let cfg: { slos?: unknown; run?: unknown } = {};
  if (command) {
    try {
      cfg = JSON.parse(command);
    } catch {
      /* handled by the SLO check below */
    }
  }
  const slos = Array.isArray(cfg.slos) ? cfg.slos : [];
  if (slos.length === 0) {
    throw new Error(
      `load check has no declared SLO thresholds — a load test must gate on numbers traced to a real SLO, ` +
        `never invented ones. Declare {"slos":[…],"run":"k6 run …"} in the check config.`,
    );
  }
  const run = typeof cfg.run === "string" ? cfg.run.trim() : "";
  if (!run) {
    throw new Error(
      `load check declares SLOs but no command to run — set "run" (e.g. "k6 run script.js") in the check config`,
    );
  }

  const res = await executor.run({ projectId: ctx.projectId, command: run });
  const tail = (s: string) => s.split("\n").slice(-20).join("\n").trim();
  const detail = {
    slos,
    command: run,
    code: res.code,
    timedOut: res.timedOut,
    stdout: tail(res.stdout),
    stderr: tail(res.stderr),
  };
  if (res.code === 0 && !res.timedOut) {
    return {
      ok: true,
      summary: `load: \`${run}\` met the ${slos.length} declared SLO threshold(s) (exit 0)`,
      evidenceKind: "test-output",
      detail,
    };
  }
  const why = res.timedOut ? "timed out" : `exited ${res.code}`;
  const output = tail(res.stderr) || tail(res.stdout) || "(no output)";
  return {
    ok: false,
    summary: `load: \`${run}\` ${why} — a declared SLO was not met`,
    instruction:
      `The load test \`${run}\` ${why}. Output:\n${output}\n` +
      `A declared SLO threshold was breached; fix the regression. If the SLO itself is wrong, change it deliberately — not to make the gate pass.`,
    evidenceKind: "test-output",
    detail,
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

/** The corpus's required-output-sections rule as a gate ("theater refusal"):
 *  the newest spec version must contain every required section with concrete
 *  content. Presence + substance only — quality stays with the review gate.
 *  `command` may override the section list as a JSON array of strings. */
const DEFAULT_SPEC_SECTIONS = [
  "Tech stack",
  "Data model",
  "Code architecture",
  "Scale & operations",
  "Edge cases",
  "Out of scope",
  "Verification",
];
const MIN_SECTION_CHARS = 40;

async function runSpecSections(db: Db, projectId: string, command: string | null): Promise<CheckRunResult> {
  let required = DEFAULT_SPEC_SECTIONS;
  if (command) {
    try {
      const parsed = JSON.parse(command);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string") && parsed.length > 0) {
        required = parsed;
      }
    } catch {
      /* not JSON — keep defaults */
    }
  }

  const specs = await listArtifacts(db, projectId, { kind: "spec" });
  if (specs.length === 0) {
    return {
      ok: false,
      summary: "spec-sections: no spec artifact exists yet",
      instruction: "No spec artifact exists for this project. Run the interview and write the spec (project.artifact.write, kind spec) before proceeding.",
      evidenceKind: "state-assert",
      detail: { required, spec: null },
    };
  }
  const latest = specs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

  // Split the body into heading → content blocks (markdown #-headings).
  const sections = new Map<string, string>();
  const parts = latest.body.split(/^#{1,6}\s+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    sections.set(parts[i]!.trim().toLowerCase(), (parts[i + 1] ?? "").trim());
  }

  const missing: string[] = [];
  const thin: string[] = [];
  for (const name of required) {
    const key = [...sections.keys()].find((h) => h.includes(name.toLowerCase()));
    if (key === undefined) missing.push(name);
    else if (sections.get(key)!.length < MIN_SECTION_CHARS) thin.push(name);
  }

  const detail = {
    spec: { id: latest.id, title: latest.title, version: latest.version },
    required,
    missing,
    thin,
  };
  if (missing.length === 0 && thin.length === 0) {
    return { ok: true, summary: `spec-sections: all ${required.length} required sections are concretely filled`, evidenceKind: "state-assert", detail };
  }
  const problems = [
    ...missing.map((s) => `missing section "${s}"`),
    ...thin.map((s) => `section "${s}" has no concrete content`),
  ].join("; ");
  return {
    ok: false,
    summary: `spec-sections: spec "${latest.title}" v${latest.version} is incomplete — ${problems}`,
    instruction:
      `The spec "${latest.title}" is not concrete enough to build from: ${problems}. ` +
      `Keep interviewing until every required section can be filled concretely, then write the ` +
      `updated spec as a new version (project.artifact.write, kind spec, same title).`,
    evidenceKind: "state-assert",
    detail,
  };
}
