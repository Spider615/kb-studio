import { paginate, estimateTokens, type Page, type LlmBackend } from "@kb/core";
import { insertWikiPages, listChunkHeadings, assignChunkPages, setWikiStatus } from "@kb/db";
import { buildOutlineUserPrompt, OUTLINE_SYSTEM } from "@kb/adapters";

export interface BuildWikiOptions {
  maxPageTokens?: number;
  minPageTokens?: number;
  signal?: AbortSignal;
  onProgress?: (p: { stage: "paginate" | "outline" | "persist"; done: number; total: number }) => void;
  /**
   * 无标题时是否调 structure() 造标题，默认 true。
   * 本函数只看「有没有标题」这一条判据；更细的判据（块数下限、是否表格为主的文档、
   * KB_AUTO_STRUCTURE 环境开关，见 apps/web/lib/kb.ts 的 shouldStructure）由调用方
   * 自行判断后通过这个开关传入——@kb/pipeline 不依赖 apps/web。
   */
  autoStructure?: boolean;
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
 * 目录页提示词的页数上限：每页拼「标题 + 前 200 字」进 prompt，几百页的文档会拼出
 * 极长输入，大概率触发一次昂贵且大概率失败的调用（虽有 try/catch 兜底）。超过此上限
 * 直接走确定性兜底，不调 LLM。
 */
const MAX_OUTLINE_PAGES = 120;

/**
 * 构建 wiki：分页 → 目录页 → 写 wiki_pages → 回填 chunks.page_id。
 * 无标题的文档默认先跑 structure() 造标题（`opts.autoStructure = false` 可关）。
 */
export async function buildWiki(
  docId: string,
  markdown: string,
  deps: { llm: WikiLlm },
  opts: BuildWikiOptions = {},
): Promise<{ pageCount: number }> {
  const headingCount = (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
  let md = markdown;
  if (headingCount === 0 && opts.autoStructure !== false) {
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
  if (pages.length > MAX_OUTLINE_PAGES) {
    console.warn(`buildWiki(${docId})：页数 ${pages.length} 超过目录页 LLM 上限 ${MAX_OUTLINE_PAGES}，直接走确定性目录`);
    outlineContent = fallbackOutline(pages);
  } else {
    try {
      const listing = pages.map((p) => `${p.pageIndex}. ${p.title}\n${p.content.slice(0, 200)}`).join("\n\n");
      outlineContent = (await deps.llm.answerRaw?.(OUTLINE_SYSTEM, buildOutlineUserPrompt(listing))) ?? "";
      if (!outlineContent.trim()) {
        console.warn(`buildWiki(${docId})：目录页 LLM 返回空内容，退回确定性目录`);
        outlineContent = fallbackOutline(pages);
      }
    } catch (err) {
      console.warn(`buildWiki(${docId})：目录页 LLM 调用失败，退回确定性目录：${(err as Error)?.message ?? err}`);
      outlineContent = fallbackOutline(pages);
    }
  }

  opts.onProgress?.({ stage: "persist", done: 0, total: 2 });
  opts.signal?.throwIfAborted(); // persist 阶段的第一个检查点：insertWikiPages 之前
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
  opts.signal?.throwIfAborted(); // persist 阶段的第二个检查点：assignChunkPages 之前
  await assignChunkPages(docId, mapping);
  opts.onProgress?.({ stage: "persist", done: 2, total: 2 });

  // 注意：setWikiStatus('ready') 之前不再加检查点——页和回填都已写完时，
  // 取消掉这最后一步只会留下「写完但没置 ready」的更差中间态，不如直接写完。
  await setWikiStatus(docId, "ready");
  return { pageCount: pages.length };
}
