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
  /** Stage 9A: when true and `model` is a `profile:NAME` with a
   *  minClassForGatedTools floor, candidates below the floor are excluded —
   *  a chain that can only answer below the floor throws ModelFloorError
   *  instead of silently downgrading. Set by the agent runtime for agents
   *  holding write/destructive tools. */
  enforceGatedFloor?: boolean;
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
  /** Router profile that resolved the chain, when `model` was `profile:NAME`. */
  profile?: string;
}

// --- Router profiles (Stage 9A, docs/9ROUTER-ADOPTION.md) ---------------------------
// The 9Router study's cost tiers, renamed for a platform that holds real API
// keys ("subscription" OAuth harvesting was rejected outright): premium =
// frontier API, cheap = budget API, local = Ollama/vLLM, free = mock/no-cost.

export type CostClass = "premium" | "cheap" | "local" | "free";

export const COST_CLASSES: CostClass[] = ["premium", "cheap", "local", "free"];

const COST_CLASS_RANK: Record<CostClass, number> = { premium: 4, cheap: 3, local: 2, free: 1 };

export interface RouterProfileCandidate {
  model: string;
  costClass: CostClass;
}

export interface RouterProfile {
  name: string;
  candidates: RouterProfileCandidate[];
  /** Floor for callers with gated (write/destructive) tools; null = no floor. */
  minClassForGatedTools: CostClass | null;
}

/** Looks up an enabled profile by name; null = unknown. Injected by the server
 *  so the kernel stays storage-agnostic. */
export type ProfileResolver = (name: string) => Promise<RouterProfile | null>;

export const PROFILE_PREFIX = "profile:";

/** Thrown instead of silently serving below a profile's gated-tools floor —
 *  the agent runtime converts it into an approval gate (human decides the
 *  downgrade), per the anti-silent-substitution stance in 9ROUTER-ADOPTION §4. */
export class ModelFloorError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly floor: CostClass,
    /** Candidates the floor excluded (still available if a human approves). */
    public readonly blocked: string[],
    detail: string,
  ) {
    super(
      `profile "${profileName}" cannot serve at or above class "${floor}": ${detail}` +
        (blocked.length > 0 ? ` (below-floor candidates: ${blocked.join(", ")})` : ""),
    );
  }
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
  /** Stage 9B health/cooldown tuning; unset fields use the defaults below. */
  health?: Partial<RouterHealthConfig>;
}

// --- Candidate health & cooldowns (Stage 9B, docs/9ROUTER-ADOPTION.md) --------------
// In-memory only: cooldowns are seconds-scale, so persisting them across a
// restart would outlive their own usefulness.

export interface RouterHealthConfig {
  /** Consecutive failures before a candidate cools down. */
  failureThreshold: number;
  /** Cooldown after crossing the threshold; doubles per repeat cycle. */
  baseCooldownMs: number;
  /** Cooldown after a quota/rate-limit error (429), used when no retry-after. */
  quotaCooldownMs: number;
  /** Upper bound for any cooldown, including provider retry-after hints. */
  maxCooldownMs: number;
}

const HEALTH_DEFAULTS: RouterHealthConfig = {
  failureThreshold: 3,
  baseCooldownMs: 30_000,
  quotaCooldownMs: 60_000,
  maxCooldownMs: 120_000,
};

export interface CandidateHealth {
  state: "healthy" | "cooling";
  consecutiveFailures: number;
  /** ISO timestamp the cooldown expires (half-open probe afterwards); null = none. */
  cooldownUntil: string | null;
  lastError: string | null;
}

/** Emitted when a candidate transitions into cooldown — the server audits
 *  these as `router.cooldown` so route-arounds are visible in the trail. */
export interface RouterCooldownEvent {
  model: string;
  reason: "failures" | "quota";
  consecutiveFailures: number;
  cooldownUntil: string;
  error: string;
}

interface HealthEntry {
  consecutiveFailures: number;
  cooldownUntil: number | null;
  coolCycles: number;
  lastError: string | null;
}

/** Quota/rate-limit classification: HTTP 429 or quota-ish wording. */
function isQuotaError(msg: string): boolean {
  return /\b429\b|rate.?limit|quota|too many requests/i.test(msg);
}

