import { createHash } from "node:crypto";
import type { AutonomyTier } from "@puppetmaster/shared";
import type { BuiltinToolRegistry } from "./tools.js";

export interface McpServerConfig {
  /** Catalog namespace — tools appear as `<name>.<tool>`. */
  name: string;
  /** "stdio" (default when `command` is set) or "http" (streamable HTTP). */
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable-HTTP endpoint (Stage 7). */
  url?: string;
  /** Extra HTTP headers, e.g. Authorization — values may come from the vault. */
  headers?: Record<string, string>;
  /** Autonomy tier applied to every tool from this server (default read_auto). */
  tier?: AutonomyTier;
}

export interface McpConnection {
  name: string;
  transport: "stdio" | "http";
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

/** Elicitation → approvals bridge (Stage 7): a server-initiated question is
 *  routed to the approval inbox of the mission whose tool call triggered it.
 *  Resolves true (accept) / false (decline). */
export type ElicitationBridge = (missionId: string, message: string) => Promise<boolean>;

/** Stable hash over the parts of a tool definition a poisoning attack would
 *  rewrite: its description and input schema. */
export function hashToolDefinition(tool: { description?: string; inputSchema?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ d: tool.description ?? "", s: tool.inputSchema ?? null }))
    .digest("hex");
}

/**
 * Tool Layer (docs/ARCHITECTURE.md §3.4): connect to an MCP server — stdio or
 * streamable HTTP (Stage 7) — and merge its tools into the shared catalog, so
 * agents and workflow action nodes call MCP capabilities exactly like
 * built-ins (`callTool(server, tool)`).
 *
 * Stage 1 hardening: tool-description hashes are pinned; drift is surfaced.
 * Stage 7: server *elicitation* requests pause behind the approval inbox via
 * the host-provided bridge — accept answers with an empty payload, decline
 * refuses; requests arriving outside any mission context are declined.
 */
export async function connectMcpServer(
  registry: BuiltinToolRegistry,
  config: McpServerConfig,
  opts?: { checkPin?: ToolPinChecker; elicitation?: ElicitationBridge },
): Promise<McpConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const transportKind: "stdio" | "http" =
    config.transport ?? (config.url ? "http" : "stdio");

  const client = new Client(
    { name: "puppetmaster-kernel", version: "0.0.1" },
    { capabilities: { elicitation: {} } },
  );

  // The mission whose tool call is currently executing on this connection —
  // elicitation requests are attributed to it (tool calls on one MCP client
  // are serialized through the registry's sequential agent/executor loops).
  const current: { missionId: string | null } = { missionId: null };

  if (opts?.elicitation) {
    try {
      const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const missionId = current.missionId;
        if (!missionId) return { action: "decline" as const };
        const message = String(req.params?.message ?? "The MCP server requests confirmation.");
        const accepted = await opts.elicitation!(missionId, `[${config.name}] ${message}`);
        return accepted ? { action: "accept" as const, content: {} } : { action: "decline" as const };
      });
    } catch {
      /* SDK without elicitation support — feature simply off */
    }
  }

  if (transportKind === "http") {
    if (!config.url) throw new Error(`mcp server ${config.name}: http transport requires url`);
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    await client.connect(transport);
  } else {
    if (!config.command) throw new Error(`mcp server ${config.name}: stdio transport requires command`);
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    });
    await client.connect(transport);
  }

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
      async (args, ctx) => {
        current.missionId = ctx.missionId ?? null;
        try {
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
        } finally {
          current.missionId = null;
        }
      },
    );
  }

  return {
    name: config.name,
    transport: transportKind,
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
