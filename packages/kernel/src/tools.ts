/**
 * Tool layer (docs/ARCHITECTURE.md §3.4). In M1 this is a thin registry with a
 * handful of built-in tools so action nodes do real work; in M3 the same
 * `callTool(server, tool, args)` surface is backed by live MCP servers, and
 * both agents and workflow nodes share one catalog.
 */
import type { AutonomyTier } from "@puppetmaster/shared";

export interface ToolContext {
  /** Immediate upstream node output, for tools that transform their input. */
  input: unknown;
  /** Set when the caller is an agent tick rather than a workflow node. */
  agentId?: string;
  /** The calling mission — child missions launched by bridge tools nest under it. */
  missionId?: string;
}

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ToolInfo {
  server: string;
  tool: string;
  description: string;
  /** Autonomy tier (PRD §4): read = auto, write = approved, destructive = confirmed. */
  tier: AutonomyTier;
  inputSchema: Record<string, unknown>;
}

export interface ToolRegistry {
  callTool(server: string, tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  list(): ToolInfo[];
  info(server: string, tool: string): ToolInfo | null;
}

interface Registered extends ToolInfo {
  fn: ToolFn;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

/**
 * Egress allowlist (Stage 1, G1): with HTTP_ALLOWED_HOSTS set (comma-separated
 * hostnames; subdomains of an entry match), http.get refuses any other host —
 * an injected instruction can't exfiltrate context to an attacker's server.
 * Unset = unrestricted, preserving the open default for local dev.
 */
export function assertEgressAllowed(url: string, allowedEnv = process.env.HTTP_ALLOWED_HOSTS): void {
  const raw = allowedEnv?.trim();
  if (!raw) return;
  const allowed = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = new URL(url).hostname.toLowerCase();
  const ok = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!ok) throw new Error(`http.get: host "${host}" is not in HTTP_ALLOWED_HOSTS`);
}

export class BuiltinToolRegistry implements ToolRegistry {
  private tools = new Map<string, Registered>();

  constructor() {
    this.register("util", "echo", "Echo back a value.", "read_auto",
      obj({ value: { type: "string", description: "Value to echo" } }),
      async (args, ctx) => args.value ?? ctx.input ?? null);
    this.register("util", "now", "Current server time (ISO-8601).", "read_auto",
      obj({}),
      async () => new Date().toISOString());
    this.register("util", "merge", "Merge the given args over the input object.", "read_auto",
      obj({}),
      async (args, ctx) => ({
        ...(typeof ctx.input === "object" && ctx.input ? ctx.input : {}),
        ...args,
      }));
    this.register("math", "sum", "Sum a list of numbers.", "read_auto",
      obj({ values: { type: "array", items: { type: "number" } } }),
      async (args, ctx) => {
        const values = Array.isArray(args.values)
          ? (args.values as unknown[])
          : Array.isArray(ctx.input)
            ? (ctx.input as unknown[])
            : [];
        return values.reduce<number>((a, b) => a + Number(b), 0);
      });
    this.register("http", "get", "HTTP GET a URL and return status + parsed body.", "read_auto",
      obj({ url: { type: "string" } }, ["url"]),
      async (args) => {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//.test(url)) throw new Error(`http.get: invalid url ${url}`);
        assertEgressAllowed(url);
        const res = await fetch(url, { method: "GET" });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* leave as text */
        }
        return { status: res.status, ok: res.ok, body };
      });
    // Write-tier demo connector: exercises the approval gate until real
    // MCP connectors land in M3.
    this.register("email", "send", "Send an email (demo connector).", "write_approved",
      obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, ["to"]),
      async (args) => ({ sent: true, to: args.to, subject: args.subject ?? "" }));
  }

  register(
    server: string,
    tool: string,
    description: string,
    tier: AutonomyTier,
    inputSchema: Record<string, unknown>,
    fn: ToolFn,
  ): void {
    this.tools.set(`${server}.${tool}`, { server, tool, description, tier, inputSchema, fn });
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    const entry = this.tools.get(`${server}.${tool}`);
    if (!entry) throw new Error(`tool ${server}.${tool} not found`);
    return entry.fn(args, ctx);
  }

  info(server: string, tool: string): ToolInfo | null {
    const entry = this.tools.get(`${server}.${tool}`);
    if (!entry) return null;
    const { fn: _fn, ...info } = entry;
    return info;
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map(({ fn: _fn, ...info }) => info);
  }
}
