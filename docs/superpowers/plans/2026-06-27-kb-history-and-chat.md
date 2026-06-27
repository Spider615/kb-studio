# 知识库历史 + 多轮对话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web` 单页重构成「知识库 / 对话」两模块应用：知识库列出/回看/删除已处理文档；对话做可持久化的多轮聊天。

**Architecture:** Next.js App Router 多路由（`/` 知识库、`/chat` 对话）+ 共享 layout 左侧导航。新增 `conversations`/`messages` 两表（drizzle）。检索/对话编排下沉到 `packages/pipeline/src/chat.ts`，DB 查询集中在 `packages/db/src/repo.ts`，API route 保持薄。docs/chunks 表与既有管线不动。

**Tech Stack:** TypeScript + Next.js 15（App Router, RSC + client components）+ drizzle-orm/postgres-js + pgvector + 302 网关（Anthropic SDK：Opus 作答 / Haiku 改写）+ tsx 跑 demo。

> **本仓库验证方式（无单测框架）：** 现有"测试"是 `npm run *-demo`（tsx 脚本，靠 `process.exit` 断言）+ `npm run typecheck` + 对 dev server 跑 curl + 浏览器手测。本计划按此约定写验证步骤，不引入 jest/vitest。参考 spec：`docs/superpowers/specs/2026-06-27-kb-history-and-chat-design.md`。

---

## 文件结构（本计划要创建/修改的文件）

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/db/src/schema.ts` | 加 conversations/messages 表 + 类型 | 改 |
| `packages/db/src/index.ts` | 导出新行类型 | 改 |
| `packages/db/src/repo.ts` | 文档列表/详情/删除 + 会话/消息 CRUD | 改 |
| `packages/adapters/src/llm/llm-client.ts` | `answer` 加 history；新增 `rewriteQuery` | 改 |
| `packages/pipeline/src/chat.ts` | `chatTurn()` 编排（改写→检索→作答） | 建 |
| `packages/pipeline/src/index.ts` | 导出 chat | 改 |
| `apps/worker/src/cli/chat-demo.ts` | 多轮对话 demo（充当测试） | 建 |
| `package.json` | 加 `chat-demo` 脚本 | 改 |
| `apps/web/app/api/docs/route.ts` | GET 文档列表 | 建 |
| `apps/web/app/api/docs/[id]/route.ts` | GET 详情 / DELETE | 建 |
| `apps/web/app/api/conversations/route.ts` | GET 列表 / POST 新建 | 建 |
| `apps/web/app/api/conversations/[id]/route.ts` | GET 详情(含 messages) / DELETE | 建 |
| `apps/web/app/api/chat/route.ts` | POST 一轮对话 | 建 |
| `apps/web/components/Nav.tsx` | 左侧导航 rail | 建 |
| `apps/web/components/DocList.tsx` | 知识库：文档列表 + 上传 | 建 |
| `apps/web/components/DocDetail.tsx` | 知识库：chunk 详情 + 删除 + 推送 | 建 |
| `apps/web/components/ConversationList.tsx` | 对话：会话列表 | 建 |
| `apps/web/components/ChatThread.tsx` | 对话：消息线程 + 输入 | 建 |
| `apps/web/app/layout.tsx` | 包 Nav 外壳 | 改 |
| `apps/web/app/page.tsx` | 知识库模块容器（两栏） | 改 |
| `apps/web/app/chat/page.tsx` | 对话模块容器（两栏） | 建 |
| `apps/web/app/globals.css` | 外壳 + 两栏 + 气泡样式 | 改 |

构建顺序：DB → repo → adapters → pipeline+demo（端到端打通后端逻辑）→ API → 前端外壳 → 两个模块页面 → 总验收。

---

## Task 1: DB schema — conversations / messages 两表 + 迁移

**Files:**
- Modify: `packages/db/src/schema.ts`（在文件末尾、`ChunkRow` 类型之前/之后追加）
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: 在 schema.ts 追加两张表**

在 `packages/db/src/schema.ts` 末尾（`export type ChunkRow = ...` 那行之后）追加：

```ts
export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("新对话"),
  orgId: text("org_id"),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
```

（`pgTable/text/timestamp/jsonb/index` 都已在文件顶部 import，无需新增。）

- [ ] **Step 2: 在 index.ts 导出新类型**

把 `packages/db/src/index.ts` 第 3 行改为：

```ts
export type { DocRow, ChunkRow, ConversationRow, MessageRow } from "./schema";
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过，无报错。

- [ ] **Step 4: 生成并应用迁移**

Run: `npm run db:generate && npm run db:migrate`
Expected: drizzle-kit 在 `packages/db/migrations/` 生成一个新 SQL 文件，迁移成功（输出含 `conversations`、`messages`）。

- [ ] **Step 5: 验证表存在**

