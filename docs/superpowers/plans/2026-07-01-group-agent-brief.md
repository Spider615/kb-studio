# 分组 Agent 简介字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把收集器表单新增的「Agent 主要用来做什么？」+「其他补充」两个输入落地到 kb-studio：存到对应分组（一企业一分组），员工能在 kb-studio 里手动查看/编辑，对话检索范围限定到该分组时把这段背景喂给 Opus 问答。

**Architecture:** `groups` 表加两列 `agent_purpose`/`agent_notes`。收集器走 `/api/ingest` 的 find-or-create 分组逻辑写入，覆盖策略「新值非空才覆盖」；员工走现有 `GroupDialog` 弹框手动编辑，语义「所见即所得」。`conversations.scopeGroupId` 非空时，`chat/route.ts` 查出分组背景拼成 `groupContext` 字符串，经 `chatTurn` 透传给 `LlmClient.answer()`，拼进 Opus 的 `system` 提示词。

**Tech Stack:** TypeScript / Next.js 15 (App Router) / drizzle-orm + Postgres / `node:test`（`npx tsx --test`，DB 集成测试需 `npm run db:up`）。

参考 spec：`docs/superpowers/specs/2026-07-01-group-agent-brief-design.md`

## Global Constraints

- 中文注释 + 中文用户文案，代码标识符英文。
- `groups` 表加两个可空列，不新建表；旧行/手动建组不填时为 `null`。
- **收集器覆盖策略**（`/api/ingest`）：`agentPurpose`/`agentNotes` 新值非空才覆盖已有分组的对应字段；为空则跳过该字段（保留旧值）。
- **手动编辑**（`GroupDialog`）：所见即所得，清空并保存即写 `null`，不套用上面的「空不覆盖」规则。
- 检索/问答注入仅在 `conversations.scopeGroupId` 非空时生效；scope=全部知识库或 scope=单篇文档时不查、不注入。
- `findGroupById` 不做 `userId` 过滤，信任边界与现有 `scopeGroupId` 机制一致（`setConversationScope` 本身也不校验分组归属，属既有行为，本次不扩大修复范围）。
- 不推送秒懂、不新增对外只读 API。
- 迁移编号 `0014`（当前最新 `0013`）。
- 测试命令：`npx tsx --test <文件路径>`；DB 集成测试先 `npm run db:up`。
- 提交信息中文，结尾 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。

---

## 文件结构

**修改：**
- `packages/db/src/schema.ts` — `groups` 表加 `agentPurpose`/`agentNotes` 两列。
- `packages/db/migrations/0014_*.sql`（`db:generate` 生成）
- `packages/db/src/repo.ts` — `GroupInput`/`createGroup`/`updateGroup`/`listGroups` 加两字段；新增 `findGroupById`。
- `apps/web/app/api/ingest/route.ts` — 读取 `agentPurpose`/`agentNotes`，实现覆盖策略。
- `packages/adapters/src/llm/llm-client.ts` — 新增 `buildAnswerSystemPrompt`，`answer()` 加 `groupContext` opt。
- `packages/pipeline/src/chat.ts` — `chatTurn` 加 `groupContext` 参数。
- `apps/web/app/api/chat/route.ts` — `scopeGroupId` 非空时查分组、拼 `groupContext`、透传。
- `apps/web/app/api/groups/route.ts`、`apps/web/app/api/groups/[id]/route.ts` — 读写 `agentPurpose`/`agentNotes`。
- `apps/web/components/GroupDialog.tsx` — 加两个 textarea + props。
- `apps/web/app/globals.css` — 加 `.modal .field textarea` 样式。
- `apps/web/components/DocList.tsx` — `GroupItem` 类型、`onCreateGroup`/`onUpdateGroup` 签名、编辑弹框预填。
- `apps/web/app/page.tsx` — `createGroup`/`updateGroup` 包装函数透传新字段。

**新建：**
- `packages/db/src/groups-agent-brief.integration.test.ts`
- `packages/adapters/src/llm/llm-client.test.ts`

> 说明：`packages/db/src/index.ts`（`export * from "./repo"`）与 `packages/pipeline/src/index.ts`（`export * from "./chat"`）都是整体再导出，新函数/新参数自动随之导出，**无需改这两个 index 文件**。`apps/web/components/UploadDialog.tsx` 也不改——它内联建组走 `onCreateGroup(name, color)` 两参数调用，`agentPurpose`/`agentNotes` 在 `DocList` 的 prop 类型里设为可选参数，两参数调用天然兼容，不强制它也收集这两个字段。

---

## Task 1: DB 层 — `groups` 加列 + repo 函数

**Files:**
- Modify: `packages/db/src/schema.ts:35-43`（`groups` 表）
- Create: `packages/db/migrations/0014_*.sql`（`db:generate` 生成）
- Modify: `packages/db/src/repo.ts:261-344`（`GroupInput`/`listGroups`/`createGroup`/`updateGroup`，新增 `findGroupById`）
- Test: `packages/db/src/groups-agent-brief.integration.test.ts`（新建）

