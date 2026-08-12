import type {
  LlmBackend,
  AnswerChunk,
  AnswerOptions,
  AnswerResult,
  VisionOptions,
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
import { CITATION_INSTRUCTION, buildCitedDocsBlock, parseCitations } from "./citations";

export interface ArkLlmClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

type ArkContent = string | Array<Record<string, unknown>>;
interface ArkMessage {
  role: "system" | "user" | "assistant";
  content: ArkContent;
}

/** 方舟默认 max_tokens 只有 4096，且各接口需求差异大 → 每处都显式传，绝不吃默认值。 */
const MAX_TOKENS = {
  structure: 8000,
  contextualize: 300,
  vision: 4096,
  rewrite: 200,
  answer: 1024,
} as const;

/**
 * 火山方舟（Volcengine Ark）客户端，OpenAI 兼容协议 /chat/completions。
 * 与 302 版 LlmClient 实现同一个 LlmBackend 接口，提示词共用 ./prompts，可整体替换。
 *
 * 相对 Anthropic 协议的四处硬差异（都会静默出错，不是报错）：
 *  1. 没有顶层 system 参数 → system 必须作为 messages[0] 的一条；
 *  2. max_tokens 默认 4096 → 造结构等长输出必须显式传，否则被静默截断；
 *  3. 豆包新模型**默认开深度思考** → 解析/上下文化这类确定性任务白烧 reasoning token 且慢，
 *     一律显式 thinking:{type:"disabled"}（等价于项目早年踩过的 Claude 32k thinking 坑）；
 *  4. 没有 cache_control（方舟是隐式缓存，自动生效、不可关、不保证命中）→ 不传该字段，
 *     但仍把整份文档放在指令**前面**，符合官方「静态内容在前」的缓存最佳实践。
 *
 * 网络：ark.cn-beijing.volces.com 是国内端点，由 proxy.ts 的 host 白名单保证不走 Clash。
 */
export class ArkLlmClient implements LlmBackend {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(opts: ArkLlmClientOptions = {}) {
    // 同进程里 302 的 embedder/reranker 仍需代理；这里装的是 host 分流 dispatcher，
    // 火山走直连、302 走代理，两者共存。
    installProxyFromEnv();
    this.baseUrl = (opts.baseUrl ?? process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3")
      .replace(/\/$/, "");
    const key = opts.apiKey ?? process.env.ARK_API_KEY;
    if (!key) throw new Error("ArkLlmClient: 缺少 ARK_API_KEY（火山方舟 key），检查 .env");
    this.apiKey = key;
    this.defaultModel =
      opts.model ?? process.env.KB_MODEL_CONTEXT ?? "doubao-seed-2-0-lite-260428";
  }

  /** 统一的 chat 调用：显式 max_tokens、默认关思考、只取 content（忽略 reasoning_content）。 */
  private async chat(params: {
    model: string;
    messages: ArkMessage[];
    maxTokens: number;
    temperature?: number;
    /** 默认 true=关闭深度思考。仅在确实需要推理时传 false。 */
    disableThinking?: boolean;
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
    };
    if (params.temperature != null) body.temperature = params.temperature;
    if (params.disableThinking !== false) body.thinking = { type: "disabled" };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`方舟调用失败 ${res.status} (${params.model}): ${(await res.text()).slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message?: string };
    };
    if (json.error) throw new Error(`方舟返回错误: ${json.error.message ?? JSON.stringify(json.error)}`);
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }

  /**
   * 造结构（大文档安全）：模型只输出「在哪插什么标题」的 JSON 清单，正文由本地机械插回，
   * 从构造上杜绝截断/丢内容。低温以稳住 JSON 格式。
   */
  async structure(markdown: string, model?: string): Promise<string> {
    const blocks = splitBlocks(markdown);
    if (blocks.length <= 1) return markdown.trim(); // 无可分段结构，原样返回
    const text = await this.chat({
      // 用 KB_MODEL_STRUCTURE 而非 KB_MODEL_PARSE：后者专属解析层的 Claude Agent SDK，
      // 那条链路只认 Anthropic 模型名，两者共用一个变量会互相打架。
      model: model ?? process.env.KB_MODEL_STRUCTURE ?? this.defaultModel,
      maxTokens: MAX_TOKENS.structure,
      temperature: 0.2,
      messages: [
        { role: "system", content: STRUCTURE_SYSTEM },
        { role: "user", content: buildStructureUserPrompt(numberBlocks(blocks)) },
      ],
    });
    return applyInserts(blocks, parseInserts(text, blocks.length));
  }

  /** 上下文化：整份文档在前（吃隐式缓存）+ 片段指令在后 → 50~100 字前缀。 */
  async contextualize(fullDoc: string, chunk: string, title?: string, model?: string): Promise<string> {
    return this.chat({
      model: model ?? this.defaultModel,
      maxTokens: MAX_TOKENS.contextualize,
      messages: [
        { role: "system", content: CONTEXTUALIZE_SYSTEM },
        {
          role: "user",
          content: `${buildContextualizeDocText(fullDoc, title)}\n\n${buildContextualizeInstruction(chunk)}`,
        },
      ],
    });
  }

  /** 视觉/OCR：图片走 OpenAI 的 image_url + data URI 形状（Anthropic 的 source.base64 在这里不认）。 */
  async vision(imageBase64: string, prompt: string, opts: VisionOptions = {}): Promise<string> {
    const mediaType = opts.mediaType ?? "image/png";
    return this.chat({
      model: opts.model ?? process.env.KB_MODEL_VISION ?? this.defaultModel,
      maxTokens: opts.maxTokens ?? MAX_TOKENS.vision,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
  }

  /** 多轮检索改写：把历史 + 最新问题压成一句可独立检索的查询。 */
  async rewriteQuery(transcript: string, question: string, model?: string): Promise<string> {
    return this.chat({
      model: model ?? this.defaultModel,
      maxTokens: MAX_TOKENS.rewrite,
      messages: [
        { role: "system", content: REWRITE_SYSTEM },
        { role: "user", content: buildRewriteUserPrompt(transcript, question) },
      ],
    });
  }

  /**
   * 带引用的问答。方舟没有 Anthropic 的 citations 协议能力，改用序号标记法：
   * TopK 以 [1][2]… 编号喂进去，要求模型在结论后标序号，本地解析回 chunk 并做范围校验。
   * 详见 ./citations 里对「丢失了什么保证」的说明。
   */
  async answer(query: string, chunks: AnswerChunk[], opts: AnswerOptions = {}): Promise<AnswerResult> {
    const history: ArkMessage[] = (opts.history ?? []).map((m) => ({ role: m.role, content: m.content }));
    const raw = await this.chat({
      model: opts.model ?? process.env.KB_MODEL_ANSWER ?? "doubao-seed-2-0-pro-260215",
      maxTokens: MAX_TOKENS.answer,
      // 问答默认也关思考：知识库问答是「基于给定资料作答」而非推理，reasoning token 按输出价计费
      // （pro 30 元/百万）性价比低。确需推理可设 KB_ANSWER_THINKING=on。
      disableThinking: (process.env.KB_ANSWER_THINKING ?? "").toLowerCase() !== "on",
      messages: [
        { role: "system", content: buildAnswerSystemPrompt(opts.groupContext) },
        ...history,
        { role: "user", content: `${buildCitedDocsBlock(chunks)}\n\n问题：${query}${CITATION_INSTRUCTION}` },
      ],
    });
    return parseCitations(raw, chunks);
  }
}
