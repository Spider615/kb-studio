import type { Reranker, RerankCandidate, RerankHit } from "@kb/core";

/** 占位重排：保持原顺序取前 topK。接口留好，后续可换 bge-reranker-v2-m3 / Cohere。 */
export class NoopReranker implements Reranker {
  async rerank(
    _query: string,
    candidates: RerankCandidate[],
    topK: number,
  ): Promise<RerankHit[]> {
    return candidates.slice(0, topK).map((c, i) => ({ id: c.id, score: 1 - i * 1e-6 }));
  }
}
