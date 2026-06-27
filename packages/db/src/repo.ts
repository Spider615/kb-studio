import { sql, eq, desc, asc, inArray } from "drizzle-orm";
import { db } from "./client";
import { docs, chunks, conversations, messages, miaodongCredentials } from "./schema";
import type { DocRow, ChunkRow, MessageRow, DocProgress, PushTarget, MiaodongCredentialRow } from "./schema";
import { tokenizeZh, toTsQuery } from "./bm25";
import type { Chunk } from "@kb/core";

export interface DocInput {
  id: string;
  title: string;
  source: string;
  mime?: string | null;
  structuredMd?: string | null;
  status?: string;
}

export async function upsertDoc(d: DocInput): Promise<void> {
  await db
    .insert(docs)
    .values({
      id: d.id,
      title: d.title,
      source: d.source,
      mime: d.mime ?? null,
      structuredMd: d.structuredMd ?? null,
      status: d.status ?? "ready",
    })
    .onConflictDoUpdate({
      target: docs.id,
      set: { title: d.title, source: d.source, status: d.status ?? "ready" },
    });
}

export async function insertChunks(items: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void> {
  if (!items.length) return;
  await db
    .insert(chunks)
    .values(
      items.map(({ chunk, embedding }) => ({
        id: chunk.id,
        docId: chunk.doc_id,
        content: chunk.content,
        contentOriginal: chunk.content_original,
        contextPrefix: chunk.context_prefix,
        chunkIndex: chunk.chunk_index,
        chunkType: chunk.chunk_type,
        tokenEstimate: chunk.token_estimate,
        metadata: chunk.metadata,
        embedding,
        tsvText: tokenizeZh(chunk.content),
      })),
    )
    .onConflictDoNothing();
}

export interface SearchHit {
  id: string;
  content: string;
  score: number;
  heading_path: string[];
}

function toHits(rows: any): SearchHit[] {
  const data: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return data.map((r) => ({
    id: r.id,
    content: r.content,
    score: Number(r.score),
    heading_path: r.metadata?.heading_path ?? [],
  }));
}

/** 向量检索（cosine）。docId 非空时限定到该文档。 */
export async function vectorSearch(queryEmbedding: number[], topK = 5, docId?: string | null): Promise<SearchHit[]> {
  const lit = `[${queryEmbedding.join(",")}]`;
  const docFilter = docId ? sql`AND doc_id = ${docId}` : sql``;
  const rows = await db.execute(sql`
    SELECT id, content, metadata, 1 - (embedding <=> ${lit}::vector) AS score
    FROM chunks
    WHERE embedding IS NOT NULL ${docFilter}
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${topK}
  `);
  return toHits(rows);
}

/** 关键词检索（jieba 分词 + Postgres 全文 ts_rank_cd，近似 BM25，补数字/专名召回）。docId 非空时限定到该文档。 */
export async function keywordSearch(query: string, topK = 5, docId?: string | null): Promise<SearchHit[]> {
  const tsq = toTsQuery(query);
  if (!tsq) return [];
  const docFilter = docId ? sql`AND doc_id = ${docId}` : sql``;
  const rows = await db.execute(sql`
    SELECT id, content, metadata,
           ts_rank_cd(to_tsvector('simple', tsv_text), to_tsquery('simple', ${tsq})) AS score
    FROM chunks
    WHERE tsv_text IS NOT NULL
      AND to_tsvector('simple', tsv_text) @@ to_tsquery('simple', ${tsq})
      ${docFilter}
    ORDER BY score DESC
    LIMIT ${topK}
  `);
  return toHits(rows);
}

/** 混合检索：向量 + 关键词，RRF 融合排序。docId 非空时两路都限定到该文档。 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  topK = 5,
  poolN = 20,
  docId?: string | null,
): Promise<SearchHit[]> {
  const [vec, kw] = await Promise.all([
    vectorSearch(queryEmbedding, poolN, docId),
    keywordSearch(query, poolN, docId),
  ]);
  const K = 60; // RRF 常数
  const acc = new Map<string, { hit: SearchHit; rrf: number }>();
  const fold = (list: SearchHit[]) =>
    list.forEach((h, i) => {
      const e = acc.get(h.id) ?? { hit: h, rrf: 0 };
      e.rrf += 1 / (K + i + 1);
      acc.set(h.id, e);
    });
  fold(vec);
  fold(kw);
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK)
    .map((e) => ({ ...e.hit, score: e.rrf }));
}

/** demo 用：清空所有 chunk + doc（重新入库前调用）。 */
export async function clearAll(): Promise<void> {
  await db.execute(sql`TRUNCATE chunks, docs CASCADE`);
}

export interface DocListItem {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  createdAt: Date;
  pushedAt: Date | null;
  progress: DocProgress | null;
  error: string | null;
}

/** 文档列表（含 chunk 数 + 处理进度/错误），按创建时间倒序。 */
export async function listDocs(): Promise<DocListItem[]> {
  const rows: any = await db.execute(sql`
    SELECT d.id, d.title, d.source, d.status, d.created_at, d.pushed_at, d.progress, d.error,
           (SELECT count(*) FROM chunks c WHERE c.doc_id = d.id)::int AS chunk_count
    FROM docs d
    ORDER BY d.created_at DESC
  `);
  const data: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return data.map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source,
    status: r.status,
    chunkCount: Number(r.chunk_count),
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    progress: r.progress ?? null,
    error: r.error ?? null,
  }));
}

