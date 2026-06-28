# 设计：文档分组（Groups）

- 日期：2026-06-28
- 状态：已批准（待写实现计划）
- 范围：`packages/db`、`packages/pipeline`、`apps/web`

## 1. 背景与目标

知识库模块（`/`）当前文档是**平铺单列表**（`DocList` 一个 `.list`，按 `docs` 表逐行渲染），无任何归类维度。文档变多后难以整理、批量操作、限定检索范围。

引入「分组」概念，一篇文档归属 0 或 1 个分组（扁平、无嵌套）。

### 目标（brainstorming 结论，三个用途）
1. **整理 / 归类**：侧栏按分组分段折叠展示，「未分组」兜底。
2. **按分组批量推送秒懂**：选「推送整组」→ 复用现有多目标 `PushDialog` → 组内所有可推送文档逐个推送。
3. **对话检索范围**：对话可把检索限定到「整个分组」或「某一篇文档」（单篇已有，分组为新增的一层，二者互斥）。

### 非目标
- 不做嵌套子组、不做一篇属多组（多对多）。
- 分组**不绑定**推送目标（每次推送时在弹框选凭证）。
- 不做拖拽排序文档；不动解析/入库/向量化/rerank/citations 逻辑。
- org_id/user_id 仍留空（仅为多用户预留列）。

## 2. 决策记录（brainstorming 结论）

- 归属模型：**一篇只属一组（扁平）**，`docs.group_id`。
- 删组：**文档回到「未分组」**（`ON DELETE SET NULL`），不级联删文档。
- 推送目标：**每次推送时选**（复用现有 `PushDialog` 多选凭证），分组不绑目标。
- 检索 scope：分组 scope 与单篇 scope **互斥**（UI 单个下拉），过滤统一走 **`docIds` 列表**（单篇 = 长度 1 的特例），不给分组单开 JOIN 路径。
- 归组交互：**拖拽**（原生 HTML5 DnD，不引第三方库）+ **下拉菜单「移动到分组」**兜底，二者共用同一 `moveDoc(docId, groupId)`。

## 3. 数据契约（DB 变更，迁移 `0006`）

### 新表 `groups`
```
id          text PK            -- 如 grp_xxxxx
name        text NOT NULL
color       text               -- 可选；侧栏小圆点色，暖色预设之一
sort_order  integer NOT NULL default 0  -- 手动排序；默认按 created_at
org_id      text               -- 留空
user_id     text               -- 留空
created_at  timestamptz NOT NULL default now()
```
`GroupRow = typeof groups.$inferSelect`。

### `docs` 加列
```
group_id  text  references groups(id) ON DELETE SET NULL   -- null = 未分组
```

### `conversations` 加列
```
scope_group_id  text  references groups(id) ON DELETE SET NULL  -- null = 不按组限定
```
- 与现有 `scope_doc_id` **互斥**：设其一时把另一清空（在 repo/API 层保证）。
- 外键 `ON DELETE SET NULL`：删组后会话/文档自动失去该 scope/归属，检索回退「全部」。

> 注：现有 docs/conversations 行外键约束风格——`chunks.doc_id`、`messages.conversation_id` 都用了 references + cascade，故此处用 references 一致；`scope_doc_id` 历史上未加外键，本次新增列加外键不回填改 `scope_doc_id`。

## 4. repo（`packages/db/src/repo.ts`）

新增分组 CRUD + 归组 + 检索过滤泛化：

```ts
listGroups(): Promise<Array<GroupRow & { docCount: number }>>   // 含每组文档数，按 sort_order, created_at
createGroup(input: { name: string; color?: string | null }): Promise<GroupRow>
updateGroup(id: string, patch: { name?: string; color?: string | null; sortOrder?: number }): Promise<void>
deleteGroup(id: string): Promise<void>                          // 仅删 groups 行，docs.group_id 由外键 SET NULL
setDocGroup(docId: string, groupId: string | null): Promise<void>
listDocIdsInGroup(groupId: string): Promise<string[]>           // 检索 scope + 批量推送共用
setConversationScope(id, { docId?, groupId? }): 互斥写         // 扩展现有 setConversationScope
```

