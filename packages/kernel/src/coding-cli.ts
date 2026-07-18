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
  /** Claude Code's durable conversation id, when the adapter reports one. */
  sessionId?: string;
  /** End-to-end and API-only durations reported by Claude Code. */
  durationMs?: number;
  durationApiMs?: number;
  /** Per-model usage/cost breakdown from recent Claude Code result events. */
  modelUsage?: unknown;
  /** Tool calls the headless session could not authorize. */
  permissionDenials?: unknown;
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

export type ClaudePermissionMode = "plan" | "acceptEdits" | "dontAsk";
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CodingCliOptions {
  maxTurns: number;
  model?: string;
  permissionMode?: ClaudePermissionMode;
  effort?: ClaudeEffort;
  maxBudgetUsd?: number;
  sessionId?: string;
  resume?: boolean;
  sessionName?: string;
  configDir?: string;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
}

export interface CodingCliAdapter {
  /** Stable adapter id, also the value of DelegateResult.cli. */
  readonly name: string;
  /** Build the shell command to run headless in the workbench. `maxTurns` is
   *  advisory — an adapter whose CLI has no turn cap may ignore it. */
  buildCommand(task: string, opts: CodingCliOptions): string;
  /** Parse the CLI's stdout (+ exit context) into a DelegateResult. */
  parse(stdout: string, exec: DelegateExec): DelegateResult;
}

/** POSIX single-quote for safe interpolation into `sh -c`. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

const AIDER_REPO_CONTROL_FILES = [
  ".env",
  ".aider.conf.yml",
  ".aider.conf.yaml",
  ".aider.model.settings.yml",
  ".aider.model.metadata.json",
  ".aiderignore",
] as const;

/** Run Aider in a disposable repository copy with repository-owned Aider and
 * dotenv controls removed. Docker execution applies approved successful edits
 * later from a secret-free trusted container; this command never sees the
 * durable project volume writable. */
export function isolateAiderRepositoryCommand(
  command: string,
  executionId: string,
  _mode: "plan" | "execute",
): string {
  const token = executionId.replace(/[^A-Za-z0-9]/g, "");
  if (!token) throw new Error("Aider isolation requires a stable execution id");
  const turnRoot = `/tmp/puppetmaster-aider-turn-${token}`;
  // This key authenticates journals inside the disposable provider scratch
  // only. Durable copy-back uses a separate random key held in Docker volume
  // metadata and never supplied to the provider container.
  const scratchJournalKey = `scratch-${token}`;
  const controls = AIDER_REPO_CONTROL_FILES.map(shQuote).join(" ");
  const apply = _mode === "execute"
    ? `if [ "$code" -eq 0 ]; then ` +
      `puppetmaster-sync apply "$turn_root/repo" /workbench ${shQuote(token)} - ${shQuote(scratchJournalKey)} || exit $?; ` +
      `fi; `
    : "";
  return (
    `turn_root=${shQuote(turnRoot)}; ` +
    `cleanup_aider_turn() { cd /; ` +
    `puppetmaster-sync recover /workbench ${shQuote(token)} ${shQuote(scratchJournalKey)} >/dev/null 2>&1 || true; ` +
    `rm -rf -- "$turn_root"; }; ` +
    `trap cleanup_aider_turn EXIT; trap 'exit 143' HUP INT TERM; ` +
    `rm -rf -- "$turn_root"; mkdir -p -- "$turn_root/repo"; ` +
    `cp -a -- . "$turn_root/repo" || exit $?; ` +
    `cd "$turn_root/repo" || exit $?; rm -rf -- ${controls}; ` +
    `${command}; code=$?; ${apply}exit "$code"`
  );
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
  const sessionId = typeof resultEvent.session_id === "string" ? resultEvent.session_id : undefined;
  const durationMs = typeof resultEvent.duration_ms === "number" ? resultEvent.duration_ms : undefined;
  const durationApiMs =
    typeof resultEvent.duration_api_ms === "number" ? resultEvent.duration_api_ms : undefined;
  const modelUsage = resultEvent.modelUsage ?? resultEvent.model_usage;
  const permissionDenials = resultEvent.permission_denials;

  return {
    cli: "claude",
    ok: !isError,
    numTurns,
    usage: resultEvent.usage,
    result: text || subtype || "",
    costUsd,
    sessionId,
    durationMs,
    durationApiMs,
    ...(modelUsage === undefined ? {} : { modelUsage }),
    ...(permissionDenials === undefined ? {} : { permissionDenials }),
    ...(isError ? { reason: subtype ?? "the CLI reported an error result" } : {}),
    // exec is accepted for a uniform signature; claude's own result event is
    // authoritative for ok/reason, so we don't override it from the exit code.
    ...(exec ? {} : {}),
  };
}

