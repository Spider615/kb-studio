import { paginate, estimateTokens, type Page, type LlmBackend } from "@kb/core";
import { insertWikiPages, listChunkHeadings, assignChunkPages, setWikiStatus } from "@kb/db";
import { buildOutlineUserPrompt, OUTLINE_SYSTEM } from "@kb/adapters";

export interface BuildWikiOptions {
  maxPageTokens?: number;
  minPageTokens?: number;
  signal?: AbortSignal;
  onProgress?: (p: { stage: "paginate" | "outline" | "persist"; done: number; total: number }) => void;
}

/**
 * buildWiki 需要的 LLM 能力：structure 来自 LlmBackend；answerRaw 是 LlmClient 的扩展方法
 * （Task 5 实现），豆包后端没有——所以声明为可选，缺失时目录页走确定性兜底。
 */
export type WikiLlm = LlmBackend & {
  answerRaw?: (system: string, user: string, opts?: { model?: string; maxTokens?: number }) => Promise<string>;
};

/**
 * chunk → page 映射：chunk 的 heading_path 与页的 headingPath 做最长前缀匹配。
 * 并列时取 pageIndex 更小者（跨页 chunk 归起始页）；无命中归第 1 页（文档前言）。
 * 纯函数，可离线测。
 */
export function mapChunksToPages(
  chunkHeadings: Array<{ id: string; headingPath: string[]; chunkIndex: number }>,
  pages: Page[],
): Array<{ chunkId: string; pageIndex: number }> {
  if (pages.length === 0) return [];
  const firstPage = pages[0]!.pageIndex;
  return chunkHeadings.map((c) => {
    let bestLen = -1;
    let bestPage = firstPage;
    for (const p of pages) {
      const ph = p.headingPath;
      if (ph.length === 0) continue;
      const isPrefix = ph.every((seg, i) => c.headingPath[i] === seg);
      if (!isPrefix) continue;
      if (ph.length > bestLen) {
        bestLen = ph.length;
        bestPage = p.pageIndex;
      }
    }
    return { chunkId: c.id, pageIndex: bestPage };
  });
}

/** 确定性目录（LLM 生成失败时的兜底）：只列序号 + 标题，不加说明。 */
function fallbackOutline(pages: Page[]): string {
  return pages.map((p) => `${p.pageIndex}. ${p.title}`).join("\n");
}

/**
 * 构建 wiki：分页 → 目录页 → 写 wiki_pages → 回填 chunks.page_id。
 * 无标题的文档先跑 structure() 造标题（与上传流程同一判据）。
 */
export async function buildWiki(
  docId: string,
  markdown: string,
  deps: { llm: WikiLlm },
  opts: BuildWikiOptions = {},
): Promise<{ pageCount: number }> {
  const headingCount = (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
  let md = markdown;
  if (headingCount === 0) {
    try {
      md = await deps.llm.structure(markdown);
    } catch {
      md = markdown; // 造结构失败退回原文，仍能整篇成一页
    }
  }
  opts.signal?.throwIfAborted();

  opts.onProgress?.({ stage: "paginate", done: 0, total: 1 });
  const pages = paginate(md, { maxPageTokens: opts.maxPageTokens, minPageTokens: opts.minPageTokens });
  if (pages.length === 0) throw new Error("分页结果为空（文档无正文）");
  opts.signal?.throwIfAborted();

  // 目录页：只让模型写一句话说明，不改标题、不新增页
  opts.onProgress?.({ stage: "outline", done: 0, total: 1 });
  let outlineContent: string;
  try {
    const listing = pages.map((p) => `${p.pageIndex}. ${p.title}\n${p.content.slice(0, 200)}`).join("\n\n");
    outlineContent = (await deps.llm.answerRaw?.(OUTLINE_SYSTEM, buildOutlineUserPrompt(listing))) ?? "";
    if (!outlineContent.trim()) outlineContent = fallbackOutline(pages);
  } catch {
    outlineContent = fallbackOutline(pages);
  }
  opts.signal?.throwIfAborted();

  opts.onProgress?.({ stage: "persist", done: 0, total: 2 });
  await insertWikiPages([
    {
      id: `page_${docId}_0`,
      docId,
      pageIndex: 0,
      title: "目录",
      content: outlineContent,
      headingPath: [],
      tokenEstimate: estimateTokens(outlineContent),
    },
    ...pages.map((p) => ({
      id: `page_${docId}_${p.pageIndex}`,
      docId,
      pageIndex: p.pageIndex,
      title: p.title,
      content: p.content,
      headingPath: p.headingPath,
      tokenEstimate: p.tokenEstimate,
    })),
  ]);

  const chunkHeadings = await listChunkHeadings(docId);
  const mapping = mapChunksToPages(chunkHeadings, pages).map((m) => ({
    chunkId: m.chunkId,
    pageId: `page_${docId}_${m.pageIndex}`,
  }));
  await assignChunkPages(docId, mapping);
  opts.onProgress?.({ stage: "persist", done: 2, total: 2 });

  await setWikiStatus(docId, "ready");
  return { pageCount: pages.length };
}
