import { retrieve, type RetrieveDeps, type RetrieveOptions } from "./retrieve";
import type { LlmBackend, TokenUsage } from "@kb/core";
import type { SearchHit } from "@kb/db";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDeps extends RetrieveDeps {
  llm: LlmBackend;
}

export interface ChatTurnResult {
  answer: string;
  sources: Array<{ id: string; heading_path: string[] }>;
  hits: SearchHit[];
  standaloneQuery: string;
  usage?: TokenUsage;
}

/** 一轮对话编排：历史感知改写 → 混合检索(+rerank) → 带历史的 Opus 引用作答。
 *  history 为该会话此前的全部轮次（不含本次 query）。
 *  groupContext：scope=某分组时的客户背景（Agent 用途/补充），透传给 Opus system 提示词。 */
export async function chatTurn(
  history: ChatMessage[],
  query: string,
  deps: ChatDeps,
  opts: RetrieveOptions = {},
  groupContext?: string | null,
): Promise<ChatTurnResult> {
  // 首轮无历史，直接用原问题，省一次模型调用
  let standaloneQuery = query;
  if (history.length > 0) {
    const transcript = history
      .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n");
    const rewritten = await deps.llm.rewriteQuery(transcript, query);
    if (rewritten) standaloneQuery = rewritten;
  }

  const hits = await retrieve(standaloneQuery, deps, opts);
  // 零命中：不调 LLM 作答（空上下文会被网关拒），直接返回友好空答案
  if (hits.length === 0) {
    return { answer: "没有找到相关内容。", sources: [], hits: [], standaloneQuery };
  }
  const { answer, sources, usage } = await deps.llm.answer(
    query,
    hits.map((h) => ({ id: h.id, content: h.content, heading_path: h.heading_path })),
    { history, groupContext },
  );
  // 邻居扩展块只作上下文喂 LLM，不计入对外展示的「命中片段」（其 score 非同一量纲）
  const shownHits = hits.filter((h) => h.via !== "neighbor");
  return { answer, sources, hits: shownHits, standaloneQuery, usage };
}

export type { SearchHit };