**Interfaces:**
- Produces: `GroupInput.agentPurpose?: string | null`、`GroupInput.agentNotes?: string | null`；`createGroup(g: GroupInput): Promise<void>`（写入两字段）；`updateGroup(id, patch: {..., agentPurpose?: string|null, agentNotes?: string|null}, userId): Promise<void>`（局部更新）；`findGroupById(id: string): Promise<GroupRow | null>`；`listGroups(userId)` 返回的每项含 `agentPurpose`/`agentNotes`。

> 集成测试需起着的 pg。先 `npm run db:up`，并确保 `DATABASE_URL` 指向它（见 `.env`）。

- [ ] **Step 1: 给 `groups` 表加两列**

`packages/db/src/schema.ts` 的 `groups` 定义（35-43 行）改为：

```ts
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
```

（`text` 已在文件顶部 import，无需新增 import。）

- [ ] **Step 2: 生成并应用迁移**

Run:
```bash
cd /Users/hukui/Desktop/workspace/kb-studio
npm run db:generate
npm run db:migrate
```
Expected: `packages/db/migrations/` 下新增 `0014_*.sql`（内容含 `ALTER TABLE "groups" ADD COLUMN "agent_purpose" text;` 和 `ALTER TABLE "groups" ADD COLUMN "agent_notes" text;`），migrate 输出无报错。

- [ ] **Step 3: 写失败测试**

Create `packages/db/src/groups-agent-brief.integration.test.ts`:

```ts
// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。会自建并清理测试数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, groups, users } from "./schema";
import { eq } from "drizzle-orm";
import { createUser, createGroup, updateGroup, findGroupById } from "./repo";

const createdUsers: string[] = [];
async function makeUser() {
  const id = "usr_test_" + randomUUID().slice(0, 8);
  await createUser({ id, email: id + "@test.local", passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return id;
}

after(async () => {
  for (const id of createdUsers) {
    await db.delete(docs).where(eq(docs.userId, id));
    await db.delete(groups).where(eq(groups.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await pg.end();
});

test("createGroup 带 agentPurpose/agentNotes 写入", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组", userId, agentPurpose: "售后客服", agentNotes: "语气亲切" });
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, "售后客服");
  assert.equal(g?.agentNotes, "语气亲切");
});

test("createGroup 不带 agentPurpose/agentNotes 默认 null", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组2", userId });
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, null);
  assert.equal(g?.agentNotes, null);
});

test("updateGroup 只传 agentPurpose 不影响 agentNotes（局部更新）", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组3", userId, agentPurpose: "旧用途", agentNotes: "补充A" });
  await updateGroup(gid, { agentPurpose: "新用途" }, userId);
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, "新用途");
  assert.equal(g?.agentNotes, "补充A");
});

test("updateGroup 传 null 清空字段", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组4", userId, agentPurpose: "旧用途" });
  await updateGroup(gid, { agentPurpose: null }, userId);
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, null);
});

test("findGroupById 查不到返回 null", async () => {
  const g = await findGroupById("grp_nope_" + randomUUID().slice(0, 8));
  assert.equal(g, null);
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx tsx --test packages/db/src/groups-agent-brief.integration.test.ts`
Expected: FAIL —`createGroup`/`updateGroup` 不接受 `agentPurpose`/`agentNotes`（TS 报错）或 `findGroupById` 未导出。

- [ ] **Step 5: 改 `GroupInput` + `createGroup` + `updateGroup` + `listGroups`**

`packages/db/src/repo.ts` 的 261-307 行（`GroupInput` 到 `updateGroup`）整段替换为：

```ts
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
```

- [ ] **Step 6: 新增 `findGroupById`**

在 `packages/db/src/repo.ts` 里 `groupBelongsToUser` 之后（原 337-344 行，Step 5 替换后行号会前移，按内容定位而非行号插入）加：

```ts
/** 按 id 查分组（不做 userId 过滤；用于 scopeGroupId 场景取 Agent 背景，信任边界同现有 scope 机制）。 */
export async function findGroupById(id: string): Promise<GroupRow | null> {
  const rows = await db.select().from(groups).where(eq(groups.id, id));
  return rows[0] ?? null;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx tsx --test packages/db/src/groups-agent-brief.integration.test.ts`
Expected: PASS（5 个 test 全过）。

- [ ] **Step 8: 跑现有分组测试确认没破坏**

Run: `npx tsx --test packages/db/src/groups-upload.integration.test.ts`
Expected: PASS（3 个 test 全过，`createGroup` 签名扩展未破坏原有调用点）。

- [ ] **Step 9: typecheck**

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/src/repo.ts packages/db/src/groups-agent-brief.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): groups 加 agent_purpose/agent_notes + findGroupById

收集器表单收集的"Agent用途/其他补充"要落到对应分组（一企业一分组）；
updateGroup 局部更新逻辑天然支持"只传变化字段"，为后续覆盖策略打底。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 收集器写入路径 — `/api/ingest` 覆盖策略

**Files:**
- Modify: `apps/web/app/api/ingest/route.ts`（第 3 行 import；32-43 行 find-or-create 分组块）

**Interfaces:**
- Consumes: `createGroup(g: GroupInput)`、`updateGroup(id, patch, userId)`（Task 1）。

- [ ] **Step 1: import 加 `updateGroup`**

`apps/web/app/api/ingest/route.ts` 第 3 行：

