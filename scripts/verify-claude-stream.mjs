#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  ClaudeJsonLineDecoder,
  MAX_CLAUDE_EVENT_LINE_CHARS,
  normalizeClaudeResult,
} from "../packages/kernel/dist/claude-stream.js";
import { buildClaudeCommand } from "../packages/kernel/dist/coding-cli.js";

const terminal = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Implemented and verified.",
  duration_ms: 1234,
  duration_api_ms: 1000,
  num_turns: 3,
  total_cost_usd: 0.012,
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    cache_creation_input_tokens: 8,
    cache_read_input_tokens: 13,
  },
};

const decoder = new ClaudeJsonLineDecoder();
const encoded = `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } })}\n${JSON.stringify(terminal)}\n`;
const split = Math.floor(encoded.length / 2);
const lines = [...decoder.push(encoded.slice(0, split)), ...decoder.push(encoded.slice(split)), ...decoder.finish()];
assert.equal(lines.length, 2, "chunk boundaries must not create or drop lines");
assert.equal(lines[0].text, "hel");
assert.match(lines[0].eventType, /text_delta/);
const result = normalizeClaudeResult(lines[1].event);
assert.equal(result?.result, terminal.result);
assert.equal(result?.usage?.cacheReadInputTokens, 13);
assert.equal(result?.totalCostUsd, 0.012);

const noisy = new ClaudeJsonLineDecoder().push("not-json\n");
assert.equal(noisy[0]?.eventType, "noise");
assert.equal(noisy[0]?.raw, "not-json");

const oversized = new ClaudeJsonLineDecoder();
const first = oversized.push("x".repeat(MAX_CLAUDE_EVENT_LINE_CHARS + 5));
assert.equal(first[0]?.eventType, "oversize");
assert.ok(first[0].raw.length <= MAX_CLAUDE_EVENT_LINE_CHARS + 40);
const resumed = oversized.push(`discarded tail\n${JSON.stringify(terminal)}\n`);
assert.equal(resumed.length, 1, "decoder must resume at the next line after an oversize record");
assert.equal(normalizeClaudeResult(resumed[0].event)?.result, terminal.result);

const command = buildClaudeCommand("fix 'quoted' input", {
  model: "sonnet",
  effort: "high",
  permissionMode: "plan",
  maxTurns: 12,
  maxBudgetUsd: 3.5,
  sessionId: "session-1",
  resume: true,
  configDir: "/home/bench/.puppetmaster/claude-config",
  includePartialMessages: true,
  includeHookEvents: true,
});
for (const flag of [
  "--output-format stream-json",
  "--permission-mode 'plan'",
  "--max-turns 12",
  "--max-budget-usd 3.5",
  "--resume 'session-1'",
  "--include-partial-messages",
  "--include-hook-events",
  "--setting-sources ''",
  "--strict-mcp-config",
  `--settings '{"disableAllHooks":true,"hooks":{},"enabledPlugins":{}}'`,
  `--mcp-config '{"mcpServers":{}}'`,
]) {
  assert.ok(command.includes(flag), `command must include ${flag}`);
}
assert.ok(command.includes(String.raw`'fix '\''quoted'\'' input'`), "single quotes in prompts must be shell escaped");

console.log("CLAUDE STREAM PASS: chunking, noise, oversize recovery, terminal normalization, and safe CLI flags");
