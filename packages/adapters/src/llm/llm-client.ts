import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmBackend,
  AnswerChunk,
  AnswerOptions,
  AnswerResult,
  VisionOptions,
  ToolSpec,
  ToolUseRequest,
  RunToolsTurn,
} from "@kb/core";
import { installProxyFromEnv } from "../proxy";
import {
  CONTEXTUALIZE_SYSTEM,
  REWRITE_SYSTEM,
  STRUCTURE_SYSTEM,
  applyInserts,
  buildAnswerSystemPrompt,
  buildContextualizeDocText,
  buildContextualizeInstruction,
  buildRewriteUserPrompt,
  buildStructureUserPrompt,
  numberBlocks,
  parseInserts,
  splitBlocks,
} from "./prompts";

export interface LlmClientOptions {
  baseUrl?: string;
  authToken?: string;
  model?: string;
  /** answer() 专用模型，独立于 KB_MODEL_ANSWER（该 env 被 LlmClient/ArkLlmClient 两个后端共用，
   *  值可能是豆包模型名）。传了就优先于 env，不传时行为与改动前完全一致。 */
  answerModel?: string;
  /** answerRaw() 专用模型（目录页生成等一次性纯文本调用），与 answerModel 对称、避开同一个坑：
   *  answerRaw() 原先退到 this.defaultModel（= KB_MODEL_CONTEXT，该 env 同样两个后端共用、真实
   *  部署下是豆包模型名），打这里的 Anthropic /v1/messages 端点必错——而调用方 buildWiki 外包了
   *  一层 try/catch，只 console.warn 一行就静默退回确定性目录，功能拿不到还不报错。
   *  不传时退回 KB_MODEL_AGENT（runTools 已经在用同一个「必须是真 Anthropic 模型」的坑的解法）
   *  而不是 defaultModel，所以哪怕调用方（如 wiki-demo.ts 的 makeLlm()）不显式传这个选项，
   *  只要 .env 没把 KB_MODEL_AGENT 填成豆包名，行为也是对的。 */
  rawModel?: string;
}

// 提示词已挪到 ./prompts 与方舟后端共用；此处 re-export 保持既有 import 路径不变。
export { buildAnswerSystemPrompt } from "./prompts";

/** 上下文化的 user content（两块文本）：可缓存文档块（含标题）+ 含「归属补全」的说明指令。纯函数，便于单测。 */
export function buildContextualizeContent(
  fullDoc: string,
  chunk: string,
  title?: string,
): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: buildContextualizeDocText(fullDoc, title), cache_control: { type: "ephemeral" } },
    { type: "text", text: buildContextualizeInstruction(chunk) },
  ];
}

export interface RunToolsOpts {
  model?: string;
  maxTokens?: number;
  /**
   * 显式传 `{ type: "none" }` 可以在**保留 tools 数组**的前提下让模型这一轮不请求工具
   * （agentSearch 的强制作答轮用它）。不要靠"不下发 tools 字段"来断工具：Anthropic 协议要求
   * 续接请求的 tools 数组与历史轮次里已经出现过的 tool_use/tool_result 块保持一致，
   * messages 里堆着历史工具调用时把 tools 撤掉，网关会判 400——这条路径又恰好是
   * maxTurns 耗尽/预算耗尽时的唯一兜底，一旦触发就是生产环境唯一一次真正要它工作的时候。
   */
  toolChoice?: { type: "none" | "auto" | "any" } | { type: "tool"; name: string };
}

/** 构造 runTools 的请求参数：纯函数，便于单测断言 tools 为空数组时不下发 tools 字段
 *  （而不是发字面量 `tools: []`——SDK/Anthropic 协议对「省略」与「空数组」是否等价没有明文保证，
 *  没必要留这个不确定性）。这条「空数组时省略」的逻辑只服务于"确实没有任何工具可用"的场景；
 *  "有工具、但这一轮不想让模型用"的场景请走 opts.toolChoice，不要清空 tools 数组来伪造它。 */
