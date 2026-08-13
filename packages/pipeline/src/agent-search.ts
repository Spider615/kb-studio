import { estimateTokens } from "@kb/core";
import { appendGroupContext, type OpenAICompatEmbedder } from "@kb/adapters";
import { TOOL_SPECS, runTool, safeTruncateUtf16, type ToolDeps } from "./agent-tools";

/** 累计注入的工具结果 token 上限：超过则停止接受新工具调用，转为强制作答。 */
const CONTEXT_BUDGET_TOKENS = 120_000;

/**
 * B 栏每轮作答的 max_tokens 上限，必须与 A 栏 `llm-client.ts` `answer()` 硬编码的
 * `max_tokens: 1024` 保持一致，一个字都不能改。
 *
 * `/ab` 对比实验的前提是两栏之间**只有检索方式这一个变量不同**，其余输入必须完全一致。
 * 这里如果不显式传，runTools 会退到 buildRunToolsParams 的默认值 2048——B 栏就能写两倍长的
 * 答案，人工评分比较"完整性/覆盖度"时会系统性偏向 B，而这与检索方式本身无关，两栏答案长度
 * 上限必须一致，否则实验数据直接失效。
 */
export const B_ANSWER_MAX_TOKENS = 1024;

export const AGENT_SYSTEM =
  "你是知识库检索助手，通过工具自主查阅资料后作答。\n" +
  "工作方式：先用 list_docs / search / grep 定位到相关文档，再用 read_outline 看它的结构，" +
  "再用 read_page 读完整的一页。需要完整条款或完整流程时必须读整页，不要只凭检索到的定位信息猜测内容。\n" +
  "涉及多个主题时分别读对应的页，注意页与页之间的关联（例如某页的规则是否被另一页修正）。\n" +
  "信息足够就立即作答，不要无谓翻页。作答只依据读到的资料，不编造；说明依据来自哪份文档的哪一页。";

export interface AgentSearchDeps {
  llm: { runTools: (system: string, messages: any[], tools: any[], opts?: any) => Promise<any> };
  embedder: OpenAICompatEmbedder;
  docIds: string[];
}

export interface AgentSearchOptions {
  maxTurns?: number;
  model?: string;
  /** 客户对该知识库/Agent 的背景诉求（分组 agentPurpose/agentNotes 拼成），注入 system 提示词。
   *  拼法与 llm/prompts.ts 的 buildAnswerSystemPrompt 共用 appendGroupContext，两条链路口径一致。 */
  groupContext?: string | null;
  /** 注入式工具执行器（测试用假实现；生产默认走 agent-tools 的 runTool）。 */
  runToolFn?: (name: string, input: any, deps: ToolDeps) => Promise<string>;
}

export interface AgentTraceStep {
  step: number;
  tool: string;
  args: unknown;
  resultSummary: string;
  ms: number;
}

export interface AgentSearchResult {
  answer: string;
  trace: AgentTraceStep[];
  tokens: { input: number; output: number };
  turnsUsed: number;
  truncated: boolean;
}

export async function agentSearch(
  query: string,
  deps: AgentSearchDeps,
  opts: AgentSearchOptions = {},
): Promise<AgentSearchResult> {
  const maxTurns = opts.maxTurns ?? 12;
  const exec = opts.runToolFn ?? runTool;
  const toolDeps: ToolDeps = { embedder: deps.embedder, docIds: deps.docIds };
  // 强制作答轮换了一套提示语，客户背景要跟着带上，两个 system 变体都算一遍
  const systemNormal = appendGroupContext(AGENT_SYSTEM, opts.groupContext);
  const systemForced = appendGroupContext(
    `${AGENT_SYSTEM}\n\n注意：不能再查阅资料了，请基于已读到的内容直接作答；若信息不足，如实说明缺什么。`,
    opts.groupContext,
  );

  const messages: any[] = [{ role: "user", content: query }];
  const trace: AgentTraceStep[] = [];
  const tokens = { input: 0, output: 0 };
  let injected = 0; // 已注入的工具结果 token
  let truncated = false;
  let answer = "";
  let turnsUsed = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    const budgetExhausted = injected >= CONTEXT_BUDGET_TOKENS;
    // 预算耗尽或最后一轮：强制模型基于已读内容作答，不再让它使用工具。
    // 断工具靠 tool_choice:"none"（下方 opts），不是把 tools 数组清空——messages 里此时
    // 已经堆了历史轮次的 tool_use/tool_result 块，撤掉 tools 字段会被网关判 400（见
    // llm-client.ts RunToolsOpts.toolChoice 的注释）。
    // 一旦进入强制作答，本次结果就是「信息可能不全」的，标 truncated。
    const forceAnswer = budgetExhausted || turn === maxTurns - 1;
    if (forceAnswer) truncated = true;
    const res = await deps.llm.runTools(forceAnswer ? systemForced : systemNormal, messages, TOOL_SPECS, {
      model: opts.model,
      maxTokens: B_ANSWER_MAX_TOKENS, // 与 A 栏 answer() 对齐，见上方常量注释
      ...(forceAnswer ? { toolChoice: { type: "none" } } : {}),
    });
    tokens.input += res.usage?.input ?? 0;
    tokens.output += res.usage?.output ?? 0;

    if (!res.toolUses || res.toolUses.length === 0) {
      answer = res.text;
      // 模型自己收了工，但如果是在 max_tokens 处被截停的，text 只是半截答案——不消费这个信号
      // 就会被当成正常收尾放行，truncated 仍是 false，用户拿到一份看不出被截断的残缺答案。
      if (res.stopReason === "max_tokens") truncated = true;
      break;
    }

    // 模型请求工具：本轮把 assistant 的 tool_use 块与工具结果一并追加进 messages
    messages.push({
      role: "assistant",
      content: [
        ...(res.text ? [{ type: "text", text: res.text }] : []),
        ...res.toolUses.map((t: any) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
      ],
    });

    const results: any[] = [];
    for (const t of res.toolUses) {
      const started = Date.now();
      const out = await exec(t.name, t.input, toolDeps);
      const ms = Date.now() - started;
      injected += estimateTokens(out);
      trace.push({
        step: trace.length + 1,
        tool: t.name,
        args: t.input,
        resultSummary: out.length > 200 ? `${safeTruncateUtf16(out, 200)}…` : out,
        ms,
      });
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }

  if (!answer) {
    answer = "未能在限定轮次内得出答案。";
    truncated = true;
  }
  return { answer, trace, tokens, turnsUsed, truncated };
}
