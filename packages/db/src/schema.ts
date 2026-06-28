import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  customType,
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
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    docIdx: index("chunks_doc_idx").on(t.docId),
  }),
);

export type DocRow = typeof docs.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;

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
export const miaodongCredentials = pgTable("miaodong_credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  accessKeyId: text("access_key_id").notNull(),
  accessKeySecret: text("access_key_secret").notNull(),
  knowledgeBaseId: text("knowledge_base_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type MiaodongCredentialRow = typeof miaodongCredentials.$inferSelect;