export function buildRunToolsParams(
  system: string,
  messages: any[],
  tools: ToolSpec[],
  opts: RunToolsOpts = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    // 不读 KB_MODEL_ANSWER：那个变量两个后端共用，方舟部署下会是豆包模型名，
    // 打到这里的 Anthropic /v1/messages 协议端点会 400（即便被路由也不支持 tools 参数）。
    model: opts.model ?? process.env.KB_MODEL_AGENT ?? "claude-opus-4-8",
    max_tokens: opts.maxTokens ?? 2048,
    system,
    messages,
  };
  if (tools.length > 0) {
    params.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    // tool_choice 只在下发了 tools 时才有意义，且必须与 tools 同批下发——不存在「tools 为空但传
    // tool_choice」的合法场景，放在这个分支里天然保证了这一点。
    if (opts.toolChoice) params.tool_choice = opts.toolChoice;
  }
  return params;
}

/** 把 Anthropic messages 响应解析成中立的 RunToolsTurn。纯函数，可测。 */
export function parseToolsTurn(res: any): RunToolsTurn {
  let text = "";
  const toolUses: ToolUseRequest[] = [];
  // content 可能是非数组的畸形响应（网关异常/协议不符），只信 Array.isArray，不能只挡 null/undefined
  const blocks: any[] = Array.isArray(res?.content) ? res.content : [];
  for (const block of blocks) {
    if (block.type === "text") text += block.text ?? ""; // text 字段缺失时不拼进字面量 "undefined"
    else if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
  }
  return {
    text: text.trim(),
    toolUses,
    usage: { input: res?.usage?.input_tokens ?? 0, output: res?.usage?.output_tokens ?? 0 },
    stopReason: res?.stop_reason ?? "end_turn",
  };
}

/**
 * 直连 302 网关的 Claude 客户端（Anthropic 格式 /v1/messages）。
 * 造结构 / 上下文化 / vision / citations 共用。用 Authorization: Bearer（302 key），
 * 显式抹掉 x-api-key，避免和 Bearer 冲突（也防止环境里残留的 ANTHROPIC_API_KEY 串进来）。
 *
 * 与 ArkLlmClient 同为 LlmBackend 实现，可整体替换；差别在 answer() 的溯源强度——
 * 这里走 Anthropic 协议级 citations，cited_text 由 API 保证逐字来自原文。
 */
export class LlmClient implements LlmBackend {
  private client: Anthropic;
  private defaultModel: string;
  private answerModel?: string;
  private rawModel?: string;

  constructor(opts: LlmClientOptions = {}) {
    installProxyFromEnv(); // 直连 302 海外端点需走代理（host 上有 HTTPS_PROXY；容器里没有则直连）
    const baseURL = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.302.ai";
    const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN;
    if (!authToken) throw new Error("LlmClient: 缺少 ANTHROPIC_AUTH_TOKEN（302 key），检查 .env");
    this.defaultModel = opts.model ?? process.env.KB_MODEL_CONTEXT ?? "claude-haiku-4-5-20251001";
    this.answerModel = opts.answerModel;
    this.rawModel = opts.rawModel;
    this.client = new Anthropic({
      baseURL,
      authToken,
      apiKey: null,
      defaultHeaders: { "x-api-key": null },
    });
  }

  /**
   * 造结构（大文档安全）：让模型**只决定"在哪插什么标题"**（输出一小段 JSON 清单），
   * 原文按段落编号、由本地机械插回——模型不重新输出任何正文，从构造上杜绝截断/丢内容。
   * 输出只是标题清单（小），不会因文档大而超 max_tokens。
   */
  async structure(markdown: string, model?: string): Promise<string> {
    const blocks = splitBlocks(markdown);
    if (blocks.length <= 1) return markdown.trim(); // 无可分段结构，原样返回
    const res = await this.client.messages.create({
      // 见 ArkLlmClient.structure 的说明：造结构与解析层 Agent SDK 不再共用 KB_MODEL_PARSE
      model: model ?? process.env.KB_MODEL_STRUCTURE ?? this.defaultModel,
      max_tokens: 8000,
      system: STRUCTURE_SYSTEM,
      messages: [{ role: "user", content: buildStructureUserPrompt(numberBlocks(blocks)) }],
    });
    return applyInserts(blocks, parseInserts(firstText(res), blocks.length));
  }

