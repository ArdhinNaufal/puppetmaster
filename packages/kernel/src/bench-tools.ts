import { randomUUID } from "node:crypto";
import { getBlockingWorkbenchCopybackForProject, getProject, type Db } from "@puppetmaster/db";
import { isolateAiderRepositoryCommand, resolveCodingCli } from "./coding-cli.js";
import type { CommandExecutor } from "./command-runner.js";
import type { BuiltinToolRegistry } from "./tools.js";

/**
 * Workbench tools (AI-SDLC plan WP3b.3, ADR-002/ADR-005). The `bench.*`
 * namespace lets an agent drive a project's containerized workbench — read a
 * file, run a command, and use git — over the same `CommandExecutor.run()`
 * seam WP3a (local) and WP3b.1 (docker) built. No new execution boundary is
 * added here; the tools are a thin, tiered surface on top of it.
 *
 * Tiers gate the danger (PRD §4): reads are `read_auto`; mutations (exec,
 * write, commit) are `write_approved`; and `bench.git.push` is
 * `destructive_confirmed` — the corpus's "injection → push is gated" rule.
 *
 * Results re-enter model context through the runtime's untrusted-data envelope
 * and Stage 9C compaction like any catalog tool (agent-runtime wraps + compacts
 * every non-runtime tool result) — bench output is external data, treated as
 * such automatically. Nothing bench-specific is needed for that.
 *
 * No executor wired (WORKBENCH_MODE unset) ⇒ every bench call refuses by name,
 * the same honest refusal the shell verify checks give (verify.ts). Commands
 * run in the workbench's working dir (`/workbench` for docker); file paths are
 * relative to it and may not escape.
 */

/** POSIX single-quote a value for safe interpolation into `sh -c`. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Coerce an arg to an integer, clamped to [min, max]; falls back to `def`
 *  when absent or not a finite number. Guards the delegate budgets. */
function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampFloat(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const CLAUDE_DELEGATE_SECRETS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
];

