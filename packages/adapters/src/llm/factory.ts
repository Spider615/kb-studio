import type { LlmBackend } from "@kb/core";
import { LlmClient } from "./llm-client";
import { ArkLlmClient } from "./ark-llm-client";

/**
 * 对话模型后端工厂：默认火山方舟（豆包），`KB_LLM=claude` 退回 302 的 Claude（调试/效果对比）。
 *
 * 注意向量与重排**仍在 302**（bge-m3 / bge-reranker-v2-m3）：方舟没有独立 rerank 接口，
 * 且换 embedding 要把存量 chunk 全量重嵌，故本次只迁对话层。
 * 解析层（Claude Agent SDK）也未迁，见 KB_MODEL_PARSE 的注释。
 */
export function makeLlm(): LlmBackend {
  return (process.env.KB_LLM ?? "ark").toLowerCase() === "claude"
    ? new LlmClient()
    : new ArkLlmClient();
}