```ts
import { createGroup, findGroupByNameAndUser, findUserByCollectToken } from "@kb/db";
```

改为：

```ts
import { createGroup, findGroupByNameAndUser, findUserByCollectToken, updateGroup } from "@kb/db";
```

- [ ] **Step 2: 读取两个字段 + 实现覆盖策略**

同文件 32-43 行：

```ts
    // 一企业一分组：按企业名 find-or-create 该员工名下分组；空企业名 → 未分组
    const company = String(form.get("company") ?? "").trim();
    let groupId: string | null = null;
    if (company) {
      const existing = await findGroupByNameAndUser(company, user.id);
      if (existing) {
        groupId = existing.id;
      } else {
        groupId = "grp_" + randomUUID().slice(0, 8);
        await createGroup({ id: groupId, name: company, userId: user.id });
      }
    }
```

替换为：

```ts
    // 一企业一分组：按企业名 find-or-create 该员工名下分组；空企业名 → 未分组
    const company = String(form.get("company") ?? "").trim();
    // 客户对这个 Agent 的诉求（收集器表单新增字段）；新值非空才覆盖已有分组的对应值，空值保留旧值
    const agentPurpose = String(form.get("agentPurpose") ?? "").trim();
    const agentNotes = String(form.get("agentNotes") ?? "").trim();
    let groupId: string | null = null;
    if (company) {
      const existing = await findGroupByNameAndUser(company, user.id);
      if (existing) {
        groupId = existing.id;
        const patch: { agentPurpose?: string; agentNotes?: string } = {};
        if (agentPurpose) patch.agentPurpose = agentPurpose;
        if (agentNotes) patch.agentNotes = agentNotes;
        if (Object.keys(patch).length > 0) await updateGroup(existing.id, patch, user.id);
      } else {
        groupId = "grp_" + randomUUID().slice(0, 8);
        await createGroup({
          id: groupId,
          name: company,
          userId: user.id,
          agentPurpose: agentPurpose || null,
          agentNotes: agentNotes || null,
        });
      }
    }
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/ingest/route.ts
git commit -m "$(cat <<'EOF'
feat(ingest): /api/ingest 接住收集器的 agentPurpose/agentNotes

find-or-create 分组时一并写入；命中已有分组时新值非空才覆盖，
避免收集器同公司重复提交时空值把已有背景描述清空。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

> 端到端验证（分组已存在时覆盖策略是否生效）留到 Task 9 用 curl 走查，因为 `/api/ingest` 依赖服务密钥 + 真实解析管线，不适合脱离 dev server 单测。

---

## Task 3: `LlmClient.answer()` — 客户背景注入 system 提示词

**Files:**
- Modify: `packages/adapters/src/llm/llm-client.ts:1-9`（顶部，新增 `buildAnswerSystemPrompt`）、`132-141`（`answer()` 签名与 `system` 行）
- Test: `packages/adapters/src/llm/llm-client.test.ts`（新建）

**Interfaces:**
- Produces: `buildAnswerSystemPrompt(groupContext?: string | null): string`；`LlmClient.answer(query, chunks, opts: { model?; history?; groupContext?: string | null })`。

- [ ] **Step 1: 写失败测试**

Create `packages/adapters/src/llm/llm-client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerSystemPrompt } from "./llm-client";

const BASE = "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。";

test("无背景时返回基础提示词，不追加内容", () => {
  assert.equal(buildAnswerSystemPrompt(), BASE);
  assert.equal(buildAnswerSystemPrompt(null), BASE);
  assert.equal(buildAnswerSystemPrompt(""), BASE);
});

