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
 *
 * 注意 kw 传进来时应当**已经与 core 同尺度**（都是 reranker 分）。本函数只负责「注入」，
 * 不负责排序——排序由调用方在确认尺度一致后统一做，见 retrieve()。
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

  // lexguard 候选**提前取**，与召回池合并后一起送精排。
  // 早先的写法是在 rerank 之后才追加，导致保底项身上带的是 BM25 的 ts_rank_cd 分
  // （无上限、且只反映词频），跟主命中的 reranker 分(0~1)不同尺度：前端并排显示时
  // 会出现「2.000 排在 0.717 后面」这种没法解读的画面。合并进池后所有结果同一把尺子。
  // 注：这次 keywordSearch(lexGuardN) 与 hybridSearch 内部的 keywordSearch(poolN) 前缀重复，
  // 但仅 lexGuardN(默认2) 行、成本可忽略；不改 hybridSearch 签名以免影响 search-demo。
  const kw = lexGuardN > 0 ? await keywordSearch(query, lexGuardN, opts.docIds) : [];
  const inPool = new Set(pool.map((h) => h.id));
  const candidates = [...pool, ...kw.filter((h) => !inPool.has(h.id))];
  if (candidates.length === 0) return [];

  let core: SearchHit[];
  if (deps.reranker) {
    // top_n 要全量而非 topK：保底项即便排不进 topK，也必须拿到分数才能与主命中同尺度比较
    const ranked = await deps.reranker.rerank(
      query,
      candidates.map((h) => ({ id: h.id, text: h.content })),
      candidates.length,
    );
    const byId = new Map(candidates.map((h) => [h.id, h]));
    const scored = ranked
      .map((r) => {
        const h = byId.get(r.id);
        return h ? { ...h, score: r.score } : null;
      })
      .filter((h): h is SearchHit => h !== null);
    scored.sort((a, b) => b.score - a.score); // 不依赖上游按序返回
    const kwIds = new Set(kw.map((h) => h.id));
    core = applyLexGuard(
      scored.slice(0, topK),
      scored.filter((h) => kwIds.has(h.id)),
      topK,
      lexGuardN,
    );
    // 此刻全部是 reranker 分，尺度一致 → 整体降序，前端直接按序渲染
    core.sort((a, b) => b.score - a.score);
  } else {
    // 无 reranker：主命中是 RRF 分、保底项是 BM25 分，两者不可比 → 保持「注入项追加末尾」
    // 的旧行为，不做混排（排了反而会让 BM25 高分假性霸榜）。
    core = applyLexGuard(pool.slice(0, topK), kw, topK, lexGuardN);
  }

  return expandNeighbors(core, neighbors, (ids) => getChunksByIds(ids, opts.docIds));
}

export type { SearchHit };
