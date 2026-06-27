# 对话按知识库范围检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对话时可单选某篇已处理文档（或全部），把检索限定到它，并把选择持久化到会话——用于验证某篇文档入库后能否被检索到。

**Architecture:** `conversations` 加 `scope_doc_id` 列作唯一真相源；检索链路 `retrieve → hybridSearch → vector/keywordSearch` 加可选 `docId` 过滤（空=全库，行为不变）；`/api/chat` 读会话的 scope 做检索；对话 UI 加一个选择器，onChange 经 PATCH 写回会话。

**Tech Stack:** TypeScript + drizzle-orm/postgres-js + pgvector + Next.js 15（App Router）+ 302 网关 + tsx demo。

> **验证方式（无单测框架）：** `npm run *-demo`（tsx，process.exit 断言）+ `npm run typecheck`（root）+ `npm run typecheck --workspace @kb/web`（web，必须单独跑，root 不覆盖 web）+ 对运行中的 dev server 跑 curl。参考 spec：`docs/superpowers/specs/2026-06-27-scoped-retrieval-design.md`。当前分支 `feat/kb-history-and-chat`。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/db/src/schema.ts` | conversations 加 `scopeDocId` 列 | 改 |
| `packages/db/src/repo.ts` | 检索三函数加 docId 过滤 + `setConversationScope` | 改 |
| `packages/pipeline/src/retrieve.ts` | `RetrieveOptions.docId` + 透传 | 改 |
| `apps/worker/src/cli/scoped-search-demo.ts` | 范围过滤验证（充当测试） | 建 |
| `package.json` | 加 `scoped-search-demo` 脚本 | 改 |
| `apps/web/app/api/conversations/[id]/route.ts` | 加 `PATCH`（设 scope） | 改 |
| `apps/web/app/api/chat/route.ts` | 检索带 `conv.scopeDocId` | 改 |
| `apps/web/app/chat/page.tsx` | 拉 `/api/docs` 传给 ChatThread | 改 |
| `apps/web/components/ChatThread.tsx` | 知识库选择器 + 初始化 + PATCH | 改 |
| `apps/web/app/globals.css` | `.scope-select` 样式 | 改 |

构建顺序：DB → 检索过滤(+demo) → repo/API → UI。每步 typecheck + commit。

---

## Task 1: DB — conversations 加 scope_doc_id 列 + 迁移

**Files:** Modify `packages/db/src/schema.ts`

- [ ] **Step 1: 加列**

在 `packages/db/src/schema.ts` 的 `conversations` 表定义里，`updatedAt` 那行之后、表闭合 `});` 之前加一列：

```ts
  scopeDocId: text("scope_doc_id"),
```

（`text` 已 import；nullable，null = 全部知识库。`ConversationRow` 自动含 `scopeDocId`，无需改类型导出。）

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 3: 生成并应用迁移**

Run: `npm run db:generate && npm run db:migrate`
Expected: 在 `packages/db/migrations/` 生成新 SQL（含 `ALTER TABLE "conversations" ADD COLUMN "scope_doc_id" text;`），迁移成功。

- [ ] **Step 4: 验证列存在**

Run: `docker exec kb-studio-db psql -U kb -d kbstudio -c "\d conversations"`
Expected: 输出含 `scope_doc_id | text`。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): conversations 加 scope_doc_id（按文档限定检索范围）"
```

---

## Task 2: 检索过滤（repo + retrieve）+ scoped-search-demo

**Files:**
- Create: `apps/worker/src/cli/scoped-search-demo.ts`
- Modify: `package.json`
- Modify: `packages/db/src/repo.ts`
- Modify: `packages/pipeline/src/retrieve.ts`

- [ ] **Step 1: 先写 demo（失败用例）— 创建 `apps/worker/src/cli/scoped-search-demo.ts`：**

