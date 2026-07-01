# 设计：分组 Agent 简介字段（收集器需求描述落地）

- 日期：2026-07-01
- 状态：已批准（待写实现计划）
- 范围：`packages/db`、`packages/pipeline`、`packages/adapters`、`apps/web`

## 1. 背景与目标

外部「收集器」表单（客户填公司名 + 上传文件，走专属收集链接提交给 kb-studio）新增了两个输入：

1. **Agent 主要用来做什么？**（必填，收集器侧校验）——客户对这个知识库/未来 Agent 的用途描述。
2. **其他补充**（选填）——客户风格 / 特殊要求等自由文本。

这两个字段目前在 kb-studio 里无处安放。kb-studio 现有「一企业一分组」模型（`POST /api/ingest` 按 `company` 名 find-or-create 一个 `groups` 行）已经把"一个客户"映射成"一个分组"，这两个字段本质是该分组（该客户）的属性，不是某篇文档的属性。

### 目标（brainstorming 结论）
1. 收集器提交时能把这两段文本存到对应分组上。
2. 员工在 kb-studio 里能看到、也能手动填/改（不经过收集器的分组同样适用）。
3. 对话检索范围限定到某个分组时，这两段文本要能影响 Opus 的回答（作为客户背景喂给模型），不只是展示用。

### 非目标
- 不推送到秒懂知识库。
- 不对外暴露只读 API 给其他系统（如未来独立的"Agent 构建"系统）读取——目前只服务 kb-studio 自己的展示和问答。
- 不新建实体表，不做多值/历史版本（每个分组只有当前一份"用途+补充"，覆盖即丢旧值）。
- scope=全部知识库 / scope=单篇文档时不注入这段背景（只在 scope=某个分组时生效）。

## 2. 决策记录（brainstorming 结论）

- **归属模型**：挂在 `groups` 表，两个新列 `agent_purpose` / `agent_notes`，都可空。
- **收集器写入时的覆盖策略**：每次提交都尝试覆盖成最新值，但**新值为空则不覆盖**（保留旧值）。判空发生在写入前：`agentPurpose`/`agentNotes` 非空字符串才纳入更新 patch，为空整体跳过该字段。
- **手动编辑时的覆盖策略**：所见即所得——员工在弹框里清空并保存，就是清空，不套用上面"空不覆盖"的规则（那条规则只针对收集器的自动重复提交场景）。
- **展示位置**：只在现有「新建/改名分组」弹框（`GroupDialog`）里展示 + 编辑，不新增分组详情页或侧栏展示面积。
- **检索/问答注入**：只在对话 `scopeGroupId` 非空时，把这两段文本拼成"客户背景"喂进 Opus 的 `system` 提示词，并显式要求"仅供理解背景，不要在回答里逐字复述"。scope=全部或单篇文档时不注入。

## 3. 数据契约（DB 变更，迁移 `0014`）

### `groups` 加列
```
agent_purpose  text   -- 客户诉求："Agent主要用来做什么？"
agent_notes    text   -- 其他补充（选填）
```
两列均可空；旧行、手动建组不填时为 `null`。`GroupRow` 类型自动带上这两个可选字段。

## 4. repo（`packages/db/src/repo.ts`）

```ts
export interface GroupInput {
  id: string;
  name: string;
  color?: string | null;
  userId: string;
  agentPurpose?: string | null;   // 新增
  agentNotes?: string | null;     // 新增
}

createGroup(g: GroupInput): Promise<void>
// insert 时一并写入 agentPurpose/agentNotes（未传则列为 null）

updateGroup(
  id: string,
  patch: { name?: string; color?: string | null; sortOrder?: number;
           agentPurpose?: string | null; agentNotes?: string | null },  // 扩展
  userId: string,
): Promise<void>
// 沿用现有"只更新传入字段"的 set 构造逻辑，无需改动结构，只加两个 if 分支

findGroupById(id: string): Promise<GroupRow | null>   // 新增：chat 路由查询分组背景用
```

`findGroupById` 不做 `userId` 过滤——与当前 `scopeGroupId` 的信任边界一致（`setConversationScope` 本身也不校验分组归属，属于既有行为，本次不扩大修复范围）。

## 5. 写入路径（`apps/web/app/api/ingest/route.ts`）

formData 新增两个可选字段：`agentPurpose`、`agentNotes`（trim 后判断非空）。

- **新建分组分支**：`createGroup({ id, name: company, userId, agentPurpose, agentNotes })`。
- **命中已有分组分支**：构造 patch，仅当 `agentPurpose`/`agentNotes` trim 后非空才放入：
  ```ts
  const patch: { agentPurpose?: string; agentNotes?: string } = {};
  if (agentPurpose) patch.agentPurpose = agentPurpose;
  if (agentNotes) patch.agentNotes = agentNotes;
  if (Object.keys(patch).length > 0) await updateGroup(existing.id, patch, user.id);
  ```
  空值天然不写，等价于"保留旧值"。

> 注：收集器那侧需要同步在提交时带上这两个 formData 字段（字段名以此为准），属于协作方要跟进的改动，不在本仓库范围内。

## 6. 手动编辑（`apps/web`）

