import {
  LlmClient,
  OpenAICompatEmbedder,
  Reranker302,
  SandboxDockerParser,
  TabularSandboxParser,
  PdfParser,
  ClaudeCodeSandboxParser,
} from "@kb/adapters";
import type { ParserBackend } from "@kb/core";
import { ingestDoc } from "@kb/pipeline";
import { setDocProgress, failDoc, clearDocProgress, getDocStatus } from "@kb/db";
import { startJob, endJob } from "./jobs";

/**
 * 解析后端按文件类型分流：
 * - csv/xlsx → TabularSandboxParser（容器内确定性解析，逐行保真、无模型、最快）
 * - pdf → PdfParser（判扫描件：有文本层走 Claude Code，扫描件走 vision 逐页 OCR）
 * - 其余 → SandboxDockerParser（容器化 Claude Code，处理 docx/复杂布局）
 * 设 KB_PARSER=host 则强制退回宿主机进程内 Claude Code（调试用）。
 */
export function getParser(filename?: string): ParserBackend {
  if ((process.env.KB_PARSER ?? "docker").toLowerCase() === "host") {
    return new ClaudeCodeSandboxParser();
  }
  const ext = (filename ?? "").toLowerCase();
  if (/\.(csv|tsv|xlsx?|xlsm)$/.test(ext)) return new TabularSandboxParser();
  if (ext.endsWith(".pdf")) {
    return new PdfParser({ llm: new LlmClient(), fallback: new SandboxDockerParser() });
  }
  return new SandboxDockerParser();
}

/**
 * 是否对解析结果做 LLM 造结构：仅当「无标题 + 有一定篇幅」时触发；
 * 已有标题、太短、或表格类（调用方会先排除）都跳过。设 KB_AUTO_STRUCTURE=off 全局关闭。
 */
export function shouldStructure(markdown: string): boolean {
  if ((process.env.KB_AUTO_STRUCTURE ?? "on").toLowerCase() === "off") return false;
  const headings = (markdown.match(/^#{1,6}\s/gm) || []).length;
  const blocks = markdown.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
  return headings === 0 && blocks >= 4;
}

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

/**
 * 后台处理一篇已建行的文档：解析 →（条件）造结构 → 入库（chunk→上下文化→embed→存）。
 * 经 startJob/endJob 注册到任务表，可被 abortJob 中止（删处理中文档时）。
 * 文档行须已由 createProcessingDoc 建好；ingestDoc 末尾把 status 置 ready。
 * /api/upload（cookie 上传）与 /api/ingest（服务端按 ref 入库）共用此函数。
 */
export async function processDoc(docId: string, bytes: Uint8Array, filename: string): Promise<void> {
  const signal = startJob(docId);
  try {
    const tableRowChunks = /\.(csv|xlsx?|tsv)$/i.test(filename);
    const { llm, embedder } = getDeps();

    // 1. 解析
    await setDocProgress(docId, { stage: "parsing", done: 0, total: 0 });
    const parser = getParser(filename);
    let markdown = (await parser.parse({ bytes, filename })).markdown;
    if (signal.aborted) return;

    // 2. 造结构（条件，失败不致命）
    if (!tableRowChunks && shouldStructure(markdown)) {
      await setDocProgress(docId, { stage: "structuring", done: 0, total: 0 });
      try {
        markdown = await llm.structure(markdown);
      } catch (e: any) {
        console.error("[processDoc] structure 失败，按原文入库:", e?.message ?? e);
      }
    }
    if (signal.aborted) return;

    // 3. 入库（chunk → 上下文化(进度) → embed → 存）；ingestDoc 末尾把 status 置 ready
    await ingestDoc(
      { docId, title: filename, source: filename, markdown },
      { llm, embedder },
      {
        tableRowChunks,
        signal,
        onProgress: (p) => setDocProgress(docId, p),
      },
    );

    if (signal.aborted) return;
    await clearDocProgress(docId);
  } catch (e: any) {
    if (e?.name === "AbortError" || signal.aborted) return; // 被取消：行已删，静默
    // 行可能已被用户删除（删处理中文档）；还在才标失败
    const st = await getDocStatus(docId).catch(() => null);
    if (st) await failDoc(docId, String(e?.message ?? e)).catch(() => {});
    console.error("[processDoc] 处理失败:", e?.message ?? e);
  } finally {
    endJob(docId);
  }
}
