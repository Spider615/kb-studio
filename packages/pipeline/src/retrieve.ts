import { hybridSearch, type SearchHit } from "@kb/db";
import type { OpenAICompatEmbedder } from "@kb/adapters";
import type { Reranker } from "@kb/core";

export interface RetrieveDeps {
  embedder: OpenAICompatEmbedder;
  reranker?: Reranker;
}
export interface RetrieveOptions {
  topK?: number;
  poolN?: number;
}

/** 检索编排：embed query → 混合检索(向量+BM25+RRF) → 可选 Reranker → top-K。 */
export async function retrieve(query: string, deps: RetrieveDeps, opts: RetrieveOptions = {}): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const poolN = opts.poolN ?? 20;
  const [qv] = await deps.embedder.embed([query]);
  const pool = await hybridSearch(query, qv!, poolN, poolN);
  if (!deps.reranker || pool.length === 0) return pool.slice(0, topK);
  const hits = await deps.reranker.rerank(query, pool.map((h) => ({ id: h.id, text: h.content })), topK);
  const byId = new Map(pool.map((h) => [h.id, h]));
  return hits.map((r) => ({ ...byId.get(r.id)!, score: r.score }));
}

export type { SearchHit };
