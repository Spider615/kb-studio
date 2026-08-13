import { sql, eq, desc, asc, inArray, and } from "drizzle-orm";
import { db } from "./client";
import { docs, chunks, conversations, messages, miaodongCredentials, groups, users, sessions, emailVerifications, wikiPages, abRuns } from "./schema";
import type { DocRow, ChunkRow, MessageRow, DocProgress, PushTarget, MiaodongCredentialRow, GroupRow, UserRow, SessionRow, EmailVerificationRow, VerificationPurpose, WikiPageRow } from "./schema";
import { tokenizeZh, toTsQuery } from "./bm25";
import { bm25Score, type CorpusStats } from "./bm25-score";
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
  prev_chunk_id: string | null; // 用于检索期邻居扩展
  next_chunk_id: string | null;
  via?: "lexguard" | "neighbor"; // 来源标记：lexguard 强留 / 邻居扩展带回；undefined=主命中(向量/RRF/rerank)
}

function toHits(rows: any): SearchHit[] {
  const data: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return data.map((r) => ({
    id: r.id,
    content: r.content,
    score: Number(r.score),
    heading_path: r.metadata?.heading_path ?? [],
    prev_chunk_id: r.metadata?.prev_chunk_id ?? null,
    next_chunk_id: r.metadata?.next_chunk_id ?? null,
  }));
}

/** doc 过滤片段：限定到给定 docIds（空/undefined → 不过滤=全库）。
 *  用 sql.join 逐个绑参而非 `= ANY($1)`：drizzle 对裸 JS 数组序列化有 bug。 */
function docFilterSql(docIds?: string[] | null) {
  return docIds?.length
    ? sql`AND doc_id IN (${sql.join(docIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
}

/** 向量检索（cosine）。docIds 非空时限定到这些文档。 */
export async function vectorSearch(queryEmbedding: number[], topK = 5, docIds?: string[] | null): Promise<SearchHit[]> {
  const lit = `[${queryEmbedding.join(",")}]`;
  const docFilter = docFilterSql(docIds);
  const rows = await db.execute(sql`
    SELECT id, content, metadata, 1 - (embedding <=> ${lit}::vector) AS score
    FROM chunks
    WHERE embedding IS NOT NULL ${docFilter}
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${topK}
  `);
  return toHits(rows);
}

/** 语料统计缓存 TTL：DF/avgdl 随入库缓慢变化，短时间内复用足够准，避免每次检索都扫库。 */
const STATS_TTL_MS = Number(process.env.KB_BM25_STATS_TTL_MS ?? 5 * 60_000);
/** 关键词召回的候选上限：先粗召回，再由 Node 侧真 BM25 精算。语料小于此值时等同全量召回。 */
const CANDIDATE_LIMIT = Number(process.env.KB_BM25_CANDIDATES ?? 500);

let corpusSizeCache: { N: number; avgdl: number; at: number } | null = null;
const dfCache = new Map<string, { df: number; at: number }>();

/** 清空 BM25 语料统计缓存。重建索引（rebuildTsvText）或大批入库后应调用，避免用陈旧 DF 打分。 */
export function clearBm25StatsCache(): void {
  corpusSizeCache = null;
  dfCache.clear();
}

/**
 * 取 BM25 所需的语料统计（N / avgdl / 各查询词的 DF）。
 *
 * **IDF 一律按全库统计，不受 docIds 限制**：词的稀有度是语料的固有属性，按 scope 重算
 * 既拿不到缓存、又会让同一个词在「搜单篇」和「搜全库」时权重漂移，排序变得不可解释。
 * docIds 只用于限定召回范围。
 */
async function corpusStats(terms: string[]): Promise<CorpusStats> {
  const now = Date.now();
  if (!corpusSizeCache || now - corpusSizeCache.at > STATS_TTL_MS) {
    const rows: any = await db.execute(sql`
      SELECT count(*)::int AS n,
             COALESCE(avg(array_length(string_to_array(tsv_text, ' '), 1)), 0)::float AS avgdl
      FROM chunks WHERE tsv_text IS NOT NULL
    `);
    const r = (Array.isArray(rows) ? rows : (rows?.rows ?? []))[0] ?? {};
    corpusSizeCache = { N: Number(r.n ?? 0), avgdl: Number(r.avgdl ?? 0), at: now };
  }

  const df = new Map<string, number>();
  const missing: string[] = [];
  for (const t of terms) {
    const c = dfCache.get(t);
    if (c && now - c.at <= STATS_TTL_MS) df.set(t, c.df);
    else missing.push(t);
  }
  // 逐词查 DF：建了 GIN 索引后单次是毫秒级，且结果进缓存；一次查询的词数一般 <10
  await Promise.all(
    missing.map(async (t) => {
      const lit = `'${t.replace(/'/g, "''")}'`; // to_tsquery 要求词用单引号包裹
      const rows: any = await db.execute(sql`
        SELECT count(*)::int AS df FROM chunks
        WHERE tsv_text IS NOT NULL
          AND to_tsvector('simple', tsv_text) @@ to_tsquery('simple', ${lit})
      `);
      const n = Number((Array.isArray(rows) ? rows : (rows?.rows ?? []))[0]?.df ?? 0);
      dfCache.set(t, { df: n, at: now });
      df.set(t, n);
    }),
  );
  return { N: corpusSizeCache.N, avgdl: corpusSizeCache.avgdl, df };
}

