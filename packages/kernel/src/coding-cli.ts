/**
 * Pluggable coding-CLI adapters for bench.delegate (WP3b.4, ADR-002 + ADR-008).
 *
 * ADR-002 chose a headless coding CLI for the EXECUTE phase. This module makes
 * *which* CLI a per-call choice rather than a hardcode, so the product isn't
 * locked to one vendor's model: each adapter knows how to (a) build the CLI's
 * headless invocation for a task + budgets, and (b) parse that CLI's output
 * into a common DelegateResult. bench.delegate resolves an adapter by name and
 * stays otherwise identical (same tier gate, same CommandExecutor.run() seam).
 *
 * Adapters differ in output richness and in which budgets they can enforce —
 * that is expected. DelegateResult's fields are optional so a CLI that reports
 * less (aider: no turn count) simply fills fewer, without the tool pretending
 * it got data it didn't. The parsing logic is pure and unit-testable against
 * canned transcripts (scripts/verify-delegate-parse.mjs) — no Docker or key.
 */

/** The parsed outcome of a delegate run, common across CLIs. */
export interface DelegateResult {
  /** Which adapter served the run (e.g. "claude", "aider"). */
  cli: string;
  /** Did the CLI session finish successfully? */
  ok: boolean;
  /** Agent turns the session took, if the CLI reports them (claude does; aider doesn't). */
  numTurns?: number;
  /** Token usage the CLI reported, passed through in whatever shape it gave. */
  usage?: unknown;
  /** The CLI's final result text (its answer / a summary of what it did). */
  result: string;
  /** Total cost in USD the CLI reported for the session, if present. */
  costUsd?: number;
  /** Files the CLI reported editing, when it names them (aider does). */
  filesChanged?: string[];
  /** Why `ok` is false, when it is. */
  reason?: string;
}

/** Context a parser needs beyond stdout: the process exit code and stderr. */
export interface DelegateExec {
  code: number;
  stderr: string;
}

export interface CodingCliAdapter {
  /** Stable adapter id, also the value of DelegateResult.cli. */
  readonly name: string;
  /** Build the shell command to run headless in the workbench. `maxTurns` is
   *  advisory — an adapter whose CLI has no turn cap may ignore it. */
  buildCommand(task: string, opts: { maxTurns: number }): string;
  /** Parse the CLI's stdout (+ exit context) into a DelegateResult. */
  parse(stdout: string, exec: DelegateExec): DelegateResult;
}

/** POSIX single-quote for safe interpolation into `sh -c`. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// --- Claude Code (Anthropic) -------------------------------------------------
// Emits newline-delimited JSON: one object per line (system/assistant/user)
// terminated by a single `result` event carrying is_error/num_turns/usage/text.

/** Parse Claude Code's `--output-format stream-json` transcript. Robust to
 *  interleaved noise (unparseable lines skipped) and a missing result event
 *  (a failure, not a throw). The last `result` event wins. */
export function parseClaudeStream(stdout: string, exec?: DelegateExec): DelegateResult {
  let resultEvent: Record<string, unknown> | undefined;
  for (const line of String(stdout ?? "").split("\n")) {
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
    return { cli: "claude", ok: false, result: "", reason: "no result event in stream-json transcript" };
  }

  const isError = resultEvent.is_error === true;
  const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : undefined;
  const text = typeof resultEvent.result === "string" ? resultEvent.result : "";
  const numTurns = typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : undefined;
  const costUsd =
    typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : undefined;

  return {
    cli: "claude",
    ok: !isError,
    numTurns,
    usage: resultEvent.usage,
    result: text || subtype || "",
    costUsd,
    ...(isError ? { reason: subtype ?? "the CLI reported an error result" } : {}),
    // exec is accepted for a uniform signature; claude's own result event is
    // authoritative for ok/reason, so we don't override it from the exit code.
    ...(exec ? {} : {}),
  };
}

export const claudeAdapter: CodingCliAdapter = {
  name: "claude",
  buildCommand: (task, { maxTurns }) =>
    `claude -p ${shQuote(task)} --output-format stream-json --verbose ` +
    `--max-turns ${maxTurns} --permission-mode acceptEdits`,
  parse: (stdout, exec) => parseClaudeStream(stdout, exec),
};

