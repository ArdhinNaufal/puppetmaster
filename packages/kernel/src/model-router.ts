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
  /** Which candidate of a fallback chain actually served the call (Stage 8). */
  servedBy?: string;
}

export type StreamDelta = (textDelta: string) => void;

export interface ModelProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Optional true token streaming; providers without it fall back to chat(). */
  chatStream?(req: ChatRequest, onDelta: StreamDelta): Promise<ChatResponse>;
}

/** Anthropic provider on the official SDK. */
export class AnthropicProvider implements ModelProvider {
  constructor(private readonly apiKey?: string) {}

  /** True streaming via the SDK's message stream (Stage 6). */
  async chatStream(req: ChatRequest, onDelta: StreamDelta): Promise<ChatResponse> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : new Anthropic();
    const stream = client.messages.stream(await this.buildParams(req));
    stream.on("text", (delta) => onDelta(delta));
    const response = await stream.finalMessage();
    return this.toChatResponse(response);
  }

  private async buildParams(
    req: ChatRequest,
  ): Promise<import("@anthropic-ai/sdk").Anthropic.MessageCreateParams> {
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

    return {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages,
      tools: (req.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as import("@anthropic-ai/sdk").Anthropic.Tool.InputSchema,
      })),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : new Anthropic();
    const response = await client.messages.create({ ...(await this.buildParams(req)), stream: false });
    return this.toChatResponse(response);
  }

  private toChatResponse(response: import("@anthropic-ai/sdk").Anthropic.Message): ChatResponse {
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

/**
 * Routes by model string and accumulates per-call token usage.
 *
 * Fallback chains (Stage 8): a model string may list candidates separated by
 * `|` — `"claude-sonnet-5|openai/gpt-5|mock"` tries each in order, recording
 * per-model failure counts (`failureStats()`); the response carries
 * `servedBy` so audits show which candidate answered.
 */
export class ModelRouter {
  private readonly config: RouterConfig;
  private readonly failures = new Map<string, number>();
  totalUsage: ChatUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: RouterConfig = {}) {
    this.config = config;
  }

  /** Per-model failure counts across fallback attempts (reliability signal). */
  failureStats(): Record<string, number> {
    return Object.fromEntries(this.failures);
  }

  private candidatesOf(model: string): string[] {
    const parts = model.split("|").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [model];
  }

  private async withFallback(
    model: string,
    run: (candidate: string) => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    const candidates = this.candidatesOf(model);
    let lastErr: unknown = null;
    for (const candidate of candidates) {
      try {
        const res = await run(candidate);
        res.servedBy = candidate;
        this.totalUsage.inputTokens += res.usage.inputTokens;
        this.totalUsage.outputTokens += res.usage.outputTokens;
        return res;
      } catch (err) {
        lastErr = err;
        this.failures.set(candidate, (this.failures.get(candidate) ?? 0) + 1);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`all model candidates failed: ${candidates.join(", ")}`);
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
    return this.withFallback(req.model, (candidate) =>
      this.providerFor(candidate).chat({ ...req, model: candidate }),
    );
  }

  /**
   * Streaming chat (Stage 6): true token deltas where the provider supports
   * it (Anthropic); otherwise the reply is delivered in small chunks so the
   * UX contract (progressive `agent.message.delta` events) holds everywhere.
   */
  async chatStream(req: ChatRequest, onDelta: StreamDelta): Promise<ChatResponse> {
    return this.withFallback(req.model, async (candidate) => {
      const provider = this.providerFor(candidate);
      if (provider.chatStream) return provider.chatStream({ ...req, model: candidate }, onDelta);
      const res = await provider.chat({ ...req, model: candidate });
      for (let i = 0; i < res.text.length; i += 24) onDelta(res.text.slice(i, i + 24));
      return res;
    });
  }
}
