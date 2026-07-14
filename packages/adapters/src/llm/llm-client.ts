import Anthropic from "@anthropic-ai/sdk";
import { installProxyFromEnv } from "../proxy";

export interface LlmClientOptions {
  baseUrl?: string;
  authToken?: string;
  model?: string;
}

const BASE_ANSWER_SYSTEM = "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。";

/** 按分组背景（Agent 用途/补充）拼出问答用的 system 提示词；无背景时原样返回基础提示词。 */
export function buildAnswerSystemPrompt(groupContext?: string | null): string {
  if (!groupContext) return BASE_ANSWER_SYSTEM;
  return [
    BASE_ANSWER_SYSTEM,
    "",
    "以下是该客户对这个知识库/Agent 的背景诉求，仅供你理解语境、把握回答口径，不要在回答中逐字复述：",
    "<客户背景>",
    groupContext,
    "</客户背景>",
  ].join("\n");
}

/** 上下文化的 user content（两块文本）：可缓存文档块（含标题）+ 含「归属补全」的说明指令。纯函数，便于单测。 */
export function buildContextualizeContent(
  fullDoc: string,
  chunk: string,
  title?: string,
): Anthropic.TextBlockParam[] {
  const docText = title
    ? `文档标题/来源文件：《${title}》\n\n<document>\n${fullDoc}\n</document>`
    : `<document>\n${fullDoc}\n</document>`;
  return [
    { type: "text", text: docText, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: [
        "请阅读上述完整文档，为下面片段生成上下文说明（来源定位 + 归属补全 + 核心对象/时间 + 指代消解）：",
        "归属补全：若片段本身没写明所属品牌/公司/时间等，而文档标题/文件名里有，就在描述中补上（例：价格表某行没写品牌，则从文件名补出该品牌）。自然融入即可，不必照抄完整文件名/扩展名。",
        "<chunk>",
        chunk,
        "</chunk>",
      ].join("\n"),
    },
  ];
}

/**
 * 直连 302 网关的 Claude 客户端（Anthropic 格式 /v1/messages）。
 * 造结构 / 上下文化 / vision / citations 共用。用 Authorization: Bearer（302 key），
 * 显式抹掉 x-api-key，避免和 Bearer 冲突（也防止环境里残留的 ANTHROPIC_API_KEY 串进来）。
 */