/**
 * 关键词检索：jieba 分词召回 + **Okapi BM25** 打分。docIds 非空时限定到这些文档。
 *
 * 早先用 Postgres 的 `ts_rank_cd`，它**没有 IDF**——「产品」这种满库都是的泛词和
 * 「葡萄牙」这种关键罕见词权重相同，谁词频高谁赢。实测踩过：某片段靠「润」「度」
 * 「产品」高频拿到全场最高分，而查询真正在问的「葡萄牙」在其中出现 0 次。
 * 现在 SQL 只负责**筛**（走 GIN 索引），**排**交给 Node 侧的真 BM25（见 ./bm25-score）。
 */
export async function keywordSearch(query: string, topK = 5, docIds?: string[] | null): Promise<SearchHit[]> {
  const tsq = toTsQuery(query);
  if (!tsq) return [];
  const terms = [...new Set(tokenizeZh(query).split(" ").filter(Boolean))];
  const docFilter = docFilterSql(docIds);
  const rows: any = await db.execute(sql`
    SELECT id, content, metadata, tsv_text
    FROM chunks
    WHERE tsv_text IS NOT NULL
      AND to_tsvector('simple', tsv_text) @@ to_tsquery('simple', ${tsq})
      ${docFilter}
    LIMIT ${CANDIDATE_LIMIT}
  `);
  const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  if (!list.length) return [];

  const stats = await corpusStats(terms);
  return list
    .map((r) => ({
      id: r.id,
      content: r.content,
      score: bm25Score(terms, String(r.tsv_text ?? "").split(" ").filter(Boolean), stats),
      heading_path: r.metadata?.heading_path ?? [],
      prev_chunk_id: r.metadata?.prev_chunk_id ?? null,
      next_chunk_id: r.metadata?.next_chunk_id ?? null,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 用当前分词规则重建**全部** chunk 的 tsv_text。
 *
 * 什么时候必须跑：改了 `KB_JIEBA_WORDS`（或任何影响 tokenizeZh 的逻辑）之后。
 * tsv_text 是入库那一刻固化下来的分词结果，改了词典若不重建，查询会用新词
 * （'润度'）去撞索引里的旧词（'润' '度'），**一条都匹配不上**——比不改还糟。
 *
 * 只重算分词，不碰向量、不调任何模型，纯本地 CPU，千级 chunk 数秒完成。
 */
export async function rebuildTsvText(
  onProgress?: (done: number, total: number) => void,
  batchSize = 500,
): Promise<number> {
  const cntRows: any = await db.execute(sql`SELECT count(*)::int AS n FROM chunks`);
  const total = Number((Array.isArray(cntRows) ? cntRows : (cntRows?.rows ?? []))[0]?.n ?? 0);
  let done = 0;
  // 按 id 分页；本操作不改 id 也不增删行，分页稳定
  for (let offset = 0; offset < total; offset += batchSize) {
    const rows: any = await db.execute(
      sql`SELECT id, content FROM chunks ORDER BY id LIMIT ${batchSize} OFFSET ${offset}`,
    );
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    for (const r of list) {
      await db.execute(sql`UPDATE chunks SET tsv_text = ${tokenizeZh(String(r.content ?? ""))} WHERE id = ${r.id}`);
      done++;
    }
    onProgress?.(done, total);
  }
  clearBm25StatsCache(); // 分词变了，DF/avgdl 全部作废，否则会拿旧统计给新索引打分
  return done;
}

/** 混合检索：向量 + 关键词，RRF 融合排序。docIds 非空时两路都限定到这些文档。 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  topK = 5,
  poolN = 20,
  docIds?: string[] | null,
): Promise<SearchHit[]> {
  const [vec, kw] = await Promise.all([
    vectorSearch(queryEmbedding, poolN, docIds),
    keywordSearch(query, poolN, docIds),
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

/** 按 id 批量取 chunk（用于检索期邻居扩展）。按传入 ids 顺序返回，缺失的跳过。 */
export async function getChunksByIds(ids: string[], docIds?: string[] | null): Promise<SearchHit[]> {
  if (!ids.length) return [];
  const docFilter = docFilterSql(docIds);
  const rows = await db.execute(sql`
    SELECT id, content, metadata, 0 AS score
    FROM chunks
    WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ${docFilter}
  `);
  const byId = new Map(toHits(rows).map((h) => [h.id, h]));
  return ids.map((id) => byId.get(id)).filter((h): h is SearchHit => !!h);
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
  groupId: string | null;
}

/** 文档列表（含 chunk 数 + 处理进度/错误），按创建时间倒序。限定到指定用户。 */
export async function listDocs(userId: string): Promise<DocListItem[]> {
  const rows: any = await db.execute(sql`
    SELECT d.id, d.title, d.source, d.status, d.created_at, d.pushed_at, d.progress, d.error, d.group_id,
           (SELECT count(*) FROM chunks c WHERE c.doc_id = d.id)::int AS chunk_count
    FROM docs d
    WHERE d.user_id = ${userId}
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
    groupId: r.group_id ?? null,
  }));
}

/** 建处理中文档行（上传开始时调用，先于后台处理）。fileId=落盘的原文件名。 */
export async function createProcessingDoc(
  id: string,
  title: string,
  source: string,
  fileId: string | null,
  userId: string,
  groupId: string | null = null,
): Promise<void> {
  await db.insert(docs).values({
    id,
    title,
    source,
    fileId: fileId ?? null,
    userId,
    groupId,
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

/** 取整行文档（不含 chunk）；不存在返回 null。 */
export async function getDoc(id: string): Promise<DocRow | null> {
  const rows = await db.select().from(docs).where(eq(docs.id, id));
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

// ===== 分组（groups） =====

export interface GroupInput {
  id: string;
  name: string;
  color?: string | null;
  userId: string;
  agentPurpose?: string | null;
  agentNotes?: string | null;
}

/** 分组列表（含每组文档数），按 sort_order, created_at 正序。限定到指定用户。 */
export async function listGroups(userId: string): Promise<Array<GroupRow & { docCount: number }>> {
  const rows: any = await db.execute(sql`
    SELECT g.id, g.name, g.color, g.sort_order, g.org_id, g.user_id, g.created_at,
           g.agent_purpose, g.agent_notes,
           (SELECT count(*) FROM docs d WHERE d.group_id = g.id)::int AS doc_count
    FROM groups g
    WHERE g.user_id = ${userId}
    ORDER BY g.sort_order ASC, g.created_at ASC
  `);
  const data: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color ?? null,
    sortOrder: Number(r.sort_order),
    orgId: r.org_id ?? null,
    userId: r.user_id ?? null,
    createdAt: r.created_at,
    agentPurpose: r.agent_purpose ?? null,
    agentNotes: r.agent_notes ?? null,
    docCount: Number(r.doc_count),
  }));
}

/** 建组。 */
export async function createGroup(g: GroupInput): Promise<void> {
  await db.insert(groups).values({
    id: g.id,
    name: g.name,
    color: g.color ?? null,
    userId: g.userId,
    agentPurpose: g.agentPurpose ?? null,
    agentNotes: g.agentNotes ?? null,
  });
}

/** 改名 / 改色 / 改排序 / 改 Agent 用途与补充（只更新传入字段）。仅限本人分组。 */
export async function updateGroup(
  id: string,
  patch: {
    name?: string;
    color?: string | null;
    sortOrder?: number;
    agentPurpose?: string | null;
    agentNotes?: string | null;
  },
  userId: string,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  if (patch.agentPurpose !== undefined) set.agentPurpose = patch.agentPurpose;
  if (patch.agentNotes !== undefined) set.agentNotes = patch.agentNotes;
  if (Object.keys(set).length === 0) return;
  await db.update(groups).set(set).where(and(eq(groups.id, id), eq(groups.userId, userId)));
}

/** 删组（docs.group_id 由外键 onDelete:set null 自动置空，不删文档）。仅限本人分组。 */
export async function deleteGroup(id: string, userId: string): Promise<void> {
  await db.delete(groups).where(and(eq(groups.id, id), eq(groups.userId, userId)));
}

/** 设置文档所属分组（null = 移回未分组）。仅限本人文档。 */
export async function setDocGroup(docId: string, groupId: string | null, userId: string): Promise<void> {
  if (groupId === null) {
    await db.update(docs).set({ groupId: null }).where(and(eq(docs.id, docId), eq(docs.userId, userId)));
    return;
  }
  // 仅当目标分组也属于该用户时才设置（防把自己的文档挂到别人的分组）
  await db.execute(sql`
    UPDATE docs SET group_id = ${groupId}
    WHERE id = ${docId} AND user_id = ${userId}
      AND EXISTS (SELECT 1 FROM groups WHERE id = ${groupId} AND user_id = ${userId})
  `);
}

/** 按分组名 + 用户查分组（一企业一分组的 find-or-create 的 find 半边）；不存在返回 null。 */
export async function findGroupByNameAndUser(name: string, userId: string): Promise<GroupRow | null> {
  const rows = await db
    .select()
    .from(groups)
    .where(and(eq(groups.name, name), eq(groups.userId, userId)));
  return rows[0] ?? null;
}

/** 该分组是否属于此用户（上传时校验，防把文档挂到别人的分组）。 */
export async function groupBelongsToUser(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.userId, userId)));
  return rows.length > 0;
}

/** 按 id 查分组（不做 userId 过滤；用于 scopeGroupId 场景取 Agent 背景，信任边界同现有 scope 机制）。 */
export async function findGroupById(id: string): Promise<GroupRow | null> {
  const rows = await db.select().from(groups).where(eq(groups.id, id));
  return rows[0] ?? null;
}

/** 组内全部文档 id（检索 scope + 批量推送共用）。 */
export async function listDocIdsInGroup(groupId: string): Promise<string[]> {
  const rows = await db.select({ id: docs.id }).from(docs).where(eq(docs.groupId, groupId));
  return rows.map((r) => r.id);
}

/** 新建空会话。 */
export async function createConversation(id: string, userId: string, title = "新对话") {
  await db.insert(conversations).values({ id, userId, title });
  return { id, title };
}

/** 会话列表（id/title/updatedAt/messageCount），按最近更新倒序。限定到指定用户。 */
export async function listConversations(
  userId: string,
): Promise<Array<{ id: string; title: string; updatedAt: Date; messageCount: number }>> {
  const rows: any = await db.execute(sql`
    SELECT c.id, c.title, c.updated_at,
           (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS message_count
    FROM conversations c
    WHERE c.user_id = ${userId}
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
  userId: string;
}

/** 全部凭据（按创建时间倒序）。限定到指定用户。 */
export async function listCredentials(userId: string): Promise<MiaodongCredentialRow[]> {
  return db
    .select()
    .from(miaodongCredentials)
    .where(eq(miaodongCredentials.userId, userId))
    .orderBy(desc(miaodongCredentials.createdAt));
}

/** 新建凭据。 */
export async function createCredential(c: CredentialInput): Promise<void> {
  await db.insert(miaodongCredentials).values(c);
}

/** 删除凭据。 */
export async function deleteCredential(id: string): Promise<void> {
  await db.delete(miaodongCredentials).where(eq(miaodongCredentials.id, id));
}

/** 取单个凭据全字段（含 secret，供查看/编辑）；不存在返回 null。 */
export async function getCredential(id: string): Promise<MiaodongCredentialRow | null> {
  const rows = await db.select().from(miaodongCredentials).where(eq(miaodongCredentials.id, id));
  return rows[0] ?? null;
}

/** 更新凭据；accessKeySecret 为空时保留原值不改。 */
export async function updateCredential(
  id: string,
  fields: { name: string; domain: string; accessKeyId: string; knowledgeBaseId: string; accessKeySecret?: string },
): Promise<void> {
  const set: Record<string, string> = {
    name: fields.name,
    domain: fields.domain,
    accessKeyId: fields.accessKeyId,
    knowledgeBaseId: fields.knowledgeBaseId,
  };
  if (fields.accessKeySecret) set.accessKeySecret = fields.accessKeySecret;
  await db.update(miaodongCredentials).set(set).where(eq(miaodongCredentials.id, id));
}

/** 取指定多个凭据（推送用），限本人。 */
export async function getCredentials(ids: string[], userId: string): Promise<MiaodongCredentialRow[]> {
  if (!ids.length) return [];
  return db
    .select()
    .from(miaodongCredentials)
    .where(and(inArray(miaodongCredentials.id, ids), eq(miaodongCredentials.userId, userId)));
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

/** 设置会话检索范围：scopeDocId / scopeGroupId 同时写入（互斥由 API 保证只有一个非 null）。 */
export async function setConversationScope(
  id: string,
  scopeDocId: string | null,
  scopeGroupId: string | null,
): Promise<void> {
  await db.update(conversations).set({ scopeDocId, scopeGroupId }).where(eq(conversations.id, id));
}

// ===== 认证：用户 / 会话 =====

export interface UserInput {
  id: string;
  email: string;
  passwordHash: string;
  displayName?: string | null;
}

/** 建用户。 */
export async function createUser(u: UserInput): Promise<void> {
  await db.insert(users).values({
    id: u.id,
    email: u.email,
    passwordHash: u.passwordHash,
    displayName: u.displayName ?? null,
  });
}

/** 按邮箱查用户（登录/查重）；不存在返回 null。 */
export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.email, email));
  return rows[0] ?? null;
}

/** 按 id 查用户（/me）；不存在返回 null。 */
export async function findUserById(id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

/** 按收集 token 查用户（/api/ingest 用 ref 反查归属员工）；不存在返回 null。 */
export async function findUserByCollectToken(token: string): Promise<UserRow | null> {
  if (!token) return null;
  const rows = await db.select().from(users).where(eq(users.collectToken, token));
  return rows[0] ?? null;
}

/** 设置/重置用户的收集 token。 */
export async function setUserCollectToken(userId: string, token: string): Promise<void> {
  await db.update(users).set({ collectToken: token }).where(eq(users.id, userId));
}

/** 记录最近登录时间（登录成功时调用）。 */
export async function touchUserLastLogin(userId: string): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

/** 换密码哈希（重置 / 修改密码）。调用方须已校验身份。 */
export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

// ===== 管理后台（全局只读，跨用户，仅 /admin 用；区别于上方按 userId 隔离的函数）=====

/** 注册用户总数。 */
export async function adminCountUsers(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return rows[0]?.n ?? 0;
}

export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  docCount: number;
  conversationCount: number;
  credentialCount: number;
};

/** 每个用户一行：基本信息 + 文档/对话/凭据计数。按注册时间倒序。 */
export async function adminListUsers(): Promise<AdminUserRow[]> {
  // 相关子查询：每个用户的文档/对话/凭据计数。
  // 必须手写完全限定的标识符（"docs"."user_id" = "users"."id"）：drizzle 在
  // db.select({...}).from(users) 的投影里，会把 sql 模板插值的列对象渲染成「不带表限定」的
  // "user_id"/"id"，于是子查询里的 "id" 绑到子查询自己的 docs 表（docs 也有 id 列），
  // 相关性丢失、恒等 0 行（已实测）。故这里用原始 SQL 字符串显式限定表名。
  // 映射：docs.user_id / conversations.user_id / miaodong_credentials.user_id ↔ users.id。
  const docCount = sql<number>`(select count(*)::int from "docs" where "docs"."user_id" = "users"."id")`;
  const convCount = sql<number>`(select count(*)::int from "conversations" where "conversations"."user_id" = "users"."id")`;
  const credCount = sql<number>`(select count(*)::int from "miaodong_credentials" where "miaodong_credentials"."user_id" = "users"."id")`;
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      docCount,
      conversationCount: convCount,
      credentialCount: credCount,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
  return rows;
}

export type AdminSystemStats = {
  totalUsers: number;
  totalDocs: number;
  docsByStatus: Record<string, number>;
  totalChunks: number;
  pushedDocCount: number;
  registrations7d: number;
  registrations30d: number;
};

/** 系统级统计。 */
export async function adminSystemStats(): Promise<AdminSystemStats> {
  const [userRow] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [docRow] = await db.select({ n: sql<number>`count(*)::int` }).from(docs);
  const [chunkRow] = await db.select({ n: sql<number>`count(*)::int` }).from(chunks);
  const [pushedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(docs)
    .where(sql`${docs.pushedAt} is not null`);
  const statusRows = await db
    .select({ status: docs.status, n: sql<number>`count(*)::int` })
    .from(docs)
    .groupBy(docs.status);
  const [reg7] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.createdAt} > now() - interval '7 days'`);
  const [reg30] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.createdAt} > now() - interval '30 days'`);
  const docsByStatus: Record<string, number> = {};
  for (const r of statusRows) docsByStatus[r.status] = r.n;
  return {
    totalUsers: userRow?.n ?? 0,
    totalDocs: docRow?.n ?? 0,
    docsByStatus,
    totalChunks: chunkRow?.n ?? 0,
    pushedDocCount: pushedRow?.n ?? 0,
    registrations7d: reg7?.n ?? 0,
    registrations30d: reg30?.n ?? 0,
  };
}

/** 建会话。id = cookie 原 token 的 sha256。 */
export async function createSession(s: { id: string; userId: string; expiresAt: Date }): Promise<void> {
  await db.insert(sessions).values({ id: s.id, userId: s.userId, expiresAt: s.expiresAt });
}

/** 按 id 查会话；不存在返回 null。不过滤过期——调用方须自行检查 expiresAt > now。 */
export async function findSessionById(id: string): Promise<SessionRow | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id));
  return rows[0] ?? null;
}

