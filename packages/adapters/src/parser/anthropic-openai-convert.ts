/**
 * Anthropic Messages 协议 ↔ OpenAI Chat Completions 协议的双向转换（纯函数，便于单测）。
 *
 * 用途：让 @anthropic-ai/claude-agent-sdk（只会说 Anthropic 协议）驱动火山方舟的豆包模型。
 * 配套的 HTTP 反代见 ./ark-anthropic-proxy。
 *
 * 两边协议的结构性差异（不是字段改名那么简单）：
 *  1. system：Anthropic 是顶层参数（string 或 block 数组），OpenAI 要作为 messages[0]；
 *  2. tool_result：Anthropic 塞在 **user** 消息的 content 数组里，OpenAI 要求**独立的
 *     role:"tool" 消息**——所以一条 Anthropic 消息可能要拆成多条 OpenAI 消息；
 *  3. tool_use：Anthropic 是 assistant content 里的一个 block，OpenAI 是 message.tool_calls 数组；
 *  4. 工具定义：Anthropic `{name, description, input_schema}` vs OpenAI `{type:"function", function:{…, parameters}}`；
 *  5. 流式：OpenAI 是扁平的 delta 累积，Anthropic 是带 index 的 content_block 状态机。
 */

// ---------- 请求：Anthropic → OpenAI ----------

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Anthropic 的 system（string 或 block 数组）拍平成一个字符串。 */
export function flattenSystem(system: unknown): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** 把 Anthropic 的一条消息转成若干条 OpenAI 消息（tool_result 要拆出去单独成条）。 */
function convertMessage(msg: any): OpenAIMessage[] {
  const role = msg?.role === "assistant" ? "assistant" : "user";
  const content = msg?.content;

  // content 是纯字符串：直接过
  if (typeof content === "string") return [{ role, content }];
  if (!Array.isArray(content)) return [];

  const out: OpenAIMessage[] = [];
  const parts: Array<Record<string, unknown>> = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];

  for (const block of content) {
    const t = block?.type;
    if (t === "text") {
      parts.push({ type: "text", text: block.text ?? "" });
    } else if (t === "image") {
      // Anthropic: {source:{type:"base64",media_type,data}} → OpenAI: {image_url:{url:"data:…"}}
      const src = block.source ?? {};
      const url =
        src.type === "base64"
          ? `data:${src.media_type ?? "image/png"};base64,${src.data ?? ""}`
          : (src.url ?? "");
      if (url) parts.push({ type: "image_url", image_url: { url } });
    } else if (t === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
      });
    } else if (t === "tool_result") {
      // 工具结果必须独立成 role:"tool" 消息，且要排在引用它的 assistant 消息之后
      out.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id ?? ""),
        content: stringifyToolResult(block.content),
      });
    }
    // 其余（thinking / redacted_thinking 等 Anthropic 私有块）直接丢弃：豆包不认
  }

  const own: OpenAIMessage = { role };
  if (parts.length === 1 && parts[0]!.type === "text") {
    own.content = String(parts[0]!.text ?? ""); // 单段文本用字符串，兼容性最好
  } else if (parts.length > 0) {
    own.content = parts;
  }
  if (toolCalls.length) {
    own.role = "assistant";
    own.tool_calls = toolCalls;
    if (own.content == null) own.content = ""; // 带 tool_calls 时 content 可为空串，但不能缺字段
  }
  // 有内容或有工具调用才产出；纯 tool_result 消息只产出上面拆出的 tool 条目
  if (own.content != null || own.tool_calls) out.unshift(own);
  return out;
}

/** tool_result 的 content 可能是字符串或 block 数组，统一成字符串喂给 OpenAI 的 tool 消息。 */
function stringifyToolResult(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

export interface ConvertRequestOptions {
  /** 强制使用的目标模型（豆包）。Agent SDK 传来的 claude-* 模型名一律被它覆盖。 */
  targetModel: string;
  /** 是否显式关闭深度思考（解析场景应为 true，避免白烧 reasoning token）。默认 true。 */
  disableThinking?: boolean;
}

/** Anthropic /v1/messages 请求体 → OpenAI /chat/completions 请求体。 */
export function anthropicToOpenAI(body: any, opts: ConvertRequestOptions): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];
  const sys = flattenSystem(body?.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of body?.messages ?? []) messages.push(...convertMessage(m));

  const out: Record<string, unknown> = {
    model: opts.targetModel,
    messages,
    // Anthropic 的 max_tokens 是必填；方舟默认才 4096，必须显式带上
    max_tokens: body?.max_tokens ?? 4096,
    stream: !!body?.stream,
  };
  if (typeof body?.temperature === "number") out.temperature = body.temperature;
  if (typeof body?.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body?.stream) out.stream_options = { include_usage: true };

  // 工具定义：input_schema → parameters
  if (Array.isArray(body?.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t: any) => t?.name) // 跳过 Anthropic 服务端工具（web_search 等无 name/schema 的）
      .map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }));
  }
  // tool_choice：{type:"auto"|"any"|"tool",name} → OpenAI 形式
  const tc = body?.tool_choice;
  if (tc?.type === "tool" && tc.name) {
    out.tool_choice = { type: "function", function: { name: tc.name } };
  } else if (tc?.type === "any") {
    out.tool_choice = "required";
  } else if (tc?.type === "auto") {
    out.tool_choice = "auto";
  }

  // 解析场景关思考：豆包新模型默认开，会显著拖慢并烧 reasoning token
  if (opts.disableThinking !== false) out.thinking = { type: "disabled" };
  return out;
}