// --- aider (provider-agnostic: OpenAI / Anthropic / Gemini / Ollama / local) --
// aider is model-agnostic — the DELEGATE_MODEL env (its --model) picks the
// provider, and it reads that provider's key from the env (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, GEMINI_API_KEY, …) injected via the ADR-005 secrets path.
// Its output is human text, not JSON, but it prints machine-recognisable
// footer lines we can parse: "Applied edit to <file>" and
// "Tokens: N sent, M received. Cost: $X message, $Y session.".

const AIDER_APPLIED_RE = /^Applied edit to (.+)$/gm;
const AIDER_COST_RE = /Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session/i;
const AIDER_TOKENS_RE = /Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i;

/** Parse a token count like "3.2k" or "412" into a number. */
function parseTokenCount(s: string): number {
  const m = s.trim().match(/^([\d.]+)(k?)$/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

/** Parse aider's non-interactive (`--message`) output. Unlike stream-json this
 *  has no explicit success event, so exit code is the primary success signal;
 *  we enrich with the cost/token/applied-file footer lines when present. */
export function parseAiderOutput(stdout: string, exec?: DelegateExec): DelegateResult {
  const text = String(stdout ?? "");
  const code = exec?.code ?? 0;

  const filesChanged = [...text.matchAll(AIDER_APPLIED_RE)].map((m) => m[1]!.trim());

  const costM = text.match(AIDER_COST_RE);
  const costUsd = costM ? Number(costM[2]) : undefined; // session cost

  const tokM = text.match(AIDER_TOKENS_RE);
  const usage = tokM
    ? { inputTokens: parseTokenCount(tokM[1]!), outputTokens: parseTokenCount(tokM[2]!) }
    : undefined;

  const ok = code === 0;
  const result = ok
    ? filesChanged.length > 0
      ? `Applied edits to ${filesChanged.join(", ")}`
      : "aider run completed (no file edits reported)"
    : "";

  return {
    cli: "aider",
    ok,
    // aider has no turn concept in --message mode — numTurns stays undefined
    // rather than being faked.
    usage,
    result,
    costUsd,
    ...(filesChanged.length > 0 ? { filesChanged } : {}),
    ...(ok ? {} : { reason: `aider exited ${code}${exec?.stderr ? `: ${exec.stderr.trim().slice(0, 200)}` : ""}` }),
  };
}

export const aiderAdapter: CodingCliAdapter = {
  name: "aider",
  // --yes-always: no interactive confirms; --no-auto-commits: commits stay a
  // separate reviewed step via bench.git.commit/push (ADR-002 keeps git-write
  // outside the CLI). The model rides DELEGATE_MODEL (its --model), defaulting
  // to a local Ollama model so a keyless local deployment still works.
  // maxTurns is not applicable to aider's single-message mode — intentionally
  // ignored (the wall-clock budget in bench.delegate is the hard stop).
  buildCommand: (task) =>
    `aider --yes-always --no-auto-commits --no-pretty ` +
    `--model "\${DELEGATE_MODEL:-ollama/llama3}" --message ${shQuote(task)}`,
  parse: (stdout, exec) => parseAiderOutput(stdout, exec),
};

// --- Registry ----------------------------------------------------------------

export const CODING_CLI_ADAPTERS: Record<string, CodingCliAdapter> = {
  claude: claudeAdapter,
  aider: aiderAdapter,
};

/** The default adapter name when a caller/deployment doesn't specify one.
 *  Overridable via DELEGATE_CLI so a deployment without Anthropic access can
 *  make aider the default. */
export function defaultCliName(env: { DELEGATE_CLI?: string } = {}): string {
  const name = (env.DELEGATE_CLI ?? "").trim();
  return name && name in CODING_CLI_ADAPTERS ? name : "claude";
}

/** Resolve an adapter by name (falls back to the deployment default). Throws a
 *  named error for an unknown CLI rather than silently picking one. */
export function resolveCodingCli(
  name: string | undefined,
  env: { DELEGATE_CLI?: string } = {},
): CodingCliAdapter {
  const requested = (name ?? "").trim() || defaultCliName(env);
  const adapter = CODING_CLI_ADAPTERS[requested];
  if (!adapter) {
    throw new Error(
      `bench.delegate: unknown coding CLI "${requested}" — known: ${Object.keys(CODING_CLI_ADAPTERS).join(", ")}`,
    );
  }
  return adapter;
}
