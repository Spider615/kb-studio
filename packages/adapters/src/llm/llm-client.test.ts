import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerSystemPrompt } from "./llm-client";

const BASE = "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。";

test("无背景时返回基础提示词，不追加内容", () => {
  assert.equal(buildAnswerSystemPrompt(), BASE);
  assert.equal(buildAnswerSystemPrompt(null), BASE);
  assert.equal(buildAnswerSystemPrompt(""), BASE);
});

test("有背景时追加客户背景块，且提醒不要逐字复述", () => {
  const out = buildAnswerSystemPrompt("用途：做售后客服机器人");
  assert.ok(out.startsWith(BASE));
  assert.ok(out.includes("<客户背景>"));
  assert.ok(out.includes("用途：做售后客服机器人"));
  assert.ok(out.includes("不要在回答中逐字复述"));
  assert.ok(out.includes("</客户背景>"));
});