```ts
import "dotenv/config";
import { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import { clearAll } from "@kb/db";
import { ingestDoc, retrieve } from "@kb/pipeline";

// 范围检索验证：入两篇文档，按 docId 过滤检索 → 命中只来自指定文档。
const docX = `# 退款政策\n\n退款申请需在购买后 7 日内提交，审核通常三个工作日内完成，原路退回。`;
const docY = `# 配送说明\n\n标准快递 48 小时内发出，偏远地区可能延迟，支持顺丰到付。`;

const llm = new LlmClient();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});

await clearAll();
console.error("→ 入库两篇…");
await ingestDoc({ docId: "doc_x", title: "退款政策", source: "scoped-demo", markdown: docX }, { llm, embedder });
await ingestDoc({ docId: "doc_y", title: "配送说明", source: "scoped-demo", markdown: docY }, { llm, embedder });

const q = "多久能处理好？"; // 两篇都可能沾边
const onlyX = await retrieve(q, { embedder }, { topK: 5, docId: "doc_x" });
const onlyY = await retrieve(q, { embedder }, { topK: 5, docId: "doc_y" });
const all = await retrieve(q, { embedder }, { topK: 5 });

const xOk = onlyX.length > 0 && onlyX.every((h) => h.id.startsWith("doc_x"));
const yOk = onlyY.length > 0 && onlyY.every((h) => h.id.startsWith("doc_y"));
console.log(`docId=doc_x → ${onlyX.map((h) => h.id).join(",")}  [仅 doc_x: ${xOk}]`);
console.log(`docId=doc_y → ${onlyY.map((h) => h.id).join(",")}  [仅 doc_y: ${yOk}]`);
console.log(`无过滤   → ${all.map((h) => h.id).join(",")}`);
process.exit(xOk && yOk ? 0 : 1);
```

- [ ] **Step 2: 加 npm 脚本**

在 root `package.json` 的 `scripts` 里、`"search-demo"` 那行之后加：

```json
    "scoped-search-demo": "tsx apps/worker/src/cli/scoped-search-demo.ts",
