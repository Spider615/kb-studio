// 只测响应解析/请求构造，不发真实请求：注入一个假的 messages.create。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolsTurn, buildRunToolsParams } from "./llm-client";

test("解析出文本、工具调用与 usage", () => {
  const res = {
    content: [
      { type: "text", text: "我先看看目录。" },
      { type: "tool_use", id: "tu_1", name: "read_outline", input: { docId: "doc_1" } },
    ],
    usage: { input_tokens: 1200, output_tokens: 80 },
    stop_reason: "tool_use",
  };
  const turn = parseToolsTurn(res);
  assert.equal(turn.text, "我先看看目录。");
  assert.equal(turn.toolUses.length, 1);
  assert.equal(turn.toolUses[0]!.name, "read_outline");
  assert.deepEqual(turn.toolUses[0]!.input, { docId: "doc_1" });
  assert.deepEqual(turn.usage, { input: 1200, output: 80 });
  assert.equal(turn.stopReason, "tool_use");
});

test("没有工具调用时 toolUses 为空数组", () => {
  const turn = parseToolsTurn({
    content: [{ type: "text", text: "答案是三天。" }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  });
  assert.equal(turn.toolUses.length, 0);
  assert.equal(turn.text, "答案是三天。");
});

test("text block 缺 text 字段时不拼出字面量 \"undefined\"", () => {
  const turn = parseToolsTurn({ content: [{ type: "text" }] });
  assert.equal(turn.text, "");
});

test("content 是非数组畸形响应时不抛错、按空轮处理", () => {
  const turn = parseToolsTurn({ content: { not: "an array" } });
  assert.equal(turn.text, "");
  assert.deepEqual(turn.toolUses, []);
});

test("buildRunToolsParams：tools 为空数组时不下发 tools 字段", () => {
  const params = buildRunToolsParams("system", [{ role: "user", content: "问题" }], []);
  assert.ok(!("tools" in params), "tools 为空时不应该出现 tools 键");
  assert.equal(params.system, "system");
});

test("buildRunToolsParams：tools 非空时按 name/description/input_schema 映射下发", () => {
  const tools = [{ name: "list_docs", description: "列出文档", input_schema: { type: "object", properties: {}, required: [] } }];
  const params = buildRunToolsParams("system", [], tools);
  assert.deepEqual(params.tools, [{ name: "list_docs", description: "列出文档", input_schema: tools[0]!.input_schema }]);
});

test("buildRunToolsParams：传 toolChoice:none 时 tools 数组仍然下发，且带上 tool_choice 字段", () => {
  // 这是必修 2 的核心断言：强制作答轮不能靠清空 tools 数组来断工具（历史轮次的 tool_use/
  // tool_result 块还在 messages 里，撤掉 tools 会被 Anthropic 网关判 400），必须走
  // tool_choice:"none"，同时保留完整的 tools 数组。
  const tools = [{ name: "list_docs", description: "列出文档", input_schema: { type: "object", properties: {}, required: [] } }];
  const params = buildRunToolsParams("system", [], tools, { toolChoice: { type: "none" } });
  assert.ok(Array.isArray(params.tools) && (params.tools as unknown[]).length === 1, "tool_choice:none 时 tools 不应被清空");
  assert.deepEqual(params.tool_choice, { type: "none" });
});

test("buildRunToolsParams：不传 toolChoice 时不下发 tool_choice 字段", () => {
  const tools = [{ name: "list_docs", description: "列出文档", input_schema: { type: "object", properties: {}, required: [] } }];
  const params = buildRunToolsParams("system", [], tools);
  assert.ok(!("tool_choice" in params), "不传 toolChoice 时不应该出现 tool_choice 键");
});
