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
  close: () => Promise<void>;
}

/**
 * Tool Layer (docs/ARCHITECTURE.md §3.4): connect to an MCP server over stdio
 * and merge its tools into the shared catalog, so agents and workflow action
 * nodes call MCP capabilities exactly like built-ins (`callTool(server, tool)`).
 */
export async function connectMcpServer(
  registry: BuiltinToolRegistry,
  config: McpServerConfig,
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
  for (const tool of tools) {
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