/** 删会话（登出 / 过期清理）。 */
export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/**
 * 删某用户全部会话（改/重置密码后强制所有设备重新登录，含当前这台）。
 * 返回删除行数，便于调用方记日志。
 */
export async function deleteSessionsByUser(userId: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return rows.length;
}

/** 某用户的全部文档 id（检索隔离用）。 */
export async function listDocIdsForUser(userId: string): Promise<string[]> {
  const rows = await db.select({ id: docs.id }).from(docs).where(eq(docs.userId, userId));
  return rows.map((r) => r.id);
}

// ===== 邮箱验证码（注册 / 重置密码）=====

export interface EmailVerificationInput {
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: Date;
  lastSentAt: Date;
}

/** 定位一行验证码的条件：(email, purpose) 复合主键。 */
function verificationKey(email: string, purpose: VerificationPurpose) {
  return and(eq(emailVerifications.email, email), eq(emailVerifications.purpose, purpose));
}

/** upsert 验证码（按 email+purpose；重发覆盖旧码并重置 attempts=0）。 */
export async function upsertEmailVerification(v: EmailVerificationInput): Promise<void> {
  await db
    .insert(emailVerifications)
    .values({
      email: v.email,
      purpose: v.purpose,
      codeHash: v.codeHash,
      expiresAt: v.expiresAt,
      lastSentAt: v.lastSentAt,
      attempts: 0,
    })
    .onConflictDoUpdate({
      target: [emailVerifications.email, emailVerifications.purpose],
      set: { codeHash: v.codeHash, expiresAt: v.expiresAt, lastSentAt: v.lastSentAt, attempts: 0 },
    });
}