export class LlmClient {
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
    const numbered = blocks.map((b, i) => `[${i}] ${b.replace(/\n/g, " ⏎ ")}`).join("\n\n");
    const res = await this.client.messages.create({
      model: model ?? process.env.KB_MODEL_PARSE ?? this.defaultModel,
      max_tokens: 8000,
      system: "你在为 RAG 预处理无结构文档。唯一任务是决定在哪些位置插入标题，绝不输出或改动任何正文。",
      messages: [
        {
          role: "user",
          content: [
            "下面是按空行切分、带编号的文本块。找出话题切换处，给出要插入的标题。",
            "要求：",
            "- 只在话题明显切换处插入 `##`(二级) 或 `###`(三级)；标题之间间隔 2~5 个块，别太碎",
            "- 标题概括其后内容的主题（5~15 字）",
            "- 已经是标题的块（以 # 开头）不要再插",
            '- 只输出 JSON 数组，每项 {"before": 块号(整数), "level": 2 或 3, "title": "标题文字"}',
            "- 不要输出正文、不要解释、不要代码围栏",
            "",
            "<blocks>",
            numbered,
            "</blocks>",
          ].join("\n"),
        },
      ],
    });
    return applyInserts(blocks, parseInserts(firstText(res), blocks.length));
  }

  /** 视觉/OCR：把一张图片（base64）连同提示喂给 vision 模型，返回文字。默认用 KB_MODEL_VISION（haiku）。 */
  async vision(
    imageBase64: string,
    prompt: string,
    opts: { model?: string; mediaType?: string; maxTokens?: number } = {},
  ): Promise<string> {
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
      system:
        "你为 RAG 检索生成 chunk 的上下文描述。只输出描述本身：50~100 字、单段、不要『该片段…』之类前缀或解释。若片段缺品牌/公司/时间等归属而文档标题里有，请补进描述。",
      messages: [{ role: "user", content: buildContextualizeContent(fullDoc, chunk, title) }],
    });
    return firstText(res);
  }

  /** Citations 问答：把 top chunks 作可引用文档喂 Opus，返回 {answer, sources}（block_index→chunk 反查）。
   *  opts.history：多轮对话的前几轮 {role,content}，会垫进 messages 数组（仅最后一轮带可引用 document）。
   *  opts.groupContext：对话 scope 限定到某分组时，该分组的 Agent 用途/补充拼成的客户背景，注入 system。 */
  async answer(
    query: string,
    chunks: Array<{ id: string; content: string; heading_path: string[] }>,
    opts: {
      model?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
      groupContext?: string | null;
    } = {},
  ): Promise<{ answer: string; sources: Array<{ id: string; heading_path: string[] }> }> {
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
    const sources: Array<{ id: string; heading_path: string[] }> = [];
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
    return { answer: answer.trim(), sources };
  }

  /** 多轮检索改写：把对话历史 + 最新问题压成一句能独立检索的查询（指代消解、补主语）。
   *  默认走 KB_MODEL_CONTEXT（haiku）。返回空串时调用方应回退原问题。 */
  async rewriteQuery(transcript: string, question: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? this.defaultModel,
      max_tokens: 200,
      system:
        "你把多轮对话里的最新问题改写成一句能独立检索的查询：补全指代和省略的主语。只输出改写后的查询本身，不要解释、不要引号。",
      messages: [
        {
          role: "user",
          content: ["<对话历史>", transcript, "</对话历史>", "", `最新问题：${question}`, "", "改写后的独立查询："].join(
            "\n",
          ),
        },
      ],
    });
    return firstText(res);
  }
}

function firstText(res: { content: any[] }): string {
  const block = res.content.find((b) => b?.type === "text");
  return (block?.text ?? "").trim();
}

/** 按空行把文档切成块（段落/标题/表格各自成块），供造结构编号与插回。 */
function splitBlocks(md: string): string[] {
  return md
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/** 解析模型返回的插标题清单，做范围/去重/字段校验，丢弃非法项。 */
function parseInserts(
  raw: string,
  blockCount: number,
): Array<{ before: number; level: number; title: string }> {
  let arr: any;
  try {
    const m = raw.match(/\[[\s\S]*\]/); // 容忍模型多输出的解释/围栏，抠出 JSON 数组
    arr = JSON.parse(m ? m[0] : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out: Array<{ before: number; level: number; title: string }> = [];
  for (const it of arr) {
    const before = Number(it?.before);
    const level = Number(it?.level) === 3 ? 3 : 2;
    const title = String(it?.title ?? "").trim();
    if (!Number.isInteger(before) || before < 0 || before >= blockCount || !title) continue;
    if (seen.has(before)) continue; // 同一位置只插一个
    seen.add(before);
    out.push({ before, level, title });
  }
  return out;
}

/** 把标题机械插回原文块：原块一字不改地输出，仅在指定块前加标题行。 */
function applyInserts(
  blocks: string[],
  inserts: Array<{ before: number; level: number; title: string }>,
): string {
  const byPos = new Map<number, { level: number; title: string }>();
  for (const ins of inserts) {
    if (/^#{1,6}\s/.test(blocks[ins.before] ?? "")) continue; // 目标块本身是标题，跳过
    byPos.set(ins.before, { level: ins.level, title: ins.title });
  }
  const out: string[] = [];
  blocks.forEach((b, i) => {
    const h = byPos.get(i);
    if (h) out.push(`${"#".repeat(h.level)} ${h.title}`);
    out.push(b);
  });
  return out.join("\n\n");
}
