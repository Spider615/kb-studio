import type { Chunk, ParseResult } from "./contracts";

/** 解析输入：给路径或字节，外加文件名/mime。 */
export interface ParseInput {
  filePath?: string;
  bytes?: Uint8Array;
  filename: string;
  mime?: string;
}

/** 文件解析后端（默认实现：Claude code-execution 沙箱）。 */
export interface ParserBackend {
  parse(input: ParseInput): Promise<ParseResult>;
}

/** 向量化后端（默认实现：OpenAI 兼容端点的 BGE-M3）。 */
export interface EmbeddingBackend {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface RerankCandidate {
  id: string;
  text: string;
}
export interface RerankHit {
  id: string;
  score: number;
}
/** 重排后端（默认实现：Noop；可换 bge-reranker / Cohere）。 */
export interface Reranker {
  rerank(query: string, candidates: RerankCandidate[], topK: number): Promise<RerankHit[]>;
}

/** 作答时喂给模型的候选片段（id 是可读 chunk id，如 doc_42_c0007，用于溯源反查）。 */
export interface AnswerChunk {
  id: string;
  content: string;
  heading_path: string[];
}
export interface AnswerSource {
  id: string;
  heading_path: string[];
}
export interface TokenUsage {
  input: number;
  output: number;
}
export interface AnswerResult {
  answer: string;
  sources: AnswerSource[];
  usage?: TokenUsage; // 只读的可观测性字段，不读即无感知
}
export interface AnswerOptions {
  model?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  groupContext?: string | null;
}
export interface VisionOptions {
  model?: string;
  mediaType?: string;
  maxTokens?: number;
}

/** 工具循环用的中立结构（不进 LlmBackend 接口，由具体客户端实现 runTools 消费）。 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ToolUseRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface RunToolsTurn {
  text: string;
  toolUses: ToolUseRequest[];
  usage: TokenUsage;
  stopReason: string;
}

/**
 * 对话模型后端。两个实现：LlmClient（302 网关 / Anthropic 协议）、
 * ArkLlmClient（火山方舟 / OpenAI 协议）。管线只依赖本接口，换后端不动调用点。
 *
 * 注意 answer() 的溯源保证在两个实现间**不等价**：Anthropic 走协议级 citations，
 * cited_text 由 API 保证逐字来自原文；方舟没有该能力，靠模型输出 chunk id 标记 +
 * 本地校验，属尽力而为。调用方不应假设 sources 一定非空。
 */
export interface LlmBackend {
  structure(markdown: string, model?: string): Promise<string>;
  contextualize(fullDoc: string, chunk: string, title?: string, model?: string): Promise<string>;
  vision(imageBase64: string, prompt: string, opts?: VisionOptions): Promise<string>;
  rewriteQuery(transcript: string, question: string, model?: string): Promise<string>;
  answer(query: string, chunks: AnswerChunk[], opts?: AnswerOptions): Promise<AnswerResult>;
}

export interface MiaodongCredentials {
  domain: string; // 用户填，适配器内规范化成 https://<host>
  accessKeyId: string;
  accessKeySecret: string;
  knowledgeBaseId: string;
}

export interface PushPayload {
  docId: string;
  title: string;
  chunks: Chunk[];
}
export interface PushResult {
  ok: boolean;
  pushed: number; // 成功推送的段落数
  target: string; // "miaodong" | "stub"
  remoteDocId?: string; // 秒懂返回的文档 id
  knowledgeBaseId?: string; // 推送到的知识库 id（回显输入凭据的 knowledgeBaseId）
  ref?: string; // 保留
}
/** 推送到秒懂的后端（默认实现：Stub；真实实现 RealMiaodongAdapter）。 */
export interface MiaodongAdapter {
  push(payload: PushPayload, creds: MiaodongCredentials): Promise<PushResult>;
}
