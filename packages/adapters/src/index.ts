// 默认解析后端：自己集成的 Claude Code 沙箱（模型走 302 网关）
export { ClaudeCodeSandboxParser } from "./parser/claude-code-sandbox";
export type { ClaudeCodeSandboxParserOptions } from "./parser/claude-code-sandbox";
// 容器化解析后端：在锁死 Docker 沙箱里跑解析（预装 python 解析库，隔离不可信文件）
export { SandboxDockerParser } from "./parser/sandbox-docker";
export type { SandboxDockerParserOptions } from "./parser/sandbox-docker";
// 确定性表格解析后端：csv/xlsx 在容器里逐行转 markdown（无模型、无网络、保真）
export { TabularSandboxParser } from "./parser/tabular-sandbox";
export type { TabularSandboxParserOptions } from "./parser/tabular-sandbox";
// PDF 解析后端：判扫描件 → Claude Code（有文本层）或 vision 逐页 OCR（扫描件）
export { PdfParser } from "./parser/pdf-parser";
export type { PdfParserOptions } from "./parser/pdf-parser";
// 备选：Anthropic 第一方 code_execution 沙箱（仅在有真实 Anthropic key 时可用，走不了 302 网关）
export { ClaudeSandboxParser } from "./parser/claude-sandbox";
export type { ClaudeSandboxParserOptions } from "./parser/claude-sandbox";
export { OpenAICompatEmbedder } from "./embedding/openai-compat";
export type { OpenAICompatEmbedderOptions } from "./embedding/openai-compat";
export { NoopReranker } from "./reranker/noop";
export { Reranker302 } from "./reranker/reranker-302";
export type { Reranker302Options } from "./reranker/reranker-302";
export { StubMiaodongAdapter } from "./miaodong/stub";
// 302 网关的 Claude 客户端（造结构 / 上下文化 / vision / citations 共用）
export { LlmClient } from "./llm/llm-client";
export type { LlmClientOptions } from "./llm/llm-client";
export { installProxyFromEnv } from "./proxy";