/** Build the current Claude Code non-interactive command. Every variable value
 *  is quoted here so the opaque delegate and durable session runtime share the
 *  same command-injection boundary. */
export function buildClaudeCommand(task: string, opts: CodingCliOptions): string {
  // Managed runs must not inherit commit-able project/local settings, hooks,
  // plugins, or MCP servers. The explicit settings object is still supplied so
  // hook execution remains disabled even if Claude's empty-source semantics
  // change in a future CLI release.
  const managedSettings = JSON.stringify({
    disableAllHooks: true,
    hooks: {},
    enabledPlugins: {},
  });
  const managedMcp = JSON.stringify({ mcpServers: {} });
  const args = [
    "claude",
    "-p",
    shQuote(task),
    "--output-format stream-json",
    "--verbose",
    `--max-turns ${Math.max(1, Math.trunc(opts.maxTurns))}`,
    `--permission-mode ${shQuote(opts.permissionMode ?? "acceptEdits")}`,
    `--setting-sources ${shQuote("")}`,
    `--settings ${shQuote(managedSettings)}`,
    "--strict-mcp-config",
    `--mcp-config ${shQuote(managedMcp)}`,
  ];
  if (opts.model?.trim()) args.push(`--model ${shQuote(opts.model.trim())}`);
  if (opts.effort) args.push(`--effort ${shQuote(opts.effort)}`);
  if (typeof opts.maxBudgetUsd === "number" && Number.isFinite(opts.maxBudgetUsd)) {
    args.push(`--max-budget-usd ${Math.max(0.01, opts.maxBudgetUsd)}`);
  }
  if (opts.sessionId?.trim()) {
    args.push(`${opts.resume ? "--resume" : "--session-id"} ${shQuote(opts.sessionId.trim())}`);
  }
  if (!opts.resume && opts.sessionName?.trim()) {
    args.push(`--name ${shQuote(opts.sessionName.trim())}`);
  }
  if (opts.includePartialMessages) args.push("--include-partial-messages");
  if (opts.includeHookEvents) args.push("--include-hook-events");
  if (opts.allowedTools?.length) {
    args.push(`--allowedTools ${shQuote(opts.allowedTools.join(","))}`);
  }
  if (opts.disallowedTools?.length) {
    args.push(`--disallowedTools ${shQuote(opts.disallowedTools.join(","))}`);
  }
  for (const dir of opts.additionalDirectories ?? []) {
    if (dir.trim()) args.push(`--add-dir ${shQuote(dir.trim())}`);
  }
  const command = args.join(" ");
  return opts.configDir?.trim()
    ? `CLAUDE_CONFIG_DIR=${shQuote(opts.configDir.trim())} ${command}`
    : command;
}