**检索过滤泛化**：现有 `docId?: string | null` 形参 → `docIds?: string[] | null`：
- `vectorSearch(queryEmbedding, topK, docIds?)`、`keywordSearch(query, topK, docIds?)`：
  `const docFilter = docIds?.length ? sql\`AND doc_id = ANY(${docIds})\` : sql\`\`;`
- `hybridSearch(query, queryEmbedding, topK, poolN, docIds?)`：透传。
- 老调用点单篇传 `[docId]`；为空/未传 = 全库（行为与现状逐字等价）。

`getDocs`（列表查询）返回里带上 `groupId`。

## 5. pipeline（`packages/pipeline/src/retrieve.ts`）

- `RetrieveOptions`：`docId?: string | null` → `docIds?: string[] | null`。
- `retrieve` 调 `hybridSearch(query, qv, poolN, poolN, opts.docIds)`。
- `chatTurn` 签名不变（`opts` 原样透传）。

## 6. API（`apps/web/app/api`）

### 分组管理 `api/groups/`
- `GET  /api/groups` → `{ groups: Array<{id,name,color,sortOrder,docCount}> }`
- `POST /api/groups` `{name, color?}` → `{ group }`
- `PATCH  /api/groups/[id]` `{name?, color?, sortOrder?}` → `{ ok }`
- `DELETE /api/groups/[id]` → `{ ok }`（文档自动回未分组）

### 文档归组 `api/docs/[id]`（PATCH，无则新增）
- `{ groupId: string | null }` → `setDocGroup` → `{ ok }`。

### 文档列表 `api/docs`（GET）
- 每行加 `groupId`。

### 批量推送 `api/confirm`（POST，扩展）
- 现有 `{ docId, credentialIds[] }` 之外支持 `{ groupId, credentialIds[] }`：
  后端 `listDocIdsInGroup(groupId)` 取组内 `ready`/`pushed` 文档 → 逐个走现有单文档推送逻辑 → 汇总每篇结果返回（沿用现有「每凭证具体原因」结构，按文档聚合）。

### 会话 scope `api/conversations/[id]`（PATCH，扩展）
- body 支持 `{ scopeDocId?: string|null, scopeGroupId?: string|null }`：
  设 `scopeGroupId` 非空 → 清 `scopeDocId`；设 `scopeDocId` 非空 → 清 `scopeGroupId`（互斥）。
- `api/chat/route.ts`：读会话 → `scopeGroupId` 非空则 `listDocIdsInGroup` 解析为 `docIds`；否则 `scopeDocId` → `[scopeDocId]`；都空 → 不传。调 `chatTurn(..., { topK, poolN, docIds })`。

## 7. 前端 UI（`apps/web`，Claude 暖色风）

### 7.1 侧栏分组分段（`DocList.tsx` + page 状态）
- `page.tsx` 增 `GET /api/groups` 拉分组，与 `GET /api/docs` 并存；`groups` 透传给 `DocList`。
- 顶部动作：「↑ 上传文档」+「＋ 新建分组」。
- 列表渲染成**可折叠分组段**：段头 = 暖色小圆点 + 组名 + 文档数 + 折叠箭头；段头 hover 出 `⋯` 菜单（改名 / 改色 / 推送整组 / 删除）。
- **「未分组」固定为最后一段**（无菜单、不可删），承接 `group_id = null` 的文档。
- 折叠状态存 `localStorage`。

### 7.2 归组：拖拽 + 菜单（共用 `moveDoc(docId, groupId)`）
- **拖拽**：原生 HTML5 DnD（`draggable` + `onDragStart/onDragOver/onDrop`），不引库。
  - 拖文档项；放目标 = 分组段（段头+段体整块），含「未分组」段。
  - 拖起该项半透明；拖到某段时该段 `drag-over` 暖色高亮边框；松手 → `PATCH /api/docs/[id] {groupId}`，乐观更新 + 失败回滚。
  - 拖到当前所在组 = 无操作。