/** Provider retry-after hint, in ms — `retry-after: 17` / `retry after 17s`. */
function retryAfterMs(msg: string): number | null {
  const m = msg.match(/retry[-_ ]?after[:\s"]*(\d+)/i);
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * Routes by model string and accumulates per-call token usage.
 *
 * Fallback chains (Stage 8): a model string may list candidates separated by
 * `|` — `"claude-sonnet-5|openai/gpt-5|mock"` tries each in order, recording
 * per-model failure counts (`failureStats()`); the response carries
 * `servedBy` so audits show which candidate answered.
 *
 * Router profiles (Stage 9A): `model: "profile:NAME"` resolves through the
 * injected ProfileResolver to a named workspace chain; a profile floor plus
 * `enforceGatedFloor` refuses to silently serve gated callers below the
 * floor (ModelFloorError → approval gate upstream).
 */
export class ModelRouter {
  private readonly config: RouterConfig;
  private readonly failures = new Map<string, number>();
  private readonly healthCfg: RouterHealthConfig;
  private readonly health = new Map<string, HealthEntry>();
  private profileResolver: ProfileResolver | null = null;
  private cooldownSink: ((e: RouterCooldownEvent) => void) | null = null;
  totalUsage: ChatUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: RouterConfig = {}) {
    this.config = config;
    // Only positive finite overrides apply — undefined env values must not
    // clobber the defaults through the spread.
    this.healthCfg = { ...HEALTH_DEFAULTS };
    for (const key of Object.keys(HEALTH_DEFAULTS) as (keyof RouterHealthConfig)[]) {
      const v = config.health?.[key];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) this.healthCfg[key] = v;
    }
  }

  setProfileResolver(resolver: ProfileResolver): void {
    this.profileResolver = resolver;
  }

  /** Cooldown transitions are pushed here (Stage 9B) — the server audits them. */
  setCooldownSink(sink: (e: RouterCooldownEvent) => void): void {
    this.cooldownSink = sink;
  }

  /** Per-model failure counts across fallback attempts (reliability signal). */
  failureStats(): Record<string, number> {
    return Object.fromEntries(this.failures);
  }

  /** Health snapshot for GET /api/usage: state, cooldown expiry, last error. */
  healthStats(): Record<string, CandidateHealth> {
    const out: Record<string, CandidateHealth> = {};
    const nowMs = Date.now();
    for (const [model, h] of this.health) {
      out[model] = {
        state: h.cooldownUntil !== null && nowMs < h.cooldownUntil ? "cooling" : "healthy",
        consecutiveFailures: h.consecutiveFailures,
        cooldownUntil:
          h.cooldownUntil !== null && nowMs < h.cooldownUntil
            ? new Date(h.cooldownUntil).toISOString()
            : null,
        lastError: h.lastError,
      };
    }
    return out;
  }

  private isCooling(model: string): boolean {
    const h = this.health.get(model);
    return h !== undefined && h.cooldownUntil !== null && Date.now() < h.cooldownUntil;
  }

  private recordSuccess(model: string): void {
    const h = this.health.get(model);
    if (!h) return;
    h.consecutiveFailures = 0;
    h.cooldownUntil = null;
    h.coolCycles = 0;
    h.lastError = null;
  }

  /** Failure bookkeeping: quota errors cool immediately (retry-after honoured,
   *  capped); other errors cool after `failureThreshold` consecutive misses,
   *  doubling per repeat cycle up to `maxCooldownMs`. Expiry is the half-open
   *  probe — the counter is NOT reset, so one more failure re-arms at once. */
  private recordFailure(model: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const h: HealthEntry = this.health.get(model) ?? {
      consecutiveFailures: 0,
      cooldownUntil: null,
      coolCycles: 0,
      lastError: null,
    };
    h.consecutiveFailures++;
    h.lastError = msg.slice(0, 300);
    const wasCooling = h.cooldownUntil !== null && Date.now() < h.cooldownUntil;

    const quota = isQuotaError(msg);
    let cooldownMs: number | null = null;
    if (quota) {
      cooldownMs = Math.min(retryAfterMs(msg) ?? this.healthCfg.quotaCooldownMs, this.healthCfg.maxCooldownMs);
    } else if (h.consecutiveFailures >= this.healthCfg.failureThreshold) {
      cooldownMs = Math.min(
        this.healthCfg.baseCooldownMs * 2 ** h.coolCycles,
        this.healthCfg.maxCooldownMs,
      );
    }
    if (cooldownMs !== null) {
      h.cooldownUntil = Date.now() + cooldownMs;
      h.coolCycles = Math.min(h.coolCycles + 1, 8);
      // Audit only the transition into cooling, not every failure inside it.
      if (!wasCooling) {
        this.cooldownSink?.({
          model,
          reason: quota ? "quota" : "failures",
          consecutiveFailures: h.consecutiveFailures,
          cooldownUntil: new Date(h.cooldownUntil).toISOString(),
          error: h.lastError,
        });
      }
    }
    this.health.set(model, h);
  }

  private candidatesOf(model: string): string[] {
    const parts = model.split("|").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [model];
  }

  /** Resolve the attempt list: a `profile:NAME` model becomes the profile's
   *  chain (floor applied when the caller enforces it); anything else keeps
   *  the Stage 8 `|`-chain semantics. */
  private async resolveAttempts(
    model: string,
    enforceGatedFloor: boolean,
  ): Promise<{ attempts: string[]; profile?: RouterProfile }> {
    if (!model.startsWith(PROFILE_PREFIX)) {
      return { attempts: this.candidatesOf(model) };
    }
    const name = model.slice(PROFILE_PREFIX.length).trim();
    const profile = this.profileResolver ? await this.profileResolver(name) : null;
    if (!profile) throw new Error(`unknown router profile: "${name}"`);
    if (profile.candidates.length === 0) {
      throw new Error(`router profile "${name}" has no candidates`);
    }
    const floor = enforceGatedFloor ? profile.minClassForGatedTools : null;
    if (!floor) return { attempts: profile.candidates.map((c) => c.model), profile };
    const eligible = profile.candidates.filter(
      (c) => (COST_CLASS_RANK[c.costClass] ?? 0) >= COST_CLASS_RANK[floor],
    );
    const blocked = profile.candidates
      .filter((c) => (COST_CLASS_RANK[c.costClass] ?? 0) < COST_CLASS_RANK[floor])
      .map((c) => c.model);
    if (eligible.length === 0) {
      throw new ModelFloorError(name, floor, blocked, "every candidate is below the floor");
    }
    // Keep the full profile alongside the floored attempt list so the
    // exhausted-chain path below can still name the blocked candidates.
    return { attempts: eligible.map((c) => c.model), profile };
  }

  private async withFallback(
    req: { model: string; enforceGatedFloor?: boolean },
    run: (candidate: string) => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    const { attempts, profile } = await this.resolveAttempts(
      req.model,
      req.enforceGatedFloor ?? false,
    );
    // Health-aware ordering (Stage 9B): cooling candidates are deprioritized,
    // not removed — healthy ones are tried first, cooling ones remain as the
    // last resort so the chain never fails closed on stale health state.
    const healthy = attempts.filter((c) => !this.isCooling(c));
    const ordered = healthy.length === attempts.length || healthy.length === 0
      ? attempts
      : [...healthy, ...attempts.filter((c) => this.isCooling(c))];
    let lastErr: unknown = null;
    for (const candidate of ordered) {
      try {
        const res = await run(candidate);
        res.servedBy = candidate;
        if (profile) res.profile = profile.name;
        this.recordSuccess(candidate);
        this.totalUsage.inputTokens += res.usage.inputTokens;
        this.totalUsage.outputTokens += res.usage.outputTokens;
        return res;
      } catch (err) {
        lastErr = err;
        this.failures.set(candidate, (this.failures.get(candidate) ?? 0) + 1);
        this.recordFailure(candidate, err);
      }
    }
    // A floored profile that exhausted its eligible candidates surfaces as a
    // floor error when below-floor candidates remain — the caller may gate on
    // a human downgrade decision instead of failing outright.
    if (profile && (req.enforceGatedFloor ?? false) && profile.minClassForGatedTools) {
      const floor = profile.minClassForGatedTools;
      const blocked = profile.candidates
        .filter((c) => (COST_CLASS_RANK[c.costClass] ?? 0) < COST_CLASS_RANK[floor])
        .map((c) => c.model);
      if (blocked.length > 0) {
        throw new ModelFloorError(
          profile.name,
          floor,
          blocked,
          `all at-or-above-floor candidates failed (${attempts.join(", ")})`,
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`all model candidates failed: ${attempts.join(", ")}`);
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
    return this.withFallback(req, (candidate) =>
      this.providerFor(candidate).chat({ ...req, model: candidate }),
    );
  }

  /**
   * Streaming chat (Stage 6): true token deltas where the provider supports
   * it (Anthropic); otherwise the reply is delivered in small chunks so the
   * UX contract (progressive `agent.message.delta` events) holds everywhere.
   */
  async chatStream(req: ChatRequest, onDelta: StreamDelta): Promise<ChatResponse> {
    return this.withFallback(req, async (candidate) => {
      const provider = this.providerFor(candidate);
      if (provider.chatStream) return provider.chatStream({ ...req, model: candidate }, onDelta);
      const res = await provider.chat({ ...req, model: candidate });
      for (let i = 0; i < res.text.length; i += 24) onDelta(res.text.slice(i, i + 24));
      return res;
    });
  }
}
