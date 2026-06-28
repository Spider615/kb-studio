# 上传时选择分组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在上传文档时弹框选择目标分组（可选，默认未分组，支持就地新建分组），文档建行那一刻即写入 `group_id`。

**Architecture:** 选完文件不立即上传，先弹 `UploadDialog` 选分组 → 带 `groupId` POST `/api/upload`。后端校验分组归属当前用户后透传给 `createProcessingDoc`。后台异步处理流程完全不变。

**Tech Stack:** Next.js 15（apps/web，React client component）、Drizzle + Postgres（packages/db）、node:test 集成测试（`npx tsx --test`，需 DB up）。

参考 spec：`docs/superpowers/specs/2026-06-28-upload-group-select-design.md`

---

## 文件结构

- `packages/db/src/repo.ts`（修改）：`createProcessingDoc` 加 `groupId` 参数；新增 `groupBelongsToUser`。
- `packages/db/src/groups-upload.integration.test.ts`（新建）：DB 层 TDD 测试。
- `apps/web/app/api/upload/route.ts`（修改）：读取 + 校验 `groupId`，透传。
- `apps/web/app/page.tsx`（修改）：`createGroup` 返回新建 `GroupItem`。
- `apps/web/components/DocList.tsx`（修改）：上传拆成「选文件 → 弹框 → 确认」，渲染 `UploadDialog`；`onCreateGroup` 类型改 `Promise<GroupItem>`。
- `apps/web/components/UploadDialog.tsx`（新建）：选目标分组 + 内联建组 + 确认上传。
- `apps/web/app/globals.css`（修改）：补 `.modal .field select` 样式。

---

## Task 1: DB 层 — `groupBelongsToUser` + `createProcessingDoc` 加 `groupId`

**Files:**
- Modify: `packages/db/src/repo.ts`（`createProcessingDoc` 在 184-200；`setDocGroup` 模板在 ~313-326）
- Test: `packages/db/src/groups-upload.integration.test.ts`（新建）

> 集成测试需起着的 pg。先 `npm run db:up`，并确保 `DATABASE_URL` 指向它（见 `.env`）。

- [ ] **Step 1: 写失败测试**

Create `packages/db/src/groups-upload.integration.test.ts`:

```ts
// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。会自建并清理测试数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, groups, users } from "./schema";
import { eq } from "drizzle-orm";
import { createUser, createGroup, createProcessingDoc, groupBelongsToUser } from "./repo";

const createdUsers: string[] = [];
async function makeUser() {
  const id = "usr_test_" + randomUUID().slice(0, 8);
  await createUser({ id, email: id + "@test.local", passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return id;
}

after(async () => {
  // 删用户即可：docs/groups 经外键 cascade/set null，测试数据用完清掉
  for (const id of createdUsers) {
    await db.delete(docs).where(eq(docs.userId, id));
    await db.delete(groups).where(eq(groups.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await pg.end();
});

test("createProcessingDoc 写入 groupId", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组", color: null, userId });
  const docId = "doc_test_" + randomUUID().slice(0, 8);
  await createProcessingDoc(docId, "f.pdf", "f.pdf", null, userId, gid);
  const row = await db.select({ groupId: docs.groupId }).from(docs).where(eq(docs.id, docId));
  assert.equal(row[0]?.groupId, gid);
});

test("createProcessingDoc 不传 groupId 默认 null", async () => {
  const userId = await makeUser();
  const docId = "doc_test_" + randomUUID().slice(0, 8);
  await createProcessingDoc(docId, "f.pdf", "f.pdf", null, userId);
  const row = await db.select({ groupId: docs.groupId }).from(docs).where(eq(docs.id, docId));
  assert.equal(row[0]?.groupId, null);
});

test("groupBelongsToUser：本人组 true，他人组 false，不存在 false", async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "u1 的组", color: null, userId: u1 });
  assert.equal(await groupBelongsToUser(gid, u1), true);
  assert.equal(await groupBelongsToUser(gid, u2), false);
  assert.equal(await groupBelongsToUser("grp_nope_xyz", u1), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test packages/db/src/groups-upload.integration.test.ts`
Expected: FAIL — `groupBelongsToUser` 未导出 / `createProcessingDoc` 第 6 个参数类型不存在（TS 报错或断言失败）。

- [ ] **Step 3: 改 `createProcessingDoc` 加 `groupId` 参数**

In `packages/db/src/repo.ts`, replace the function (currently 184-200):

```ts
export async function createProcessingDoc(
  id: string,
  title: string,
  source: string,
  fileId: string | null,
  userId: string,
  groupId: string | null = null,
): Promise<void> {
  await db.insert(docs).values({
    id,
    title,
    source,
    fileId: fileId ?? null,
    userId,
    groupId,
    status: "processing",
    progress: { stage: "parsing", done: 0, total: 0 },
  });
}
```