- **下拉菜单**：文档项 `⋯` 加「移动到分组 ▾」（所有分组 + 未分组 + 「＋ 新建并移入」），触屏/无障碍兜底。

### 7.3 新建/改名分组弹框
- 轻量小弹框，复用 `CredentialsDialog` 暖色风格与 CSS 变量；选色给 4–5 个预设暖色点。

### 7.4 对话 scope 选择器（`ChatThread.tsx`）
- 现有 `scope-select` 下拉扩展为 `<optgroup>` 分区：
  - 「全部知识库」(value="")
  - `──分组──`：各分组（value=`g:<groupId>`，显示组名+文档数）
  - `──单篇──`：各文档（value=`d:<docId>`）
- onChange 解析前缀：`g:` → `PATCH {scopeGroupId, scopeDocId:null}`；`d:` → `PATCH {scopeDocId, scopeGroupId:null}`；空 → 两者皆 null。
- 初始化：会话 `scopeGroupId` 优先、否则 `scopeDocId`；指向已删组/文档则回退「全部」。
- 需 `chat/page.tsx` 也拉 `groups` 传入。

### 7.5 文档详情（`DocDetail.tsx`）
- 顶部显示当前所属分组小标签 +「移动」入口（复用同一移动菜单），与现有「已推送凭证名」标签并排。

## 8. 错误处理
- 所有新 API 统一 `try/catch → {error}` + 状态码。
- 拖拽/菜单移动失败：乐观更新回滚 + 红字提示，不影响其它操作。
- 悬空 scope（指向已删组/文档）：检索命中空 → Opus 答「未找到」，选择器初始化回退「全部」。
- 批量推送：组内含未就绪文档时跳过并在结果里标注；全失败时按文档+凭证给出具体原因（沿用 ⑦ 现状）。
- 互斥：scope 写入在 repo 层保证（设一清一），前端无需额外防御。

## 9. 测试
- **迁移**：`db:generate && db:migrate` 干净加 `groups` 表 + 两列；现有 docs/chunks/conversations 数据不受影响（新列默认 null）。
- **检索过滤单测**（仿 `search-demo`）：入库 2 篇文档分属 2 组 → 同 query 分别带 `docIds=[A]` / 组A的 docIds / 不带 → 命中范围正确；单篇 `[docId]` 与旧行为逐字等价。
- **端到端**（dev + curl）：
  1. 建组 → 文档 PATCH 归组 → `GET /api/docs` 含 groupId；删组 → 文档 groupId 回 null。
  2. 会话 `PATCH {scopeGroupId}` → `/api/chat` 命中只来自组内文档；切单篇/全部行为正确；互斥（设组清单篇）。
  3. `/api/confirm {groupId, credentialIds}` → 组内 ready/pushed（已处理完成）文档全部推送、结果按文档聚合；processing/failed 跳过并标注。
- **浏览器**：分组段折叠记忆；拖拽移动 + 菜单移动一致、失败回滚；scope 下拉 optgroup 分区随会话记忆；详情页分组标签。

## 10. 影响面
- **增**：`groups` 表 + docs/conversations 两列 + 迁移 `0006`；repo 分组 CRUD/归组/`listDocIdsInGroup`；`api/groups/*`、`api/docs/[id]` PATCH；新建/改名弹框组件；`DocList` 分段 + 拖拽。
- **改**：`packages/db/src/{schema.ts,repo.ts}`、`packages/pipeline/src/retrieve.ts`、`apps/web/app/api/{docs,confirm,conversations/[id],chat}/route.ts`、`apps/web/app/{page,chat/page}.tsx`、`apps/web/components/{DocList,ChatThread,DocDetail,PushDialog}.tsx`、`apps/web/app/globals.css`。
- **不动**：解析/入库/向量化/rerank/citations、`chatTurn` 签名、凭证表、消息/对话核心逻辑。
