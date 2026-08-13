import type { ToolSpec } from "@kb/core";
import { estimateTokens } from "@kb/core";
import {
  hybridSearch,
  keywordSearch,
  listWikiDocs,
  listWikiPages,
  getWikiPage,
  getWikiOutline,
  pageIdsForChunkIds,
} from "@kb/db";
import type { OpenAICompatEmbedder } from "@kb/adapters";

/** 单次 read_page 注入模型的 token 上限（超出截断并提示可读续页）。 */
const MAX_PAGE_TOKENS = 8000;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_docs",
    description: "列出当前可检索范围内的全部文档（标题与页数）。不知道该从哪份资料入手时先调它。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_outline",
    description: "读某份文档的目录页，了解它分几页、每页讲什么。决定读哪一页之前先调它。",
    input_schema: {
      type: "object",
      properties: { docId: { type: "string", description: "文档 id" } },
      required: ["docId"],
    },
  },
  {
    name: "read_page",
    description: "读某份文档某一页的完整正文。需要完整条款、完整流程时用它，不要只凭检索片段作答。",
    input_schema: {
      type: "object",
      properties: {
        docId: { type: "string", description: "文档 id" },
        pageIndex: { type: "number", description: "页序号，从 1 开始；0 是目录页" },
      },
      required: ["docId", "pageIndex"],
    },
  },
  {
    name: "grep",
    description: "关键词精确检索，适合查具体型号、编号、金额、专有名词。返回命中所在的页。",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键词" },
        docIds: { type: "array", items: { type: "string" }, description: "限定文档，省略则全范围" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "search",
    description: "语义检索，适合用自然语言描述的问题。返回命中内容所在的页（不是碎片）。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言查询" },
        docIds: { type: "array", items: { type: "string" }, description: "限定文档，省略则全范围" },
      },
      required: ["query"],
    },
  },
];

export interface ToolDeps {
  embedder: OpenAICompatEmbedder;
  docIds: string[]; // 白名单：本次会话可访问的全部文档
}

/** 把模型传来的 docIds 收窄到白名单内；未传则用全部白名单。 */
export function clampDocIds(requested: string[] | undefined, allowed: string[]): string[] {
  if (!requested || requested.length === 0) return allowed;
  const set = new Set(allowed);
  return requested.filter((id) => set.has(id));
}

/** 把页列表渲染成喂回模型的文本，单页超预算则截断并提示。 */
export function formatPagesForModel(
  pages: Array<{ docId: string; pageIndex: number; title: string; content: string }>,
  maxTokens = MAX_PAGE_TOKENS,
): string {
  return pages
    .map((p) => {
      let body = p.content;
      if (estimateTokens(body) > maxTokens) {
        // 粗略按字符比例截断（estimateTokens 与字符数近似线性）
        const ratio = maxTokens / estimateTokens(body);
        body = body.slice(0, Math.max(1, Math.floor(body.length * ratio))) + "\n\n…（本页已截断，可读下一页续页）";
      }
      return `【${p.docId} 第${p.pageIndex}页 · ${p.title}】\n${body}`;
    })
    .join("\n\n---\n\n");
}

/** 命中的 chunk id 折算成所属页，去重后按页返回。未跑 wiki 化的 chunk（无 page_id）被跳过。 */
async function chunksToPages(chunkIds: string[]): Promise<Array<{ docId: string; pageIndex: number; title: string; content: string }>> {
  const pageIdByChunk = await pageIdsForChunkIds(chunkIds);
  const seen = new Set<string>();
  const out: Array<{ docId: string; pageIndex: number; title: string; content: string }> = [];
  for (const cid of chunkIds) {
    const pid = pageIdByChunk.get(cid);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    // page id 形如 page_<docId>_<idx>，末段是序号，其余是 docId
    const lastUnderscore = pid.lastIndexOf("_");
    const docId = pid.slice("page_".length, lastUnderscore);
    const pageIndex = Number(pid.slice(lastUnderscore + 1));
    const page = await getWikiPage(docId, pageIndex);
    if (page) out.push({ docId, pageIndex, title: page.title, content: page.content });
  }
  return out;
}

/** 执行一个工具，返回喂回模型的文本。工具自身的错误也以文本返回，让模型自纠而不是中断循环。 */
export async function runTool(name: string, input: any, deps: ToolDeps): Promise<string> {
  try {
    switch (name) {
      case "list_docs": {
        const docs = await listWikiDocs(deps.docIds);
        if (docs.length === 0) return "当前范围内没有已生成 wiki 页的文档。";
        return docs.map((d) => `${d.docId} · ${d.title}（${d.pageCount} 页）`).join("\n");
      }
      case "read_outline": {
        const docId = String(input?.docId ?? "");
        if (!deps.docIds.includes(docId)) return `错误：文档 ${docId} 不在可访问范围内。请先用 list_docs 查看可用文档。`;
        const outline = await getWikiOutline(docId);
        if (!outline) return `错误：文档 ${docId} 没有目录页（可能未生成 wiki）。`;
        const pages = await listWikiPages(docId);
        const maxIndex = Math.max(...pages.map((p) => p.pageIndex));
        return `【${docId} 目录】共 ${maxIndex} 页\n${outline.content}`;
      }
      case "read_page": {
        const docId = String(input?.docId ?? "");
        const pageIndex = Number(input?.pageIndex);
        if (!deps.docIds.includes(docId)) return `错误：文档 ${docId} 不在可访问范围内。`;
        if (!Number.isInteger(pageIndex) || pageIndex < 0) return `错误：pageIndex 必须是不小于 0 的整数，收到 ${input?.pageIndex}。`;
        const page = await getWikiPage(docId, pageIndex);
        if (!page) {
          const pages = await listWikiPages(docId);
          const maxIndex = pages.length ? Math.max(...pages.map((p) => p.pageIndex)) : 0;
          return `错误：文档 ${docId} 没有第 ${pageIndex} 页，有效范围是 0-${maxIndex}。`;
        }
        return formatPagesForModel([{ docId, pageIndex, title: page.title, content: page.content }]);
      }
      case "grep": {
        const keyword = String(input?.keyword ?? "").trim();
        if (!keyword) return "错误：keyword 不能为空。";
        const scope = clampDocIds(input?.docIds, deps.docIds);
        if (scope.length === 0) return "错误：指定的文档都不在可访问范围内。";
        const hits = await keywordSearch(keyword, 10, scope);
        const pages = await chunksToPages(hits.map((h) => h.id));
        if (pages.length === 0) return `没有命中「${keyword}」。`;
        return pages.map((p) => `${p.docId} 第${p.pageIndex}页 · ${p.title}`).join("\n");
      }
      case "search": {
        const query = String(input?.query ?? "").trim();
        if (!query) return "错误：query 不能为空。";
        const scope = clampDocIds(input?.docIds, deps.docIds);
        if (scope.length === 0) return "错误：指定的文档都不在可访问范围内。";
        const [qv] = await deps.embedder.embed([query]);
        const hits = await hybridSearch(query, qv!, 10, 10, scope);
        const pages = await chunksToPages(hits.map((h) => h.id));
        if (pages.length === 0) return `没有检索到与「${query}」相关的页。`;
        return pages.map((p) => `${p.docId} 第${p.pageIndex}页 · ${p.title}`).join("\n");
      }
      default:
        return `错误：未知工具 ${name}。可用工具：${TOOL_SPECS.map((t) => t.name).join("、")}。`;
    }
  } catch (e: any) {
    return `工具 ${name} 执行出错：${String(e?.message ?? e).slice(0, 300)}`;
  }
}
