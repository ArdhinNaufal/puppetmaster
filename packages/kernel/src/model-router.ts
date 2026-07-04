/**
 * Model Router (docs/ARCHITECTURE.md §3.5): one abstraction over Anthropic,
 * OpenAI-compatible runtimes (OpenAI, Ollama, vLLM), and a scripted mock for
 * keyless dev/e2e. Providers are selected by model-string prefix:
 *
 *   "claude-*"            -> anthropic
 *   "openai/<model>"      -> openai-compat (OPENAI_BASE_URL / OPENAI_API_KEY)
 *   "ollama/<model>"      -> openai-compat (OLLAMA_BASE_URL, default :11434)
 *   "mock*"               -> mock
 */

export interface ChatToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  /** Plain text for user/assistant; tool messages carry the result payload. */
  text?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolResults?: { toolCallId: string; result: unknown; isError?: boolean }[];
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  maxTokens?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: ChatUsage;
}

export interface ModelProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** Anthropic provider on the official SDK. */
export class AnthropicProvider implements ModelProvider {
  constructor(private readonly apiKey?: string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : new Anthropic();

    const messages: import("@anthropic-ai/sdk").Anthropic.MessageParam[] = [];
    for (const m of req.messages) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.text ?? "" });
      } else if (m.role === "assistant") {
        const content: import("@anthropic-ai/sdk").Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const tc of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        }
        if (content.length > 0) messages.push({ role: "assistant", content });
      } else {
        messages.push({
          role: "user",
          content: (m.toolResults ?? []).map((tr) => ({
            type: "tool_result" as const,
            tool_use_id: tr.toolCallId,
            content: JSON.stringify(tr.result ?? null),
            is_error: tr.isError ?? false,
          })),
        });
      }
    }

    const response = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages,
      tools: (req.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as import("@anthropic-ai/sdk").Anthropic.Tool.InputSchema,
      })),
    });

    const text = response.content
      .filter((b): b is import("@anthropic-ai/sdk").Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = response.content
      .filter((b): b is import("@anthropic-ai/sdk").Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));

    const stopReason: ChatResponse["stopReason"] =
      response.stop_reason === "tool_use"
        ? "tool_use"
        : response.stop_reason === "end_turn"
          ? "end_turn"
          : response.stop_reason === "max_tokens"
            ? "max_tokens"
            : response.stop_reason === "refusal"
              ? "refusal"
              : "other";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

/** OpenAI-compatible chat/completions — covers OpenAI, Ollama, and vLLM. */
export class OpenAICompatProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model.includes("/") ? req.model.split("/").slice(1).join("/") : req.model;
    const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.text ?? "" });
      } else if (m.role === "assistant") {
        messages.push({
          role: "assistant",
          content: m.text ?? null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        });
      } else {
        for (const tr of m.toolResults ?? []) {
          messages.push({
            role: "tool",
            tool_call_id: tr.toolCallId,
            content: JSON.stringify(tr.result ?? null),
          });
        }
      }
    }

    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 4096,
        messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`model provider error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name ?? "",
      args: safeParse(tc.function?.arguments),
    }));
    return {
      text: choice?.message?.content ?? "",
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Scripted mock provider for keyless dev and e2e. Behaviour is driven by the
 * user message so tests can exercise the full tick loop:
 *   "use <server.tool> <json-args>"  -> emits that tool call, then summarizes
 *   "remember: <text>"               -> calls memory.save, then confirms
 *   anything else                    -> echoes a canned assistant reply
 */
export class MockProvider implements ModelProvider {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const lastMsg = req.messages[req.messages.length - 1];
    const usage = { inputTokens: 10, outputTokens: 10 };

    // If the last message is a tool result, finish the loop with a summary.
    if (lastMsg?.role === "tool") {
      const results = (lastMsg.toolResults ?? []).map((r) => JSON.stringify(r.result));
      return {
        text: `Done. Tool returned: ${results.join(", ")}`,
        toolCalls: [],
        stopReason: "end_turn",
        usage,
      };
    }

    const text = lastUser?.text ?? "";
    const useMatch = text.match(/^use\s+([\w.]+)\s*(\{.*\})?$/s);
    if (useMatch) {
      const [server, tool] = useMatch[1]!.split(".");
      return {
        text: "",
        toolCalls: [
          {
            id: `call_${Date.now()}`,
            name: `${server}__${tool}`,
            args: useMatch[2] ? safeParse(useMatch[2]) : {},
          },
        ],
        stopReason: "tool_use",
        usage,
      };
    }
    const rememberMatch = text.match(/^remember:\s*(.+)$/s);
    if (rememberMatch) {
      return {
        text: "",
        toolCalls: [
          {
            id: `call_${Date.now()}`,
            name: "memory__save",
            args: { content: rememberMatch[1]!.trim() },
          },
        ],
        stopReason: "tool_use",
        usage,
      };
    }
    return {
      text: `[mock:${req.model}] I received: "${text}". Persona says: ${req.system.slice(0, 60)}…`,
      toolCalls: [],
      stopReason: "end_turn",
      usage,
    };
  }
}

export interface RouterConfig {
  anthropicApiKey?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  ollamaBaseUrl?: string;
}

/** Routes by model string and accumulates per-call token usage. */
export class ModelRouter {
  private readonly config: RouterConfig;
  totalUsage: ChatUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: RouterConfig = {}) {
    this.config = config;
  }

  providerFor(model: string): ModelProvider {
    if (model.startsWith("mock")) return new MockProvider();
    if (model.startsWith("claude")) return new AnthropicProvider(this.config.anthropicApiKey);
    if (model.startsWith("ollama/")) {
      return new OpenAICompatProvider(this.config.ollamaBaseUrl ?? "http://127.0.0.1:11434");
    }
    if (model.startsWith("openai/")) {
      return new OpenAICompatProvider(
        this.config.openaiBaseUrl ?? "https://api.openai.com",
        this.config.openaiApiKey,
      );
    }
    // Unknown prefix: assume an OpenAI-compatible local runtime (vLLM etc.).
    if (this.config.openaiBaseUrl) {
      return new OpenAICompatProvider(this.config.openaiBaseUrl, this.config.openaiApiKey);
    }
    return new MockProvider();
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.providerFor(req.model).chat(req);
    this.totalUsage.inputTokens += res.usage.inputTokens;
    this.totalUsage.outputTokens += res.usage.outputTokens;
    return res;
  }
}
