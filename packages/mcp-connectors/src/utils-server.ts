#!/usr/bin/env node
/**
 * Bundled first-party MCP connector (docs/ARCHITECTURE.md §3.4): a small
 * "utils" server spoken over stdio. Every Puppetmaster integration is an MCP
 * server — this one doubles as the reference implementation and the e2e
 * fixture for the MCP client in the kernel.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "puppetmaster-utils", version: "0.0.1" });

server.tool(
  "upper",
  "Uppercase a string.",
  { text: z.string().describe("Text to uppercase") },
  async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }),
);

server.tool(
  "word_count",
  "Count the words in a string.",
  { text: z.string() },
  async ({ text }) => ({
    content: [
      { type: "text", text: JSON.stringify({ words: text.trim().split(/\s+/).filter(Boolean).length }) },
    ],
  }),
);

server.tool(
  "uuid",
  "Generate a random UUID.",
  {},
  async () => ({ content: [{ type: "text", text: crypto.randomUUID() }] }),
);

await server.connect(new StdioServerTransport());