test("有背景时追加客户背景块，且提醒不要逐字复述", () => {
  const out = buildAnswerSystemPrompt("用途：做售后客服机器人");
  assert.ok(out.startsWith(BASE));
  assert.ok(out.includes("<客户背景>"));
  assert.ok(out.includes("用途：做售后客服机器人"));
  assert.ok(out.includes("不要在回答中逐字复述"));
  assert.ok(out.includes("</客户背景>"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test packages/adapters/src/llm/llm-client.test.ts`
Expected: FAIL — `buildAnswerSystemPrompt` 未导出。

- [ ] **Step 3: 新增 `buildAnswerSystemPrompt`**

`packages/adapters/src/llm/llm-client.ts` 第 4-8 行（`LlmClientOptions` 接口）之后插入：

```ts
const BASE_ANSWER_SYSTEM = "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。";

/** 按分组背景（Agent 用途/补充）拼出问答用的 system 提示词；无背景时原样返回基础提示词。 */
export function buildAnswerSystemPrompt(groupContext?: string | null): string {
  if (!groupContext) return BASE_ANSWER_SYSTEM;
  return [
    BASE_ANSWER_SYSTEM,
    "",
    "以下是该客户对这个知识库/Agent 的背景诉求，仅供你理解语境、把握回答口径，不要在回答中逐字复述：",
    "<客户背景>",
    groupContext,
    "</客户背景>",
  ].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test packages/adapters/src/llm/llm-client.test.ts`
Expected: PASS（2 个 test 全过）。

- [ ] **Step 5: `answer()` 接住 `groupContext` 并使用**

`packages/adapters/src/llm/llm-client.ts` 的 `answer()` 方法（130-141 行）：

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
```

替换为：

```ts
  /** Citations 问答：把 top chunks 作可引用文档喂 Opus，返回 {answer, sources}（block_index→chunk 反查）。
   *  opts.history：多轮对话的前几轮 {role,content}，会垫进 messages 数组（仅最后一轮带可引用 document）。
   *  opts.groupContext：对话 scope 限定到某分组时，该分组的 Agent 用途/补充拼成的客户背景，注入 system。 */
  async answer(
    query: string,
    chunks: Array<{ id: string; content: string; heading_path: string[] }>,
    opts: {
      model?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
      groupContext?: string | null;
    } = {},
  ): Promise<{ answer: string; sources: Array<{ id: string; heading_path: string[] }> }> {
    const history = (opts.history ?? []).map((m) => ({ role: m.role, content: m.content }));
    const params: any = {
      model: opts.model ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
      max_tokens: 1024,
      system: buildAnswerSystemPrompt(opts.groupContext),
```

（该方法后续 `messages: [...]` 及往后代码不变。）

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/llm/llm-client.ts packages/adapters/src/llm/llm-client.test.ts
git commit -m "$(cat <<'EOF'
feat(adapters): answer() 支持按分组背景注入 system 提示词

buildAnswerSystemPrompt 拆成纯函数单测；无背景时行为与现状逐字
一致，有背景时追加<客户背景>块并显式要求不要逐字复述。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `chatTurn` 透传 `groupContext`

**Files:**
- Modify: `packages/pipeline/src/chat.ts`（`chatTurn` 签名 23-28 行；调用 `deps.llm.answer` 处 44-48 行）

**Interfaces:**
- Consumes: `LlmClient.answer(query, chunks, opts: { ...; groupContext?: string | null })`（Task 3）。
- Produces: `chatTurn(history, query, deps, opts?, groupContext?: string | null): Promise<ChatTurnResult>`。

- [ ] **Step 1: 加第五个参数并透传**

`packages/pipeline/src/chat.ts` 全文（50 行）替换为：

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
 *  history 为该会话此前的全部轮次（不含本次 query）。
 *  groupContext：scope=某分组时的客户背景（Agent 用途/补充），透传给 Opus system 提示词。 */
export async function chatTurn(
  history: ChatMessage[],
  query: string,
  deps: ChatDeps,
  opts: RetrieveOptions = {},
  groupContext?: string | null,
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
  // 零命中：不调 LLM 作答（空上下文会被网关拒），直接返回友好空答案
  if (hits.length === 0) {
    return { answer: "没有找到相关内容。", sources: [], hits: [], standaloneQuery };
  }
  const { answer, sources } = await deps.llm.answer(
    query,
    hits.map((h) => ({ id: h.id, content: h.content, heading_path: h.heading_path })),
    { history, groupContext },
  );
  return { answer, sources, hits, standaloneQuery };
}

export type { SearchHit };
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无报错（`apps/worker/src/cli/chat-demo.ts` 只传 4 个参数，`groupContext` 可选，向后兼容）。

- [ ] **Step 3: Commit**

```bash
git add packages/pipeline/src/chat.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): chatTurn 新增可选 groupContext 参数透传给 answer()

不污染 RetrieveOptions（检索专属），单独加第五参数；两个现有
调用点（chat/route.ts、chat-demo.ts）向后兼容。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `apps/web/app/api/chat/route.ts` — 组装并传入 `groupContext`

**Files:**
- Modify: `apps/web/app/api/chat/route.ts`（3-11 行 import；33-48 行 scope 解析与 `chatTurn` 调用）

**Interfaces:**
- Consumes: `findGroupById(id): Promise<GroupRow | null>`（Task 1）、`chatTurn(..., groupContext?)`（Task 4）。

- [ ] **Step 1: import 加 `findGroupById`**

`apps/web/app/api/chat/route.ts` 3-11 行：

```ts
import {
  getConversation,
  getMessages,
  insertMessages,
  touchConversation,
  listDocIdsInGroup,
  listDocIdsForUser,
} from "@kb/db";
```

改为：

```ts
import {
  getConversation,
  getMessages,
  insertMessages,
  touchConversation,
  listDocIdsInGroup,
  listDocIdsForUser,
  findGroupById,
} from "@kb/db";
```

- [ ] **Step 2: scope=分组时查背景并透传**

同文件 33-48 行：

```ts
    // 检索隔离：先取本人全部文档 id，再按会话 scope 收窄，全程不越权
    const allowed = new Set(await listDocIdsForUser(auth.userId));
    let docIds: string[];
    if (conv.scopeGroupId) {
      docIds = (await listDocIdsInGroup(conv.scopeGroupId)).filter((id) => allowed.has(id));
    } else if (conv.scopeDocId) {
      docIds = allowed.has(conv.scopeDocId) ? [conv.scopeDocId] : [];
    } else {
      docIds = [...allowed];
    }
    if (docIds.length === 0) docIds = ["__none__"]; // 零命中而非退回全库

    const r = await chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docIds });
```

替换为：

```ts
    // 检索隔离：先取本人全部文档 id，再按会话 scope 收窄，全程不越权
    const allowed = new Set(await listDocIdsForUser(auth.userId));
    let docIds: string[];
    let groupContext: string | null = null;
    if (conv.scopeGroupId) {
      docIds = (await listDocIdsInGroup(conv.scopeGroupId)).filter((id) => allowed.has(id));
      // scope=分组时把该分组的 Agent 用途/补充拼成客户背景，喂给 Opus 作答
      const group = await findGroupById(conv.scopeGroupId);
      const parts: string[] = [];
      if (group?.agentPurpose) parts.push(`用途：${group.agentPurpose}`);
      if (group?.agentNotes) parts.push(`补充：${group.agentNotes}`);
      if (parts.length > 0) groupContext = parts.join("\n");
    } else if (conv.scopeDocId) {
      docIds = allowed.has(conv.scopeDocId) ? [conv.scopeDocId] : [];
    } else {
      docIds = [...allowed];
    }
    if (docIds.length === 0) docIds = ["__none__"]; // 零命中而非退回全库

    const r = await chatTurn(
      history,
      query,
      { llm, embedder, reranker },
      { topK: 4, poolN: 10, docIds },
      groupContext,
    );
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/chat/route.ts
git commit -m "$(cat <<'EOF'
feat(chat): scope=分组时把分组 Agent 背景传给 chatTurn

scope=全部知识库或单篇文档时不查、不传，只在明确限定到某个
分组的对话里生效。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `api/groups` 路由支持读写 `agentPurpose`/`agentNotes`

**Files:**
- Modify: `apps/web/app/api/groups/route.ts`（全文 36 行）
- Modify: `apps/web/app/api/groups/[id]/route.ts`（PATCH handler 8-27 行）

**Interfaces:**
- Consumes: `createGroup`/`updateGroup`/`listGroups`（Task 1，均已支持两字段）。
- Produces: `GET /api/groups` 每项含 `agentPurpose`/`agentNotes`；`POST /api/groups` body 可带 `agentPurpose`/`agentNotes`，返回的 `group` 含这两字段；`PATCH /api/groups/[id]` body 可带 `agentPurpose`/`agentNotes`（含显式 `null` 清空）。

- [ ] **Step 1: `GET`/`POST` 加两字段**

`apps/web/app/api/groups/route.ts` 全文替换为：

```ts
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listGroups, createGroup } from "@kb/db";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const rows = await listGroups(auth.userId);
    const groups = rows.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color ?? null,
      sortOrder: g.sortOrder,
      docCount: g.docCount,
      agentPurpose: g.agentPurpose ?? null,
      agentNotes: g.agentNotes ?? null,
    }));
    return NextResponse.json({ groups });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const body = await req.json().catch(() => null);
    const name = (body?.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "分组名不能为空" }, { status: 400 });
    const id = "grp_" + randomUUID().slice(0, 8);
    const color = body?.color ?? null;
    const agentPurpose = body?.agentPurpose ?? null;
    const agentNotes = body?.agentNotes ?? null;
    await createGroup({ id, name, color, userId: auth.userId, agentPurpose, agentNotes });
    return NextResponse.json({
      group: { id, name, color, sortOrder: 0, docCount: 0, agentPurpose, agentNotes },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: `PATCH` 加两字段**

`apps/web/app/api/groups/[id]/route.ts` 的 `PATCH` handler（8-27 行）：

```ts
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const patch: { name?: string; color?: string | null; sortOrder?: number } = {};
    if (typeof body?.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "分组名不能为空" }, { status: 400 });
      patch.name = name;
    }
    if ("color" in (body ?? {})) patch.color = body.color ?? null;
    if (typeof body?.sortOrder === "number") patch.sortOrder = body.sortOrder;
    await updateGroup(id, patch, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

替换为：

```ts
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const patch: {
      name?: string;
      color?: string | null;
      sortOrder?: number;
      agentPurpose?: string | null;
      agentNotes?: string | null;
    } = {};
    if (typeof body?.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "分组名不能为空" }, { status: 400 });
      patch.name = name;
    }
    if ("color" in (body ?? {})) patch.color = body.color ?? null;
    if ("agentPurpose" in (body ?? {})) patch.agentPurpose = body.agentPurpose ?? null;
    if ("agentNotes" in (body ?? {})) patch.agentNotes = body.agentNotes ?? null;
    if (typeof body?.sortOrder === "number") patch.sortOrder = body.sortOrder;
    await updateGroup(id, patch, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

（`DELETE` handler 不变。）

- [ ] **Step 3: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/groups/route.ts apps/web/app/api/groups/\[id\]/route.ts
git commit -m "$(cat <<'EOF'
feat(web): api/groups 读写 agentPurpose/agentNotes

GET 列表返回、POST 建组带上、PATCH 支持改（含显式传 null 清空）。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `GroupDialog` 加两个文本框

**Files:**
- Modify: `apps/web/components/GroupDialog.tsx`（全文 91 行）
- Modify: `apps/web/app/globals.css`（`.modal .field select`，149-150 行之后加 textarea 规则）

**Interfaces:**
- Produces: `GroupDialog` 的 `onSubmit: (name, color, agentPurpose: string | null, agentNotes: string | null) => Promise<void>`；新增 props `initialAgentPurpose?: string | null`、`initialAgentNotes?: string | null`。

- [ ] **Step 1: 重写 `GroupDialog.tsx`**

`apps/web/components/GroupDialog.tsx` 全文替换为：

```tsx
"use client";
import { useEffect, useState } from "react";

export const GROUP_COLORS = ["#C96442", "#C8A24A", "#7A9A6B", "#6B8B9A", "#9A6B8B"];

/** 建组 / 改名弹框。mode=create 时提交建组；mode=edit 时提交改名+改色+改 Agent 简介。 */
export default function GroupDialog({
  open,
  mode,
  initialName,
  initialColor,
  initialAgentPurpose,
  initialAgentNotes,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  initialName?: string;
  initialColor?: string | null;
  initialAgentPurpose?: string | null;
  initialAgentNotes?: string | null;
  onClose: () => void;
  onSubmit: (
    name: string,
    color: string | null,
    agentPurpose: string | null,
    agentNotes: string | null,
  ) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(GROUP_COLORS[0]);
  const [agentPurpose, setAgentPurpose] = useState("");
  const [agentNotes, setAgentNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setColor(initialColor ?? GROUP_COLORS[0]);
    setAgentPurpose(initialAgentPurpose ?? "");
    setAgentNotes(initialAgentNotes ?? "");
    setErr("");
  }, [open, initialName, initialColor, initialAgentPurpose, initialAgentNotes]);

  if (!open) return null;

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onSubmit(name.trim(), color, agentPurpose.trim() || null, agentNotes.trim() || null);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "create" ? "新建分组" : "编辑分组"}</h3>
        <label className="field">
          <span>分组名</span>
          <input
            value={name}
            autoFocus
            placeholder="如：产品手册"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <div className="field">
          <span>颜色</span>
          <div className="color-pick">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={c === color ? "swatch on" : "swatch"}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`选择颜色 ${c}`}
              />
            ))}
          </div>
        </div>
        <label className="field">
          <span>Agent 用途</span>
          <textarea
            value={agentPurpose}
            placeholder="客户希望这个知识库/Agent 用来做什么"
            rows={3}
            onChange={(e) => setAgentPurpose(e.target.value)}
          />
        </label>
        <label className="field">
          <span>其他补充</span>
          <textarea
            value={agentNotes}
            placeholder="客服风格、特殊要求等（选填）"
            rows={2}
            onChange={(e) => setAgentNotes(e.target.value)}
          />
        </label>
        {err && <p className="err">⚠ {err}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 加 textarea 样式**

`apps/web/app/globals.css` 的 `.modal .field select{...}` 规则（149-150 行）之后新增一行：

```css
.modal .field textarea{padding:9px 12px;border:1px solid var(--border-strong);border-radius:9px;font-size:14px;
                       font-family:inherit;color:var(--text);background:var(--surface);resize:vertical;min-height:56px;}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 会因 `DocList.tsx` 里 `onSubmit={async (name, color) => {...}}` 只接两个参数、类型不匹配而报错——这是预期的，Task 8 会改 `DocList.tsx` 对齐。若想单独验证本任务的 `GroupDialog.tsx` 自身无报错，可用编辑器/IDE 单文件检查；命令行 typecheck 到 Task 8 完成后再看整体是否绿。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/GroupDialog.tsx apps/web/app/globals.css
git commit -m "$(cat <<'EOF'
feat(web): GroupDialog 加 Agent 用途/其他补充两个文本框

create/edit 两种 mode 都可填、都选填；modal textarea 样式对齐
现有 input/select。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `DocList` + `page.tsx` 接线

**Files:**
- Modify: `apps/web/components/DocList.tsx`（`GroupItem` 类型 24 行；prop 类型 76-77 行；`dialog` 状态 92 行；编辑按钮 342 行；`GroupDialog` 渲染 367-377 行）
- Modify: `apps/web/app/page.tsx`（`createGroup` 94-107 行；`updateGroup` 109-120 行）

**Interfaces:**
- Consumes: `GroupDialog` 的新 `onSubmit`/`initialAgentPurpose`/`initialAgentNotes`（Task 7）；`GET/POST/PATCH /api/groups` 新字段（Task 6）。
- Produces: `GroupItem` 含 `agentPurpose: string | null`、`agentNotes: string | null`；`page.tsx` 的 `createGroup(name, color, agentPurpose?, agentNotes?)`、`updateGroup(id, name, color, agentPurpose, agentNotes)`。

- [ ] **Step 1: `GroupItem` 类型加两字段**

`apps/web/components/DocList.tsx` 第 24 行：

```tsx
export type GroupItem = { id: string; name: string; color: string | null; sortOrder: number; docCount: number };
```

改为：

```tsx
export type GroupItem = {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  docCount: number;
  agentPurpose: string | null;
  agentNotes: string | null;
};
```

- [ ] **Step 2: `onCreateGroup`/`onUpdateGroup` prop 类型**

同文件 76-77 行：

```tsx
  onCreateGroup: (name: string, color: string | null) => Promise<GroupItem>;
  onUpdateGroup: (id: string, name: string, color: string | null) => Promise<void>;
```

改为：

```tsx
  // agentPurpose/agentNotes 设为可选参数：UploadDialog 内联建组不填这两项，仍可直接把 onCreateGroup 传给它
  onCreateGroup: (
    name: string,
    color: string | null,
    agentPurpose?: string | null,
    agentNotes?: string | null,
  ) => Promise<GroupItem>;
  onUpdateGroup: (
    id: string,
    name: string,
    color: string | null,
    agentPurpose: string | null,
    agentNotes: string | null,
  ) => Promise<void>;
```

- [ ] **Step 3: `dialog` 状态类型加两字段**

同文件第 92 行：

```tsx
  const [dialog, setDialog] = useState<{ mode: "create" | "edit"; id?: string; name?: string; color?: string | null } | null>(null);
```

改为：

```tsx
  const [dialog, setDialog] = useState<{
    mode: "create" | "edit";
    id?: string;
    name?: string;
    color?: string | null;
    agentPurpose?: string | null;
    agentNotes?: string | null;
  } | null>(null);
```

- [ ] **Step 4: 编辑按钮预填分组的 Agent 字段**

同文件第 342 行：

```tsx
                    <button type="button" onClick={() => { setDialog({ mode: "edit", id: s.gid!, name: s.name, color: s.color }); setGroupMenuFor(null); }}>
                      编辑（改名 / 改色）
                    </button>
```

替换为：

```tsx
                    <button
                      type="button"
                      onClick={() => {
                        const g = groups.find((x) => x.id === s.gid);
                        setDialog({
                          mode: "edit",
                          id: s.gid!,
                          name: s.name,
                          color: s.color,
                          agentPurpose: g?.agentPurpose ?? null,
                          agentNotes: g?.agentNotes ?? null,
                        });
                        setGroupMenuFor(null);
                      }}
                    >
                      编辑（改名 / 改色 / Agent 用途）
                    </button>
```

- [ ] **Step 5: `GroupDialog` 渲染接住新 props**

同文件 367-377 行：

```tsx
      <GroupDialog
        open={!!dialog}
        mode={dialog?.mode ?? "create"}
        initialName={dialog?.name}
        initialColor={dialog?.color}
        onClose={() => setDialog(null)}
        onSubmit={async (name, color) => {
          if (dialog?.mode === "edit" && dialog.id) await onUpdateGroup(dialog.id, name, color);
          else await onCreateGroup(name, color);
        }}
      />
```

替换为：

```tsx
      <GroupDialog
        open={!!dialog}
        mode={dialog?.mode ?? "create"}
        initialName={dialog?.name}
        initialColor={dialog?.color}
        initialAgentPurpose={dialog?.agentPurpose}
        initialAgentNotes={dialog?.agentNotes}
        onClose={() => setDialog(null)}
        onSubmit={async (name, color, agentPurpose, agentNotes) => {
          if (dialog?.mode === "edit" && dialog.id)
            await onUpdateGroup(dialog.id, name, color, agentPurpose, agentNotes);
          else await onCreateGroup(name, color, agentPurpose, agentNotes);
        }}
      />
```

- [ ] **Step 6: `page.tsx` 的 `createGroup`/`updateGroup` 透传新字段**

`apps/web/app/page.tsx` 94-107 行（`createGroup`）：

```tsx
  const createGroup = useCallback(
    async (name: string, color: string | null): Promise<GroupItem> => {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "建组失败");
      await load();
      return json.group as GroupItem;
    },
    [load],
  );