/** 取验证码行；不存在返回 null。 */
export async function getEmailVerification(
  email: string,
  purpose: VerificationPurpose,
): Promise<EmailVerificationRow | null> {
  const rows = await db.select().from(emailVerifications).where(verificationKey(email, purpose));
  return rows[0] ?? null;
}

/** 输错一次：attempts+1，返回自增后的次数（原子，供超次作废判断）。 */
export async function incEmailVerificationAttempts(
  email: string,
  purpose: VerificationPurpose,
): Promise<number> {
  const rows = await db
    .update(emailVerifications)
    .set({ attempts: sql`${emailVerifications.attempts} + 1` })
    .where(verificationKey(email, purpose))
    .returning({ attempts: emailVerifications.attempts });
  return rows[0]?.attempts ?? 0;
}

/** 删验证码行（验证成功消费 / 超次作废）。 */
export async function deleteEmailVerification(
  email: string,
  purpose: VerificationPurpose,
): Promise<void> {
  await db.delete(emailVerifications).where(verificationKey(email, purpose));
}

// ───────────────────────── wiki 页（B 套加工产物） ─────────────────────────

export interface WikiPageInput {
  id: string;
  docId: string;
  pageIndex: number;
  title: string;
  content: string;
  headingPath: string[];
  tokenEstimate: number;
}

