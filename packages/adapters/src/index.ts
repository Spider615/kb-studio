// 默认解析后端：自己集成的 Claude Code 沙箱（模型走 302 网关）
export { ClaudeCodeSandboxParser } from "./parser/claude-code-sandbox";
export type { ClaudeCodeSandboxParserOptions } from "./parser/claude-code-sandbox";
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
