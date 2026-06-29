// 默认解析后端：自己集成的 Claude Code 沙箱（模型走 302 网关）
export { ClaudeCodeSandboxParser } from "./parser/claude-code-sandbox";
export type { ClaudeCodeSandboxParserOptions } from "./parser/claude-code-sandbox";
// 容器化解析后端：在锁死 Docker 沙箱里跑解析（预装 python 解析库，隔离不可信文件）
export { SandboxDockerParser } from "./parser/sandbox-docker";
export type { SandboxDockerParserOptions } from "./parser/sandbox-docker";
// 确定性表格解析后端：csv/xlsx 在容器里逐行转 markdown（无模型、无网络、保真）
export { TabularSandboxParser } from "./parser/tabular-sandbox";
export type { TabularSandboxParserOptions } from "./parser/tabular-sandbox";
// 压缩包解压后端：zip/rar/7z 在容器里 unar 解压 + 过滤 + 限量（客户打包上传）
export { ArchiveExtractor } from "./parser/archive-sandbox";
export type {
  ArchiveExtractorOptions,
  ArchiveExtractResult,
  ExtractedFile,
} from "./parser/archive-sandbox";
// PDF 解析后端：判扫描件 → Claude Code（有文本层）或 vision 逐页 OCR（扫描件）
export { PdfParser } from "./parser/pdf-parser";
export type { PdfParserOptions } from "./parser/pdf-parser";
// office→PDF 转换：在沙箱里用 LibreOffice 把 pptx/ppt/odp 转 PDF，供前端内联预览
export { OfficePdfConverter } from "./parser/office-pdf-sandbox";
export type { OfficePdfConverterOptions } from "./parser/office-pdf-sandbox";
// 备选：Anthropic 第一方 code_execution 沙箱（仅在有真实 Anthropic key 时可用，走不了 302 网关）
export { ClaudeSandboxParser } from "./parser/claude-sandbox";
export type { ClaudeSandboxParserOptions } from "./parser/claude-sandbox";
export { OpenAICompatEmbedder } from "./embedding/openai-compat";
export type { OpenAICompatEmbedderOptions } from "./embedding/openai-compat";
export { NoopReranker } from "./reranker/noop";
export { Reranker302 } from "./reranker/reranker-302";
export type { Reranker302Options } from "./reranker/reranker-302";
export { StubMiaodongAdapter } from "./miaodong/stub";
export { RealMiaodongAdapter } from "./miaodong/real";
// 302 网关的 Claude 客户端（造结构 / 上下文化 / vision / citations 共用）
export { LlmClient } from "./llm/llm-client";
export type { LlmClientOptions } from "./llm/llm-client";
export { installProxyFromEnv } from "./proxy";