/** 整篇覆盖式写入：先清掉该文档已有的页，再插新页（重跑 wiki 化时幂等）。 */
export async function insertWikiPages(pages: WikiPageInput[]): Promise<void> {
  if (pages.length === 0) return;
  const docId = pages[0]!.docId;
  // 只能整篇写同一个文档：混了别的 docId 会导致 delete 范围（按 pages[0] 的 docId）
  // 与 insert 的行（原样带各自 docId）对不上，静默破坏「整篇覆盖式写入」语义。
  if (pages.some((p) => p.docId !== docId)) {
    throw new Error(`insertWikiPages 只能写入同一篇文档的页，收到了多个 docId`);
  }
  // delete + insert 必须同一事务：不然 insert 失败（唯一索引冲突/连接中断）时，
  // 旧页已删、新页未建成，会留下「该文档 wiki 页为空」的中间态。
  await db.transaction(async (tx) => {
    await tx.delete(wikiPages).where(eq(wikiPages.docId, docId));
    await tx.insert(wikiPages).values(pages);
  });
}

export async function listWikiPages(docId: string): Promise<WikiPageRow[]> {
  return db.select().from(wikiPages).where(eq(wikiPages.docId, docId)).orderBy(asc(wikiPages.pageIndex));
}

export async function getWikiPage(docId: string, pageIndex: number): Promise<WikiPageRow | null> {
  const rows = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.docId, docId), eq(wikiPages.pageIndex, pageIndex)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWikiOutline(docId: string): Promise<WikiPageRow | null> {
  return getWikiPage(docId, 0);
}

