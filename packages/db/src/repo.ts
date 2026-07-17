import { sql, eq, desc, asc, inArray, and } from "drizzle-orm";
import { db } from "./client";
import { docs, chunks, conversations, messages, miaodongCredentials, groups, users, sessions, emailVerifications } from "./schema";
import type { DocRow, ChunkRow, MessageRow, DocProgress, PushTarget, MiaodongCredentialRow, GroupRow, UserRow, SessionRow, EmailVerificationRow } from "./schema";
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

/** 关键词检索（jieba 分词 + Postgres 全文 ts_rank_cd，近似 BM25）。docIds 非空时限定到这些文档。 */
export async function keywordSearch(query: string, topK = 5, docIds?: string[] | null): Promise<SearchHit[]> {
  const tsq = toTsQuery(query);
  if (!tsq) return [];
  const docFilter = docFilterSql(docIds);
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

/** 某用户的全部文档 id（检索隔离用）。 */
export async function listDocIdsForUser(userId: string): Promise<string[]> {
  const rows = await db.select({ id: docs.id }).from(docs).where(eq(docs.userId, userId));
  return rows.map((r) => r.id);
}

// ===== 注册邮箱验证码 =====

export interface EmailVerificationInput {
  email: string;
  codeHash: string;
  expiresAt: Date;
  lastSentAt: Date;
}

/** upsert 验证码（按 email；重发覆盖旧码并重置 attempts=0）。 */
export async function upsertEmailVerification(v: EmailVerificationInput): Promise<void> {
  await db
    .insert(emailVerifications)
    .values({ email: v.email, codeHash: v.codeHash, expiresAt: v.expiresAt, lastSentAt: v.lastSentAt, attempts: 0 })
    .onConflictDoUpdate({
      target: emailVerifications.email,
      set: { codeHash: v.codeHash, expiresAt: v.expiresAt, lastSentAt: v.lastSentAt, attempts: 0 },
    });
}

/** 取验证码行；不存在返回 null。 */
export async function getEmailVerification(email: string): Promise<EmailVerificationRow | null> {
  const rows = await db.select().from(emailVerifications).where(eq(emailVerifications.email, email));
  return rows[0] ?? null;
}

/** 输错一次：attempts+1，返回自增后的次数（原子，供超次作废判断）。 */
export async function incEmailVerificationAttempts(email: string): Promise<number> {
  const rows = await db
    .update(emailVerifications)
    .set({ attempts: sql`${emailVerifications.attempts} + 1` })
    .where(eq(emailVerifications.email, email))
    .returning({ attempts: emailVerifications.attempts });
  return rows[0]?.attempts ?? 0;
}

/** 删验证码行（验证成功消费 / 超次作废）。 */
export async function deleteEmailVerification(email: string): Promise<void> {
  await db.delete(emailVerifications).where(eq(emailVerifications.email, email));
}
