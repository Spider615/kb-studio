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

/** 把 Anthropic messages 响应解析成中立的 RunToolsTurn。纯函数，可测。 */
export function parseToolsTurn(res: any): RunToolsTurn {
  let text = "";
  const toolUses: ToolUseRequest[] = [];
  for (const block of res?.content ?? []) {
    if (block.type === "text") text += block.text;
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

  constructor(opts: LlmClientOptions = {}) {
    installProxyFromEnv(); // 直连 302 海外端点需走代理（host 上有 HTTPS_PROXY；容器里没有则直连）
    const baseURL = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.302.ai";
    const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN;
    if (!authToken) throw new Error("LlmClient: 缺少 ANTHROPIC_AUTH_TOKEN（302 key），检查 .env");
    this.defaultModel = opts.model ?? process.env.KB_MODEL_CONTEXT ?? "claude-haiku-4-5-20251001";
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
      model: opts.model ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
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

  /** 一次无工具、无 citations 的纯文本调用（目录页生成等内部用途）。 */
  async answerRaw(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
    const res = await this.client.messages.create({
      model: opts.model ?? this.defaultModel,
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
    opts: { model?: string; maxTokens?: number } = {},
  ): Promise<RunToolsTurn> {
    const res: any = await this.client.messages.create({
      model: opts.model ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
      max_tokens: opts.maxTokens ?? 2048,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages,
    } as any);
    return parseToolsTurn(res);
  }
}

function firstText(res: { content: any[] }): string {
  const block = res.content.find((b) => b?.type === "text");
  return (block?.text ?? "").trim();
}