- [ ] **Step 4: 新增 `groupBelongsToUser`**

In `packages/db/src/repo.ts`, add right after `setDocGroup` (after ~line 326), mirroring its EXISTS 思路：

```ts
/** 该分组是否属于此用户（上传时校验，防把文档挂到别人的分组）。 */
export async function groupBelongsToUser(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.userId, userId)));
  return rows.length > 0;
}
```

> `and`/`eq`/`groups` 已在该文件顶部导入（`setDocGroup`/`deleteGroup` 已在用），无需新增 import。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test packages/db/src/groups-upload.integration.test.ts`
Expected: PASS（3 个 test 全过）。

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 无报错（root tsconfig 覆盖 packages/*）。

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repo.ts packages/db/src/groups-upload.integration.test.ts
git commit -m "feat(db): createProcessingDoc 支持 groupId + groupBelongsToUser 校验"
```

---

## Task 2: 上传接口读取并校验 `groupId`

**Files:**
- Modify: `apps/web/app/api/upload/route.ts`（form 读取在 17-23，建行在 34）

- [ ] **Step 1: 改 import，引入 `groupBelongsToUser`**

In `apps/web/app/api/upload/route.ts` line 4, 把：

```ts
import { createProcessingDoc, setDocProgress, failDoc, clearDocProgress, getDocStatus } from "@kb/db";
```

改为：

```ts
import { createProcessingDoc, setDocProgress, failDoc, clearDocProgress, getDocStatus, groupBelongsToUser } from "@kb/db";
```

- [ ] **Step 2: 读取 + 校验 groupId，透传给 createProcessingDoc**

In the same file, 把 21-34 段（从读 filename 到 `createProcessingDoc(...)`）：

```ts
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = (typeof file.name === "string" && file.name) || "upload.bin";

    const docId = "doc_" + randomUUID().slice(0, 8);
    // 落盘原文件（供预览）；失败不致命，仅预览不可用
    let fileId: string | null = null;
    try {
      fileId = await saveOriginal(docId, filename, bytes);
    } catch (e: any) {
      console.error("[upload] 存原文件失败:", e?.message ?? e);
    }
    // 先建处理中文档行，立即返回 docId；真正处理在后台异步跑（前端轮询进度）
    await createProcessingDoc(docId, filename, filename, fileId, auth.userId);
```

替换为（新增 groupId 解析与校验，插在建 docId 之前；建行带 groupId）：

```ts
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = (typeof file.name === "string" && file.name) || "upload.bin";

    // 目标分组：空 → 未分组(null)；非空必须属于当前用户
    const rawGroupId = form.get("groupId");
    const groupId = typeof rawGroupId === "string" && rawGroupId.trim() ? rawGroupId.trim() : null;
    if (groupId && !(await groupBelongsToUser(groupId, auth.userId)))
      return NextResponse.json({ error: "分组不存在" }, { status: 400 });

    const docId = "doc_" + randomUUID().slice(0, 8);
    // 落盘原文件（供预览）；失败不致命，仅预览不可用
    let fileId: string | null = null;
    try {
      fileId = await saveOriginal(docId, filename, bytes);
    } catch (e: any) {
      console.error("[upload] 存原文件失败:", e?.message ?? e);
    }
    // 先建处理中文档行，立即返回 docId；真正处理在后台异步跑（前端轮询进度）
    await createProcessingDoc(docId, filename, filename, fileId, auth.userId, groupId);
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/upload/route.ts
git commit -m "feat(upload): /api/upload 读取并校验 groupId 透传建行"
```

---

## Task 3: `page.tsx` 的 `createGroup` 返回新建 `GroupItem`

**Files:**
- Modify: `apps/web/app/page.tsx`（`createGroup` 在 94-105）

- [ ] **Step 1: 改 `createGroup` 接住并返回 group**

In `apps/web/app/page.tsx`, 把 94-105 的 `createGroup`：

```ts
  const createGroup = useCallback(
    async (name: string, color: string | null) => {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "建组失败");
      await load();
    },
    [load],
  );
```

替换为：

```ts
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

> `GroupItem` 已在文件顶部 `import { type DocItem, type GroupItem } from "../components/DocList"`（line 4），无需新增。`/api/groups` 的 POST 已返回 `{ group: { id, name, color, sortOrder, docCount } }`，结构即 `GroupItem`。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 这一步可能报 `DocList` 的 `onCreateGroup` prop 类型不匹配（Task 4 会改 DocList prop 类型）。若仅此一处报错属预期；若想单独验证本任务，可暂记，Task 5 typecheck 时整体绿。

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/page.tsx
git commit -m "feat(web): createGroup 返回新建分组供上传弹框选中"
```

