import type { EmbeddingBackend } from "@kb/core";
import { installProxyFromEnv } from "../proxy";

export interface OpenAICompatEmbedderOptions {
  baseUrl: string; // 如 http://localhost:11434/v1 或 https://api.siliconflow.cn/v1
  apiKey?: string;
  model?: string; // 默认 bge-m3
  dimensions?: number; // 默认 1024
}

/** 任意 OpenAI 兼容 /embeddings 端点的向量化后端（默认 BGE-M3）。 */
export class OpenAICompatEmbedder implements EmbeddingBackend {
  readonly dimensions: number;
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(opts: OpenAICompatEmbedderOptions) {
    installProxyFromEnv(); // 直连 302 海外端点走代理（容器内不设则直连）
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "bge-m3";
    this.dimensions = opts.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embed 失败 ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}
