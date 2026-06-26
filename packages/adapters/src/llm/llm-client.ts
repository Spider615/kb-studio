import Anthropic from "@anthropic-ai/sdk";
import { installProxyFromEnv } from "../proxy";

export interface LlmClientOptions {
  baseUrl?: string;
  authToken?: string;
  model?: string;
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

  /** 造结构：给无结构文本插 H2/H3 标题，不改原文。 */
  async structure(markdown: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? process.env.KB_MODEL_PARSE ?? this.defaultModel,
      max_tokens: 8000,
      system:
        "你在为 RAG 系统预处理文档：给定无标题结构的原始文本，只插入 Markdown 标题，绝不改动任何原文。",
      messages: [
        {
          role: "user",
          content: [
            "下面是一份没有标题结构的原始文本，请输出结构化版本：",
            "1. 不修改任何原文内容，只插入标题",
            "2. 在话题切换处插入 `## 二级标题` 或 `### 三级标题`",
            "3. 标题概括该段核心主题（5~15 字）",
            "4. 标题之间段落数控制在 2~5 段",
            "5. 直接输出处理后的 Markdown，不要任何额外说明",
            "",
            "<document>",
            markdown,
            "</document>",
          ].join("\n"),
        },
      ],
    });
    return firstText(res);
  }

  /** 上下文化：给一个 chunk 生成 50~100 字上下文前缀；整份文档走 prompt caching。 */
  async contextualize(fullDoc: string, chunk: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? this.defaultModel,
      max_tokens: 300,
      system:
        "你为 RAG 检索生成 chunk 的上下文描述。只输出描述本身：50~100 字、单段、不要『该片段…』之类前缀或解释。",
      messages: [
        {
          role: "user",
          content: [
            // 整份文档作为可缓存前缀（同文档下所有 chunk 命中缓存）
            {
              type: "text",
              text: `<document>\n${fullDoc}\n</document>`,
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: [
                "请阅读上述完整文档，为下面片段生成上下文说明（来源定位 + 核心对象/时间 + 指代消解）：",
                "<chunk>",
                chunk,
                "</chunk>",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    return firstText(res);
  }

  /** Citations 问答：把 top chunks 作可引用文档喂 Opus，返回 {answer, sources}（block_index→chunk 反查）。 */
  async answer(
    query: string,
    chunks: Array<{ id: string; content: string; heading_path: string[] }>,
    model?: string,
  ): Promise<{ answer: string; sources: Array<{ id: string; heading_path: string[] }> }> {
    const params: any = {
      model: model ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
      max_tokens: 1024,
      system: "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。",
      messages: [
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
}

function firstText(res: { content: any[] }): string {
  const block = res.content.find((b) => b?.type === "text");
  return (block?.text ?? "").trim();
}
