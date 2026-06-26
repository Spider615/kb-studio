import { LlmClient, OpenAICompatEmbedder, Reranker302 } from "@kb/adapters";

/** 构造 302 网关的一套依赖（LLM / embedder / reranker）。 */
export function getDeps() {
  const llm = new LlmClient();
  const embedder = new OpenAICompatEmbedder({
    baseUrl: process.env.EMBED_BASE_URL ?? "https://api.302.ai/v1",
    apiKey: process.env.EMBED_API_KEY,
    model: process.env.EMBED_MODEL ?? "BAAI/bge-m3",
    dimensions: Number(process.env.EMBED_DIM ?? 1024),
  });
  const reranker = new Reranker302();
  return { llm, embedder, reranker };
}
