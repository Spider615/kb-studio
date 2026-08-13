import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  customType,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { ChunkMetadata } from "@kb/core";

/**
 * pgvector 列：用 customType 自定义，避免依赖某个 drizzle 版本是否内置 `vector` 导出。
 * 入库时把 number[] 序列化成 `[1,2,3]`，读取时还原。
 */
const vectorType = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(v: number[]) {
      return `[${v.join(",")}]`;
    },
    fromDriver(v: string) {
      return v
        .replace(/^\[|\]$/g, "")
        .split(",")
        .filter(Boolean)
        .map(Number);
    },
  });

const embedding1024 = vectorType(1024);

export const groups = pgTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  orgId: text("org_id"),
  userId: text("user_id"),
  // 客户对该分组（一企业一组）的诉求：收集器表单采集，均可空，手动建组也不强制填
  agentPurpose: text("agent_purpose"), // "Agent主要用来做什么？"
  agentNotes: text("agent_notes"), // 其他补充
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GroupRow = typeof groups.$inferSelect;

export const docs = pgTable("docs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  mime: text("mime"),
  fileId: text("file_id"),
  rawText: text("raw_text"),
  structuredMd: text("structured_md"),
  status: text("status").notNull().default("pending"),
  orgId: text("org_id"),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  miaodongKbId: text("miaodong_kb_id"),
  miaodongDocId: text("miaodong_doc_id"),
  miaodongDomain: text("miaodong_domain"),
  // 异步处理进度（status=processing 时有值，完成后清空）
  progress: jsonb("progress").$type<DocProgress>(),
  // 处理失败原因（status=failed 时）
  error: text("error"),
  // 推送目标历史（可推送到多个秒懂知识库）
  pushTargets: jsonb("push_targets").$type<PushTarget[]>(),
  // 所属分组（null = 未分组）；删组时置 null，不删文档
  groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
  // wiki 化状态，与主 status 解耦：wiki 失败不让文档变 failed
  wikiStatus: text("wiki_status"), // null|pending|ready|failed
  wikiError: text("wiki_error"),
}, (t) => ({
  groupIdx: index("docs_group_idx").on(t.groupId),
}));

/** 处理阶段进度。 */
export type DocProgress = {
  stage: "parsing" | "structuring" | "contextualizing" | "embedding" | "storing";
  done: number;
  total: number;
};

/** 一次推送到某个秒懂知识库的记录。 */
export type PushTarget = {
  credentialId: string;
  credentialName: string;
  knowledgeBaseId: string;
  domain: string;
  remoteDocId: string | null;
  pushedAt: string; // ISO
};

export const chunks = pgTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentOriginal: text("content_original").notNull(),
    contextPrefix: text("context_prefix"),
    chunkIndex: integer("chunk_index").notNull(),
    chunkType: text("chunk_type").notNull().default("text"),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    metadata: jsonb("metadata").$type<ChunkMetadata>().notNull(),
    embedding: embedding1024("embedding"),
    tsvText: text("tsv_text"), // jieba 分词后的文本，BM25 用 to_tsvector('simple', tsv_text)
    // 所属 wiki 页（null = 该文档未跑 wiki 化）。A 套查询不带此列，零影响。
    // FK → wiki_pages(id) ON DELETE SET NULL：wiki 页被删（重跑 wiki 化会先删该文档全部页再重建）
    // 时若中途失败，避免留下指向已删页的悬空 ID。
    pageId: text("page_id").references(() => wikiPages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    docIdx: index("chunks_doc_idx").on(t.docId),
    pageIdx: index("chunks_page_id_idx").on(t.pageId),
  }),
);

export type DocRow = typeof docs.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;

/** wiki 页：按语义主题分的自包含大页，正文逐字取自原文。page_index=0 是 LLM 生成的目录页。 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(), // page_<docId>_<idx>
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(), // 0 = 目录页
    title: text("title").notNull(),
    content: text("content").notNull(),
    headingPath: jsonb("heading_path").$type<string[]>().notNull().default([]),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    docIdx: index("wiki_pages_doc_idx").on(t.docId),
    uniqDocPage: uniqueIndex("wiki_pages_doc_page_uniq").on(t.docId, t.pageIndex),
  }),
);
export type WikiPageRow = typeof wikiPages.$inferSelect;

/** A/B 对比记录：一次提问的两栏结果 + 人工评分。两栏各留 error 列，失败本身也是数据。 */
export const abRuns = pgTable(
  "ab_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id"),
    query: text("query").notNull(),

    aAnswer: text("a_answer"),
    aHits: jsonb("a_hits"),
    aMs: integer("a_ms"),
    aTokens: integer("a_tokens"),
    aError: text("a_error"),

    bAnswer: text("b_answer"),
    bTrace: jsonb("b_trace"),
    bMs: integer("b_ms"),
    bTokens: integer("b_tokens"),
    bError: text("b_error"),

    verdict: text("verdict"), // null|a|b|tie|neither
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("ab_runs_user_idx").on(t.userId, t.createdAt),
  }),
);
export type AbRunRow = typeof abRuns.$inferSelect;

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("新对话"),
  orgId: text("org_id"),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  scopeDocId: text("scope_doc_id"),
  // 检索范围限定到某分组（与 scopeDocId 互斥，由 API 保证只设其一）
  scopeGroupId: text("scope_group_id").references(() => groups.id, { onDelete: "set null" }),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    sources: jsonb("sources").$type<Array<{ id: string; heading_path: string[] }>>(),
    hits: jsonb("hits").$type<Array<{ id: string; score: number; heading_path: string[]; content: string }>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    convIdx: index("messages_conv_idx").on(t.conversationId, t.createdAt),
  }),
);

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/** 秒懂推送凭据（命名保存，可存多个；本地内部工具，secret 明文存）。 */
export const miaodongCredentials = pgTable(
  "miaodong_credentials",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    accessKeyId: text("access_key_id").notNull(),
    accessKeySecret: text("access_key_secret").notNull(),
    knowledgeBaseId: text("knowledge_base_id").notNull(),
    // 个人私密，按用户隔离；旧行为 null（对任何用户不可见）。保持可空，旧 null 行继续合法
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("miaodong_credentials_user_idx").on(t.userId),
  }),
);

export type MiaodongCredentialRow = typeof miaodongCredentials.$inferSelect;

// ===== 认证（用户 / 会话） =====

export const users = pgTable("users", {
  id: text("id").primaryKey(), // usr_xxxxxxxx
  email: text("email").notNull().unique(), // 小写归一
  passwordHash: text("password_hash").notNull(), // bcryptjs
  displayName: text("display_name"),
  // 专属收集链接 token（明文存：链接要能反复展示；低敏感，泄漏可一键重置）
  collectToken: text("collect_token"),
  // 最近一次登录时间（每次登录成功写 now()；存量行为 null）
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // cookie 原 token 的 sha256（不存原 token）
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

/** 验证码用途：注册 / 重置密码。同一邮箱两种码可并存，互不覆盖。 */
export type VerificationPurpose = "register" | "reset";

/**
 * 邮箱验证码（已发待校验；按 (email, purpose) 一行，重发 upsert 覆盖）。
 * purpose 进主键：否则用户点了「忘记密码」再去注册，前一个码会被顶掉。
 */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    email: text("email").notNull(),
    purpose: text("purpose").notNull().default("register"), // register | reset
    codeHash: text("code_hash").notNull(), // 6 位码的 sha256，不存明文
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0), // 输错次数，≥5 作废
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(), // 重发冷却用
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.email, t.purpose] }),
  }),
);

export type EmailVerificationRow = typeof emailVerifications.$inferSelect;
