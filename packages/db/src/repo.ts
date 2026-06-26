import { sql } from "drizzle-orm";
import { db } from "./client";
import { docs, chunks } from "./schema";
import { tokenizeZh, toTsQuery } from "./bm25";
import type { Chunk } from "@kb/core";

export interface DocInput {
  id: string;
  title: string;
  source: string;
  mime?: string | null;
  structuredMd?: string | null;
  status?: string;
}

export async function upsertDoc(d: DocInput): Promise<void> {
  await db
    .insert(docs)
    .values({
      id: d.id,
      title: d.title,
      source: d.source,
      mime: d.mime ?? null,
      structuredMd: d.structuredMd ?? null,
      status: d.status ?? "ready",
    })
    .onConflictDoUpdate({
      target: docs.id,
      set: { title: d.title, source: d.source, status: d.status ?? "ready" },
    });
}

export async function insertChunks(items: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void> {
  if (!items.length) return;
  await db
    .insert(chunks)
    .values(
      items.map(({ chunk, embedding }) => ({
        id: chunk.id,
        docId: chunk.doc_id,
        content: chunk.content,
        contentOriginal: chunk.content_original,
        contextPrefix: chunk.context_prefix,
        chunkIndex: chunk.chunk_index,
        chunkType: chunk.chunk_type,
        tokenEstimate: chunk.token_estimate,
        metadata: chunk.metadata,
        embedding,
        tsvText: tokenizeZh(chunk.content),
      })),
    )
    .onConflictDoNothing();
}

export interface SearchHit {
  id: string;
  content: string;
  score: number;
  heading_path: string[];
}

function toHits(rows: any): SearchHit[] {
  const data: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return data.map((r) => ({
    id: r.id,
    content: r.content,
    score: Number(r.score),
    heading_path: r.metadata?.heading_path ?? [],
  }));
}

/** 向量检索（cosine）。 */
export async function vectorSearch(queryEmbedding: number[], topK = 5): Promise<SearchHit[]> {
  const lit = `[${queryEmbedding.join(",")}]`;
  const rows = await db.execute(sql`
    SELECT id, content, metadata, 1 - (embedding <=> ${lit}::vector) AS score
    FROM chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${topK}
  `);
  return toHits(rows);
}

/** 关键词检索（jieba 分词 + Postgres 全文 ts_rank_cd，近似 BM25，补数字/专名召回）。 */
export async function keywordSearch(query: string, topK = 5): Promise<SearchHit[]> {
  const tsq = toTsQuery(query);
  if (!tsq) return [];
  const rows = await db.execute(sql`
    SELECT id, content, metadata,
           ts_rank_cd(to_tsvector('simple', tsv_text), to_tsquery('simple', ${tsq})) AS score
    FROM chunks
    WHERE tsv_text IS NOT NULL
      AND to_tsvector('simple', tsv_text) @@ to_tsquery('simple', ${tsq})
    ORDER BY score DESC
    LIMIT ${topK}
  `);
  return toHits(rows);
}

/** 混合检索：向量 + 关键词，RRF 融合排序。 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  topK = 5,
  poolN = 20,
): Promise<SearchHit[]> {
  const [vec, kw] = await Promise.all([vectorSearch(queryEmbedding, poolN), keywordSearch(query, poolN)]);
  const K = 60; // RRF 常数
  const acc = new Map<string, { hit: SearchHit; rrf: number }>();
  const fold = (list: SearchHit[]) =>
    list.forEach((h, i) => {
      const e = acc.get(h.id) ?? { hit: h, rrf: 0 };
      e.rrf += 1 / (K + i + 1);
      acc.set(h.id, e);
    });
  fold(vec);
  fold(kw);
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK)
    .map((e) => ({ ...e.hit, score: e.rrf }));
}

/** demo 用：清空所有 chunk + doc（重新入库前调用）。 */
export async function clearAll(): Promise<void> {
  await db.execute(sql`TRUNCATE chunks, docs CASCADE`);
}
