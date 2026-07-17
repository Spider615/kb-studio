import { hybridSearch, keywordSearch, getChunksByIds, type SearchHit } from "@kb/db";
import type { OpenAICompatEmbedder } from "@kb/adapters";
import type { Reranker } from "@kb/core";

export interface RetrieveDeps {
  embedder: OpenAICompatEmbedder;
  reranker?: Reranker;
}
export interface RetrieveOptions {
  topK?: number;
  poolN?: number;
  docIds?: string[] | null; // 非空则限定到这些文档（单篇=长度1，分组=组内全部）
  neighbors?: number; // 检索期邻居扩展：把命中 chunk 的前后 ±N 个相邻 chunk 一并带回（默认 1，0=关）
  lexGuardN?: number; // 词法召回保护：强制把关键词(BM25)前 N 个精确命中留在结果里，防被向量稀释挤出（默认 2，0=关）
}

/**
 * lexguard：把关键词(BM25)精确命中强制并入 core（替换 core 末尾最弱项，保持 topK）。纯函数，可测。
 * 注入名额上限 = min(lexGuardN, ⌊topK/3⌋ 但至少 1)：只做「保底」不「霸榜」，保住多数精排/RRF 名额，
 * 避免弱关键词命中把 reranker 强相关块挤出。注入项标 via:"lexguard"。
 */
export function applyLexGuard(core: SearchHit[], kw: SearchHit[], topK: number, lexGuardN: number): SearchHit[] {
  if (lexGuardN <= 0 || topK <= 0) return core;
  const cap = Math.min(lexGuardN, Math.max(1, Math.floor(topK / 3)));
  const inCore = new Set(core.map((h) => h.id));
  const inject = kw.filter((h) => !inCore.has(h.id)).slice(0, cap).map((h) => ({ ...h, via: "lexguard" as const }));
  if (!inject.length) return core;
  return [...core.slice(0, Math.max(0, topK - inject.length)), ...inject];
}

/**
 * 检索期把命中 chunk 的 ±N 相邻 chunk 一并带回：靠 metadata 的 prev/next_chunk_id 沿链扩展。
 * 恢复被切到相邻 chunk 的跨界事实（比机械 overlap 更省，不重复存储）。命中在前、邻居在后。
 * fetchByIds 注入（生产=getChunksByIds，测试可传假实现）。
 */
export async function expandNeighbors(
  core: SearchHit[],
  n: number,
  fetchByIds: (ids: string[]) => Promise<SearchHit[]>,
): Promise<SearchHit[]> {
  if (n <= 0) return core;
  const have = new Map(core.map((h) => [h.id, h]));
  let frontier = core;
  for (let hop = 0; hop < n; hop++) {
    const want: string[] = [];
    for (const h of frontier) {
      for (const nid of [h.prev_chunk_id, h.next_chunk_id]) {
        if (nid && !have.has(nid)) want.push(nid);
      }
    }
    const uniq = [...new Set(want)];
    if (!uniq.length) break;
    const fetched = (await fetchByIds(uniq)).map((h) => ({ ...h, via: "neighbor" as const }));
    frontier = fetched;
    for (const h of fetched) if (!have.has(h.id)) have.set(h.id, h);
  }
  const coreIds = new Set(core.map((h) => h.id));
  return [...core, ...[...have.values()].filter((h) => !coreIds.has(h.id))];
}

/** 检索编排：embed query → 混合检索(向量+BM25+RRF) → 可选 Reranker → lexguard → 邻居扩展。 */
export async function retrieve(query: string, deps: RetrieveDeps, opts: RetrieveOptions = {}): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const poolN = opts.poolN ?? 20;
  const neighbors = opts.neighbors ?? 1;
  const lexGuardN = opts.lexGuardN ?? 2;

  const [qv] = await deps.embedder.embed([query]);
  const pool = await hybridSearch(query, qv!, poolN, poolN, opts.docIds);
  if (pool.length === 0) return pool;

  // 融合 + 可选 rerank → 核心 topK
  let core: SearchHit[];
  if (deps.reranker) {
    const hits = await deps.reranker.rerank(query, pool.map((h) => ({ id: h.id, text: h.content })), topK);
    const byId = new Map(pool.map((h) => [h.id, h]));
    core = hits.map((r) => ({ ...byId.get(r.id)!, score: r.score }));
  } else {
    core = pool.slice(0, topK);
  }

  // lexguard：强制保留关键词前 N 个精确命中（防型号/编码被向量稀释挤出 topK）。
  // 注：这次 keywordSearch(lexGuardN) 与 hybridSearch 内部的 keywordSearch(poolN) 前缀重复，
  // 但仅 lexGuardN(默认2) 行、成本可忽略；不改 hybridSearch 签名以免影响 search-demo。
  if (lexGuardN > 0) {
    const kw = await keywordSearch(query, lexGuardN, opts.docIds);
    core = applyLexGuard(core, kw, topK, lexGuardN);
  }

  return expandNeighbors(core, neighbors, (ids) => getChunksByIds(ids, opts.docIds));
}

export type { SearchHit };
