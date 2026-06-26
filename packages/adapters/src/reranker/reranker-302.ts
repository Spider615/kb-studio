import type { Reranker, RerankCandidate, RerankHit } from "@kb/core";
import { installProxyFromEnv } from "../proxy";

export interface Reranker302Options {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** 302 的重排（默认 BAAI/bge-reranker-v2-m3）。Cohere/Jina 风格 /rerank 接口。 */
export class Reranker302 implements Reranker {
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(opts: Reranker302Options = {}) {
    installProxyFromEnv();
    this.baseUrl = (opts.baseUrl ?? process.env.EMBED_BASE_URL ?? "https://api.302.ai/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.EMBED_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
    this.model = opts.model ?? process.env.RERANK_MODEL ?? "BAAI/bge-reranker-v2-m3";
  }

  async rerank(query: string, candidates: RerankCandidate[], topK: number): Promise<RerankHit[]> {
    if (!candidates.length) return [];
    const res = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: candidates.map((c) => c.text),
        top_n: topK,
      }),
    });
    if (!res.ok) throw new Error(`rerank 失败 ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
    return json.results.map((r) => ({ id: candidates[r.index]!.id, score: r.relevance_score }));
  }
}