```

替换为：

```tsx
  const createGroup = useCallback(
    async (
      name: string,
      color: string | null,
      agentPurpose: string | null = null,
      agentNotes: string | null = null,
    ): Promise<GroupItem> => {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color, agentPurpose, agentNotes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "建组失败");
      await load();
      return json.group as GroupItem;
    },
    [load],
  );
```

同文件 109-120 行（`updateGroup`）：

```tsx
  const updateGroup = useCallback(
    async (id: string, name: string, color: string | null) => {
      const res = await fetch(`/api/groups/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "保存失败");
      await load();
    },
    [load],
  );
```

替换为：

```tsx
  const updateGroup = useCallback(
    async (
      id: string,
      name: string,
      color: string | null,
      agentPurpose: string | null,
      agentNotes: string | null,
    ) => {
      const res = await fetch(`/api/groups/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color, agentPurpose, agentNotes }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "保存失败");
      await load();
    },
    [load],
  );
```

- [ ] **Step 7: typecheck（整体）**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无报错（Task 7/8 类型此时全部对齐；`UploadDialog.tsx` 未改动，`onCreateGroup` 两参数调用因 `DocList` 侧新签名的第三、四参数可选而依旧兼容）。

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/DocList.tsx apps/web/app/page.tsx
git commit -m "$(cat <<'EOF'
feat(web): DocList/page.tsx 接线分组 Agent 用途/补充的手动编辑

GroupItem 类型、编辑弹框预填、createGroup/updateGroup 包装函数
透传两字段；UploadDialog 内联建组不受影响（未改动该文件）。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 整体验证

**Files:** 无（仅验证）

- [ ] **Step 1: 全量 typecheck**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web`
Expected: 两条都无报错。

