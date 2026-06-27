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
