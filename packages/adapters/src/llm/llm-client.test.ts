import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerSystemPrompt, buildContextualizeContent } from "./llm-client";

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

test("buildContextualizeContent 传 title：可缓存块含《title》+cache_control，第二块含归属补全", () => {
  const content = buildContextualizeContent("整份文档正文XYZ", "某片段ABC", "2022年-精骐&捷美-产品价格表.csv");
  const first = content[0] as any;
  assert.ok(first.text.includes("《2022年-精骐&捷美-产品价格表.csv》"));
  assert.ok(first.text.includes("<document>"));
  assert.ok(first.text.includes("整份文档正文XYZ"));
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
  const second = content[1] as any;
  assert.ok(second.text.includes("<chunk>"));
  assert.ok(second.text.includes("某片段ABC"));
  assert.ok(second.text.includes("归属"));
});

test("buildContextualizeContent 不传 title：可缓存块无标题行、无《》（向后兼容）", () => {
  const content = buildContextualizeContent("正文", "片段");
  const first = content[0] as any;
  assert.ok(first.text.startsWith("<document>"));
  assert.ok(!first.text.includes("《"));
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
});