  /** 视觉/OCR：把一张图片（base64）连同提示喂给 vision 模型，返回文字。默认用 KB_MODEL_VISION（haiku）。 */
  async vision(imageBase64: string, prompt: string, opts: VisionOptions = {}): Promise<string> {
    const res = await this.client.messages.create({
      model: opts.model ?? process.env.KB_MODEL_VISION ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (opts.mediaType ?? "image/png") as any,
                data: imageBase64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    return firstText(res);
  }

  /** 上下文化：给一个 chunk 生成 50~100 字上下文前缀；整份文档 + 文件名走 prompt caching。
   *  title 存在时会喂给模型，并要求它在片段缺归属（品牌/公司/时间）时从文件名补出。 */
  async contextualize(fullDoc: string, chunk: string, title?: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? this.defaultModel,
      max_tokens: 300,
      system: CONTEXTUALIZE_SYSTEM,
      messages: [{ role: "user", content: buildContextualizeContent(fullDoc, chunk, title) }],
    });
    return firstText(res);
  }

  /** Citations 问答：把 top chunks 作可引用文档喂 Opus，返回 {answer, sources}（block_index→chunk 反查）。
   *  opts.history：多轮对话的前几轮 {role,content}，会垫进 messages 数组（仅最后一轮带可引用 document）。
   *  opts.groupContext：对话 scope 限定到某分组时，该分组的 Agent 用途/补充拼成的客户背景，注入 system。 */
  async answer(query: string, chunks: AnswerChunk[], opts: AnswerOptions = {}): Promise<AnswerResult> {
    const history = (opts.history ?? []).map((m) => ({ role: m.role, content: m.content }));
    const params: any = {
      model: opts.model ?? this.answerModel ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
      max_tokens: 1024,
      system: buildAnswerSystemPrompt(opts.groupContext),
      messages: [
        ...history,
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "content", content: chunks.map((c) => ({ type: "text", text: c.content })) },
              citations: { enabled: true },
            },
            { type: "text", text: query },
          ],
        },
      ],
    };
    const res: any = await this.client.messages.create(params);
    let answer = "";
    const sources: AnswerResult["sources"] = [];
    const seen = new Set<string>();
    for (const block of res.content ?? []) {
      if (block.type !== "text") continue;
      answer += block.text;
      for (const cite of block.citations ?? []) {
        const idx = cite.start_block_index ?? cite.document_index ?? -1;
        const ch = chunks[idx];
        if (ch && !seen.has(ch.id)) {
          seen.add(ch.id);
          sources.push({ id: ch.id, heading_path: ch.heading_path });
        }
      }
    }
    return {
      answer: answer.trim(),
      sources,
      usage: { input: res?.usage?.input_tokens ?? 0, output: res?.usage?.output_tokens ?? 0 },
    };
  }

  /** 多轮检索改写：把对话历史 + 最新问题压成一句能独立检索的查询（指代消解、补主语）。
   *  默认走 KB_MODEL_CONTEXT（haiku）。返回空串时调用方应回退原问题。 */
  async rewriteQuery(transcript: string, question: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? this.defaultModel,
      max_tokens: 200,
      system: REWRITE_SYSTEM,
      messages: [{ role: "user", content: buildRewriteUserPrompt(transcript, question) }],
    });
    return firstText(res);
  }

  /** 一次无工具、无 citations 的纯文本调用（目录页生成等内部用途）。
   *  不退到 this.defaultModel：那个读 KB_MODEL_CONTEXT，两个后端共用、真实部署下是豆包模型名，
   *  打这里的 Anthropic /v1/messages 端点会错（调用方 buildWiki 的 try/catch 会吞掉，只
   *  console.warn 一行，静默退回确定性目录，功能拿不到还不报错）。 */
  async answerRaw(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
    const res = await this.client.messages.create({
      model: opts.model ?? this.rawModel ?? process.env.KB_MODEL_AGENT ?? "claude-opus-4-8",
      max_tokens: opts.maxTokens ?? 2048,
      system,
      messages: [{ role: "user", content: user }],
    });
    return firstText(res);
  }

  /** 带工具的单轮调用：返回本轮文本 + 模型请求的工具调用 + usage。循环由调用方（agentSearch）驱动。 */
  async runTools(
    system: string,
    messages: any[],
    tools: ToolSpec[],
    opts: RunToolsOpts = {},
  ): Promise<RunToolsTurn> {
    const res: any = await this.client.messages.create(buildRunToolsParams(system, messages, tools, opts) as any);
    return parseToolsTurn(res);
  }
}

function firstText(res: { content: any[] }): string {
  const block = res.content.find((b) => b?.type === "text");
  return (block?.text ?? "").trim();
}
