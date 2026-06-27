# 设计：知识库历史 + 多轮对话（web 重构为两模块应用）

- 日期：2026-06-27
- 状态：已批准（待写实现计划）
- 范围：`apps/web`、`packages/db`、`packages/pipeline`、`packages/adapters`

## 1. 背景与问题

用户反馈「项目没有保存记录的功能，处理完一次结果就不见了」。

经排查，**数据并未丢失**：`/api/upload` 通过 `ingestDoc` 已把 chunk 写入 Postgres+pgvector，`docs` 表也建了行（排查时库内有 19 篇文档 / 56 个 chunk）。真正的缺口在前端：

- `apps/web/app/page.tsx` 把处理结果只放在 React 内存变量 `doc` 里；刷新页面或再传一个文件（`setDoc(null)`）后，上一篇预览就从画面消失，但 DB 里仍在。
- 界面没有「已处理文档列表 / 历史」，也没有列出库内文档、点开回看 chunk 的接口。
- 检索台查的是整库，与当前屏幕显示的那一篇无关，所以「还能搜到」掩盖了「看不到历史」。

因此本设计补齐两件事：**(1) 知识库历史**（看得见、回得去、能删）；**(2) 多轮对话**（把现有单次检索台升级为可持久化的多轮聊天）。借此把已经三合一的单页 `page.tsx` 重构为按模块拆分的应用。

## 2. 目标与非目标

### 目标
- 左侧导航在「知识库」「对话」两个一级模块间切换（应用外壳）。
- 知识库：文档列表（文件名/类型/chunk 数/时间/状态）；点开回看 chunk；删除文档（级联删 chunk）；上传仍走现有流程，成功后出现在列表中。
- 对话：多轮聊天；会话持久化到 DB（多会话，可新建/切换/删除，刷新不丢）；每轮做历史感知检索 + Opus 引用作答。

### 非目标（本期不做）
- 不改解析/造结构/入库/向量化管线本身。
- 不对历史文档做「重新推送 / 改状态」专门功能（现有 `/api/confirm` 按钮原样保留在详情页即可）。
- 不做用户/组织多租户（`org_id/user_id` 继续预留留空）。
- 不引入任务队列异步化上传（保持现有同步处理）。

## 3. 决策记录（brainstorming 结论）

- 功能范围：列出已处理文档 + 点开回看 chunk + 删除文档（用户多选确认）。
- 布局：左侧导航菜单切换「知识库」「对话」；每个模块内部「列表列 + 详情区」两栏。
- 对话形态：真正的多轮聊天（非单次问答换皮）。
- 会话存储：存入 DB，多会话，刷新不丢。
- 实现方案：**方案 1 — Next.js App Router 多路由 + 共享 layout 外壳**（相对「单页 view-state 切换」更好维护、URL 可定位、组件职责单一）。
- 拆分节奏：A（骨架）+ B（知识库）+ C（对话）**在本 spec 一次性设计**。

## 4. 架构 / 路由 / 文件布局

应用外壳：`app/layout.tsx` 加一条窄的左侧导航 rail（两项：知识库 / 对话）。每个模块内部为「列表列 + 详情区」两栏，整体视觉为 `[导航 rail][列表列][详情区]`。

路由：
- `/` → 知识库模块（默认落地页）
- `/chat` → 对话模块

文件布局（🆕 = 新增）：