export const claudeAdapter: CodingCliAdapter = {
  name: "claude",
  buildCommand: buildClaudeCommand,
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
const AIDER_CLI_ERROR_RE = /\baider:\s*error:/i;
const AIDER_ENV_ALLOWLIST = [
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_BASE",
  "DELEGATE_MODEL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
] as const;

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
  const stderr = String(exec?.stderr ?? "");

  const filesChanged = [...text.matchAll(AIDER_APPLIED_RE)].map((m) => m[1]!.trim());

  const costM = text.match(AIDER_COST_RE);
  const costUsd = costM ? Number(costM[2]) : undefined; // session cost

  const tokM = text.match(AIDER_TOKENS_RE);
  const usage = tokM
    ? { inputTokens: parseTokenCount(tokM[1]!), outputTokens: parseTokenCount(tokM[2]!) }
    : undefined;

  // Aider 0.86.1 can return exit 0 after argparse/configuration errors. Treat
  // its explicit CLI error marker and an empty transcript as terminal even
  // when the process code lies. A successful no-edit answer still has text.
  const cliError = AIDER_CLI_ERROR_RE.test(stderr);
  const noResponse = text.trim().length === 0;
  const ok = code === 0 && !cliError && !noResponse;
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
    ...(ok
      ? {}
      : {
          reason: cliError
            ? `aider rejected the command: ${stderr.trim().slice(0, 200)}`
            : code === 0 && noResponse
              ? `aider exited without a model response${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`
            : `aider exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
        }),
  };
}

export const aiderAdapter: CodingCliAdapter = {
  name: "aider",
  // --yes-always: no interactive confirms; --no-auto-commits: commits stay a
  // separate reviewed step via bench.git.commit/push (ADR-002 keeps git-write
  // outside the CLI). An explicit per-run model wins; DELEGATE_MODEL remains
  // the legacy fallback for bench.delegate deployments.
  // maxTurns is not applicable to aider's single-message mode — intentionally
  // ignored (the wall-clock budget in bench.delegate is the hard stop).
  // Repository-local Aider config/.env/history is disabled so project content
  // cannot override the server-selected model, credentials, or safety flags.
  buildCommand: (task, opts) => {
    const model = opts.model?.trim()
      ? shQuote(opts.model.trim())
      : '"${DELEGATE_MODEL:-ollama/llama3}"';
    const planning = opts.permissionMode === "plan";
    const chatMode = planning ? "ask" : "code";
    const isolatedEnv =
      `env -i PATH="$PATH" HOME="$aider_home" XDG_CONFIG_HOME="$aider_home/.config" ` +
      `LANG="\${LANG:-C.UTF-8}" TERM=dumb ` +
      `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 ` +
      `GIT_CONFIG_COUNT=2 ` +
      `GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null ` +
      `GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false ` +
      AIDER_ENV_ALLOWLIST.map((name) => `${name}="\${${name}-}"`).join(" ") +
      ` `;
    const invocation =
      `${isolatedEnv}aider --yes-always --no-auto-commits --no-dirty-commits --no-gitignore --no-pretty ` +
      `--config "$aider_config" --env-file /dev/null ` +
      `--model-settings-file "$aider_model_settings" ` +
      `--model-metadata-file "$aider_model_metadata" --aiderignore /dev/null ` +
      `--input-history-file /dev/null --chat-history-file /dev/null ` +
      `--llm-history-file /dev/null --no-restore-chat-history ` +
      `--verify-ssl --no-auto-lint --no-auto-test --no-watch-files ` +
      `--no-notifications --no-fancy-input ` +
      `--no-analytics --no-check-update --no-show-release-notes ` +
      `--no-detect-urls --disable-playwright --no-suggest-shell-commands ` +
      `${planning ? "--dry-run" : "--no-dry-run"} ` +
      `--model ${model} --chat-mode ${chatMode}` +
      (opts.effort ? ` --reasoning-effort ${shQuote(opts.effort)}` : "") +
      ` --message ${shQuote(task)}`;
    // /dev/null is not a valid YAML mapping to Aider 0.86.1. Generate valid,
    // process-private empty config/model files instead. This also prevents an
    // untrusted repository from supplying model API parameters via Aider's
    // default .aider.model.* files.
    return (
      `(umask 077; aider_tmp="/tmp/puppetmaster-aider-$$"; ` +
      `aider_home="$aider_tmp-home"; ` +
      `aider_config="$aider_tmp-config.yml"; ` +
      `aider_model_settings="$aider_tmp-model-settings.yml"; ` +
      `aider_model_metadata="$aider_tmp-model-metadata.json"; ` +
      `aider_stdout="$aider_tmp-stdout"; aider_stderr="$aider_tmp-stderr"; ` +
      `cleanup_aider_config() { rm -rf -- "$aider_home"; ` +
      `rm -f -- "$aider_config" "$aider_model_settings" "$aider_model_metadata" ` +
      `"$aider_stdout" "$aider_stderr"; }; ` +
      `trap cleanup_aider_config EXIT; trap 'exit 143' HUP INT TERM; ` +
      `mkdir -p -- "$aider_home/.config" || exit $?; ` +
      `printf '%s\\n' '{}' > "$aider_config" || exit $?; ` +
      `printf '%s\\n' '[]' > "$aider_model_settings" || exit $?; ` +
      `printf '%s\\n' '{}' > "$aider_model_metadata" || exit $?; ` +
      `${invocation} >"$aider_stdout" 2>"$aider_stderr"; aider_code=$?; ` +
      `cat "$aider_stdout"; cat "$aider_stderr" >&2; ` +
      `if [ "$aider_code" -eq 0 ] && ` +
      `{ ! grep -q '[^[:space:]]' "$aider_stdout" || grep -Eqi 'aider:[[:space:]]*error:' "$aider_stderr"; }; ` +
      `then aider_code=64; fi; exit "$aider_code")`
    );
  },
  parse: (stdout, exec) => parseAiderOutput(stdout, exec),
};

// --- Registry ----------------------------------------------------------------

export const CODING_CLI_ADAPTERS: Record<string, CodingCliAdapter> = {
  claude: claudeAdapter,
  aider: aiderAdapter,
};

/** The default adapter name when a caller/deployment doesn't specify one.
 *  Overridable via DELEGATE_CLI. Aider is currently supported here for parsing
 *  and read-only Plan; mutating ownership is supplied by the CLAUDE runtime. */
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
