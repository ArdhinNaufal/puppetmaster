/**
 * Tool layer (docs/ARCHITECTURE.md §3.4). In M1 this is a thin registry with a
 * handful of built-in tools so action nodes do real work; in M3 the same
 * `callTool(server, tool, args)` surface is backed by live MCP servers, and
 * both agents and workflow nodes share one catalog.
 */
export interface ToolContext {
  /** Immediate upstream node output, for tools that transform their input. */
  input: unknown;
}

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ToolRegistry {
  callTool(server: string, tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  list(): { server: string; tool: string }[];
}

export class BuiltinToolRegistry implements ToolRegistry {
  private tools = new Map<string, ToolFn>();

  constructor() {
    this.register("util", "echo", async (args, ctx) => args.value ?? ctx.input ?? null);
    this.register("util", "now", async () => new Date().toISOString());
    this.register("util", "merge", async (args, ctx) => ({
      ...(typeof ctx.input === "object" && ctx.input ? ctx.input : {}),
      ...args,
    }));
    this.register("math", "sum", async (args, ctx) => {
      const values = Array.isArray(args.values)
        ? (args.values as unknown[])
        : Array.isArray(ctx.input)
          ? (ctx.input as unknown[])
          : [];
      return values.reduce<number>((a, b) => a + Number(b), 0);
    });
    this.register("http", "get", async (args) => {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new Error(`http.get: invalid url ${url}`);
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
  }

  register(server: string, tool: string, fn: ToolFn): void {
    this.tools.set(`${server}.${tool}`, fn);
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    const fn = this.tools.get(`${server}.${tool}`);
    if (!fn) throw new Error(`tool ${server}.${tool} not found`);
    return fn(args, ctx);
  }

  list(): { server: string; tool: string }[] {
    return [...this.tools.keys()].map((k) => {
      const [server, tool] = k.split(".");
      return { server: server!, tool: tool! };
    });
  }
}