/** 建处理中文档行（上传开始时调用，先于后台处理）。 */
export async function createProcessingDoc(id: string, title: string, source: string): Promise<void> {
  await db.insert(docs).values({
    id,
    title,
    source,
    status: "processing",
    progress: { stage: "parsing", done: 0, total: 0 },
  });
}

/** 更新处理进度。 */
export async function setDocProgress(id: string, progress: DocProgress): Promise<void> {
  await db.update(docs).set({ progress }).where(eq(docs.id, id));
}

/** 标记失败。 */
export async function failDoc(id: string, error: string): Promise<void> {
  await db.update(docs).set({ status: "failed", error, progress: null }).where(eq(docs.id, id));
}

/** 成功后清理进度/错误。 */
export async function clearDocProgress(id: string): Promise<void> {
  await db.update(docs).set({ progress: null, error: null }).where(eq(docs.id, id));
}

/** 取文档状态（取消时判断行是否还在）。 */
export async function getDocStatus(id: string): Promise<{ status: string } | null> {
  const rows = await db.select({ status: docs.status }).from(docs).where(eq(docs.id, id));
  return rows[0] ?? null;
}

/** 写文档推送目标 + 标 pushed。 */
export async function setDocPushTargets(id: string, targets: PushTarget[]): Promise<void> {
  await db
    .update(docs)
    .set({ status: "pushed", pushedAt: new Date(), confirmedAt: new Date(), pushTargets: targets })
    .where(eq(docs.id, id));
}

/** 单篇文档 + 它的 chunk（按 chunk_index 正序）；不存在返回 null。 */
export async function getDocWithChunks(
  docId: string,
): Promise<{ doc: DocRow; chunks: ChunkRow[] } | null> {
  const docRows = await db.select().from(docs).where(eq(docs.id, docId));
  const doc = docRows[0];
  if (!doc) return null;
  const chunkRows = await db
    .select()
    .from(chunks)
    .where(eq(chunks.docId, docId))
    .orderBy(chunks.chunkIndex);
  return { doc, chunks: chunkRows };
}

/** 删文档（chunk 靠 FK onDelete cascade 自动删）。 */
export async function deleteDoc(docId: string): Promise<void> {
  await db.delete(docs).where(eq(docs.id, docId));
}

/** 新建空会话。 */
export async function createConversation(id: string, title = "新对话") {
  await db.insert(conversations).values({ id, title });
  return { id, title };
}

/** 会话列表（id/title/updatedAt/messageCount），按最近更新倒序。 */
export async function listConversations(): Promise<
  Array<{ id: string; title: string; updatedAt: Date; messageCount: number }>
> {
  const rows: any = await db.execute(sql`
    SELECT c.id, c.title, c.updated_at,
           (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS message_count
    FROM conversations c
    ORDER BY c.updated_at DESC
  `);
  const data: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return data.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count),
  }));
}

// ===== 秒懂凭据（命名保存，可多个） =====

export interface CredentialInput {
  id: string;
  name: string;
  domain: string;
  accessKeyId: string;
  accessKeySecret: string;
  knowledgeBaseId: string;
}

/** 全部凭据（按创建时间倒序）。 */
export async function listCredentials(): Promise<MiaodongCredentialRow[]> {
  return db.select().from(miaodongCredentials).orderBy(desc(miaodongCredentials.createdAt));
}

/** 新建凭据。 */
export async function createCredential(c: CredentialInput): Promise<void> {
  await db.insert(miaodongCredentials).values(c);
}

/** 删除凭据。 */
export async function deleteCredential(id: string): Promise<void> {
  await db.delete(miaodongCredentials).where(eq(miaodongCredentials.id, id));
}

/** 取指定多个凭据（推送用）。 */
export async function getCredentials(ids: string[]): Promise<MiaodongCredentialRow[]> {
  if (!ids.length) return [];
  return db.select().from(miaodongCredentials).where(inArray(miaodongCredentials.id, ids));
}

/** 单个会话，不存在返回 null。 */
export async function getConversation(id: string) {
  const rows = await db.select().from(conversations).where(eq(conversations.id, id));
  return rows[0] ?? null;
}

/** 会话的全部消息，按时间正序。 */
export async function getMessages(conversationId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

/** 删会话（messages 级联删）。 */
export async function deleteConversation(id: string): Promise<void> {
  await db.delete(conversations).where(eq(conversations.id, id));
}

export interface MessageInput {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ id: string; heading_path: string[] }> | null;
  hits?: Array<{ id: string; score: number; heading_path: string[]; content: string }> | null;
}

/** 插一条消息。 */
export async function insertMessage(m: MessageInput): Promise<void> {
  await db.insert(messages).values({
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    sources: m.sources ?? null,
    hits: m.hits ?? null,
  });
}

/** 原子批量插入多条消息（同一轮的 user+assistant 要么都进要么都不进）。 */
export async function insertMessages(items: MessageInput[]): Promise<void> {
  if (!items.length) return;
  await db.insert(messages).values(
    items.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      sources: m.sources ?? null,
      hits: m.hits ?? null,
    })),
  );
}

/** 刷新会话 updatedAt（可选改 title，仅首轮传）。 */
export async function touchConversation(id: string, title?: string): Promise<void> {
  const set: { updatedAt: Date; title?: string } = { updatedAt: new Date() };
  if (title !== undefined) set.title = title;
  await db.update(conversations).set(set).where(eq(conversations.id, id));
}

/** 设置会话的检索范围（null = 全部知识库）。 */
export async function setConversationScope(id: string, scopeDocId: string | null): Promise<void> {
  await db.update(conversations).set({ scopeDocId }).where(eq(conversations.id, id));
}