```

- [ ] **Step 3: 运行 demo，确认失败（retrieve 还不认 docId）**

Run: `npm run db:up && npm run scoped-search-demo`
Expected: FAIL — 退出码非 0（onlyX/onlyY 会混进另一篇，因为过滤还没实现），或 TS 报 `docId` 不在 RetrieveOptions。

- [ ] **Step 4: repo 三函数加 docId 过滤**

把 `packages/db/src/repo.ts` 的 `vectorSearch` 整个替换为：

```ts
/** 向量检索（cosine）。docId 非空时限定到该文档。 */
export async function vectorSearch(queryEmbedding: number[], topK = 5, docId?: string | null): Promise<SearchHit[]> {
  const lit = `[${queryEmbedding.join(",")}]`;
  const docFilter = docId ? sql`AND doc_id = ${docId}` : sql``;
  const rows = await db.execute(sql`
    SELECT id, content, metadata, 1 - (embedding <=> ${lit}::vector) AS score
    FROM chunks
    WHERE embedding IS NOT NULL ${docFilter}
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${topK}
  `);
  return toHits(rows);
}
```

把 `keywordSearch` 整个替换为：

```ts
/** 关键词检索（jieba 分词 + Postgres 全文 ts_rank_cd）。docId 非空时限定到该文档。 */
export async function keywordSearch(query: string, topK = 5, docId?: string | null): Promise<SearchHit[]> {
  const tsq = toTsQuery(query);
  if (!tsq) return [];
  const docFilter = docId ? sql`AND doc_id = ${docId}` : sql``;
  const rows = await db.execute(sql`
    SELECT id, content, metadata,
           ts_rank_cd(to_tsvector('simple', tsv_text), to_tsquery('simple', ${tsq})) AS score
    FROM chunks
    WHERE tsv_text IS NOT NULL
      AND to_tsvector('simple', tsv_text) @@ to_tsquery('simple', ${tsq})
      ${docFilter}
    ORDER BY score DESC
    LIMIT ${topK}
  `);
  return toHits(rows);
}
```

把 `hybridSearch` 的签名与前两行调用替换为（RRF 融合逻辑保持不变）：

```ts
/** 混合检索：向量 + 关键词，RRF 融合排序。docId 非空时两路都限定到该文档。 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  topK = 5,
  poolN = 20,
  docId?: string | null,
): Promise<SearchHit[]> {
  const [vec, kw] = await Promise.all([
    vectorSearch(queryEmbedding, poolN, docId),
    keywordSearch(query, poolN, docId),
  ]);
```

（`hybridSearch` 函数体其余部分 `const K = 60; ... return [...acc.values()]...` 一字不改。）

- [ ] **Step 5: retrieve 透传 docId**

把 `packages/pipeline/src/retrieve.ts` 的 `RetrieveOptions` 接口与 `retrieve` 里调 `hybridSearch` 那行替换：

接口改为：
```ts
export interface RetrieveOptions {
  topK?: number;
  poolN?: number;
  docId?: string | null; // 非空则限定到该文档
}
```

`retrieve` 里把
```ts
  const pool = await hybridSearch(query, qv!, poolN, poolN);
```
改为
```ts
  const pool = await hybridSearch(query, qv!, poolN, poolN, opts.docId);
```

（`chatTurn` 无需改：它已把 `opts` 原样传给 `retrieve`，`docId` 随 `RetrieveOptions` 透传。）

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 7: 运行 demo，确认通过**

Run: `npm run scoped-search-demo`
Expected: PASS（exit 0）。输出里 `docId=doc_x` 只列 `doc_x_*`、`docId=doc_y` 只列 `doc_y_*`，无过滤则可能两篇都有。

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/repo.ts packages/pipeline/src/retrieve.ts apps/worker/src/cli/scoped-search-demo.ts package.json
git commit -m "feat(retrieve): 检索支持按 docId 限定范围 + scoped-search-demo"
```

---

## Task 3: repo setter + API（PATCH scope + chat 用 scope）

**Files:**
- Modify: `packages/db/src/repo.ts`
- Modify: `apps/web/app/api/conversations/[id]/route.ts`
- Modify: `apps/web/app/api/chat/route.ts`

- [ ] **Step 1: repo 加 setConversationScope**

在 `packages/db/src/repo.ts` 的 `touchConversation` 函数之后追加：

```ts
/** 设置会话的检索范围（null = 全部知识库）。 */
export async function setConversationScope(id: string, scopeDocId: string | null): Promise<void> {
  await db.update(conversations).set({ scopeDocId }).where(eq(conversations.id, id));
}
```

（`conversations`、`eq` 已在 repo.ts 顶部 import。）

- [ ] **Step 2: API 加 PATCH**

在 `apps/web/app/api/conversations/[id]/route.ts` 顶部 import 里把 `deleteConversation` 那行补上 `setConversationScope`：

```ts
import { getConversation, getMessages, deleteConversation, setConversationScope } from "@kb/db";
```

在文件末尾（`DELETE` handler 之后）追加：

```ts
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { scopeDocId } = await req.json();
    await setConversationScope(id, scopeDocId || null);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: /api/chat 检索带 scope**

在 `apps/web/app/api/chat/route.ts` 里，把
```ts
    const r = await chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10 });
```
改为
```ts
    const r = await chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docId: conv.scopeDocId });
```

（`conv` 已在前面 `const conv = await getConversation(conversationId)` 取得，含 `scopeDocId`。）

