import {
  createDocument,
  getDocument,
  getDocumentChunks,
  searchChunksByText,
  searchChunksByVector,
  setChunkEmbedding,
  type ChunkHit,
  type Db,
} from "@puppetmaster/db";
import { toVectorLiteral, type EmbeddingProvider } from "./embeddings.js";
import type { BuiltinToolRegistry } from "./tools.js";

/**
 * Knowledge base / RAG (Stage 3, G5 — §1.6 best practices): heading-aware
 * chunking → hybrid retrieval (Postgres full-text + pgvector cosine) →
 * reciprocal-rank fusion → top-k with citations. An optional reranker hook
 * slots between fusion and the final cut when a reranker model is configured.
 */

export interface KbChunk {
  idx: number;
  heading: string;
  content: string;
}

const TARGET_CHUNK_CHARS = 1400;

/**
 * Heading-aware markdown chunking: sections are delimited by ATX headings and
 * carry their breadcrumb ("Guide › Setup"); long sections are split further on
 * paragraph boundaries so each chunk stays retrieval-sized. Plain text (no
 * headings) degrades to paragraph packing.
 */
export function chunkMarkdown(text: string): KbChunk[] {
  interface Section {
    heading: string;
    lines: string[];
  }
  const trail: string[] = [];
  const sections: Section[] = [{ heading: "", lines: [] }];
  for (const line of text.split("\n")) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1]!.length;
      trail.length = level - 1;
      trail[level - 1] = m[2]!.trim();
      sections.push({ heading: trail.filter(Boolean).join(" › "), lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  const chunks: KbChunk[] = [];
  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (!body) continue;
    const paragraphs = body.split(/\n{2,}/);
    let buf = "";
    const flush = () => {
      if (buf.trim()) chunks.push({ idx: chunks.length, heading: section.heading, content: buf.trim() });
      buf = "";
    };
    for (const p of paragraphs) {
      if (buf && buf.length + p.length + 2 > TARGET_CHUNK_CHARS) flush();
      buf = buf ? `${buf}\n\n${p}` : p;
      // A single paragraph longer than the target is split hard.
      while (buf.length > TARGET_CHUNK_CHARS * 1.5) {
        chunks.push({ idx: chunks.length, heading: section.heading, content: buf.slice(0, TARGET_CHUNK_CHARS) });
        buf = buf.slice(TARGET_CHUNK_CHARS);
      }
    }
    flush();
  }
  return chunks;
}

/** Reciprocal-rank fusion over any number of ranked lists (k=60 standard). */
export function rrfFuse<T>(lists: T[][], idOf: (item: T) => string, k = 60): { item: T; score: number }[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = idOf(item);
      const entry = scores.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

/** Optional rerank hook: score fused candidates against the query (higher =
 *  more relevant). Wire a cross-encoder here when one is configured. */
export type Reranker = (query: string, candidates: ChunkHit[]) => Promise<number[]>;

export interface KbSearchResult extends ChunkHit {
  /** Render-ready citation anchor, e.g. "Handbook#3 (Ops › Escalation)". */
  citation: string;
}

export interface KbDeps {
  db: Db;
  workspaceId: string;
  embedder?: EmbeddingProvider | null;
  reranker?: Reranker | null;
}

/** Hybrid search: dense + sparse top-50 each → RRF → (optional rerank) → top-k. */
export async function kbSearch(deps: KbDeps, query: string, limit = 5): Promise<KbSearchResult[]> {
  const lists: ChunkHit[][] = [];
  if (deps.embedder && query.trim()) {
    try {
      const [qv] = await deps.embedder.embed([query]);
      lists.push(await searchChunksByVector(deps.db, deps.workspaceId, toVectorLiteral(qv!), 50));
    } catch {
      /* dense leg unavailable — sparse still works */
    }
  }
  lists.push(await searchChunksByText(deps.db, deps.workspaceId, query, 50));

  let fused = rrfFuse(lists, (h) => h.chunkId).map(({ item, score }) => ({ ...item, score }));
  if (deps.reranker && fused.length > 1) {
    try {
      const top = fused.slice(0, 50);
      const scores = await deps.reranker(query, top);
      fused = top
        .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    } catch {
      /* reranker is advisory */
    }
  }
  return fused.slice(0, limit).map((h) => ({
    ...h,
    citation: `${h.title}#${h.idx}${h.heading ? ` (${h.heading})` : ""}`,
  }));
}

/** Chunk + embed + store a document. Embedding failures degrade to
 *  keyword-only retrieval for the affected chunks. */
export async function kbIngest(
  deps: KbDeps,
  input: { title: string; content: string; source?: string; mime?: string },
) {
  const chunks = chunkMarkdown(input.content);
  const { document, chunks: rows } = await createDocument(deps.db, {
    workspaceId: deps.workspaceId,
    title: input.title,
    source: input.source,
    mime: input.mime,
    content: input.content,
    chunks,
  });
  let embedded = 0;
  if (deps.embedder && rows.length > 0) {
    try {
      const vectors = await deps.embedder.embed(rows.map((r) => r.content));
      for (let i = 0; i < rows.length; i++) {
        if (await setChunkEmbedding(deps.db, rows[i]!.id, toVectorLiteral(vectors[i]!))) embedded++;
      }
    } catch {
      /* keyword-only retrieval still works */
    }
  }
  return { document, chunkCount: rows.length, embedded };
}

/** Register kb.search / kb.read in the shared tool catalog (read-tier), so
 *  agents and workflow action nodes cite the same knowledge base. */
export function registerKbTools(registry: BuiltinToolRegistry, deps: KbDeps): void {
  registry.register(
    "kb",
    "search",
    "Search the workspace knowledge base (hybrid semantic + keyword). Returns cited chunks.",
    "read_auto",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    async (args) => {
      const hits = await kbSearch(deps, String(args.query ?? ""), Math.min(Number(args.limit ?? 5), 20));
      return hits.map((h) => ({
        citation: h.citation,
        documentId: h.documentId,
        chunkIdx: h.idx,
        heading: h.heading,
        score: Number(h.score.toFixed(4)),
        content: h.content,
      }));
    },
  );

  registry.register(
    "kb",
    "read",
    "Read a knowledge-base document (all chunks in order), by document id.",
    "read_auto",
    {
      type: "object",
      properties: {
        documentId: { type: "string" },
      },
      required: ["documentId"],
    },
    async (args) => {
      const doc = await getDocument(deps.db, String(args.documentId ?? ""));
      if (!doc || doc.workspaceId !== deps.workspaceId) throw new Error("document not found");
      const chunks = await getDocumentChunks(deps.db, doc.id);
      return {
        documentId: doc.id,
        title: doc.title,
        source: doc.source,
        chunks: chunks.map((c) => ({ idx: c.idx, heading: c.heading, content: c.content })),
      };
    },
  );
}
