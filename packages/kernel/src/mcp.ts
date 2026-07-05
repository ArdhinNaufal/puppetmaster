import { createHash } from "node:crypto";
import type { AutonomyTier } from "@puppetmaster/shared";
import type { BuiltinToolRegistry } from "./tools.js";

export interface McpServerConfig {
  /** Catalog namespace — tools appear as `<name>.<tool>`. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Autonomy tier applied to every tool from this server (default read_auto). */
  tier?: AutonomyTier;
}

export interface McpConnection {
  name: string;
  toolCount: number;
  /** Tools whose description/schema hash changed since they were pinned. */
  driftedTools: string[];
  close: () => Promise<void>;
}

/** Host-provided pin store (Stage 1, G1): the kernel hashes each tool's
 *  description+schema and the host decides where pins live and how drift is
 *  surfaced (audit log). Returned "drifted" means the pin existed and changed. */
export type ToolPinChecker = (
  server: string,
  tool: string,
  hash: string,
) => Promise<"new" | "unchanged" | "drifted">;

/** Stable hash over the parts of a tool definition a poisoning attack would
 *  rewrite: its description and input schema. */
export function hashToolDefinition(tool: { description?: string; inputSchema?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ d: tool.description ?? "", s: tool.inputSchema ?? null }))
    .digest("hex");
}

/**
 * Tool Layer (docs/ARCHITECTURE.md §3.4): connect to an MCP server over stdio
 * and merge its tools into the shared catalog, so agents and workflow action
 * nodes call MCP capabilities exactly like built-ins (`callTool(server, tool)`).
 *
 * Stage 1 hardening: each tool's description hash is pinned at first connect;
 * a changed hash on reconnect (tool poisoning / rug-pull canary) is reported
 * through `checkPin` and in the returned `driftedTools`.
 */
export async function connectMcpServer(
  registry: BuiltinToolRegistry,
  config: McpServerConfig,
  opts?: { checkPin?: ToolPinChecker },
): Promise<McpConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const client = new Client({ name: "puppetmaster-kernel", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const driftedTools: string[] = [];
  for (const tool of tools) {
    if (opts?.checkPin) {
      const hash = hashToolDefinition(tool);
      try {
        const pin = await opts.checkPin(config.name, tool.name, hash);
        if (pin === "drifted") driftedTools.push(tool.name);
      } catch {
        /* pinning is advisory — never block the connect */
      }
    }
    registry.register(
      config.name,
      tool.name,
      tool.description ?? `MCP tool ${tool.name} from ${config.name}`,
      config.tier ?? "read_auto",
      (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      async (args) => {
        const result = await client.callTool({ name: tool.name, arguments: args });
        const blocks = Array.isArray(result.content) ? result.content : [];
        const text = blocks
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n");
        if (result.isError) throw new Error(text || `MCP tool ${tool.name} failed`);
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    );
  }

  return {
    name: config.name,
    toolCount: tools.length,
    driftedTools,
    close: () => client.close(),
  };
}

/** Parse the MCP_SERVERS env var (JSON array of McpServerConfig). */
export function parseMcpServersEnv(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    console.error("[mcp] MCP_SERVERS is not valid JSON; ignoring");
    return [];
  }
}
