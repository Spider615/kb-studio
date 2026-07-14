import { chunkMarkdown } from "@kb/core";
import type { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import { upsertDoc, insertChunks } from "@kb/db";

export interface IngestInput {
  docId: string;
  title: string;
  source: string;
  markdown: string; // 已是「有结构」的 markdown（无结构的先过 llm.structure）
}

/** 入库阶段进度（与 @kb/db 的 DocProgress 同形）。 */
export type IngestProgress = {
  stage: "contextualizing" | "embedding" | "storing";
  done: number;
  total: number;
};

/** 取消用：抛出后调用方按 name==='AbortError' 静默处理。 */
function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** 受限并发地遍历（默认 6 路）：上下文化是逐 chunk 的独立 LLM 调用，并发能大幅缩短墙钟。 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

/** 决定 chunk 最终上下文前缀：LLM 织入优先，空/纯空白退确定性《文件名》· 章节（仍带文件名）。纯函数，便于单测。 */
export function resolveChunkPrefix(
  llmPrefix: string | null | undefined,
  title: string,
  headingPath: string[],
): string {
  const deterministic = `《${title}》${headingPath.length ? " · " + headingPath.join(" · ") : ""}`;
  return llmPrefix && llmPrefix.trim() ? llmPrefix : deterministic;
}

/**
 * 入库管线：chunk → 逐 chunk 上下文化（整份文档作可缓存前缀，受限并发）→ embed → 存 pgvector。
 * tableRowChunks=true（CSV/Excel）时表格按数据行切。行级 chunk 默认也走 LLM 上下文化；
 * 但一篇行数超过 maxLlmRows（默认 400）时，行级回退确定性前缀（《文档》· sheet/章节），避免大表烧爆。
 */
export async function ingestDoc(
  input: IngestInput,
  deps: { llm: LlmClient; embedder: OpenAICompatEmbedder },
  opts: {
    tableRowChunks?: boolean;
    maxLlmRows?: number;
    concurrency?: number;
    onProgress?: (p: IngestProgress) => void | Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const chunks = chunkMarkdown(
    { docId: input.docId, docTitle: input.title, markdown: input.markdown },
    { tableRowChunks: opts.tableRowChunks },
  );

  const maxLlmRows = opts.maxLlmRows ?? 400;
  const concurrency = opts.concurrency ?? 6;
  const rowCount = chunks.filter((c) => c.metadata.is_table_row).length;
  const llmForRows = rowCount <= maxLlmRows; // 行太多则行级回退确定性前缀

  // 进度上报（节流：每 step 个 chunk 或最后一个才回报，避免高频写库）
  const total = chunks.length;
  const step = Math.max(1, Math.ceil(total / 20));
  let done = 0;
  const report = async (stage: IngestProgress["stage"], d: number) => {
    if (opts.onProgress) await opts.onProgress({ stage, done: d, total });
  };
  await report("contextualizing", 0);

  await mapWithConcurrency(chunks, concurrency, async (c) => {
    if (opts.signal?.aborted) throw abortError();
    let llmPrefix: string | null = null;
    if (!(c.metadata.is_table_row && !llmForRows)) {
      // 非大表：走 LLM 上下文化（喂文件名，织入归属）
      llmPrefix = await deps.llm.contextualize(input.markdown, c.content_original, input.title);
    }
    c.context_prefix = resolveChunkPrefix(llmPrefix, input.title, c.metadata.heading_path);
    c.content = `${c.context_prefix}\n${c.content_original}`;
    done += 1;
    if (done === total || done % step === 0) await report("contextualizing", done);
  });

  if (opts.signal?.aborted) throw abortError();
  await report("embedding", total);
  const vectors = await deps.embedder.embed(chunks.map((c) => c.content));

  if (opts.signal?.aborted) throw abortError();
  await report("storing", total);
  await upsertDoc({ id: input.docId, title: input.title, source: input.source, status: "ready" });
  await insertChunks(chunks.map((c, i) => ({ chunk: c, embedding: vectors[i]! })));
  return chunks.length;
}
