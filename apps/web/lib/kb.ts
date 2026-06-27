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
