# 设计：对话按知识库（文档）范围检索

- 日期：2026-06-27
- 状态：已批准（待写实现计划）
- 范围：`packages/db`、`packages/pipeline`、`apps/web`

## 1. 背景与目标

对话模块当前是**全库检索**（`hybridSearch` 查整张 `chunks` 表，无任何过滤）。用户需要在对话时**选定某一篇已处理文档**，把检索限定到它，**主要目的：验证某篇文档处理入库后能否被正常检索到**。

本仓库没有独立的"知识库"分组概念——**每篇上传文档（`docs` 一行）= 一个可选知识库单位**。

### 目标
- 对话界面顶部一个**单选**选择器：「全部知识库」（默认，等于现状全库）或某一篇文档。
- 选择**持久化到每个会话**（重开会话记得上次选择）。
- 检索按所选文档过滤；选「全部」时行为与现状完全一致。

### 非目标
- 不做多选 / 文档分组 / 标签。
- 不改解析、入库、向量化、rerank、citations 逻辑。
- 知识库模块（`/`）不变。

## 2. 决策记录（brainstorming 结论）
- 粒度：单选（全部 / 某一篇）。
- 持久化：是，存在会话行。
- 方案 1：**会话行作唯一真相源**——`conversations.scope_doc_id` 存范围；选择器 onChange 经 PATCH 写库；`/api/chat` 只读会话行做检索（前端 chat body 不带范围字段）。

## 3. 数据契约（DB 变更）
`conversations` 加一列：
```
scope_doc_id  text  (nullable)   -- null = 全部知识库；否则 = 限定到该 doc_id
```
- drizzle 新增迁移：`ALTER TABLE conversations ADD COLUMN scope_doc_id text;`（加列、幂等，不动 docs/chunks/messages）。
- `ConversationRow` 自动含 `scopeDocId`。
- 不加外键约束（删文档后留悬空 id 也无妨，检索时自然命中空；与现有 org_id/user_id 留空风格一致）。

## 4. 检索过滤（贯穿 @kb/db + @kb/pipeline）

所有函数新增可选末位参数 `docId?: string | null`；为 null/undefined/空串时**不加过滤**（= 现状全库）。

- `packages/db/src/repo.ts`
  - `vectorSearch(queryEmbedding, topK, docId?)`：构造 `const docFilter = docId ? sql\`AND doc_id = ${docId}\` : sql\`\`;`，嵌入 `WHERE embedding IS NOT NULL ${docFilter}`。
  - `keywordSearch(query, topK, docId?)`：同样在 `WHERE ... @@ ...` 后追加 `${docFilter}`。
  - `hybridSearch(query, queryEmbedding, topK, poolN, docId?)`：把 `docId` 透传给 `vectorSearch`/`keywordSearch`。
- `packages/pipeline/src/retrieve.ts`
  - `RetrieveOptions` 加 `docId?: string | null`。
  - `retrieve` 调 `hybridSearch(query, qv, poolN, poolN, opts.docId)`。
- `packages/pipeline/src/chat.ts`
  - `chatTurn` **签名不变**：它已把 `opts` 原样传给 `retrieve`，`docId` 随 `RetrieveOptions` 自动透传。

## 5. repo + API

- `packages/db/src/repo.ts` 新增：
  ```ts
  export async function setConversationScope(id: string, scopeDocId: string | null): Promise<void>
  ```
  （`update conversations set scope_doc_id = scopeDocId where id = id`）。`getConversation` 已返回整行（含 `scopeDocId`），无需改。
- `apps/web/app/api/conversations/[id]/route.ts` 新增 `PATCH` handler：
  - body `{ scopeDocId: string | null }`（空串归一化为 null）→ `setConversationScope` → `{ ok: true }`；统一 `try/catch → {error}`。
- `apps/web/app/api/chat/route.ts`：已 `getConversation(conversationId)`，把范围带进检索：
  ```ts
  const r = await chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docId: conv.scopeDocId });
  ```
  前端 chat body **不新增字段**。

## 6. UI（对话模块）

- `apps/web/app/chat/page.tsx`：挂载时 `GET /api/docs` 拉文档列表，作为 `docs` prop 传给 `ChatThread`（与现有会话列表加载并存）。文档类型沿用 `DocItem`（id/title/...）。
- `apps/web/components/ChatThread.tsx`：
  - 新增 prop `docs: { id: string; title: string }[]`。
  - 新增本地状态 `scopeDocId: string`（""=全部）。
  - 选中会话 `GET /api/conversations/[id]` 返回的 `conversation.scopeDocId` → 初始化选择器；若该 id 不在 `docs` 中（已删），回退 ""。
  - 顶部渲染 `<select className="scope-select">`：第一项「全部知识库」(value="")，其后每篇文档 `<option value={d.id}>{d.title}</option>`。
  - onChange：`setScopeDocId(v)` + `PATCH /api/conversations/${conversationId} { scopeDocId: v || null }`（失败仅红字提示，不挡聊天）。
  - 选择器仅在已选中会话时显示（无会话时维持现有占位）。
- `apps/web/app/globals.css`：加 `.scope-select` 一点样式（沿用现有输入控件风格）。

## 7. 错误处理
- PATCH 统一 `{error}` + 状态码；前端 PATCH 失败只提示、不影响发消息。
- 悬空 `scope_doc_id`（指向已删文档）：检索命中空 → Opus 答「未在该知识库找到」，不报错；选择器初始化时回退「全部」。
- 选「全部」(null)：`docFilter` 为空片段，SQL 与现状逐字等价。

## 8. 测试
- **迁移**：`db:generate && db:migrate` 干净加列；docs/chunks/messages 不受影响。
- **检索过滤单测**（仿 `search-demo`）：入库 2 篇文档 → 同一 query 分别带不同 `docId` 检索 → 命中只来自指定文档；不带 docId → 跨两篇都可能命中。
- **端到端**（dev server + curl）：
  1. 建会话 → `PATCH` 设 `scopeDocId=某篇` → `GET` 确认已存；
  2. `/api/chat` 提该篇内容相关问题 → 答案有内容、`sources` 全部属于该篇（**验证"该篇能被检索到"**）；
  3. 切到另一篇、提原问题 → 命中空 / 答未找到；
  4. 设回「全部」→ 行为与现状一致。
- **浏览器**：选择器随会话记忆、切换会话刷新选项、删文档后回退「全部」。

## 9. 影响面
- 改：`packages/db/src/{schema.ts,repo.ts}`、`packages/pipeline/src/retrieve.ts`、`apps/web/app/api/{chat,conversations/[id]}/route.ts`、`apps/web/app/chat/page.tsx`、`apps/web/components/ChatThread.tsx`、`apps/web/app/globals.css`。
- 增：conversations 一列 + 迁移、repo `setConversationScope`、检索过滤 demo。
- 不动：解析/入库/向量化/rerank/citations、知识库模块、`chatTurn` 签名。