Run: `docker exec kb-studio-db psql -U kb -d kbstudio -c "\d conversations" -c "\d messages"`
Expected: 两张表的字段定义都打印出来；`messages.conversation_id` 有外键到 `conversations`。

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/index.ts packages/db/migrations
git commit -m "feat(db): conversations/messages 两表 + 迁移"
```

---

## Task 2: repo — 文档列表/详情/删除 + 会话/消息 CRUD

**Files:**
- Modify: `packages/db/src/repo.ts`

- [ ] **Step 1: 更新顶部 import**

把 `packages/db/src/repo.ts` 第 1、3 行改为：

```ts
import { sql, eq, desc, asc } from "drizzle-orm";
import { db } from "./client";
import { docs, chunks, conversations, messages } from "./schema";
```

- [ ] **Step 2: 追加文档读取/删除 helper**

在 `repo.ts` 末尾（`clearAll` 之后）追加：

```ts
export interface DocListItem {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  createdAt: Date;
  pushedAt: Date | null;
}

/** 文档列表（含 chunk 数），按创建时间倒序。 */
export async function listDocs(): Promise<DocListItem[]> {
  const rows = await db.execute(sql`
    SELECT d.id, d.title, d.source, d.status, d.created_at, d.pushed_at,
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
  }));
}

/** 单篇文档 + 它的 chunk（按 chunk_index 正序）；不存在返回 null。 */
export async function getDocWithChunks(docId: string) {
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
```

- [ ] **Step 3: 追加会话/消息 helper**

继续在 `repo.ts` 末尾追加：

```ts
/** 新建空会话。 */
export async function createConversation(id: string, title = "新对话") {
  await db.insert(conversations).values({ id, title });
  return { id, title };
}

/** 会话列表（id/title/updatedAt），按最近更新倒序。 */
export async function listConversations() {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .orderBy(desc(conversations.updatedAt));
}

/** 单个会话，不存在返回 null。 */
export async function getConversation(id: string) {
  const rows = await db.select().from(conversations).where(eq(conversations.id, id));
  return rows[0] ?? null;
}

/** 会话的全部消息，按时间正序。 */
export async function getMessages(conversationId: string) {
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

/** 刷新会话 updatedAt（可选改 title，仅首轮传）。 */
export async function touchConversation(id: string, title?: string): Promise<void> {
  const set: { updatedAt: Date; title?: string } = { updatedAt: new Date() };
  if (title) set.title = title;
  await db.update(conversations).set(set).where(eq(conversations.id, id));
}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 5: 冒烟验证 repo（一次性 tsx 脚本，验证后删除）**

Run:
```bash
npx tsx -e "import 'dotenv/config'; import { createConversation, listConversations, insertMessage, getMessages, deleteConversation, listDocs } from './packages/db/src/index.ts'; const c = await createConversation('conv_smoke','冒烟'); await insertMessage({id:'msg_s1',conversationId:c.id,role:'user',content:'hi'}); console.log('msgs', (await getMessages(c.id)).length); console.log('convs>=1', (await listConversations()).length>=1); await deleteConversation(c.id); console.log('after del msgs', (await getMessages(c.id)).length); console.log('docs', (await listDocs()).length); process.exit(0);"
```
Expected: 打印 `msgs 1`、`convs>=1 true`、`after del msgs 0`（验证级联删消息）、`docs <数字>`。

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repo.ts
git commit -m "feat(db): repo 加文档列表/详情/删除 + 会话/消息 CRUD"
```

---

## Task 3: LlmClient — `answer` 支持历史 + 新增 `rewriteQuery`

**Files:**
- Modify: `packages/adapters/src/llm/llm-client.ts:131-171`（`answer` 方法）+ 新增方法

- [ ] **Step 1: 把 `answer` 第三参数从 `model?` 改为 `opts`（含 history），向后兼容**

把 `llm-client.ts` 中 `async answer(...)` 的签名与 `params` 构造（第 131-153 行）替换为：

```ts
  /** Citations 问答：把 top chunks 作可引用文档喂 Opus，返回 {answer, sources}（block_index→chunk 反查）。
   *  opts.history：多轮对话的前几轮 {role,content}，会垫进 messages 数组（仅最后一轮带可引用 document）。 */
  async answer(
    query: string,
    chunks: Array<{ id: string; content: string; heading_path: string[] }>,
    opts: { model?: string; history?: Array<{ role: "user" | "assistant"; content: string }> } = {},
  ): Promise<{ answer: string; sources: Array<{ id: string; heading_path: string[] }> }> {
    const history = (opts.history ?? []).map((m) => ({ role: m.role, content: m.content }));
    const params: any = {
      model: opts.model ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
      max_tokens: 1024,
      system: "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。",
      messages: [
        ...history,
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "content", content: chunks.map((c) => ({ type: "text", text: c.content })) },
              citations: { enabled: true },
            },
            { type: "text", text: query },
          ],
        },
      ],
    };
```

（第 154 行起 `const res: any = await this.client.messages.create(params);` 之后的解析逻辑保持不变。）

- [ ] **Step 2: 新增 `rewriteQuery` 方法**

在 `answer` 方法的右花括号之后、类的结束 `}` 之前，追加：

```ts
  /** 多轮检索改写：把对话历史 + 最新问题压成一句能独立检索的查询（指代消解、补主语）。
   *  默认走 KB_MODEL_CONTEXT（haiku）。返回空串时调用方应回退原问题。 */
  async rewriteQuery(transcript: string, question: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? this.defaultModel,
      max_tokens: 200,
      system:
        "你把多轮对话里的最新问题改写成一句能独立检索的查询：补全指代和省略的主语。只输出改写后的查询本身，不要解释、不要引号。",
      messages: [
        {
          role: "user",
          content: ["<对话历史>", transcript, "</对话历史>", "", `最新问题：${question}`, "", "改写后的独立查询："].join(
            "\n",
          ),
        },
      ],
    });
    return firstText(res);
  }
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过。现有 `answer(query, chunks)` 两参调用（`answer-demo.ts`、`apps/web/app/api/search/route.ts`）不受影响。

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/src/llm/llm-client.ts
git commit -m "feat(llm): answer 支持多轮 history + 新增 rewriteQuery 检索改写"
```

---

## Task 4: pipeline `chatTurn()` + `chat-demo`（充当测试）

**Files:**
- Create: `packages/pipeline/src/chat.ts`
- Modify: `packages/pipeline/src/index.ts`
- Create: `apps/worker/src/cli/chat-demo.ts`
- Modify: `package.json`（scripts）

- [ ] **Step 1: 先写 demo（失败用例）**

创建 `apps/worker/src/cli/chat-demo.ts`：

```ts
import "dotenv/config";
import { LlmClient, OpenAICompatEmbedder, Reranker302 } from "@kb/adapters";
import { clearAll } from "@kb/db";
import { ingestDoc, chatTurn, type ChatMessage } from "@kb/pipeline";

// 多轮对话全链路：入库 → (改写→混合检索+rerank→带历史 Opus 作答) ×2 轮。
const md = `# 用户服务协议

## 退款政策

退款申请需在购买后 7 日内提交，逾期视为自动放弃。退款审核通常在三个工作日内完成，通过后款项原路退回到原支付账户。

## 隐私保护

我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据。
`;

const llm = new LlmClient();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});
const reranker = new Reranker302();

await clearAll();
console.error("→ 入库…");
await ingestDoc({ docId: "doc_a", title: "用户服务协议", source: "chat-demo", markdown: md }, { llm, embedder });

const history: ChatMessage[] = [];
async function ask(q: string) {
  const r = await chatTurn(history, q, { llm, embedder, reranker }, { topK: 3, poolN: 8 });
  history.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
  console.log(`\nQ: ${q}\n改写: ${r.standaloneQuery}\nA: ${r.answer}\n溯源: ${r.sources.map((s) => s.heading_path.join(" > ")).join(" | ") || "(无)"}`);
  return r;
}

const r1 = await ask("退款申请有时间限制吗？");
const r2 = await ask("那审核一般要几个工作日？"); // 追问：靠历史把"那"消解成退款审核
process.exit(r1.answer.length > 5 && r2.answer.length > 5 ? 0 : 1);
```

- [ ] **Step 2: 加 npm 脚本**

在 `package.json` 的 `scripts` 里、`"answer-demo"` 那行之后加：

```json
    "chat-demo": "tsx apps/worker/src/cli/chat-demo.ts",
```

- [ ] **Step 3: 运行 demo，确认失败（chatTurn 尚不存在）**

Run: `npm run chat-demo`
Expected: FAIL —— 报错类似 `'chatTurn' is not exported by @kb/pipeline` 或模块解析失败。

- [ ] **Step 4: 实现 chatTurn**

创建 `packages/pipeline/src/chat.ts`：

```ts
import { retrieve, type RetrieveDeps, type RetrieveOptions } from "./retrieve";
import type { LlmClient } from "@kb/adapters";
import type { SearchHit } from "@kb/db";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDeps extends RetrieveDeps {
  llm: LlmClient;
}

export interface ChatTurnResult {
  answer: string;
  sources: Array<{ id: string; heading_path: string[] }>;
  hits: SearchHit[];
  standaloneQuery: string;
}

/** 一轮对话编排：历史感知改写 → 混合检索(+rerank) → 带历史的 Opus 引用作答。
 *  history 为该会话此前的全部轮次（不含本次 query）。 */
export async function chatTurn(
  history: ChatMessage[],
  query: string,
  deps: ChatDeps,
  opts: RetrieveOptions = {},
): Promise<ChatTurnResult> {
  // 首轮无历史，直接用原问题，省一次模型调用
  let standaloneQuery = query;
  if (history.length > 0) {
    const transcript = history
      .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n");
    const rewritten = await deps.llm.rewriteQuery(transcript, query);
    if (rewritten) standaloneQuery = rewritten;
  }

  const hits = await retrieve(standaloneQuery, deps, opts);
  const { answer, sources } = await deps.llm.answer(
    query,
    hits.map((h) => ({ id: h.id, content: h.content, heading_path: h.heading_path })),
    { history },
  );
  return { answer, sources, hits, standaloneQuery };
}
```

- [ ] **Step 5: 导出 chat**

把 `packages/pipeline/src/index.ts` 改为：

```ts
export * from "./ingest";
export * from "./retrieve";
export * from "./chat";
```

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 7: 运行 demo，确认通过（需 DB 在跑 + 302 在线）**

Run: `npm run db:up && npm run chat-demo`
Expected: PASS（exit 0）。输出里第二轮的 `改写:` 应把"那审核…"补成含"退款"的独立查询；两轮 `A:` 都有实质答案。

- [ ] **Step 8: Commit**

```bash
git add packages/pipeline/src/chat.ts packages/pipeline/src/index.ts apps/worker/src/cli/chat-demo.ts package.json
git commit -m "feat(pipeline): chatTurn 多轮对话编排 + chat-demo"
```

---

## Task 5: API — 文档端点（list / detail / delete）

**Files:**
- Create: `apps/web/app/api/docs/route.ts`
- Create: `apps/web/app/api/docs/[id]/route.ts`

- [ ] **Step 1: GET 文档列表**

创建 `apps/web/app/api/docs/route.ts`：

```ts
import { NextResponse } from "next/server";
import { listDocs } from "@kb/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ docs: await listDocs() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: GET 详情 + DELETE**

创建 `apps/web/app/api/docs/[id]/route.ts`（Next 15：`params` 是 Promise，需 await）：

```ts
import { NextResponse } from "next/server";
import { getDocWithChunks, deleteDoc } from "@kb/db";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const data = await getDocWithChunks(id);
    if (!data) return NextResponse.json({ error: "文档不存在" }, { status: 404 });
    const chunks = data.chunks.map((r: any) => ({
      id: r.id,
      chunk_type: r.chunkType,
      token_estimate: r.tokenEstimate,
      context_prefix: r.contextPrefix,
      content_original: r.contentOriginal,
      heading_path: (r.metadata as any)?.heading_path ?? [],
    }));
    return NextResponse.json({
      doc: { id: data.doc.id, title: data.doc.title, status: data.doc.status },
      chunks,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteDoc(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: 起 dev server 验证（后台跑）**

Run: `npm run dev --workspace @kb/web`（在另一个终端，或后台）
等待输出 `Ready`，监听 http://localhost:3001。

- [ ] **Step 5: curl 验证 list + detail + delete**

Run:
```bash
curl -s localhost:3001/api/docs | head -c 400; echo
# 取列表里第一个 docId（grep 第一个 "id":"..."）
DID=$(curl -s localhost:3001/api/docs | grep -o '"id":"[^"]*"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
echo "DID=$DID"
curl -s "localhost:3001/api/docs/$DID" | head -c 400; echo
```
Expected: `/api/docs` 返回 `{"docs":[...]}` 含 `chunkCount`；`/api/docs/$DID` 返回 `{"doc":{...},"chunks":[...]}`。
（删除验证放到 Task 9 手测，避免误删现有数据。）

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/docs
git commit -m "feat(web): /api/docs 文档列表/详情/删除端点"
```

---

## Task 6: API — 会话端点（list / new / detail / delete）

**Files:**
- Create: `apps/web/app/api/conversations/route.ts`
- Create: `apps/web/app/api/conversations/[id]/route.ts`

- [ ] **Step 1: GET 列表 + POST 新建**

创建 `apps/web/app/api/conversations/route.ts`：

```ts
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listConversations, createConversation } from "@kb/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ conversations: await listConversations() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const id = "conv_" + randomUUID().slice(0, 8);
    const conv = await createConversation(id);
    return NextResponse.json(conv);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: GET 详情(含 messages) + DELETE**

创建 `apps/web/app/api/conversations/[id]/route.ts`：

```ts
import { NextResponse } from "next/server";
import { getConversation, getMessages, deleteConversation } from "@kb/db";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const conversation = await getConversation(id);
    if (!conversation) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const messages = await getMessages(id);
    return NextResponse.json({ conversation, messages });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteConversation(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 4: curl 验证（dev server 仍在跑）**

Run:
```bash
CID=$(curl -s -X POST localhost:3001/api/conversations | sed -E 's/.*"id":"([^"]+)".*/\1/'); echo "CID=$CID"
curl -s localhost:3001/api/conversations | head -c 300; echo
curl -s "localhost:3001/api/conversations/$CID" | head -c 200; echo
curl -s -X DELETE "localhost:3001/api/conversations/$CID"; echo
```
Expected: POST 返回 `{"id":"conv_...","title":"新对话"}`；list 含该会话；detail 返回 `{"conversation":{...},"messages":[]}`；DELETE 返回 `{"ok":true}`。

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/conversations
git commit -m "feat(web): /api/conversations 会话列表/新建/详情/删除端点"
```

---

## Task 7: API — 一轮对话端点

**Files:**
- Create: `apps/web/app/api/chat/route.ts`

- [ ] **Step 1: POST /api/chat**

创建 `apps/web/app/api/chat/route.ts`：

```ts
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatTurn, type ChatMessage } from "@kb/pipeline";
import { getConversation, getMessages, insertMessage, touchConversation } from "@kb/db";
import { getDeps } from "../../../lib/kb";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const { conversationId, query } = await req.json();
    if (!conversationId || !query)
      return NextResponse.json({ error: "缺少 conversationId 或 query" }, { status: 400 });

    const conv = await getConversation(conversationId);
    if (!conv) return NextResponse.json({ error: "会话不存在" }, { status: 400 });

    // 取本次之前的历史（决定是否首轮 + 是否改写）
    const prior = await getMessages(conversationId);
    const history: ChatMessage[] = prior.map((m: any) => ({ role: m.role, content: m.content }));

    const { llm, embedder, reranker } = getDeps();
    const r = await chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10 });

    const hits = r.hits.map((h) => ({
      id: h.id,
      score: h.score,
      heading_path: h.heading_path,
      content: h.content,
    }));

    await insertMessage({ id: "msg_" + randomUUID().slice(0, 8), conversationId, role: "user", content: query });
    await insertMessage({
      id: "msg_" + randomUUID().slice(0, 8),
      conversationId,
      role: "assistant",
      content: r.answer,
      sources: r.sources,
      hits,
    });

    // 首轮把 title 设为问题前 20 字
    const title = history.length === 0 ? query.slice(0, 20) : undefined;
    await touchConversation(conversationId, title);

    return NextResponse.json({ answer: r.answer, sources: r.sources, hits, title: title ?? conv.title });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 3: curl 端到端验证（需 DB + 302 在线，库里已有文档）**

Run:
```bash
CID=$(curl -s -X POST localhost:3001/api/conversations | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -X POST localhost:3001/api/chat -H 'content-type: application/json' \
  -d "{\"conversationId\":\"$CID\",\"query\":\"退款审核要几个工作日？\"}" | head -c 500; echo
curl -s "localhost:3001/api/conversations/$CID" | head -c 300; echo
```
Expected: 第一次返回 `{"answer":"...","sources":[...],"hits":[...],"title":"退款审核要几个工作日？"}`；随后 detail 显示该会话已有 2 条 message（user+assistant）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/chat
git commit -m "feat(web): /api/chat 一轮对话端点（检索→作答→落库）"
```

---

## Task 8: 应用外壳 — Nav + layout + 基础样式

**Files:**
- Create: `apps/web/components/Nav.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Nav 组件**

创建 `apps/web/components/Nav.tsx`：

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "知识库" },
  { href: "/chat", label: "对话" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <div className="nav-brand">kb-studio</div>
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={active ? "nav-item active" : "nav-item"}>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: layout 包外壳**

把 `apps/web/app/layout.tsx` 整体替换为：

```tsx
import "./globals.css";
import Nav from "../components/Nav";

export const metadata = { title: "kb-studio · 知识库处理台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <div className="app">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: 追加外壳/两栏/气泡样式**

在 `apps/web/app/globals.css` 末尾追加：

```css
/* 应用外壳 */
.app { display: flex; min-height: 100vh; }
.nav { width: 132px; flex-shrink: 0; background: #111827; color: #cbd5e1; padding: 18px 12px; display: flex; flex-direction: column; gap: 6px; }
.nav-brand { color: #fff; font-weight: 700; font-size: 15px; padding: 4px 8px 14px; }
.nav-item { display: block; padding: 9px 12px; border-radius: 8px; color: #cbd5e1; text-decoration: none; font-size: 14px; }
.nav-item.active { background: #1f2937; color: #fff; }
.main { flex: 1; min-width: 0; }

/* 两栏：列表列 + 详情区 */
.pane-2 { display: flex; height: 100vh; }
.list-col { width: 280px; flex-shrink: 0; border-right: 1px solid #e6e8eb; background: #fbfbfc; display: flex; flex-direction: column; }
.upload-box { padding: 14px; border-bottom: 1px solid #eceef0; display: flex; flex-direction: column; gap: 8px; }
.list { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.list-item { display: flex; align-items: center; border: 0; background: transparent; border-radius: 8px; padding: 0; }
.list-item.active { background: #eef2ff; }
.li-main { flex: 1; min-width: 0; background: transparent; color: inherit; border: 0; padding: 9px 10px; text-align: left; cursor: pointer; }
.li-title { font-size: 13px; font-weight: 600; color: #1f2328; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.li-meta { font-size: 11px; color: #9ca3af; margin-top: 2px; }
.li-del { background: transparent; color: #9ca3af; border: 0; padding: 6px 10px; cursor: pointer; }
.li-del:hover { color: #b91c1c; }
.detail-col { flex: 1; min-width: 0; overflow-y: auto; padding: 22px 26px; }
.detail-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 12px; }
.detail-head h2 { font-size: 15px; margin: 0; color: #374151; }
button.danger { background: #b91c1c; }

/* 对话气泡 */
.detail-col.chat { display: flex; flex-direction: column; padding: 0; }
.thread { flex: 1; overflow-y: auto; padding: 22px 26px; display: flex; flex-direction: column; gap: 14px; }
.bubble { max-width: 76%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.7; }
.bubble.user { align-self: flex-end; background: #111827; color: #fff; }
.bubble.asst { align-self: flex-start; background: #f0fdf4; border: 1px solid #bbf7d0; }
.bubble-body { white-space: pre-wrap; }
.composer { display: flex; gap: 10px; padding: 14px 20px; border-top: 1px solid #e6e8eb; background: #fff; }
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 通过。（此时 `/` 仍是旧 page，会被 Task 9 替换；外壳已就位。）

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/Nav.tsx apps/web/app/layout.tsx apps/web/app/globals.css
git commit -m "feat(web): 应用外壳 — 左侧导航 Nav + 两栏/气泡样式"
```

---

## Task 9: 知识库模块 — page.tsx + DocList + DocDetail

**Files:**
- Create: `apps/web/components/DocList.tsx`
- Create: `apps/web/components/DocDetail.tsx`
- Modify: `apps/web/app/page.tsx`（整体替换）

- [ ] **Step 1: DocList（列表 + 上传入口）**

创建 `apps/web/components/DocList.tsx`：

```tsx
"use client";
import { useRef, useState } from "react";

export type DocItem = {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  createdAt: string;
  pushedAt: string | null;
};

export default function DocList({
  docs,
  selectedId,
  onSelect,
  onUploaded,
}: {
  docs: DocItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUploaded: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (json.error) setErr(json.error);
      else {
        if (fileRef.current) fileRef.current.value = "";
        onUploaded(json.docId);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  return (
    <aside className="list-col">
      <div className="upload-box">
        <input type="file" ref={fileRef} />
        <button onClick={upload} disabled={busy}>
          {busy ? "处理中…" : "上传并处理"}
        </button>
        {busy && <p className="muted">解析→切片→上下文化→向量化…</p>}
        {err && <p className="err">⚠ {err}</p>}
      </div>
      <div className="list">
        {docs.length === 0 && <p className="muted">还没有文档，先上传一个</p>}
        {docs.map((d) => (
          <div key={d.id} className={d.id === selectedId ? "list-item active" : "list-item"}>
            <button className="li-main" onClick={() => onSelect(d.id)}>
              <div className="li-title">{d.title}</div>
              <div className="li-meta">
                {d.chunkCount} chunk · {d.status}
              </div>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: DocDetail（chunk 详情 + 删除 + 推送）**

创建 `apps/web/components/DocDetail.tsx`：

```tsx
"use client";
import { useEffect, useState } from "react";

type Chunk = {
  id: string;
  chunk_type: string;
  token_estimate: number;
  context_prefix: string | null;
  content_original: string;
  heading_path: string[];
};

export default function DocDetail({
  docId,
  onDeleted,
}: {
  docId: string | null;
  onDeleted: (id: string) => void;
}) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!docId) {
      setChunks([]);
      setTitle("");
      return;
    }
    setLoading(true);
    setErr("");
    setPushed(false);
    fetch(`/api/docs/${docId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else {
          setChunks(json.chunks);
          setTitle(json.doc.title);
          setPushed(json.doc.status === "pushed");
        }
      })
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [docId]);

  async function del() {
    if (!docId || !confirm("删除这篇文档及其所有 chunk？")) return;
    const res = await fetch(`/api/docs/${docId}`, { method: "DELETE" });
    const json = await res.json();
    if (json.ok) onDeleted(docId);
    else setErr(json.error ?? "删除失败");
  }

  async function push() {
    if (!docId) return;
    const res = await fetch("/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    });
    const json = await res.json();
    if (json.ok) setPushed(true);
    else setErr(json.error ?? "推送失败");
  }

  if (!docId)
    return (
      <section className="detail-col">
        <p className="muted">从左侧选择一篇文档查看 chunk</p>
      </section>
    );

  return (
    <section className="detail-col">
      <div className="detail-head">
        <h2>
          {title}（{chunks.length} chunk）
        </h2>
        <div className="row">
          {pushed ? <span className="ok">✅ 已推送</span> : <button onClick={push}>确认推送秒懂</button>}
          <button className="danger" onClick={del}>
            删除
          </button>
        </div>
      </div>
      {err && <p className="err">⚠ {err}</p>}
      {loading ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="chunks">
          {chunks.map((c) => (
            <div className="chunk" key={c.id}>
              <div className="chunk-head">
                <span className="badge">{c.chunk_type}</span>
                <span className="path">{c.heading_path.join(" › ") || "(根)"}</span>
                <span className="tok">~{c.token_estimate} tok</span>
              </div>
              {c.context_prefix && <div className="prefix">＋上下文：{c.context_prefix}</div>}
              <div className="body">{c.content_original}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: page.tsx 改为知识库容器**

把 `apps/web/app/page.tsx` 整体替换为：

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import DocList, { type DocItem } from "../components/DocList";
import DocDetail from "../components/DocDetail";

export default function KbPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/docs");
    const json = await res.json();
    setDocs(json.docs ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onUploaded = useCallback(
    async (id: string) => {
      await load();
      setSelectedId(id);
    },
    [load],
  );

  const onDeleted = useCallback(
    async (id: string) => {
      setSelectedId((s) => (s === id ? null : s));
      await load();
    },
    [load],
  );

  return (
    <div className="pane-2">
      <DocList docs={docs} selectedId={selectedId} onSelect={setSelectedId} onUploaded={onUploaded} />
      <DocDetail docId={selectedId} onDeleted={onDeleted} />
    </div>
  );
}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 5: 浏览器手测知识库全流程**

打开 http://localhost:3001/ ，依次验证：
1. 左栏列出库里已有文档（含 chunk 数 / 状态）—— **这正是"历史看得见"**。
2. 点一篇 → 右侧显示它的 chunk（类型/heading/上下文前缀/原文）。
3. 上传一个新文件 → 处理完后左栏出现并自动选中、右侧显示其 chunk。
4. 对刚上传那篇点「删除」→ 确认 → 左栏消失、右侧清空。

- [ ] **Step 6: DB 验证级联删除**

Run:（把 `<被删docId>` 换成上一步删掉的 id）
```bash
docker exec kb-studio-db psql -U kb -d kbstudio -c "select count(*) from chunks where doc_id='<被删docId>';"
```
Expected: `0`（chunk 随文档级联删除）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/DocList.tsx apps/web/components/DocDetail.tsx apps/web/app/page.tsx
git commit -m "feat(web): 知识库模块 — 文档列表/回看 chunk/删除"
```

---

## Task 10: 对话模块 — chat/page.tsx + ConversationList + ChatThread

**Files:**
- Create: `apps/web/components/ConversationList.tsx`
- Create: `apps/web/components/ChatThread.tsx`
- Create: `apps/web/app/chat/page.tsx`

- [ ] **Step 1: ConversationList**

创建 `apps/web/components/ConversationList.tsx`：

```tsx
"use client";

export type Conv = { id: string; title: string; updatedAt: string };

export default function ConversationList({
  items,
  selectedId,
  onSelect,
  onNew,
  onDelete,
}: {
  items: Conv[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="list-col">
      <div className="upload-box">
        <button onClick={onNew}>+ 新建对话</button>
      </div>
      <div className="list">
        {items.length === 0 && <p className="muted">还没有对话</p>}
        {items.map((c) => (
          <div key={c.id} className={c.id === selectedId ? "list-item active" : "list-item"}>
            <button className="li-main" onClick={() => onSelect(c.id)}>
              <div className="li-title">{c.title}</div>
            </button>
            <button className="li-del" onClick={() => onDelete(c.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: ChatThread**

创建 `apps/web/components/ChatThread.tsx`：

```tsx
"use client";
import { useEffect, useRef, useState } from "react";

type Src = { id: string; heading_path: string[] };
type Hit = { id: string; score: number; heading_path: string[]; content: string };
type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Src[] | null;
  hits: Hit[] | null;
};

export default function ChatThread({
  conversationId,
  onTitle,
}: {
  conversationId: string | null;
  onTitle: (id: string, title: string) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversationId) {
      setMsgs([]);
      return;
    }
    setErr("");
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else setMsgs(json.messages ?? []);
      })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, [conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, sending]);

  async function send() {
    if (!conversationId || !input.trim() || sending) return;
    const q = input.trim();
    setInput("");
    setSending(true);
    setErr("");
    setMsgs((m) => [...m, { id: "tmp_" + q, role: "user", content: q, sources: null, hits: null }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, query: q }),
      });
      const json = await res.json();
      if (json.error) setErr(json.error);
      else {
        setMsgs((m) => [
          ...m,
          { id: "a_" + m.length, role: "assistant", content: json.answer, sources: json.sources, hits: json.hits },
        ]);
        if (json.title) onTitle(conversationId, json.title);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setSending(false);
  }

  if (!conversationId)
    return (
      <section className="detail-col">
        <p className="muted">新建或选择一个对话开始提问</p>
      </section>
    );

  return (
    <section className="detail-col chat">
      <div className="thread">
        {msgs.map((m) => (
          <div key={m.id} className={m.role === "user" ? "bubble user" : "bubble asst"}>
            <div className="bubble-body">{m.content}</div>
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="sources">溯源：{m.sources.map((s) => s.heading_path.join(" › ")).join("  |  ")}</div>
            )}
            {m.role === "assistant" && m.hits && m.hits.length > 0 && (
              <details>
                <summary>命中的 {m.hits.length} 个片段</summary>
                {m.hits.map((h) => (
                  <div className="hit" key={h.id}>
                    <span className="score">{h.score.toFixed(3)}</span>
                    <span className="path">{h.heading_path.join(" › ")}</span>
                    <div className="hit-body">{h.content.slice(0, 120)}…</div>
                  </div>
                ))}
              </details>
            )}
          </div>
        ))}
        {sending && (
          <div className="bubble asst">
            <div className="bubble-body muted">思考中…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {err && <p className="err">⚠ {err}</p>}
      <div className="composer">
        <input
          className="grow"
          value={input}
          placeholder="问点什么…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={sending}>
          {sending ? "…" : "发送"}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: chat/page.tsx 容器**

创建 `apps/web/app/chat/page.tsx`：

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import ConversationList, { type Conv } from "../../components/ConversationList";
import ChatThread from "../../components/ChatThread";

export default function ChatPage() {
  const [items, setItems] = useState<Conv[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const json = await res.json();
    setItems(json.conversations ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onNew = useCallback(async () => {
    const res = await fetch("/api/conversations", { method: "POST" });
    const json = await res.json();
    if (json.id) {
      await load();
      setSelectedId(json.id);
    }
  }, [load]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm("删除这个对话？")) return;
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      setSelectedId((s) => (s === id ? null : s));
      await load();
    },
    [load],
  );

  const onTitle = useCallback((id: string, title: string) => {
    setItems((arr) => arr.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  return (
    <div className="pane-2">
      <ConversationList items={items} selectedId={selectedId} onSelect={setSelectedId} onNew={onNew} onDelete={onDelete} />
      <ChatThread conversationId={selectedId} onTitle={onTitle} />
    </div>
  );
}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 5: 浏览器手测对话全流程**

打开 http://localhost:3001/chat ，验证：
1. 点「+ 新建对话」→ 左栏出现「新对话」并选中。
2. 问一句（如"退款要几天？"）→ 出现 user 气泡 + assistant 气泡（含溯源 + 可折叠命中），左栏标题变成问题前 20 字。
3. 追问（如"那钱退到哪？"）→ 答案能正确接上上一轮（历史改写生效）。
4. **刷新页面** → 该会话仍在左栏，点开消息历史还在（**持久化达成**）。
5. 点会话行的「✕」→ 确认 → 会话从左栏消失。

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/ConversationList.tsx apps/web/components/ChatThread.tsx apps/web/app/chat/page.tsx
git commit -m "feat(web): 对话模块 — 多轮聊天（会话列表/线程/持久化）"
```

---

## Task 11: 总验收

**Files:** 无（纯验证）

- [ ] **Step 1: typecheck 全绿**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 2: 后端管线 demo**

Run: `npm run chat-demo`
Expected: exit 0，两轮问答有实质答案、第二轮改写含上下文。

- [ ] **Step 3: 端到端冒烟（dev server）**

逐项确认：
- `/`：历史文档可见、可回看 chunk、上传后入列、删除生效。
- `/chat`：多轮问答、刷新不丢、删会话生效。
- 顶部导航在「知识库」「对话」间切换且高亮当前项。

- [ ] **Step 4: 清理（可选）**

若想清掉之前测试产生的垃圾文档：在 `/` 里逐条删除，或
Run: `docker exec kb-studio-db psql -U kb -d kbstudio -c "select id,title from docs order by created_at desc;"`
再按需删除。**不要** `TRUNCATE`，以免误删你想留的数据。

- [ ] **Step 5: Final commit（若有零散改动）**

```bash
git status
# 如有未提交改动：
git add -A && git commit -m "chore(web): 知识库历史 + 多轮对话收尾"
```

---

## 自检对照（spec → task 覆盖）

- 应用骨架（左导航 知识库/对话）→ Task 8 ✅
- 知识库：列表 → Task 5(API)+9(UI)；回看 chunk → Task 5+9；删除（级联）→ Task 2+5+9 ✅
- 对话：多轮聊天 → Task 3+4+7+10；会话存 DB 多会话 → Task 1+2+6；刷新不丢 → Task 10 Step5.4 ✅
- 历史感知检索 → Task 3(rewriteQuery)+4(chatTurn) ✅
- DB 两表 + 迁移 → Task 1 ✅
- 编排下沉 pipeline / API 薄 → Task 4 + Task 7 ✅
- 错误处理（{error}+4xx/5xx、confirm 删除、空态）→ 各 API/组件内置 ✅
- 测试（迁移/知识库手测/对话手测/chat-demo）→ Task 1,9,10,4,11 ✅
- docs/chunks 表与既有管线不动 → 全程未改 schema.ts 既有表、未改 ingest/retrieve ✅
```
