/**
 * Okapi BM25 打分（纯函数，便于单测）。与 ./bm25.ts 分工：那个负责**分词**，这个负责**打分**。
 *
 * 为什么不能继续用 Postgres 的 ts_rank_cd：它是 cover density ranking，**没有 IDF**——
 * 「产品」这种满库都是的泛词和「葡萄牙」这种关键罕见词权重完全相同，谁出现次数多谁分高。
 * 实测踩过：某片段因「润」「度」「产品」高频拿到全场最高分 2.000，而查询真正在问的
 * 「葡萄牙」在其中出现 **0 次**。BM25 的 IDF 项正是为此设计的。
 *
 * 三个组成部分：
 *  - **IDF**：词越罕见，命中一次越值钱（解决上面那个问题）
 *  - **词频饱和**：同一个词出现第 10 次的边际贡献远小于第 1 次，避免堆词刷分
 *  - **长度归一化**：长文档天然更容易命中，按 |D|/avgdl 折算掉这部分优势
 */

/** 词频饱和参数：越大越看重高词频。1.2~2.0 是通用区间，1.2 偏向「出现过即可」。 */
export const BM25_K1 = 1.2;
/** 长度归一化强度：0=完全不归一化，1=完全按长度线性缩放。0.75 是通用默认。 */
export const BM25_B = 0.75;

/**
 * 逆文档频率，用带平滑的 Robertson–Spärck Jones 形式。
 * 外层套 `1 +` 是为了保证 df 接近 N（词几乎人人有）时结果趋近 0 而不会变成负数——
 * 负 IDF 会让「命中一个烂大街的词」反倒扣分，排序出现诡异翻转。
 */
export function idf(N: number, df: number): number {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

export interface CorpusStats {
  /** 文档（chunk）总数 */
  N: number;
  /** 平均文档长度（词数）。为 0 时视作 1，避免除零 */
  avgdl: number;
  /** 查询词 → 含该词的文档数 */
  df: Map<string, number>;
}

/**
 * 对单篇文档算 BM25 分。
 * queryTerms 允许含重复（内部去重）；docTokens 是该文档的分词数组（即 tsv_text 拆空格）。
 */
export function bm25Score(
  queryTerms: string[],
  docTokens: string[],
  stats: CorpusStats,
  k1 = BM25_K1,
  b = BM25_B,
): number {
  const dl = docTokens.length;
  if (dl === 0) return 0;
  const avgdl = stats.avgdl > 0 ? stats.avgdl : 1;

  // 该文档内的词频表
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const q of new Set(queryTerms)) {
    const f = tf.get(q);
    if (!f) continue; // 文档里没这个词，不贡献
    const df = stats.df.get(q) ?? 0;
    const denom = f + k1 * (1 - b + (b * dl) / avgdl);
    score += idf(stats.N, df) * ((f * (k1 + 1)) / denom);
  }
  return score;
}
