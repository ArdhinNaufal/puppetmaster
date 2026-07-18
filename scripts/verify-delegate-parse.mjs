#!/usr/bin/env node
// WP3b.4 keyless verification — the PARSING logic for bench.delegate's pluggable
// coding-CLI adapters (ADR-002/ADR-008). Needs no Docker and no key: it feeds
// canned CLI transcripts through each adapter's parser and asserts the parsed
// DelegateResult. The LIVE CLI calls (real models, real tokens) are verified
// separately on a Docker host by scripts/verify-delegate.mjs.
//
// Run:  pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-delegate-parse.mjs
// Exit 0 = all cases hold; 1 = a failure.

import {
  aiderAdapter,
  isolateAiderRepositoryCommand,
  parseClaudeStream,
  parseAiderOutput,
} from "../packages/kernel/dist/coding-cli.js";

let fails = 0;
const ok = (m) => console.log(`  ok — ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};
const eq = (actual, expected, label) =>
  actual === expected ? ok(`${label} = ${JSON.stringify(actual)}`) : bad(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// A representative successful transcript: system init, an assistant turn, then
// the terminating `result` event the CLI emits with usage + cost + answer text.
const successStream = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["Read", "Edit"] }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "adding the comment" }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 4210,
    num_turns: 3,
    result: "Added a comment to add.mjs.",
    session_id: "s1",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1200, output_tokens: 84 },
  }),
].join("\n");

console.log("== [claude] a successful session parses to ok with turns/usage/cost/result ==");
{
  const r = parseClaudeStream(successStream);
  eq(r.cli, "claude", "cli");
  eq(r.ok, true, "ok");
  eq(r.numTurns, 3, "numTurns");
  eq(r.result, "Added a comment to add.mjs.", "result");
  eq(r.costUsd, 0.0123, "costUsd");
  eq(r.usage?.input_tokens, 1200, "usage.input_tokens");
  eq(r.reason, undefined, "reason (none on success)");
}

console.log("== interleaved noise / partial lines are skipped, not fatal ==");
{
  const noisy = ["not json at all", "", "   ", "{partial", successStream].join("\n");
  const r = parseClaudeStream(noisy);
  eq(r.ok, true, "ok (survives noise)");
  eq(r.numTurns, 3, "numTurns (survives noise)");
}

console.log("== a max-turns error result parses to ok:false with the subtype reason ==");
{
  const errStream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s2" }),
    JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 12,
      result: "",
      session_id: "s2",
      total_cost_usd: 0.2,
      usage: { input_tokens: 9000, output_tokens: 500 },
    }),
  ].join("\n");
  const r = parseClaudeStream(errStream);
  eq(r.ok, false, "ok");
  eq(r.reason, "error_max_turns", "reason");
  eq(r.numTurns, 12, "numTurns (still reported on error)");
  eq(r.result, "error_max_turns", "result falls back to the subtype when text is empty");
}

console.log("== the LAST result event wins if more than one appears ==");
{
  const twoResults = [
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "first" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 5, result: "second" }),
  ].join("\n");
  const r = parseClaudeStream(twoResults);
  eq(r.result, "second", "result (last wins)");
  eq(r.numTurns, 5, "numTurns (last wins)");
}

console.log("== a transcript with NO result event is a failure, not a throw ==");
{
  const noResult = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
  ].join("\n");
  const r = parseClaudeStream(noResult);
  eq(r.ok, false, "ok");
  eq(r.numTurns, undefined, "numTurns (absent)");
  (r.reason ?? "").includes("no result event") ? ok(`reason = ${JSON.stringify(r.reason)}`) : bad(`reason: ${JSON.stringify(r.reason)}`);
}

console.log("== empty / whitespace input is a clean failure ==");
{
  for (const input of ["", "   \n  \n", null, undefined]) {
    const r = parseClaudeStream(input);
    r.ok === false && r.result === "" ? ok(`empty(${JSON.stringify(input)}) → ok:false`) : bad(`empty(${JSON.stringify(input)}) not handled: ${JSON.stringify(r)}`);
  }
}

// --- aider adapter (provider-agnostic; human output, not JSON) --------------

// A representative successful aider --message run: commentary then the footer
// lines aider prints (tokens/cost + applied-edit lines) that the parser reads.
const aiderSuccess = [
  "Aider v0.86.1",
  "Model: openai/gpt-4o with diff edit format",
  "Git repo: .git with 1 files",
  "",
  "I'll add a JSDoc comment above the add function.",
  "",
  "Tokens: 3.2k sent, 412 received. Cost: $0.01 message, $0.04 session.",
  "Applied edit to add.mjs",
].join("\n");

console.log("== [aider] a clean exit parses to ok with cost/usage/filesChanged ==");
{
  const r = parseAiderOutput(aiderSuccess, { code: 0, stderr: "" });
  eq(r.cli, "aider", "cli");
  eq(r.ok, true, "ok");
  eq(r.costUsd, 0.04, "costUsd (session)");
  eq(r.usage?.inputTokens, 3200, "usage.inputTokens (3.2k → 3200)");
  eq(r.usage?.outputTokens, 412, "usage.outputTokens");
  eq(r.numTurns, undefined, "numTurns (aider has none — not faked)");
  Array.isArray(r.filesChanged) && r.filesChanged[0] === "add.mjs"
    ? ok(`filesChanged = ${JSON.stringify(r.filesChanged)}`)
    : bad(`filesChanged: ${JSON.stringify(r.filesChanged)}`);
  (r.result ?? "").includes("add.mjs") ? ok(`result = ${JSON.stringify(r.result)}`) : bad(`result: ${JSON.stringify(r.result)}`);
}

console.log("== [aider] multiple applied edits are all captured ==");
{
  const multi = ["done.", "Applied edit to a.js", "Applied edit to lib/b.js"].join("\n");
  const r = parseAiderOutput(multi, { code: 0, stderr: "" });
  r.filesChanged?.length === 2 && r.filesChanged[1] === "lib/b.js"
    ? ok(`filesChanged = ${JSON.stringify(r.filesChanged)}`)
    : bad(`filesChanged: ${JSON.stringify(r.filesChanged)}`);
}

console.log("== [aider] a non-zero exit is ok:false with the exit code + stderr in reason ==");
{
  const r = parseAiderOutput("", { code: 1, stderr: "litellm.AuthenticationError: no key" });
  eq(r.ok, false, "ok");
  (r.reason ?? "").includes("exited 1") && (r.reason ?? "").includes("AuthenticationError")
    ? ok(`reason = ${JSON.stringify(r.reason)}`)
    : bad(`reason: ${JSON.stringify(r.reason)}`);
}

console.log("== [aider] a clean exit with no footer still succeeds (edits not always reported) ==");
{
  const r = parseAiderOutput("nothing to change.", { code: 0, stderr: "" });
  eq(r.ok, true, "ok");
  eq(r.costUsd, undefined, "costUsd (none printed)");
  eq(r.filesChanged, undefined, "filesChanged (none)");
}

console.log("== [aider] exit zero without a model response is still a failure ==");
{
  const r = parseAiderOutput("", { code: 0, stderr: "Warning: Input is not a terminal" });
  eq(r.ok, false, "ok");
  (r.reason ?? "").includes("without a model response")
    ? ok(`reason = ${JSON.stringify(r.reason)}`)
    : bad(`reason: ${JSON.stringify(r.reason)}`);
}

console.log("== [aider] an explicit CLI error cannot succeed even when Aider exits zero ==");
{
  const r = parseAiderOutput("", {
    code: 0,
    stderr: "usage: aider [-h]\naider: error: invalid configuration",
  });
  eq(r.ok, false, "ok");
  (r.reason ?? "").includes("rejected the command")
    ? ok(`reason = ${JSON.stringify(r.reason)}`)
    : bad(`reason: ${JSON.stringify(r.reason)}`);
}

console.log("== [aider] command assembly selects OpenAI model, plan mode, and effort ==");
{
  const command = aiderAdapter.buildCommand("Inspect only", {
    maxTurns: 12,
    model: "openai/gpt-5",
    permissionMode: "plan",
    effort: "high",
  });
  command.includes("--model 'openai/gpt-5'")
    ? ok("explicit OpenAI model is safely quoted")
    : bad(`explicit model missing: ${command}`);
  command.includes("--chat-mode ask")
    ? ok("plan permission maps to ask chat mode")
    : bad(`plan chat mode missing: ${command}`);
  command.includes("--reasoning-effort 'high'")
    ? ok("reasoning effort is forwarded")
    : bad(`reasoning effort missing: ${command}`);
  for (const flag of [
    "--dry-run",
    '--config "$aider_config"',
    "--env-file /dev/null",
    '--model-settings-file "$aider_model_settings"',
    '--model-metadata-file "$aider_model_metadata"',
    "--aiderignore /dev/null",
    "--no-gitignore",
    "--no-dirty-commits",
    "--no-auto-lint",
    "--no-auto-test",
    "--no-watch-files",
    "--no-suggest-shell-commands",
    "--no-analytics",
    "--no-check-update",
    "env -i",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_KEY_0=core.hooksPath",
    "GIT_CONFIG_VALUE_0=/dev/null",
    "GIT_CONFIG_KEY_1=core.fsmonitor",
  ]) {
    command.includes(flag)
      ? ok(`plan command includes ${flag}`)
      : bad(`plan hardening flag missing (${flag}): ${command}`);
  }
  command.includes("printf '%s\\n' '{}' > \"$aider_config\"")
    ? ok("plan command creates a process-private empty YAML mapping")
    : bad(`isolated config initialization missing: ${command}`);
  command.includes("printf '%s\\n' '[]' > \"$aider_model_settings\"") &&
  command.includes("printf '%s\\n' '{}' > \"$aider_model_metadata\"")
    ? ok("repository model settings and metadata are replaced with private empty files")
    : bad(`isolated model metadata initialization missing: ${command}`);
  command.includes('aider_stdout="$aider_tmp-stdout"') &&
  command.includes("grep -Eqi 'aider:[[:space:]]*error:'")
    ? ok("exit-zero CLI errors and empty responses are converted to shell failure")
    : bad(`semantic exit-code guard missing: ${command}`);
}

console.log("== [aider] non-plan command uses code mode and environment model fallback ==");
{
  const command = aiderAdapter.buildCommand("Implement it", {
    maxTurns: 12,
    permissionMode: "acceptEdits",
  });
  command.includes('--model "${DELEGATE_MODEL:-ollama/llama3}"')
    ? ok("absent model falls back to DELEGATE_MODEL")
    : bad(`environment model fallback missing: ${command}`);
  command.includes("--chat-mode code")
    ? ok("non-plan permission maps to code chat mode")
    : bad(`code chat mode missing: ${command}`);
  command.includes("--no-dry-run")
    ? ok("approved code mode explicitly disables dry-run")
    : bad(`code-mode dry-run setting missing: ${command}`);
  !command.includes("--reasoning-effort")
    ? ok("unset effort does not emit a reasoning flag")
    : bad(`unexpected reasoning effort: ${command}`);
}

console.log("== [aider] disposable repository wrapper applies only approved Execute scratch ==");
{
  const inner = aiderAdapter.buildCommand("Inspect", { maxTurns: 1, permissionMode: "plan" });
  const plan = isolateAiderRepositoryCommand(inner, "plan-id", "plan");
  const execute = isolateAiderRepositoryCommand(inner, "execute-id", "execute");
  !plan.includes("puppetmaster-sync apply") && execute.includes("puppetmaster-sync apply")
    ? ok("Plan discards scratch while Execute stages a guarded scratch apply")
    : bad("Aider repository wrapper mode boundary is missing");
  execute.includes("puppetmaster-sync recover /workbench") && execute.includes("rm -rf -- '.env'")
    ? ok("wrapper recovers journals and removes repository control files")
    : bad("Aider repository cleanup/recovery guard is missing");
  execute.includes(" - 'scratch-executeid'") && execute.includes("recover /workbench 'executeid' 'scratch-executeid'")
    ? ok("disposable apply/recovery uses an exact token and per-turn journal key")
    : bad(`Aider scratch journal authentication is missing: ${execute}`);
}

console.log("== [aider] model and prompt shell metacharacters remain quoted data ==");
{
  const command = aiderAdapter.buildCommand("fix 'quoted'; touch /tmp/prompt-pwn", {
    maxTurns: 12,
    model: "openai/gpt-5'; touch /tmp/model-pwn; #",
    permissionMode: "acceptEdits",
  });
  command.includes(String.raw`--model 'openai/gpt-5'\''; touch /tmp/model-pwn; #'`)
    ? ok("model apostrophe and shell operators are POSIX quoted")
    : bad(`model was not safely quoted: ${command}`);
  command.includes(String.raw`--message 'fix '\''quoted'\''; touch /tmp/prompt-pwn'`)
    ? ok("prompt apostrophe and shell operators are POSIX quoted")
    : bad(`prompt was not safely quoted: ${command}`);
}

if (fails > 0) {
  console.error(`\nDELEGATE PARSE: FAIL (${fails})`);
  process.exit(1);
}
console.log(
  "\nDELEGATE PARSE PASS: claude parsing + aider parsing/command assembly (model/mode/effort/quoting)",
);