- [ ] **Step 4: typecheck（root + web）**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web`
Expected: 两个都通过。

- [ ] **Step 5: curl 验证 PATCH + scope 生效（dev server 在 3001）**

> 注：dev server 需已加载本批改动。若是长期运行的旧实例，先让控制器重启 dev server 再测；或本步只验证 PATCH/GET，scope 检索效果留待 Task 5 端到端。

Run:
```bash
CID=$(curl -s -X POST localhost:3001/api/conversations | grep -o '"id":"[^"]*"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
# 取库里第一篇文档 id
DID=$(curl -s localhost:3001/api/docs | grep -o '"id":"[^"]*"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
echo "CID=$CID DID=$DID"
curl -s -X PATCH "localhost:3001/api/conversations/$CID" -H 'content-type: application/json' -d "{\"scopeDocId\":\"$DID\"}"; echo
curl -s "localhost:3001/api/conversations/$CID" | grep -o "\"scopeDocId\":\"[^\"]*\"" ; echo
curl -s -X DELETE "localhost:3001/api/conversations/$CID" >/dev/null
```
Expected: PATCH 返回 `{"ok":true}`；GET 的 conversation 含 `"scopeDocId":"<DID>"`。

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repo.ts apps/web/app/api/conversations/[id]/route.ts apps/web/app/api/chat/route.ts
git commit -m "feat(web): 会话 scope setter + PATCH 端点 + chat 按会话 scope 检索"
```

---

## Task 4: UI — 知识库选择器

**Files:**
- Modify: `apps/web/app/chat/page.tsx`
- Modify: `apps/web/components/ChatThread.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: chat/page.tsx 拉文档列表传给 ChatThread**

在 `apps/web/app/chat/page.tsx` 的 `ChatPage` 组件里：

(a) 顶部状态区（`const [selectedId, setSelectedId] = useState<string | null>(null);` 之后）加：
```ts
  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);
```

(b) `useEffect(() => { load(); }, [load]);` 之后加一个拉文档的 effect：
```ts
  useEffect(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((json) => setDocs((json.docs ?? []).map((d: any) => ({ id: d.id, title: d.title }))))
      .catch((e) => console.error("[kb] 加载文档列表失败:", e));
  }, []);
```

(c) 渲染处把 `<ChatThread conversationId={selectedId} onTitle={onTitle} />` 改为：
```tsx
      <ChatThread conversationId={selectedId} onTitle={onTitle} docs={docs} />
```

- [ ] **Step 2: ChatThread 加选择器**

在 `apps/web/components/ChatThread.tsx`：

(a) props 类型加 `docs`：把
```tsx
}: {
  conversationId: string | null;
  onTitle: (id: string, title: string) => void;
}) {
```
改为
```tsx
}: {
  conversationId: string | null;
  onTitle: (id: string, title: string) => void;
  docs: { id: string; title: string }[];
}) {
```

(b) 状态区（`const [err, setErr] = useState("");` 之后）加：
```tsx
  const [scopeDocId, setScopeDocId] = useState("");
```

(c) 拉会话历史的 useEffect 里，把
```tsx
        if (json.error) setErr(json.error);
        else setMsgs(json.messages ?? []);
```
改为（顺带初始化 scope；若存的 id 不在 docs 里则回退全部）：
```tsx
        if (json.error) setErr(json.error);
        else {
          setMsgs(json.messages ?? []);
          const s = json.conversation?.scopeDocId ?? "";
          setScopeDocId(s && docs.some((d) => d.id === s) ? s : "");
        }
```

并把该 useEffect 的依赖数组从 `[conversationId]` 改为 `[conversationId, docs]`。

(d) 新增 onChange 处理函数（放在 `send` 函数之前）：
```tsx
  async function changeScope(v: string) {
    setScopeDocId(v);
    if (!conversationId) return;
    try {
      await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeDocId: v || null }),
      });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }
```

(e) 在主渲染的 `<section className="detail-col chat">` 里、`<div className="thread">` 之前插入选择器：
```tsx
      <div className="scope-bar">
        <span className="scope-label">知识库范围</span>
        <select className="scope-select" value={scopeDocId} onChange={(e) => changeScope(e.target.value)}>
          <option value="">全部知识库</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </div>
