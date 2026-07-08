#!/usr/bin/env node
// WP3b.4 keyless verification — the stream-json PARSING logic for bench.delegate
// (ADR-002). This half needs no Docker and no ANTHROPIC_API_KEY: it feeds canned
// `claude -p … --output-format stream-json` transcripts through parseDelegateStream
// and asserts the parsed DelegateResult. The LIVE CLI call (real model, real
// tokens) is verified separately on a Docker host by scripts/verify-delegate.mjs.
//
// Run:  pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-delegate-parse.mjs
// Exit 0 = all cases hold; 1 = a failure.

import { parseDelegateStream } from "../packages/kernel/dist/bench-tools.js";

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

console.log("== a successful session parses to ok with turns/usage/cost/result ==");
{
  const r = parseDelegateStream(successStream);
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
  const r = parseDelegateStream(noisy);
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
  const r = parseDelegateStream(errStream);
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
  const r = parseDelegateStream(twoResults);
  eq(r.result, "second", "result (last wins)");
  eq(r.numTurns, 5, "numTurns (last wins)");
}

console.log("== a transcript with NO result event is a failure, not a throw ==");
{
  const noResult = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
  ].join("\n");
  const r = parseDelegateStream(noResult);
  eq(r.ok, false, "ok");
  eq(r.numTurns, undefined, "numTurns (absent)");
  (r.reason ?? "").includes("no result event") ? ok(`reason = ${JSON.stringify(r.reason)}`) : bad(`reason: ${JSON.stringify(r.reason)}`);
}

console.log("== empty / whitespace input is a clean failure ==");
{
  for (const input of ["", "   \n  \n", null, undefined]) {
    const r = parseDelegateStream(input);
    r.ok === false && r.result === "" ? ok(`empty(${JSON.stringify(input)}) → ok:false`) : bad(`empty(${JSON.stringify(input)}) not handled: ${JSON.stringify(r)}`);
  }
}

if (fails > 0) {
  console.error(`\nDELEGATE PARSE: FAIL (${fails})`);
  process.exit(1);
}
console.log("\nDELEGATE PARSE PASS: success/noise-skip/max-turns-error/last-wins/no-result/empty");
