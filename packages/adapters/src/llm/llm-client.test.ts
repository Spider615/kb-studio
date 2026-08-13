import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerSystemPrompt, buildContextualizeContent, LlmClient } from "./llm-client";

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

// 必修 4 的核心断言：answerRaw() 不能踩共用环境变量 KB_MODEL_CONTEXT 的坑。真实 .env 里这个
// 变量是豆包模型名（两个后端共用），直接发到 302 的 Anthropic 端点会错，被 buildWiki 的
// try/catch 吞掉、静默退回确定性目录。这里不发真实请求，monkey-patch 掉 SDK 内部的
// messages.create 只为拦截实际拼进请求体的 model 字段。
test("answerRaw 默认模型不读 KB_MODEL_CONTEXT（可能是豆包名），退回 KB_MODEL_AGENT 或其默认值", async () => {
  const saved = {
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    context: process.env.KB_MODEL_CONTEXT,
    agent: process.env.KB_MODEL_AGENT,
  };
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  process.env.KB_MODEL_CONTEXT = "doubao-seed-2-0-lite-260428"; // 模拟真实 .env 的共用变量
  delete process.env.KB_MODEL_AGENT;
  try {
    const client = new LlmClient();
    let capturedModel: string | undefined;
    (client as any).client.messages.create = async (params: any) => {
      capturedModel = params.model;
      return { content: [{ type: "text", text: "1. 目录\n2. 正文" }] };
    };
    const text = await client.answerRaw("system", "user");
    assert.equal(text, "1. 目录\n2. 正文");
    assert.equal(capturedModel, "claude-opus-4-8"); // 不是 doubao-seed-2-0-lite-260428
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const envKey = k === "token" ? "ANTHROPIC_AUTH_TOKEN" : k === "context" ? "KB_MODEL_CONTEXT" : "KB_MODEL_AGENT";
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  }
});

test("answerRaw 的 rawModel 构造选项优先于 KB_MODEL_AGENT 兜底", async () => {
  const saved = { token: process.env.ANTHROPIC_AUTH_TOKEN, context: process.env.KB_MODEL_CONTEXT };
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  process.env.KB_MODEL_CONTEXT = "doubao-seed-2-0-lite-260428";
  try {
    const client = new LlmClient({ rawModel: "claude-haiku-4-5-20251001" });
    let capturedModel: string | undefined;
    (client as any).client.messages.create = async (params: any) => {
      capturedModel = params.model;
      return { content: [{ type: "text", text: "ok" }] };
    };
    await client.answerRaw("system", "user");
    assert.equal(capturedModel, "claude-haiku-4-5-20251001");
  } finally {
    if (saved.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    if (saved.context === undefined) delete process.env.KB_MODEL_CONTEXT;
    else process.env.KB_MODEL_CONTEXT = saved.context;
  }
});
