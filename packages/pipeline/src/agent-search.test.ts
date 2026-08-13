import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSearch, B_ANSWER_MAX_TOKENS } from "./agent-search";

/** 假 LLM：按预设脚本逐轮返回。 */
function fakeLlm(script: Array<{ text: string; toolUses: Array<{ id: string; name: string; input: any }>; stopReason?: string }>) {
  let i = 0;
  return {
    async runTools() {
      const turn = script[Math.min(i, script.length - 1)]!;
      i++;
      return {
        text: turn.text,
        toolUses: turn.toolUses,
        usage: { input: 100, output: 20 },
        stopReason: turn.stopReason ?? (turn.toolUses.length ? "tool_use" : "end_turn"),
      };
    },
  } as any;
}

/** 同 fakeLlm，但把每次调用的 (system, messages, tools, opts) 都记下来，供断言实际下发了什么。 */
function recordingFakeLlm(script: Array<{ text: string; toolUses: Array<{ id: string; name: string; input: any }>; stopReason?: string }>) {
  let i = 0;
  const calls: Array<{ system: string; messages: any[]; tools: any[]; opts: any }> = [];
  return {
    calls,
    async runTools(system: string, messages: any[], tools: any[], opts: any) {
      calls.push({ system, messages, tools, opts });
      const turn = script[Math.min(i, script.length - 1)]!;
      i++;
      return {
        text: turn.text,
        toolUses: turn.toolUses,
        usage: { input: 100, output: 20 },
        stopReason: turn.stopReason ?? (turn.toolUses.length ? "tool_use" : "end_turn"),
      };
    },
  };
}

const noopDeps = { embedder: {} as any, docIds: ["doc_1"] };

test("模型不再请求工具时循环终止并返回答案", async () => {
  const llm = fakeLlm([
    { text: "", toolUses: [{ id: "t1", name: "list_docs", input: {} }] },
    { text: "答案是三天。", toolUses: [] },
  ]);
  const r = await agentSearch("多久到账？", { llm, ...noopDeps }, { runToolFn: async () => "doc_1 · 手册（3 页）" });
  assert.equal(r.answer, "答案是三天。");
  assert.equal(r.trace.length, 1);
  assert.equal(r.trace[0]!.tool, "list_docs");
  assert.equal(r.truncated, false);
  assert.equal(r.tokens.input, 200); // 两轮各 100
});

test("maxTurns 耗尽时不报错，强制作答并标 truncated", async () => {
  const llm = fakeLlm([{ text: "", toolUses: [{ id: "t", name: "list_docs", input: {} }] }]); // 永远要工具
  const r = await agentSearch("问题", { llm, ...noopDeps }, { maxTurns: 3, runToolFn: async () => "结果" });
  assert.equal(r.truncated, true);
  assert.equal(r.turnsUsed, 3);
  assert.ok(r.trace.length >= 3);
});

test("工具报错不中断循环，错误文本回灌给模型", async () => {
  const llm = fakeLlm([
    { text: "", toolUses: [{ id: "t1", name: "read_page", input: { docId: "doc_1", pageIndex: 99 } }] },
    { text: "改读第 1 页后得到答案。", toolUses: [] },
  ]);
  const r = await agentSearch("问题", { llm, ...noopDeps }, { runToolFn: async () => "错误：没有第 99 页，有效范围是 0-3。" });
  assert.equal(r.answer, "改读第 1 页后得到答案。");
  assert.ok(r.trace[0]!.resultSummary.includes("错误"));
});

test("trace 的 resultSummary 截断不切坏落在第 200 个 code unit 上的 emoji 代理对", async () => {
  // 前 199 个 code unit 是 CJK 字，紧接着一个 emoji（代理对）——slice(0,200) 恰好只吃到
  // 高位代理，不含配对的低位代理，是复现「裸代理」问题的最小构造。
  const longResult = "字".repeat(199) + "\u{1F600}" + "字".repeat(50);
  const llm = fakeLlm([
    { text: "", toolUses: [{ id: "t1", name: "search", input: { query: "问题" } }] },
    { text: "答案。", toolUses: [] },
  ]);
  const r = await agentSearch("问题", { llm, ...noopDeps }, { runToolFn: async () => longResult });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.trace[0]!.resultSummary), "resultSummary 不应含孤立的高位代理");
});

test("模型不再请求工具但在 max_tokens 处被截停：答案是半截的，必须标 truncated", async () => {
  // 与「模型主动收工」（stopReason: end_turn）区分开：toolUses 都是空数组，唯一的区别信号
  // 就是 stopReason，不消费它就会把半截答案当正常作答放行。
  const llm = fakeLlm([{ text: "半截答案", toolUses: [], stopReason: "max_tokens" }]);
  const r = await agentSearch("问题", { llm, ...noopDeps });
  assert.equal(r.answer, "半截答案");
  assert.equal(r.truncated, true);
});

test("每轮显式传 maxTokens，与 A 栏 answer() 的 max_tokens:1024 对齐", async () => {
  const llm = recordingFakeLlm([
    { text: "", toolUses: [{ id: "t1", name: "list_docs", input: {} }] },
    { text: "答案。", toolUses: [] },
  ]);
  await agentSearch("问题", { llm, ...noopDeps }, { runToolFn: async () => "结果" });
  assert.equal(llm.calls.length, 2);
  for (const c of llm.calls) assert.equal(c.opts.maxTokens, B_ANSWER_MAX_TOKENS);
});

test("强制作答轮（maxTurns 耗尽）仍下发完整 tools 数组 + tool_choice:none，不是把 tools 清空", async () => {
  // 这条路径是 maxTurns 耗尽/预算耗尽时的唯一兜底：messages 里已经堆了历史轮次的
  // tool_use/tool_result 块，若靠「省略 tools 字段」断工具，真实网关会判 400（必修 2）。
  const llm = recordingFakeLlm([{ text: "", toolUses: [{ id: "t", name: "list_docs", input: {} }] }]); // 永远要工具，逼到 maxTurns
  const r = await agentSearch("问题", { llm, ...noopDeps }, { maxTurns: 2, runToolFn: async () => "结果" });
  assert.equal(r.truncated, true);
  const lastCall = llm.calls[llm.calls.length - 1]!;
  assert.ok(lastCall.tools.length > 0, "强制作答轮不应该把 tools 清空");
  assert.deepEqual(lastCall.opts.toolChoice, { type: "none" });
  // 非强制轮不应该带 toolChoice，避免测试只锁死"存在"而漏了"仅在强制轮出现"这个条件
  assert.equal(llm.calls[0]!.opts.toolChoice, undefined);
});