```
apps/web/
  app/
    layout.tsx              改：包一层 <Nav/> 左侧导航
    page.tsx                改：知识库模块（文档列表 + chunk 详情两栏）
    chat/page.tsx        🆕 对话模块（会话列表 + 聊天线程两栏）
    api/
      upload/route.ts        留（上传仍走它，成功后刷新文档列表）
      confirm/route.ts       留
      search/route.ts        留（暂留作兜底，chat 上线后可弃）
      docs/route.ts       🆕 GET 文档列表
      docs/[id]/route.ts  🆕 GET 读回 chunk / DELETE 删文档(级联 chunk)
      conversations/route.ts        🆕 GET 会话列表 / POST 新建会话
      conversations/[id]/route.ts   🆕 GET 会话(含 messages) / DELETE 删会话
      chat/route.ts       🆕 POST 一轮对话（检索→作答→落库）
  components/             🆕
    Nav.tsx                  左侧导航 rail
    DocList.tsx              知识库：文档列表列
    DocDetail.tsx            知识库：选中文档 chunk + 删除 + 上传入口
    ConversationList.tsx     对话：会话列表列
    ChatThread.tsx           对话：消息线程 + 输入框
  lib/kb.ts                留
packages/pipeline/src/
  chat.ts                🆕 chatTurn() 编排（改写→检索→作答），index.ts 导出
packages/db/src/
  schema.ts                改：新增 conversations / messages 两表
```

把现有三合一的 `page.tsx` 按模块拆成薄客户端组件，每块职责单一；对话/检索编排逻辑下沉到 `packages/pipeline`，API route 保持薄。

## 5. 数据契约（DB schema 变更）

用 drizzle 新增两张表，迁移走 `npm run db:generate && npm run db:migrate`。**docs / chunks 表不动**。两张新表与 docs/chunks 完全解耦。

```
conversations
  id          text pk        conv_<uuid8>
  title       text           默认「新对话」；首轮提问后取问题前 ~20 字
  created_at  timestamptz    defaultNow
  updated_at  timestamptz    每轮更新，列表按最近排序
  org_id/user_id  text 预留留空（与 docs 一致）

messages
  id               text pk          msg_<uuid8>
  conversation_id  text  → conversations.id  onDelete: cascade
  role             text             'user' | 'assistant'
  content          text             user=问题文本；assistant=答案文本
  sources          jsonb (null)     assistant 的引用 [{id, heading_path}]
  hits             jsonb (null)     该轮命中片段，供前端「展开命中」
  created_at       timestamptz      defaultNow
  index on (conversation_id, created_at)
```

删会话 → 级联删 messages。

## 6. API 端点契约

所有端点沿用现有约定：`export const runtime = "nodejs"`，出错 `try/catch` 返回 `{error}` + 4xx/5xx。

### 知识库
| 端点 | 行为 | 返回 |
|---|---|---|
| `GET /api/docs` | 列全部文档，按 `created_at` 倒序；chunk 数用子查询 count | `{docs:[{id,title,source,chunkCount,status,createdAt,pushedAt}]}` |
| `GET /api/docs/[id]` | 读回该文档 + 它的 chunk（复用 upload 回读的 chunk 形状） | `{doc,chunks:[...]}` |
| `DELETE /api/docs/[id]` | 删 docs 行（chunk 靠 FK 级联自动删） | `{ok:true}` |
| `POST /api/upload` | 不动；成功后前端重拉列表并选中新 doc | 现状 |
| `POST /api/confirm` | 不动；保留在详情页（让 status 有意义，非本期重点） | 现状 |

chunk 形状（与现有 upload 回读一致）：`{id, chunk_type, token_estimate, context_prefix, content_original, heading_path}`。

### 对话
| 端点 | 行为 | 返回 |
|---|---|---|
| `GET /api/conversations` | 列会话，按 `updated_at` 倒序 | `{conversations:[{id,title,updatedAt}]}` |
| `POST /api/conversations` | 新建空会话（title=「新对话」） | `{id,title}` |
| `GET /api/conversations/[id]` | 会话 + 全部 messages（按时间正序） | `{conversation,messages:[{id,role,content,sources,hits,createdAt}]}` |
| `DELETE /api/conversations/[id]` | 删会话（messages 级联删） | `{ok:true}` |
| `POST /api/chat` | 一轮对话：`{conversationId,query}` → 检索+作答+落库 | `{answer,sources,hits,title}` |

`/api/chat` 要求 `conversationId` 为已存在会话（前端先经「+ 新建对话」`POST /api/conversations` 建好再发消息）；缺失或非法 → 400。

