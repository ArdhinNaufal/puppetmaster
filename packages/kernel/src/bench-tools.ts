import { getProject, type Db } from "@puppetmaster/db";
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

/** The parsed outcome of a `bench.delegate` run (a pinned coding-CLI session
 *  inside the workbench, ADR-002). Derived purely from the CLI's stream-json
 *  transcript — no Docker or live key needed to test this shape. */
export interface DelegateResult {
  /** Did the CLI session finish successfully (a non-error `result` event)? */
  ok: boolean;
  /** Agent turns the session took, from the `result` event (undefined if absent). */
  numTurns?: number;
  /** Token usage reported by the `result` event, passed through verbatim. */
  usage?: unknown;
  /** The CLI's final result text (its answer), or an error subtype description. */
  result: string;
  /** Total cost in USD the CLI reported for the session, if present. */
  costUsd?: number;
  /** Why `ok` is false, when it is (max-turns, execution error, or no result). */
  reason?: string;
}

/**
 * Parse the `claude -p … --output-format stream-json` transcript into a
 * DelegateResult (WP3b.4, ADR-002). The CLI emits newline-delimited JSON: one
 * object per line (`system`/`assistant`/`user` events) terminated by a single
 * `result` event carrying `is_error`, `num_turns`, `usage`, and the answer text.
 *
 * Robust by design — this is untrusted subprocess output: unparseable lines are
 * skipped (partial buffers, interleaved stderr), and a transcript with no
 * `result` event is a failure, not a throw. The last `result` event wins.
 */
export function parseDelegateStream(raw: string): DelegateResult {
  let resultEvent: Record<string, unknown> | undefined;
  for (const line of String(raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // interleaved noise / partial line — ignore, don't fail the parse
    }
    if (event && typeof event === "object" && (event as { type?: unknown }).type === "result") {
      resultEvent = event as Record<string, unknown>;
    }
  }

  if (!resultEvent) {
    return { ok: false, result: "", reason: "no result event in stream-json transcript" };
  }

  const isError = resultEvent.is_error === true;
  const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : undefined;
  const text = typeof resultEvent.result === "string" ? resultEvent.result : "";
  const numTurns = typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : undefined;
  const costUsd =
    typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : undefined;

  return {
    ok: !isError,
    numTurns,
    usage: resultEvent.usage,
    result: text || subtype || "",
    costUsd,
    ...(isError ? { reason: subtype ?? "the CLI reported an error result" } : {}),
  };
}

/** Coerce an arg to an integer, clamped to [min, max]; falls back to `def`
 *  when absent or not a finite number. Guards the delegate budgets. */
function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
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
  const inWorkbench = async (projectId: unknown, command: string) => {
    const exec = requireExecutor();
    const id = await requireProject(String(projectId ?? ""));
    const res = await exec.run({ projectId: id, command });
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
      const res = await inWorkbench(args.projectId, `cat -- ${shQuote(path)}`);
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
    "Delegate a coding task to the pinned CLI running inside a project's workbench (ADR-002). " +
      "Runs headless with a hard turn cap and wall-clock budget; returns the parsed outcome " +
      "(ok, numTurns, usage, result). Mutating — gated behind approval. Does not push (use bench.git.push).",
    "write_approved",
    {
      type: "object",
      properties: {
        projectId: { type: "string" },
        task: { type: "string", description: "The coding task to hand the CLI (its -p prompt)." },
        maxTurns: {
          type: "number",
          description: "Hard cap on agent turns (1–50, default 12). The CLI's --max-turns.",
        },
        timeoutMs: {
          type: "number",
          description: "Wall-clock budget in ms (default 300000, max 1800000). Kills the run if exceeded.",
        },
      },
      required: ["projectId", "task"],
    },
    async (args) => {
      const task = String(args.task ?? "");
      if (!task.trim()) throw new Error("bench.delegate: a task is required");
      // Clamp the two enforceable budgets. --max-turns caps agent turns; the
      // executor timeout is the wall-clock kill. True mid-run token caps and
      // live progress→trace streaming need a streaming exec API run() lacks
      // today — a documented follow-up, not silently downgraded here.
      const maxTurns = clampInt(args.maxTurns, 12, 1, 50);
      const timeoutMs = clampInt(args.timeoutMs, 300_000, 1_000, 1_800_000);
      const command =
        `claude -p ${shQuote(task)} --output-format stream-json --verbose ` +
        `--max-turns ${maxTurns} --permission-mode acceptEdits`;
      const exec = requireExecutor();
      const id = await requireProject(String(args.projectId ?? ""));
      const res = await exec.run({ projectId: id, command, timeoutMs });
      if (res.timedOut) {
        throw new Error(`bench.delegate: exceeded the ${timeoutMs}ms wall-clock budget`);
      }
      const parsed = parseDelegateStream(res.stdout);
      // A clean CLI exit but no parseable result event, or a non-zero exit
      // with nothing parsed, is a delegate failure worth surfacing by name.
      if (!parsed.numTurns && parsed.reason && res.code !== 0) {
        throw new Error(
          `bench.delegate: CLI exited ${res.code} — ${parsed.reason}${
            res.stderr.trim() ? ` (${res.stderr.trim().slice(0, 200)})` : ""
          }`,
        );
      }
      return parsed;
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
    async (args) => inWorkbench(args.projectId, "git status --porcelain"),
  );

  registry.register(
    "bench",
    "git.diff",
    "Show a project workbench's unstaged git diff.",
    "read_auto",
    { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    async (args) => inWorkbench(args.projectId, "git diff"),
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
