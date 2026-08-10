#!/usr/bin/env node

// The repository uses an isolated pnpm layout, so this standalone fixture
// resolves through the package that declares these dependencies.
import { McpServer } from "../../packages/mcp-connectors/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../packages/mcp-connectors/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import { z } from "../../packages/mcp-connectors/node_modules/zod/index.js";

const server = new McpServer({ name: "science-mcp-verifier", version: "1.0.0" });

server.tool(
  "delay",
  "Return after a bounded delay.",
  { id: z.string(), delayMs: z.number().int().min(0).max(1_000) },
  async ({ id, delayMs }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      content: [{ type: "text", text: JSON.stringify({ id, completedAt: Date.now() }) }],
      structuredContent: { id, completedAt: Date.now() },
    };
  },
);

server.tool(
  "binary",
  "Deliberately violates the Puppetmaster command-plane contract.",
  {},
  async () => ({
    content: [{
      type: "image",
      data: Buffer.from("not-a-real-image").toString("base64"),
      mimeType: "image/png",
    }],
  }),
);

server.tool(
  "oversized",
  "Deliberately returns an oversized inline text value.",
  {},
  async () => ({
    content: [{ type: "text", text: "x".repeat(70 * 1024) }],
  }),
);

await server.connect(new StdioServerTransport());