- [ ] **Step 2: 全量相关测试**

Run:
```bash
npx tsx --test packages/db/src/groups-agent-brief.integration.test.ts
npx tsx --test packages/db/src/groups-upload.integration.test.ts
npx tsx --test packages/adapters/src/llm/llm-client.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 3: 起 web 手动走查 — 手动编辑**

Run: `npm run dev --workspace @kb/web`（http://localhost:3001，需先 `npm run db:up`）

逐项确认：
1. 点「＋ 新建分组」→ 填分组名 + 「Agent 用途」+「其他补充」→ 保存 → 分组出现在侧栏。
2. 点该分组「⋯」→「编辑」→ 弹框正确预填之前填的用途/补充。
3. 清空「其他补充」文本框 → 保存 → 再次打开编辑 → 「其他补充」为空（验证「所见即所得」清空语义）。
4. 上传文档时走「＋ 新建分组」内联建组（`UploadDialog`）→ 确认这条路径不受影响，正常建组（不需要也不应该出现这两个新文本框）。

- [ ] **Step 4: curl 验证 `/api/ingest` 覆盖策略**

需要 `.env` 里的 `COLLECTOR_SERVICE_SECRET`，以及一个已生成的收集 token（登录后 `GET /api/collect-link` 拿）。用一个小文本文件模拟收集器两次提交：

```bash
# 第一次提交：带 agentPurpose
curl -s -X POST http://localhost:3001/api/ingest \
  -H "authorization: Bearer $COLLECTOR_SERVICE_SECRET" \
  -F "ref=<上面拿到的 token>" \
  -F "company=测试公司A" \
  -F "agentPurpose=做售后客服" \
  -F "agentNotes=语气亲切" \
  -F "file=@/tmp/test.txt"