// ---------- 响应：OpenAI → Anthropic ----------

/** Anthropic 的 stop_reason 取值与 OpenAI finish_reason 的映射。 */
export function mapStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * 流式转换状态机：把 OpenAI 的 chunk 序列翻成 Anthropic 的 content_block 事件序列。
 *
 * Anthropic 侧要求严格配对：每个 content_block 必须 start → delta* → stop，
 * 且 index 连续。OpenAI 侧则是扁平 delta（文本和 tool_calls 可能交替出现），
 * 所以这里要自己维护「当前开着哪个块、它的 index 是多少」。
 */
export class StreamConverter {
  private nextIndex = 0;
  private textOpen = false;
  private textIndex = -1;
  /** OpenAI tool_calls 的 index → 我们分配的 Anthropic content_block index */
  private toolIndex = new Map<number, number>();
  private started = false;
  private stopReason = "end_turn";
  private outputTokens = 0;
  private inputTokens = 0;

  constructor(
    private messageId: string,
    private model: string,
  ) {}

  /** 起始事件（message_start）。必须在任何 content_block 之前发出。 */
  start(): SseEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  /** 处理一个 OpenAI chunk，产出对应的 Anthropic 事件。 */
  chunk(c: any): SseEvent[] {
    const events: SseEvent[] = [];
    const usage = c?.usage;
    if (usage) {
      this.inputTokens = usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = usage.completion_tokens ?? this.outputTokens;
    }
    const choice = c?.choices?.[0];
    if (!choice) return events;
    const delta = choice.delta ?? {};

    // 文本增量
    const text = delta.content;
    if (typeof text === "string" && text.length > 0) {
      if (!this.textOpen) {
        this.textIndex = this.nextIndex++;
        this.textOpen = true;
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          },
        });
      }
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text },
        },
      });
    }

    // 工具调用增量
    for (const tc of delta.tool_calls ?? []) {
      const oaIdx = tc.index ?? 0;
      let idx = this.toolIndex.get(oaIdx);
      if (idx == null) {
        // 新工具块开始前，先把还开着的文本块收掉（Anthropic 不允许交叉）
        if (this.textOpen) {
          events.push({
            event: "content_block_stop",
            data: { type: "content_block_stop", index: this.textIndex },
          });
          this.textOpen = false;
        }
        idx = this.nextIndex++;
        this.toolIndex.set(oaIdx, idx);
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: idx,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `toolu_${this.messageId}_${oaIdx}`,
              name: tc.function?.name ?? "",
              input: {},
            },
          },
        });
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: idx,
            delta: { type: "input_json_delta", partial_json: args },
          },
        });
      }
    }

    if (choice.finish_reason) this.stopReason = mapStopReason(choice.finish_reason);
    return events;
  }

  /** 收尾：关掉所有开着的块，发 message_delta + message_stop。 */
  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.textOpen) {
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.textIndex } });
      this.textOpen = false;
    }
    for (const idx of this.toolIndex.values()) {
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
    }
    this.toolIndex.clear();
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
    return events;
  }
}

/** 非流式：OpenAI 完整响应 → Anthropic Message 对象。 */
export function openAIToAnthropicMessage(resp: any, fallbackModel: string): Record<string, unknown> {
  const choice = resp?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: Array<Record<string, unknown>> = [];
  if (msg.content) content.push({ type: "text", text: String(msg.content) });
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {}; // 参数不是合法 JSON 时给空对象，让上层按「工具调用失败」处理，别整条崩掉
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input });
  }
  return {
    id: resp?.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp?.model ?? fallbackModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.prompt_tokens ?? 0,
      output_tokens: resp?.usage?.completion_tokens ?? 0,
    },
  };
}