```

- [ ] **Step 3: 样式**

在 `apps/web/app/globals.css` 末尾追加：
```css
.scope-bar { display: flex; align-items: center; gap: 8px; padding: 10px 20px; border-bottom: 1px solid #e6e8eb; background: #fbfbfc; }
.scope-label { font-size: 12px; color: #6b7280; }
.scope-select { flex: 0 1 320px; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; background: #fff; }
```

- [ ] **Step 4: typecheck（root + web）**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web`
Expected: 两个都通过。

- [ ] **Step 5: 烟测（dev server 已加载本批改动）**

Run: `curl -s -o /dev/null -w 'chat=%{http_code}\n' localhost:3001/chat`
Expected: `chat=200`。浏览器完整交互（选库记忆、发问命中该库）留到 Task 5 / 控制器手测。

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/chat/page.tsx apps/web/components/ChatThread.tsx apps/web/app/globals.css
git commit -m "feat(web): 对话加知识库范围选择器（每会话记忆）"
```

---

## Task 5: 总验收

**Files:** 无（纯验证）。前提：dev server 已重启加载全部改动（`npm run dev --workspace @kb/web`）。

- [ ] **Step 1: typecheck 双绿 + 管线 demo**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web && npm run scoped-search-demo`
Expected: 都通过，scoped-search-demo exit 0。

- [ ] **Step 2: 端到端 curl（验证"某篇能否被检索到"）**

> ⚠️ scoped-search-demo 跑过 `clearAll()` 会清库。本步前先经 web 上传至少一篇真实文档（或重跑一篇），确保库里有可检索内容。

Run:（把 DID 换成目标文档 id；问与该文档相关的问题）
```bash
CID=$(curl -s -X POST localhost:3001/api/conversations | grep -o '"id":"[^"]*"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
DID=$(curl -s localhost:3001/api/docs | grep -o '"id":"[^"]*"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
curl -s -X PATCH "localhost:3001/api/conversations/$CID" -H 'content-type: application/json' -d "{\"scopeDocId\":\"$DID\"}" >/dev/null
curl -s --max-time 200 -X POST localhost:3001/api/chat -H 'content-type: application/json' -d "{\"conversationId\":\"$CID\",\"query\":\"这篇文档讲了什么？\"}" | grep -o '"id":"[^"]*"' | head -5
curl -s -X DELETE "localhost:3001/api/conversations/$CID" >/dev/null
```
Expected: chat 返回的 hits/sources 里 chunk id 全部以 `<DID>_` 开头（检索被正确限定到该文档）。

- [ ] **Step 3: 浏览器手测**

http://localhost:3001/chat ：新建对话 → 顶部「知识库范围」选某篇 → 提该篇相关问题 → 答案+溯源属于该篇；切「全部」→ 跨库；刷新/重开会话 → 选择被记住；删该文档后重开会话 → 选择器回退「全部」。

- [ ] **Step 4: Final commit（若有零散改动）**

```bash
git status
# 如有未提交改动：git add -A && git commit -m "chore(web): 范围检索收尾"
```

---

## 自检对照（spec → task）
- conversations 加 scope_doc_id + 迁移 → Task 1 ✅
- 检索 docId 过滤（vector/keyword/hybrid/retrieve，空=全库）→ Task 2 ✅
- chatTurn 不改、自动透传 → Task 2 Step 5 ✅
- repo setConversationScope + PATCH + chat 用 scope → Task 3 ✅
- UI 选择器 + 每会话记忆 + 悬空回退全部 → Task 4 ✅
- 错误处理（PATCH {error}、PATCH 失败不挡聊天、悬空回退）→ Task 3/4 ✅
- 测试（迁移/scoped demo/端到端/浏览器）→ Task 1,2,5 ✅
- 不动解析/入库/知识库模块/chatTurn 签名 → 全程未涉及 ✅
