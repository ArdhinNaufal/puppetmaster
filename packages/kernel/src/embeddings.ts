/**
 * Embeddings for RAG semantic memory (docs/ARCHITECTURE.md §3.1, PRD §5). The
 * `agent_memories.embedding` column is `vector(1024)`, so every provider here
 * emits a fixed-width unit vector of `EMBED_DIM` via `resizeTo` — a provider
 * whose native width differs is truncated/zero-padded and re-normalised so the
 * value always fits the column and stays cosine-comparable.
 *
 * A deterministic `MockEmbeddingProvider` makes the whole pipeline exercisable
 * without any API key (keyless dev/e2e); `OpenAICompatEmbeddingProvider` covers
 * OpenAI, Ollama, and vLLM `/v1/embeddings`.
 */

export const EMBED_DIM = 1024;

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

function resizeTo(vec: number[], dim = EMBED_DIM): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < Math.min(dim, vec.length); i++) out[i] = vec[i]!;
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i]! /= norm;
  return out;
}

/** Ultra-common words carry little signal for the hashing embedder; dropping
 *  them (and 1–2 char tokens) keeps recall keyed on content words. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "we", "you",
  "it", "do", "does", "did", "our", "my", "your", "what", "which", "that", "this",
  "how", "when", "where", "who", "use", "using", "used", "have", "has", "had",
]);

/**
 * Deterministic bag-of-words hashing embedding. Each content token is hashed
 * into a bucket and accumulated, so texts sharing salient words land close in
 * cosine space — enough for the semantic-recall path to be real (and testable)
 * without a model. A real embedding model (set EMBEDDING_PROVIDER=openai) adds
 * true synonym-level semantics on the same pipeline.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(EMBED_DIM).fill(0);
    const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (t) => t.length >= 3 && !STOPWORDS.has(t),
    );
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const bucket = Math.abs(h) % EMBED_DIM;
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[bucket]! += sign;
    }
    return resizeTo(vec);
  }
}

/** OpenAI-compatible `/v1/embeddings` (OpenAI, Ollama, vLLM). */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      // `dimensions` is honoured by text-embedding-3-*; providers that ignore it
      // are corrected by resizeTo below.
      body: JSON.stringify({ model: this.model, input: texts, dimensions: EMBED_DIM }),
    });
    if (!res.ok) throw new Error(`embedding provider error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const rows = data.data ?? [];
    return texts.map((_, i) => resizeTo(rows[i]?.embedding ?? []));
  }
}

export interface EmbeddingConfig {
  /** "mock" (default, keyless) | "openai" | "none" (keyword-only recall). */
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Build the configured embedder, or null when embeddings are disabled. */
export function createEmbedder(config: EmbeddingConfig = {}): EmbeddingProvider | null {
  const which = (config.provider ?? "mock").toLowerCase();
  if (which === "none" || which === "off") return null;
  if (which === "openai") {
    return new OpenAICompatEmbeddingProvider(
      config.baseUrl ?? "https://api.openai.com",
      config.model ?? "text-embedding-3-small",
      config.apiKey,
    );
  }
  return new MockEmbeddingProvider();
}

/** pgvector literal, e.g. `[0.1,0.2,...]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
