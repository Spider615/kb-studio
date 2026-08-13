// 只测响应解析，不发真实请求：注入一个假的 messages.create。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolsTurn } from "./llm-client";

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