---

## Task 4: 新建 `UploadDialog` 组件 + select 样式

**Files:**
- Create: `apps/web/components/UploadDialog.tsx`
- Modify: `apps/web/app/globals.css`（在 `.modal .field input`（147-148）之后加 select 规则）

- [ ] **Step 1: 写 `UploadDialog.tsx`**

Create `apps/web/components/UploadDialog.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { GROUP_COLORS } from "./GroupDialog";
import type { GroupItem } from "./DocList";

const UNGROUPED = ""; // select 的 value：空串 = 未分组

/** 上传文档弹框：选目标分组（可选，默认未分组）+ 内联新建分组 + 确认上传。 */
export default function UploadDialog({
  open,
  fileName,
  groups,
  onClose,
  onConfirm,
  onCreateGroup,
}: {
  open: boolean;
  fileName: string;
  groups: GroupItem[];
  onClose: () => void;
  onConfirm: (groupId: string | null) => Promise<void>;
  onCreateGroup: (name: string, color: string | null) => Promise<GroupItem>;
}) {
  const [targetId, setTargetId] = useState<string>(UNGROUPED);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string | null>(GROUP_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setTargetId(UNGROUPED);
    setCreating(false);
    setNewName("");
    setNewColor(GROUP_COLORS[0]);
    setBusy(false);
    setErr("");
  }, [open]);

  if (!open) return null;

  async function createInline() {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const g = await onCreateGroup(newName.trim(), newColor);
      setTargetId(g.id); // 新组立即成为目标
      setCreating(false);
      setNewName("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await onConfirm(targetId === UNGROUPED ? null : targetId);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false); // 失败留在框内重试
    }
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>上传文档</h3>
        <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>文件：{fileName}</p>

        <label className="field">
          <span>归入分组</span>
          <select value={targetId} disabled={busy || creating} onChange={(e) => setTargetId(e.target.value)}>
            <option value={UNGROUPED}>未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>

        {!creating ? (
          <button
            type="button"
            className="btn ghost"
            style={{ alignSelf: "flex-start", marginBottom: 4 }}
            disabled={busy}
            onClick={() => setCreating(true)}
          >
            ＋ 新建分组
          </button>
        ) : (
          <div className="field">
            <span>新分组名</span>
            <input
              value={newName}
              autoFocus
              placeholder="如：产品手册"
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createInline()}
            />
            <div className="color-pick" style={{ marginTop: 8 }}>
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === newColor ? "swatch on" : "swatch"}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                  aria-label={`选择颜色 ${c}`}
                />
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => { setCreating(false); setNewName(""); }}>
                取消新建
              </button>
              <button type="button" className="btn primary" disabled={!newName.trim() || busy} onClick={createInline}>
                {busy ? "建组中…" : "建组并选中"}
              </button>
            </div>
          </div>
        )}

        {err && <p className="err">⚠ {err}</p>}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={confirm} disabled={busy || creating}>
            {busy ? "上传中…" : "开始上传"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 加 select 样式**

In `apps/web/app/globals.css`, 在 `.modal .field input{...}` 规则（147-148 行）之后新增一行：

```css
.modal .field select{padding:9px 12px;border:1px solid var(--border-strong);border-radius:9px;font-size:14px;
                     font-family:inherit;color:var(--text);background:var(--surface);cursor:pointer;}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 仍可能因 DocList 的 `onCreateGroup` 类型在 Task 5 才对齐而有 1 处报错（DocList 现有 prop 类型为 `Promise<void>`）。`UploadDialog` 自身应无报错。Task 5 完成后整体绿。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/UploadDialog.tsx apps/web/app/globals.css
git commit -m "feat(web): UploadDialog 组件（选分组+内联建组）+ modal select 样式"
```

---

## Task 5: `DocList` 接线 — 选文件 → 弹框 → 确认上传

**Files:**
- Modify: `apps/web/components/DocList.tsx`（`upload()` 在 108-127；file input/CTA 在 254-257；`onCreateGroup` prop 类型在 73；末尾渲染区 252-359）

- [ ] **Step 1: import UploadDialog**

In `apps/web/components/DocList.tsx`, 在 `import GroupDialog from "./GroupDialog";`（line 4）后加：

```tsx
import UploadDialog from "./UploadDialog";
```

- [ ] **Step 2: `onCreateGroup` prop 类型改为返回 GroupItem**

把 props 里（line 73）：

```tsx
  onCreateGroup: (name: string, color: string | null) => Promise<void>;