/** 只列 wiki_status=ready 的文档；pageCount 不含目录页（page_index=0）。 */
export async function listWikiDocs(docIds: string[]): Promise<Array<{ docId: string; title: string; pageCount: number }>> {
  if (docIds.length === 0) return [];
  const rows = await db
    .select({ docId: docs.id, title: docs.title, pageIndex: wikiPages.pageIndex })
    .from(docs)
    .innerJoin(wikiPages, eq(wikiPages.docId, docs.id))
    .where(and(inArray(docs.id, docIds), eq(docs.wikiStatus, "ready")));

  // 在 Node 层聚合：页数不含目录页（page_index=0）
  const byDoc = new Map<string, { docId: string; title: string; pageCount: number }>();
  for (const r of rows) {
    const cur = byDoc.get(r.docId) ?? { docId: r.docId, title: r.title, pageCount: 0 };
    if (r.pageIndex > 0) cur.pageCount++;
    byDoc.set(r.docId, cur);
  }
  return [...byDoc.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

export async function setWikiStatus(docId: string, status: string, error: string | null = null): Promise<void> {
  await db.update(docs).set({ wikiStatus: status, wikiError: error }).where(eq(docs.id, docId));
}

/** 全部 wiki_status=ready 的文档 id，不做用户过滤。仅供 CLI/调试工具（如 ab-demo）用——
 *  生产路由的检索隔离一律走 listDocIdsForUser 之类按用户限定的函数，不要在路由里复用这个。 */
export async function listWikiReadyDocIds(): Promise<string[]> {
  const rows = await db.select({ id: docs.id }).from(docs).where(eq(docs.wikiStatus, "ready"));
  return rows.map((r) => r.id);
}

/** 取该文档全部 chunk 的 heading_path（用于在 Node 层做 chunk→page 映射）。 */
export async function listChunkHeadings(docId: string): Promise<Array<{ id: string; headingPath: string[]; chunkIndex: number }>> {
  const rows = await db
    .select({ id: chunks.id, metadata: chunks.metadata, chunkIndex: chunks.chunkIndex })
    .from(chunks)
    .where(eq(chunks.docId, docId))
    .orderBy(asc(chunks.chunkIndex));
  return rows.map((r) => ({ id: r.id, headingPath: (r.metadata as any)?.heading_path ?? [], chunkIndex: r.chunkIndex }));
}

/**
 * 批量回填 chunks.page_id。按 pageId 分组，每组一条参数化 UPDATE
 * （页数通常几十，远少于 chunk 数；不拼 raw SQL）。
 */
export async function assignChunkPages(docId: string, mapping: Array<{ chunkId: string; pageId: string }>): Promise<void> {
  if (mapping.length === 0) return;
  const byPage = new Map<string, string[]>();
  for (const m of mapping) {
    const list = byPage.get(m.pageId) ?? [];
    list.push(m.chunkId);
    byPage.set(m.pageId, list);
  }
  for (const [pageId, chunkIds] of byPage) {
    await db
      .update(chunks)
      .set({ pageId })
      .where(and(eq(chunks.docId, docId), inArray(chunks.id, chunkIds)));
  }
}

/** chunkId → pageId 映射（agent 工具把命中的 chunk 折算成所属页时用）。 */
export async function pageIdsForChunkIds(chunkIds: string[]): Promise<Map<string, string>> {
  if (chunkIds.length === 0) return new Map();
  const rows = await db.select({ id: chunks.id, pageId: chunks.pageId }).from(chunks).where(inArray(chunks.id, chunkIds));
  const m = new Map<string, string>();
  for (const r of rows) if (r.pageId) m.set(r.id, r.pageId);
  return m;
}

// ───────────────────────── A/B 对比记录 ─────────────────────────

export interface AbRunInput {
  id: string;
  userId: string;
  groupId?: string | null;
  query: string;
  aAnswer?: string | null;
  aHits?: unknown;
  aMs?: number | null;
  aTokens?: number | null;
  aError?: string | null;
  bAnswer?: string | null;
  bTrace?: unknown;
  bMs?: number | null;
  bTokens?: number | null;
  bError?: string | null;
  /** 两栏语料范围（必修 3）：A 栏可查询的文档总数 / B 栏 list_docs 实际可见的文档数。见 schema.ts 注释。 */
  aScopeCount?: number | null;
  bScopeCount?: number | null;
}

export async function insertAbRun(r: AbRunInput): Promise<void> {
  // 断言收窄到 insert 的目标形状（而非 any）：aHits/bTrace 是 unknown（对应 jsonb 列，
  // drizzle 的列类型推导拒绝裸 unknown），此处只为绕开这一点，不该连带关掉 id/userId 等
  // 其余字段的类型检查——字段改名或拼错时仍要能被 tsc 抓到。
  await db.insert(abRuns).values(r as unknown as typeof abRuns.$inferInsert);
}

/**
 * 只允许本人改自己的评分。返回是否真的改到了行：id 不存在或不属于该用户时 update 影响 0 行，
 * 不报错也不代表评分被静默丢弃——调用方（路由层）必须据此区分「改成功」与「目标不存在/无权限」，
 * 不能无条件回 {ok:true}，否则用户在页面上看到评分成功、实际这条评分数据没有落库。
 *
 * drizzle-orm/postgres-js 的 update() 不带 .returning() 时，session.execute() 直接原样返回
 * postgres.js 的查询结果（该结果自带 count 字段=受影响行数），见
 * node_modules/drizzle-orm/postgres-js/session.js 的 `!fields && !customResultMapper` 分支。
 * drizzle 未导出该结果的类型，故需 `as any` 读 count；已用临时表实测验证过这个行为。
 */
export async function setAbVerdict(id: string, verdict: string, userId: string): Promise<boolean> {
  const result = await db.update(abRuns).set({ verdict }).where(and(eq(abRuns.id, id), eq(abRuns.userId, userId)));
  return (result as any).count > 0;
}
