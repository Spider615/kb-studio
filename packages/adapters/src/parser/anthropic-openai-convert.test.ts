import test from "node:test";
import assert from "node:assert/strict";
import {
  StreamConverter,
  anthropicToOpenAI,
  flattenSystem,
  mapStopReason,
  openAIToAnthropicMessage,
} from "./anthropic-openai-convert";

const OPTS = { targetModel: "doubao-seed-2-0-code-preview-260215" };

test("system 从顶层参数挪进 messages[0]（string 与 block 数组都支持）", () => {
  const a = anthropicToOpenAI({ system: "你是助手", messages: [{ role: "user", content: "hi" }] }, OPTS);
  assert.deepEqual((a.messages as any[])[0], { role: "system", content: "你是助手" });

  const b = anthropicToOpenAI(
    { system: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }], messages: [] },
    OPTS,
  );
  assert.equal((b.messages as any[])[0].content, "第一段\n\n第二段");
});

test("模型名被强制覆盖成目标豆包模型（SDK 传的 claude-* 不生效）", () => {
  const a = anthropicToOpenAI({ model: "claude-haiku-4-5-20251001", messages: [] }, OPTS);
  assert.equal(a.model, OPTS.targetModel);
});

test("工具定义 input_schema → OpenAI function.parameters", () => {
  const a = anthropicToOpenAI(
    {
      messages: [],
      tools: [{ name: "bash", description: "跑命令", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }],
    },
    OPTS,
  );
  assert.deepEqual((a.tools as any[])[0], {
    type: "function",
    function: {
      name: "bash",
      description: "跑命令",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
  });
});

test("assistant 的 tool_use block → OpenAI tool_calls（input 序列化成字符串）", () => {
  const a = anthropicToOpenAI(
    {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } }] },
      ],
    },
    OPTS,
  );
  const m = (a.messages as any[])[0];
  assert.equal(m.role, "assistant");
  assert.deepEqual(m.tool_calls[0], {
    id: "tu_1",
    type: "function",
    function: { name: "bash", arguments: '{"cmd":"ls"}' },
  });
});

test("user 里的 tool_result 被拆成独立的 role:tool 消息（两边结构差异的核心）", () => {
  const a = anthropicToOpenAI(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
            { type: "text", text: "继续" },
          ],
        },
      ],
    },
    OPTS,
  );
  const ms = a.messages as any[];
  // 自身文本消息在前，拆出的 tool 消息在后
  assert.equal(ms.length, 2);
  assert.equal(ms[0].role, "user");
  assert.equal(ms[0].content, "继续");
  assert.deepEqual(ms[1], { role: "tool", tool_call_id: "tu_1", content: "file.txt" });
});

test("图片 block 从 Anthropic base64 source 转成 OpenAI data URI", () => {
  const a = anthropicToOpenAI(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: "看图" },
          ],
        },
      ],
    },
    OPTS,
  );
  const parts = (a.messages as any[])[0].content;
  assert.equal(parts[0].image_url.url, "data:image/png;base64,AAAA");
  assert.equal(parts[1].text, "看图");
});

test("解析场景默认关思考，并显式带上 max_tokens", () => {
  const a = anthropicToOpenAI({ messages: [], max_tokens: 8000 }, OPTS);
  assert.deepEqual(a.thinking, { type: "disabled" });
  assert.equal(a.max_tokens, 8000);
  // 不传时兜 4096，绝不让方舟吃自己的默认值
  assert.equal(anthropicToOpenAI({ messages: [] }, OPTS).max_tokens, 4096);
});

test("stop_reason 映射：tool_calls→tool_use，length→max_tokens", () => {
  assert.equal(mapStopReason("tool_calls"), "tool_use");
  assert.equal(mapStopReason("length"), "max_tokens");
  assert.equal(mapStopReason("stop"), "end_turn");
});

test("flattenSystem 对空值安全", () => {
  assert.equal(flattenSystem(undefined), "");
  assert.equal(flattenSystem(null), "");
});

test("非流式响应：tool_calls → tool_use block，arguments 反序列化成 input", () => {
  const msg = openAIToAnthropicMessage(
    {
      id: "x",
      model: "doubao",
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: "我来看看", tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    "fallback",
  ) as any;
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content[0], { type: "text", text: "我来看看" });
  assert.deepEqual(msg.content[1], { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } });
  assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 5 });
});

test("非流式：arguments 不是合法 JSON 时给空 input，不整条崩掉", () => {
  const msg = openAIToAnthropicMessage(
    { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c", function: { name: "b", arguments: "{坏" } }] } }] },
    "m",
  ) as any;
  assert.deepEqual(msg.content[0].input, {});
});

test("流式：文本块产生 start→delta→stop 且 index 连续", () => {
  const c = new StreamConverter("msg_1", "doubao");
  const start = c.start();
  assert.equal(start[0]!.event, "message_start");

  const e1 = c.chunk({ choices: [{ delta: { content: "你好" } }] });
  assert.equal(e1[0]!.event, "content_block_start");
  assert.equal((e1[0]!.data as any).index, 0);
  assert.equal(e1[1]!.event, "content_block_delta");
  assert.equal((e1[1]!.data as any).delta.text, "你好");

  // 第二段文本不再重复 start
  const e2 = c.chunk({ choices: [{ delta: { content: "世界" } }] });
  assert.equal(e2.length, 1);
  assert.equal(e2[0]!.event, "content_block_delta");

  const fin = c.finish();
  assert.equal(fin[0]!.event, "content_block_stop");
  assert.equal(fin[1]!.event, "message_delta");
  assert.equal(fin[2]!.event, "message_stop");
});

test("流式：tool_calls 增量攒成 tool_use 块，且开工具块前先收掉文本块", () => {
  const c = new StreamConverter("msg_2", "doubao");
  c.start();
  c.chunk({ choices: [{ delta: { content: "先看看" } }] }); // 打开 index 0 文本块

  const e = c.chunk({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "" } }] } }],
  });
  // Anthropic 不允许块交叉：必须先 stop 文本块，再 start 工具块
  assert.equal(e[0]!.event, "content_block_stop");
  assert.equal((e[0]!.data as any).index, 0);
  assert.equal(e[1]!.event, "content_block_start");
  assert.equal((e[1]!.data as any).index, 1);
  assert.equal((e[1]!.data as any).content_block.type, "tool_use");
  assert.equal((e[1]!.data as any).content_block.name, "bash");

  const d = c.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } }] });
  assert.equal((d[0]!.data as any).delta.type, "input_json_delta");
  assert.equal((d[0]!.data as any).delta.partial_json, '{"cmd":');

  const fin = c.finish();
  assert.equal(fin[0]!.event, "content_block_stop");
  assert.equal((fin[0]!.data as any).index, 1);
});

test("流式：finish_reason=tool_calls 反映到 message_delta.stop_reason", () => {
  const c = new StreamConverter("msg_3", "doubao");
  c.start();
  c.chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  const fin = c.finish();
  const md = fin.find((e) => e.event === "message_delta")!;
  assert.equal((md.data as any).delta.stop_reason, "tool_use");
});