# 第二次提交同一公司：agentPurpose 带新值，agentNotes 留空
curl -s -X POST http://localhost:3001/api/ingest \
  -H "authorization: Bearer $COLLECTOR_SERVICE_SECRET" \
  -F "ref=<同一个 token>" \
  -F "company=测试公司A" \
  -F "agentPurpose=做售前咨询" \
  -F "file=@/tmp/test2.txt"
```

Expected: kb-studio 侧栏「测试公司A」分组下有两个文档；打开该分组「编辑」，「Agent 用途」为「做售前咨询」（第二次覆盖生效），「其他补充」仍是「语气亲切」（第二次留空，未被清空）。

- [ ] **Step 5: 手动走查 — 检索/问答注入**

1. 在「测试公司A」分组下上传一篇包含具体信息的文档（比如内容为“退货政策：7 天无理由退货”）。
2. 新建对话，检索范围选「测试公司A」这个分组。
3. 问一个和文档相关的问题，确认能正常检索并回答（不因为多拼了一段 system 提示词而报错或跑题）。
4. （可选，验证是否真的注入）临时在 `apps/web/app/api/chat/route.ts` 的 `groupContext` 赋值后加一行 `console.log("[chat] groupContext:", groupContext);`，观察 dev server 终端日志确实打印出了「用途：做售前咨询」等内容，确认后删掉这行调试日志（不要提交）。

- [ ] **Step 6: 终态 Commit（如有手动走查中的小修）**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: 分组 Agent 简介字段 手动走查微调

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)" || echo "无改动可提交"
```