```

改为：

```tsx
  onCreateGroup: (name: string, color: string | null) => Promise<GroupItem>;
```

> `GroupDialog` 经 `onSubmit={async (name, color) => { ... await onCreateGroup(name, color); }}`（341-344）调用，包装器只 `await` 不读返回值，类型仍兼容，无需改 `GroupDialog`。

- [ ] **Step 3: 把 `busy` 上传态换成 `pendingFile`，拆分 upload**

把状态声明（line 78）：

```tsx
  const [busy, setBusy] = useState(false);
```

改为：

```tsx
  const [pendingFile, setPendingFile] = useState<File | null>(null);
```

然后把整个 `upload()` 函数（108-127）：

```tsx
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
        await onUploaded(json.docId);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }
```

替换为（选完文件先开弹框；确认时才带 groupId 上传）：

```tsx
  function onFilePicked() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setErr("");
    setPendingFile(f);
    if (fileRef.current) fileRef.current.value = ""; // 清空，便于再次选同名文件
  }

  async function confirmUpload(groupId: string | null) {
    const f = pendingFile;
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    if (groupId) fd.append("groupId", groupId);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const json = await res.json();
    if (json.error) throw new Error(json.error); // 抛给弹框显示，保持打开
    setPendingFile(null);
    await onUploaded(json.docId);
  }
```

- [ ] **Step 4: 改 file input 与 CTA 按钮**

把 254-257：

```tsx
      <input type="file" ref={fileRef} hidden onChange={upload} />
      <button type="button" className="cta" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? "上传中…" : "↑ 上传文档"}
      </button>
```

替换为：

```tsx
      <input type="file" ref={fileRef} hidden onChange={onFilePicked} />
      <button type="button" className="cta" onClick={() => fileRef.current?.click()} disabled={!!pendingFile}>
        ↑ 上传文档
      </button>
```

- [ ] **Step 5: 渲染 UploadDialog**

在 return 内、`<GroupDialog ... />`（335-345）之前插入：

```tsx
      <UploadDialog
        open={!!pendingFile}
        fileName={pendingFile?.name ?? ""}
        groups={groups}
        onClose={() => setPendingFile(null)}
        onConfirm={confirmUpload}
        onCreateGroup={onCreateGroup}
      />
```

- [ ] **Step 6: typecheck（整体）**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无报错（Task 3/4/5 类型此时全部对齐）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/DocList.tsx
git commit -m "feat(web): 上传改为选文件→弹框选分组→确认上传"
```

---

## Task 6: 整体验证（typecheck + 手动走查）

**Files:** 无（仅验证）

- [ ] **Step 1: 全量 typecheck**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web`
Expected: 两条都无报错。

- [ ] **Step 2: 起 web 手动走查**

Run: `npm run dev --workspace @kb/web`（http://localhost:3001，需先 `npm run db:up`）

逐项确认：
1. 点「↑ 上传文档」选一个文件 → 弹出 UploadDialog，默认「未分组」。
2. 选一个已有分组 → 点「开始上传」→ 文档出现在该分组段、状态走解析进度。
3. 再传一个，点「＋ 新建分组」→ 填名+选色→「建组并选中」→ 下拉变为新组→「开始上传」→ 新组出现且文档在内。
4. 选文件后点「取消」→ 不产生文档、CTA 恢复可点。
5. （可选）直接对 `/api/upload` 传一个不属于自己的 `groupId` → 返回 400「分组不存在」。

- [ ] **Step 3: 终态 Commit（如有手动走查中的小修）**

```bash
git add -A
git commit -m "chore: 上传选分组 手动走查微调" || echo "无改动可提交"
```

---

## Self-Review 记录

- **Spec 覆盖**：弹框选分组(Task 5)、默认未分组(UploadDialog 默认 `UNGROUPED`)、内联新建分组(Task 4 + Task 3 返回 GroupItem)、带 groupId 上传(Task 5 confirmUpload)、服务端校验归属(Task 2 + Task 1 `groupBelongsToUser`)、`createProcessingDoc` 写入(Task 1)、单文件不变 / 后台流程不变（route.ts 仅建行处改动）。均有对应任务。
- **类型一致**：`createProcessingDoc(... groupId: string | null = null)`、`groupBelongsToUser(id, userId): Promise<boolean>`、`createGroup(): Promise<GroupItem>`、`onCreateGroup: => Promise<GroupItem>`、`onConfirm/confirmUpload(groupId: string | null)` 全链一致。
- **无 placeholder**：每步含完整代码与可执行命令。
- **边界**：分组删除经外键 `set null`（spec 已述，无需代码）；上传失败抛回弹框保持打开（confirmUpload throw → UploadDialog catch）。
