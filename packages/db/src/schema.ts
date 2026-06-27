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
});

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