### `POST /api/chat` 内部流程（编排在 `packages/pipeline/src/chat.ts` 的 `chatTurn()`）
1. 读该会话历史 messages；
2. **历史感知改写**：有历史时，用 Haiku 把「历史 + 新问题」压成一句独立检索 query（首轮直接用原问题，省一次调用）；
3. `retrieve(standaloneQuery, {embedder, reranker}, {topK, poolN})` 拿命中片段；
4. **带历史作答**：给 `LlmClient.answer` 加可选 `history` 入参（把前几轮 `{role, content}` 垫进 Opus 的 messages 数组，再附可引用 chunk）→ `{answer, sources}`；
5. **落库**：插 user message + assistant message（带 sources/hits）；首轮把会话 title 设为问题前 ~20 字；bump `updated_at`。

`chatTurn()` 像 `retrieve()` 一样可被 demo 脚本单测；API route 只做参数校验 + 落库。

`LlmClient.answer` 改动：签名扩展为 `answer(query, docs, history?)`，`history` 为 `Array<{role:'user'|'assistant', content:string}>`，默认空（不传时行为与现状完全一致，向后兼容）。

## 7. 模块 UI 与数据流

### 知识库（`/`）— `DocList` + `DocDetail` 两栏
- `DocList`：挂载时 `GET /api/docs`；每行显示 标题 / 类型徽标（按扩展名）/ chunk 数 / 状态 / 相对时间；点击选中高亮。顶部一个上传控件（沿用现有 file input + 按钮）。
- 上传成功 → 重拉列表 + 自动选中新 doc → 右侧详情加载它的 chunk。
- `DocDetail`：选中后 `GET /api/docs/[id]` → 渲染 chunk 卡片（复用现有卡片样式：徽标 / heading_path / 上下文前缀 / 原文）。顶部「删除」按钮 → `window.confirm` → `DELETE` → 列表移除 + 清空详情。「确认推送秒懂」按钮原样保留。

### 对话（`/chat`）— `ConversationList` + `ChatThread` 两栏
- `ConversationList`：`GET /api/conversations`；顶部「+ 新建对话」→ `POST` → 选中；每行可删（`DELETE`）。
- `ChatThread`：选中会话 → `GET /api/conversations/[id]` → 消息气泡（user 右 / assistant 左）。assistant 气泡含 答案 + 溯源行 + 可折叠「命中片段」（复用现有检索台展示）。底部输入框，回车提交 → `POST /api/chat` → 先乐观追加 user 气泡，再追加 assistant 气泡；返回 title 则更新左栏。

## 8. 错误处理
- 所有 API `try/catch` → `{error}`；前端就地红字提示（沿用现有 `.err` 样式）。
- 删除走 `window.confirm` 二次确认。
- 空态：无文档 / 无会话 / 未选中 都给占位文案。
- `chat` 检索为空时，照样让 Opus 作答（答「未在知识库找到」），不报错。

## 9. 测试
- **迁移**：`db:generate && db:migrate` 干净应用，docs/chunks 不受影响。
- **知识库手测**：上传 → 列表出现 → 打开看 chunk → 删除 → 列表与 DB 都没了（`select count(*) from chunks where doc_id=...` 验级联）。
- **对话**：新建 → 连问两轮且第二轮是追问（如「那个呢」）→ 验历史改写生效；刷新页面 → 会话与消息仍在。
- **管线单测**：仿 `npm run *-demo` 加一个 `chat-demo` 跑 `chatTurn()`（离线 / 在线各验一遍）。

## 10. 影响面小结
- 改：`apps/web/app/{layout,page}.tsx`、`packages/db/src/schema.ts`、`packages/adapters` 的 `LlmClient.answer`。
- 增：`apps/web/app/chat/`、`apps/web/app/api/{docs,conversations,chat}/`、`apps/web/components/*`、`packages/pipeline/src/chat.ts`、conversations/messages 两张表。
- 不动：解析 / 造结构 / ingest / embed / retrieve 既有逻辑，docs/chunks 表结构。
