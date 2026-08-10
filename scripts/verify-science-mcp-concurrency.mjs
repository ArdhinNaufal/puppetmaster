#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { BuiltinToolRegistry } from "../packages/kernel/dist/tools.js";
import { connectMcpServer } from "../packages/kernel/dist/mcp.js";

const registry = new BuiltinToolRegistry();
registry.register(
  "local-fixture",
  "binary",
  "Return forbidden inline bytes.",
  "read_auto",
  { type: "object", properties: {} },
  async () => ({ payload: "data:application/octet-stream;base64,AA==" }),
);
registry.register(
  "local-fixture",
  "oversized",
  "Return a forbidden oversized value.",
  "read_auto",
  { type: "object", properties: {} },
  async () => ({ payload: "x".repeat(70 * 1024) }),
);
await assert.rejects(
  registry.callTool("local-fixture", "binary", {}, { input: null }),
  /artifact.*reference/i,
);
await assert.rejects(
  registry.callTool("local-fixture", "oversized", {}, { input: null }),
  /exceeded.*artifact reference/i,
);
const fixture = path.resolve("scripts/fixtures/science-mcp-server.mjs");
const connection = await connectMcpServer(registry, {
  name: "science-fixture",
  command: process.execPath,
  args: [fixture],
  tier: "read_auto",
  toolTiers: { binary: "write_approved", oversized: "destructive_confirmed" },
});

try {
  assert.equal(registry.info("science-fixture", "delay")?.tier, "read_auto");
  assert.equal(registry.info("science-fixture", "binary")?.tier, "write_approved");
  assert.equal(registry.info("science-fixture", "oversized")?.tier, "destructive_confirmed");

  const startedAt = Date.now();
  const first = registry.callTool(
    "science-fixture",
    "delay",
    { id: "first", delayMs: 150 },
    { input: null, missionId: "00000000-0000-4000-8000-000000000001" },
  );
  const second = registry.callTool(
    "science-fixture",
    "delay",
    { id: "second", delayMs: 0 },
    { input: null, missionId: "00000000-0000-4000-8000-000000000002" },
  );
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, "first");
  assert.equal(b.id, "second");
  assert.ok(
    b.completedAt >= a.completedAt && Date.now() - startedAt >= 140,
    "MCP calls on one connection must execute in one attribution-safe lane",
  );

  await assert.rejects(
    registry.callTool("science-fixture", "binary", {}, { input: null, missionId: "m-binary" }),
    /artifact.*reference/i,
  );
  await assert.rejects(
    registry.callTool("science-fixture", "oversized", {}, { input: null, missionId: "m-large" }),
    /exceeded.*artifact reference/i,
  );
} finally {
  await connection.close();
}

console.log("SCIENCE MCP PASS: serialized attribution, per-tool tiers, bounded reference-only results");