---

## Self-Review 记录

- **Spec 覆盖**：`groups` 加两列(Task 1)、`findGroupById`(Task 1)、收集器覆盖策略"新值非空才覆盖"(Task 2)、手动编辑"所见即所得"(Task 7 GroupDialog 提交逻辑 + Task 6 PATCH 支持显式 null)、`GroupDialog` 展示位置(Task 7/8，唯一入口)、检索/问答注入且仅 scope=分组时生效(Task 3/4/5)、system 提示词含"不要逐字复述"提醒(Task 3)、不推送秒懂/不新增对外 API(未新增任何相关代码，符合非目标)。均有对应任务。
- **类型一致**：`GroupInput.agentPurpose?/agentNotes?`(Task1) → `createGroup(g: GroupInput)`(Task1) 全链使用同名字段；`updateGroup(id, patch: {...agentPurpose?, agentNotes?}, userId)`(Task1) 与 `/api/ingest`(Task2)、`/api/groups/[id]`(Task6) 的 patch 构造一致；`findGroupById(id): Promise<GroupRow | null>`(Task1) 与 `chat/route.ts`(Task5) 调用签名一致；`LlmClient.answer(query, chunks, opts: {...groupContext?})`(Task3) 与 `chatTurn(..., groupContext?)`(Task4) 传参一致；`GroupItem`(Task8) 新增的 `agentPurpose: string | null`/`agentNotes: string | null` 与 `GET /api/groups`(Task6) 返回结构、`GroupDialog` 的 `initialAgentPurpose`/`initialAgentNotes`(Task7) 类型一致。
- **无 placeholder**：每步含完整代码/命令；Task 2、4、5、6 因是路由/编排层胶水代码、代码库里同类文件均无自动化测试先例，未强行编造假测试，改以 typecheck + Task 9 手动/curl 走查验证，与 Task 1（DB 集成测试）、Task 3（纯函数单测）形成互补——可自动化的都已自动化。
- **边界**：`UploadDialog.tsx` 全程未改动（内联建组两参数调用天然兼容 `DocList` 侧新签名的可选第三/四参数）；`packages/db/src/index.ts`、`packages/pipeline/src/index.ts` 均整体再导出、无需改动，已在"文件结构"注明。
