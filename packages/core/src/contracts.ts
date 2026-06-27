import { z } from "zod";

/** chunk 类型——反查时按类型分流（图片才取 image_url，文本取页码/章节）。 */
export const ChunkType = z.enum(["text", "image_caption", "table", "code"]);
export type ChunkType = z.infer<typeof ChunkType>;

/** 文档在管线里的状态机。 */
export const DocStatus = z.enum([
  "pending",
  "parsing",
  "structuring",
  "chunking",
  "vision",
  "contextualizing",
  "embedding",
  "ready",
  "pushed",
  "failed",
]);
export type DocStatus = z.infer<typeof DocStatus>;

/** chunk 的结构化元数据（数据契约，固定不乱改；见飞书「切片+多模态」§4.3）。 */
export const ChunkMetadata = z.object({
  doc_id: z.string(),
  doc_title: z.string(),
  heading_path: z.array(z.string()).default([]),
  page_num: z.number().int().nullable().default(null),
  chunk_index: z.number().int(),
  chunk_type: ChunkType.default("text"),
  image_url: z.string().nullable().default(null),
  image_id: z.string().nullable().default(null),
  prev_chunk_id: z.string().nullable().default(null),
  next_chunk_id: z.string().nullable().default(null),
  is_table_row: z.boolean().optional(), // CSV/Excel 按行切：标记「表头+单行」的行级 chunk
});
export type ChunkMetadata = z.infer<typeof ChunkMetadata>;

/** 一个 chunk。content = context_prefix + 换行 + content_original（上下文化后）。 */
export const Chunk = z.object({
  id: z.string(), // 可读且可排序，如 doc_42_c0007
  doc_id: z.string(),
  content: z.string(),
  content_original: z.string(),
  context_prefix: z.string().nullable().default(null),
  chunk_index: z.number().int(),
  chunk_type: ChunkType.default("text"),
  token_estimate: z.number().int().default(0),
  metadata: ChunkMetadata,
});
export type Chunk = z.infer<typeof Chunk>;

/** 一篇文档。 */
export const Doc = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  mime: z.string().nullable().default(null),
  file_id: z.string().nullable().default(null),
  raw_text: z.string().nullable().default(null),
  structured_md: z.string().nullable().default(null),
  status: DocStatus.default("pending"),
  created_at: z.date().optional(),
  confirmed_at: z.date().nullable().default(null),
  pushed_at: z.date().nullable().default(null),
});
export type Doc = z.infer<typeof Doc>;

/** 解析阶段抽出的一张图片。 */
export const ParsedImage = z.object({
  id: z.string(),
  description: z.string().nullable().default(null),
  data_ref: z.string().nullable().default(null), // file_id / url / outputs 路径
  page_num: z.number().int().nullable().default(null),
  context: z.string().nullable().default(null), // 图片前后正文，用于 vision 生成描述
});
export type ParsedImage = z.infer<typeof ParsedImage>;

/** 解析后端的统一返回。 */
export const ParseResult = z.object({
  markdown: z.string(),
  images: z.array(ParsedImage).default([]),
  raw_text: z.string().nullable().default(null),
  scanned: z.boolean().default(false), // 扫描件标记，命中则后续走 vision OCR
  meta: z.record(z.unknown()).default({}),
});
export type ParseResult = z.infer<typeof ParseResult>;