### 6.1 `GroupDialog.tsx`
新增两个受控 `<textarea>`：「Agent 用途」「其他补充」，`create`/`edit` 两种 mode 都可填、都选填（手动创建分组时没有强制必填的理由，收集器侧的必填是它自己的表单校验）。`onSubmit` 签名扩展：
```ts
onSubmit: (name: string, color: string | null, agentPurpose: string | null, agentNotes: string | null) => Promise<void>
```
`edit` 模式下用 `initialAgentPurpose`/`initialAgentNotes` 预填（新增两个 prop）。

### 6.2 API
- `POST /api/groups`：body 加 `agentPurpose?`、`agentNotes?`，透传给 `createGroup`。
- `PATCH /api/groups/[id]`：body 里 `"agentPurpose" in body` / `"agentNotes" in body` 时纳入 patch（允许显式传空串来清空，语义上等价于用户删空文本框）。
- `GET /api/groups`：列表返回加 `agentPurpose`、`agentNotes`，供 `DocList.tsx` 打开编辑弹框时预填。

### 6.3 调用点（`DocList.tsx`）
现有 `GroupDialog` 的 `onSubmit` 回调（建组 → `POST /api/groups`，改名 → `PATCH /api/groups/[id]`）分别透传新增的两个参数；`edit` 模式打开弹框时把当前分组的 `agentPurpose`/`agentNotes` 作为 `initialAgentPurpose`/`initialAgentNotes` 传入。

## 7. 检索/问答注入

### 7.1 `packages/adapters` — `LlmClient.answer()`
`opts` 新增 `groupContext?: string | null`。非空时拼进 `system`：
```
你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。

以下是该客户对这个知识库/Agent 的背景诉求，仅供你理解语境、把握回答口径，不要在回答中逐字复述：
<客户背景>
{agentPurpose 部分（有则加"用途：..."）}
{agentNotes 部分（有则加"补充：..."）}
</客户背景>
```
两段都空时不拼这一整块（等价于现状）。

### 7.2 `packages/pipeline` — `chatTurn`
新增第五个可选参数，不污染 `RetrieveOptions`（`RetrieveOptions` 保持只跟检索相关：topK/poolN/docIds）：
```ts
export async function chatTurn(
  history: ChatMessage[],
  query: string,
  deps: ChatDeps,
  opts: RetrieveOptions = {},
  groupContext?: string | null,   // 新增
): Promise<ChatTurnResult>
```
`deps.llm.answer(query, hits, { history, groupContext })`。零命中分支不变（不调 LLM，直接返回）。

两个现有调用点（`apps/web/app/api/chat/route.ts`、`apps/worker/src/cli/chat-demo.ts`）向后兼容，worker demo 不传第五参数即可。

### 7.3 `apps/web/app/api/chat/route.ts`
`conv.scopeGroupId` 非空分支里，除了 `listDocIdsInGroup`，额外 `findGroupById(conv.scopeGroupId)` 取分组行，拼出：
```ts
const parts: string[] = [];
if (group?.agentPurpose) parts.push(`用途：${group.agentPurpose}`);
if (group?.agentNotes) parts.push(`补充：${group.agentNotes}`);
const groupContext = parts.length ? parts.join("\n") : null;
```
传给 `chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docIds }, groupContext)`。
`scopeDocId` 分支和"都为空"（scope=全部）分支不查、不传（`groupContext` 为 `undefined`）。

## 8. 错误处理
- `/api/ingest`：`agentPurpose`/`agentNotes` 缺失或空串视为"未提供"，不报错，不阻塞文件入库（这两个字段本身是增强信息，不应影响现有上传主流程）。
- `GroupDialog` 提交：两个新文本框不做前端必填校验（沿用现状，只有分组名必填）。
- `findGroupById` 查不到（分组已被删）：`groupContext` 视为 `null`，`chatTurn` 走原有无背景路径，不报错。

## 9. 测试
- **迁移**：`db:generate && db:migrate` 干净加两列；现有 `groups` 行不受影响（新列默认 null）。
- **repo 单测**：`createGroup` 带值/不带值两种；`updateGroup` 局部更新只改传入字段；`findGroupById` 命中/未命中。
- **`/api/ingest` 覆盖策略**：同公司名两次提交——① 第二次带非空新值 → 分组字段更新为新值；② 第二次带空值 → 分组字段保留第一次的值。
- **`GroupDialog`**：create/edit 两种 mode 下两个文本框可填可留空；edit 模式正确预填。
- **端到端问答**：分组设了 `agentPurpose`，对话 scope 限定到该组 → `chat/route.ts` 组装的 system prompt 含客户背景；scope=全部或单篇文档时不含。

## 10. 影响面
- **增**：`groups` 表两列 + 迁移 `0014`；`findGroupById`；`answer()`/`chatTurn` 新增可选参数。
- **改**：`packages/db/src/{schema.ts,repo.ts,index.ts}`、`packages/adapters/src/llm/llm-client.ts`、`packages/pipeline/src/chat.ts`、`apps/web/app/api/{ingest,groups,groups/[id],chat}/route.ts`、`apps/web/components/{GroupDialog,DocList}.tsx`。
- **不动**：`retrieve.ts`（`RetrieveOptions` 不变）、检索/向量化/rerank/citations 核心逻辑、`docs` 表、秒懂推送逻辑。
- **外部协作**：收集器表单需要在提交时把这两个字段（字段名以本文档 §5 为准）一起 POST 给 `/api/ingest`，属于另一个仓库的改动。
