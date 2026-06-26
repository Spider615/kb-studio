import { chunkMarkdown } from "@kb/core";
import type { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import { upsertDoc, insertChunks } from "@kb/db";

export interface IngestInput {
  docId: string;
  title: string;
  source: string;
  markdown: string; // 已是「有结构」的 markdown（无结构的先过 llm.structure）
}

/** 入库管线：chunk → 逐 chunk 上下文化（整份文档作可缓存前缀）→ embed → 存 pgvector。 */
export async function ingestDoc(
  input: IngestInput,
  deps: { llm: LlmClient; embedder: OpenAICompatEmbedder },
): Promise<number> {
  const chunks = chunkMarkdown({ docId: input.docId, docTitle: input.title, markdown: input.markdown });

  for (const c of chunks) {
    const prefix = await deps.llm.contextualize(input.markdown, c.content_original);
    c.context_prefix = prefix || null;
    c.content = prefix ? `${prefix}\n${c.content_original}` : c.content_original;
  }

  const vectors = await deps.embedder.embed(chunks.map((c) => c.content));
  await upsertDoc({ id: input.docId, title: input.title, source: input.source, status: "ready" });
  await insertChunks(chunks.map((c, i) => ({ chunk: c, embedding: vectors[i]! })));
  return chunks.length;
}