function delegateSecretNames(cli: string, model: string | undefined): string[] {
  if (cli === "claude") return CLAUDE_DELEGATE_SECRETS;
  const selected = (model ?? process.env.DELEGATE_MODEL ?? "").trim().toLowerCase();
  const provider = selected.includes("/") ? selected.split("/", 1)[0]! :
    /^(claude|anthropic)/.test(selected) ? "anthropic" :
      /^(gemini|google)/.test(selected) ? "gemini" : "openai";
  if (provider === "anthropic") return ["DELEGATE_MODEL", ...CLAUDE_DELEGATE_SECRETS];
  if (provider === "gemini" || provider === "google") {
    return ["DELEGATE_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
  }
  if (provider === "openrouter") return ["DELEGATE_MODEL", "OPENROUTER_API_KEY"];
  if (provider === "deepseek") return ["DELEGATE_MODEL", "DEEPSEEK_API_KEY"];
  return [
    "DELEGATE_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
  ];
}

/** A file path confined to the workbench: relative, no `..` escape. */
function safeRelPath(path: string): string {
  const p = String(path ?? "").trim();
  if (!p) throw new Error("bench: a file path is required");
  if (p.startsWith("/")) {
    throw new Error(`bench: path must be relative to the workbench, got absolute "${p}"`);
  }
  if (p.split("/").some((seg) => seg === "..")) {
    throw new Error(`bench: path must not escape the workbench (no "..") — got "${p}"`);
  }
  return p;
}

export function registerBenchTools(
  registry: BuiltinToolRegistry,
  deps: { db: Db; workspaceId: string; executor?: CommandExecutor },
): void {
  /** Fail closed when no workbench executor is wired — an honest refusal by
   *  name rather than a silently-absent tool (mirrors createBuiltinCheckRunner). */
  const requireExecutor = (): CommandExecutor => {
    if (!deps.executor) {
      throw new Error(
        "bench tools need a workbench command executor — none is wired in this deployment " +
          "(set WORKBENCH_MODE=docker; WP3b container executor)",
      );
    }
    return deps.executor;
  };

  /** Workspace-scoping guard: a bench call must never touch another workspace's
   *  project workbench, whatever id an injected instruction supplies. */
  const requireProject = async (projectId: string): Promise<string> => {
    const id = String(projectId ?? "");
    const project = await getProject(deps.db, id);
    if (!project || project.workspaceId !== deps.workspaceId) {
      throw new Error(`project "${id}" not found`);
    }
    return id;
  };

  /** Run a shell command in a scoped project's workbench, guards applied. */
  const inWorkbench = async (projectId: unknown, command: string, mutation = true) => {
    const exec = requireExecutor();
    const id = await requireProject(String(projectId ?? ""));
    if (mutation) {
      const blocked = await getBlockingWorkbenchCopybackForProject(deps.db, id);
      if (blocked) {
        throw new Error(`project mutation is blocked by unresolved copy-back ${blocked.id} (${blocked.state})`);
      }
    }
    const res = await exec.run({
      projectId: id,
      command,
      accessMode: mutation ? "write" : "read",
      ...(mutation
        ? { containerProfile: "plain" as const, executionId: `bench-${randomUUID()}` }
        : {}),
    });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut };
  };

  registry.register(
    "bench",
    "read",
    "Read a file from a project's workbench (path relative to the workbench root). Returns the file contents.",
    "read_auto",
    {
      type: "object",
      properties: { projectId: { type: "string" }, path: { type: "string" } },
      required: ["projectId", "path"],
    },
    async (args) => {
      const path = safeRelPath(String(args.path ?? ""));
      const res = await inWorkbench(args.projectId, `cat -- ${shQuote(path)}`, false);
      if (res.code !== 0) {
        throw new Error(`bench.read: ${res.stderr.trim() || `cat exited ${res.code}`}`);
      }
      return res.stdout;
    },
  );

  registry.register(
    "bench",
    "exec",
    "Run a shell command in a project's workbench and return its exit code, stdout, and stderr. Mutating — gated behind approval.",
    "write_approved",
    {
      type: "object",
      properties: { projectId: { type: "string" }, command: { type: "string" } },
      required: ["projectId", "command"],
    },
    async (args) => {
      const command = String(args.command ?? "");
      if (!command.trim()) throw new Error("bench.exec: a command is required");
      return inWorkbench(args.projectId, command);
    },
  );

  registry.register(
    "bench",
    "delegate",
    "Delegate a coding task to a headless CLI inside a project's workbench (ADR-002/ADR-008). " +
      "Claude supports approved mutation. Aider supports permissionMode=plan here; use the " +
      "CLAUDE page OpenAI Execute flow for durable Aider edits. Runs with a turn cap + wall-clock " +
      "budget; returns the parsed outcome (cli, ok, numTurns?, usage?, result, costUsd?). " +
      "Gated behind approval. Does not push (use bench.git.push).",
    "write_approved",
    {
      type: "object",
      properties: {
        projectId: { type: "string" },
        task: { type: "string", description: "The coding task to hand the CLI." },
        cli: {
          type: "string",
          enum: ["claude", "aider"],
          description: "Which coding CLI to delegate to. Aider is read-only in this tool; default is DELEGATE_CLI, else claude.",
        },
        maxTurns: {
          type: "number",
          description: "Hard cap on agent turns (1–50, default 12). Honoured by CLIs that support it (claude); ignored by those that don't (aider).",
        },
        timeoutMs: {
          type: "number",
          description: "Wall-clock budget in ms (default 300000, max 1800000). Kills the run if exceeded.",
        },
        model: {
          type: "string",
          description: "Backend model alias or full model id; Aider Plan accepts a provider/model value.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Adaptive reasoning effort for Claude Code models that support it.",
        },
        permissionMode: {
          type: "string",
          enum: ["plan", "acceptEdits", "dontAsk"],
          description: "Inner permission mode. plan maps Aider to ask; non-plan Aider is refused here. bypassPermissions is unavailable.",
        },
        maxBudgetUsd: {
          type: "number",
          description: "Maximum Claude API spend for this run in USD (0.01-100).",
        },
      },
      required: ["projectId", "task"],
    },
    async (args) => {
      const task = String(args.task ?? "");
      if (!task.trim()) throw new Error("bench.delegate: a task is required");
      // Resolve the coding CLI adapter (claude | aider | deployment default).
      // Unknown name throws by name rather than silently picking one.
      const adapter = resolveCodingCli(
        typeof args.cli === "string" ? args.cli : undefined,
        { DELEGATE_CLI: process.env.DELEGATE_CLI },
      );
      // Clamp the two enforceable budgets. maxTurns caps agent turns (adapters
      // that lack the concept ignore it); the executor timeout is the wall-clock
      // kill. True mid-run token caps and live progress→trace streaming need a
      // streaming exec API run() lacks today — a documented follow-up, not
      // silently downgraded here.
      const maxTurns = clampInt(args.maxTurns, 12, 1, 50);
      const timeoutMs = clampInt(args.timeoutMs, 300_000, 1_000, 1_800_000);
      const effort = ["low", "medium", "high", "xhigh", "max"].includes(String(args.effort ?? ""))
        ? (String(args.effort) as "low" | "medium" | "high" | "xhigh" | "max")
        : undefined;
      const permissionMode = ["plan", "acceptEdits", "dontAsk"].includes(String(args.permissionMode ?? ""))
        ? (String(args.permissionMode) as "plan" | "acceptEdits" | "dontAsk")
        : undefined;
      const maxBudgetUsd = args.maxBudgetUsd == null
        ? undefined
        : clampFloat(args.maxBudgetUsd, 5, 0.01, 100);
      const model = typeof args.model === "string" && args.model.trim()
        ? args.model.trim()
        : undefined;
      const adapterCommand = adapter.buildCommand(task, {
        maxTurns,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
      });
      const executionId = `delegate-${randomUUID()}`;
      const command = adapter.name === "aider"
        ? isolateAiderRepositoryCommand(
            adapterCommand,
            executionId,
            permissionMode === "plan" ? "plan" : "execute",
          )
        : adapterCommand;
      const exec = requireExecutor();
      const id = await requireProject(String(args.projectId ?? ""));
      if (permissionMode !== "plan") {
        const blocked = await getBlockingWorkbenchCopybackForProject(deps.db, id);
        if (blocked) {
          throw new Error(`project mutation is blocked by unresolved copy-back ${blocked.id} (${blocked.state})`);
        }
      }
      if (adapter.name === "aider" && (!exec.applyExecutionResult || !exec.cleanupExecutionArtifacts)) {
        throw new Error("bench.delegate (aider): requires the Docker provider-isolation executor");
      }
      if (adapter.name === "aider" && permissionMode !== "plan") {
        throw new Error(
          "bench.delegate (aider): mutating copy-back requires a durable node-execution owner; " +
            "use the CLAUDE page OpenAI Execute flow",
        );
      }
      try {
      const res = await exec.run({
        projectId: id,
        command,
        timeoutMs,
        executionId,
        ...(adapter.name === "aider" ? { executionGeneration: 1 } : {}),
        containerProfile: adapter.name === "claude" ? "claude" : "openai",
        accessMode: permissionMode === "plan" ? "read" : "write",
        readOnlyProject: adapter.name === "claude" && permissionMode === "plan",
        secretNames: delegateSecretNames(adapter.name, model),
      });
      if (res.timedOut) {
        throw new Error(`bench.delegate (${adapter.name}): exceeded the ${timeoutMs}ms wall-clock budget`);
      }
      const parsed = adapter.parse(res.stdout, { code: res.code, stderr: res.stderr });
      // A non-zero exit that the parser couldn't turn into a usable result is a
      // delegate failure worth surfacing by name.
      if (!parsed.ok && res.code !== 0) {
        throw new Error(
          `bench.delegate (${adapter.name}): CLI exited ${res.code} — ${parsed.reason ?? "unknown error"}${
            res.stderr.trim() ? ` (${res.stderr.trim().slice(0, 200)})` : ""
          }`,
        );
      }
      return parsed;
      } finally {
        if (adapter.name === "aider") await exec.cleanupExecutionArtifacts!(executionId);
      }
    },
  );

  registry.register(
    "bench",
    "write",
    "Write a file into a project's workbench (path relative to the root; parent dirs created). Mutating — gated behind approval.",
    "write_approved",
    {
      type: "object",
      properties: {
        projectId: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["projectId", "path", "content"],
    },
    async (args) => {
      const path = safeRelPath(String(args.path ?? ""));
      const content = String(args.content ?? "");
      // base64 the content so arbitrary bytes survive the shell unmangled.
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
      const command =
        `mkdir -p ${shQuote(dir)} && printf %s ${shQuote(b64)} | base64 -d > ${shQuote(path)}`;
      const res = await inWorkbench(args.projectId, command);
      if (res.code !== 0) {
        throw new Error(`bench.write: ${res.stderr.trim() || `write exited ${res.code}`}`);
      }
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    },
  );

  registry.register(
    "bench",
    "git.status",
    "Show a project workbench's git status (porcelain).",
    "read_auto",
    { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    async (args) => inWorkbench(args.projectId, "git status --porcelain", false),
  );

  registry.register(
    "bench",
    "git.diff",
    "Show a project workbench's unstaged git diff.",
    "read_auto",
    { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    async (args) => inWorkbench(args.projectId, "git diff", false),
  );

  registry.register(
    "bench",
    "git.commit",
    "Stage all changes and commit them in a project's workbench. Mutating — gated behind approval.",
    "write_approved",
    {
      type: "object",
      properties: { projectId: { type: "string" }, message: { type: "string" } },
      required: ["projectId", "message"],
    },
    async (args) => {
      const message = String(args.message ?? "");
      if (!message.trim()) throw new Error("bench.git.commit: a commit message is required");
      return inWorkbench(args.projectId, `git add -A && git commit -m ${shQuote(message)}`);
    },
  );

  registry.register(
    "bench",
    "git.push",
    "Push a project workbench's commits to its remote. Destructive — always requires confirmation.",
    "destructive_confirmed",
    { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    async (args) => inWorkbench(args.projectId, "git push"),
  );
}
