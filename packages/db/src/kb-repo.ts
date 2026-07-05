import { asc, desc, eq, ilike, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { documentChunks, documents } from "./schema.js";

// --- Knowledge base (Stage 3, G5) ------------------------------------------------

export async function createDocument(
  db: Db,
  input: {
    workspaceId: string;
    title: string;
    source?: string;
    mime?: string;
    content: string;
    chunks: { idx: number; heading: string; content: string }[];
  },
) {
  const [doc] = await db
    .insert(documents)
    .values({
      workspaceId: input.workspaceId,
      title: input.title,
      source: input.source ?? "",
      mime: input.mime ?? "text/markdown",
      content: input.content,
      chunkCount: input.chunks.length,
    })
    .returning();
  const rows =
    input.chunks.length > 0
      ? await db
          .insert(documentChunks)
          .values(input.chunks.map((c) => ({ ...c, documentId: doc!.id })))
          .returning()
      : [];
  return { document: doc!, chunks: rows };
}

export async function listDocuments(db: Db, workspaceId: string) {
  return db
    .select({
      id: documents.id,
      title: documents.title,
      source: documents.source,
      mime: documents.mime,
      chunkCount: documents.chunkCount,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.workspaceId, workspaceId))
    .orderBy(desc(documents.createdAt));
}

export async function getDocument(db: Db, id: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  return row ?? null;
}

export async function getDocumentChunks(db: Db, documentId: string) {
  return db
    .select({
      id: documentChunks.id,
      idx: documentChunks.idx,
      heading: documentChunks.heading,
      content: documentChunks.content,
    })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, documentId))
    .orderBy(asc(documentChunks.idx));
}

export async function deleteDocument(db: Db, id: string) {
  await db.delete(documents).where(eq(documents.id, id));
}

export async function setChunkEmbedding(
  db: Db,
  chunkId: string,
  vectorLiteral: string,
): Promise<boolean> {
  try {
    await db.execute(
      sql`UPDATE document_chunks SET embedding = ${vectorLiteral}::vector WHERE id = ${chunkId}`,
    );
    return true;
  } catch {
    return false;
  }
}

export interface ChunkHit {
  chunkId: string;
  documentId: string;
  title: string;
  idx: number;
  heading: string;
  content: string;
  score: number;
}

function toRows(res: unknown): Record<string, unknown>[] {
  return ((res as { rows?: unknown[] }).rows ?? (res as unknown[])) as Record<string, unknown>[];
}

/** Dense leg of hybrid retrieval: pgvector cosine over chunk embeddings.
 *  Throws when the vector column/extension is unavailable. */
export async function searchChunksByVector(
  db: Db,
  workspaceId: string,
  vectorLiteral: string,
  limit = 50,
): Promise<ChunkHit[]> {
  const res = await db.execute(
    sql`SELECT c.id AS chunk_id, c.document_id, d.title, c.idx, c.heading, c.content,
               1 - (c.embedding <=> ${vectorLiteral}::vector) AS score
        FROM document_chunks c JOIN documents d ON d.id = c.document_id
        WHERE d.workspace_id = ${workspaceId} AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}`,
  );
  return toRows(res).map((r) => ({
    chunkId: String(r.chunk_id),
    documentId: String(r.document_id),
    title: String(r.title),
    idx: Number(r.idx),
    heading: String(r.heading ?? ""),
    content: String(r.content),
    score: Number(r.score),
  }));
}

/** Sparse leg: Postgres full-text (BM25-ish ts_rank), ILIKE fallback when
 *  FTS is unavailable or the query yields no lexemes. */
export async function searchChunksByText(
  db: Db,
  workspaceId: string,
  query: string,
  limit = 50,
): Promise<ChunkHit[]> {
  try {
    const res = await db.execute(
      sql`SELECT c.id AS chunk_id, c.document_id, d.title, c.idx, c.heading, c.content,
                 ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) AS score
          FROM document_chunks c JOIN documents d ON d.id = c.document_id
          WHERE d.workspace_id = ${workspaceId}
            AND to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
          ORDER BY score DESC
          LIMIT ${limit}`,
    );
    const rows = toRows(res);
    if (rows.length > 0) {
      return rows.map((r) => ({
        chunkId: String(r.chunk_id),
        documentId: String(r.document_id),
        title: String(r.title),
        idx: Number(r.idx),
        heading: String(r.heading ?? ""),
        content: String(r.content),
        score: Number(r.score),
      }));
    }
  } catch {
    /* fall through to ILIKE */
  }
  const rows = await db
    .select({
      chunkId: documentChunks.id,
      documentId: documentChunks.documentId,
      title: documents.title,
      idx: documentChunks.idx,
      heading: documentChunks.heading,
      content: documentChunks.content,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(sql`${documents.workspaceId} = ${workspaceId} AND ${ilike(documentChunks.content, `%${query}%`)}`)
    .limit(limit);
  return rows.map((r) => ({ ...r, heading: r.heading ?? "", score: 0.1 }));
}
