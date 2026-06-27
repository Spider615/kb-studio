# 秒懂推送（MiaodongAdapter 接真接口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把秒懂推送从 stub 换成真实接口——预览页点「确认推送秒懂」弹框填凭据，确认后 取 token → 建文档 → 顺序建段落，成功后本地标 pushed 并存远端引用。

**Architecture:** 推送编排放在 `@kb/adapters` 的 `RealMiaodongAdapter`（实现 `MiaodongAdapter`），凭据由 web 弹框逐次传入、`/api/confirm` 构造适配器调用。段落正文用上下文化 `content`，>1000 字符按句切分。秒懂是国内端点，适配器不走代理。

**Tech Stack:** TypeScript / Node fetch / Next.js 15 (App Router) / drizzle-orm (pg) / 仓库 tsx 运行、`node:test`（tsx --test）做纯函数 TDD。

> 规格出处：`docs/superpowers/specs/2026-06-27-miaodong-push-design.md`

---

## 文件结构

- `packages/core/src/interfaces.ts` —（改）新增 `MiaodongCredentials`；`MiaodongAdapter.push` 加凭据参数；`PushResult` 加远端引用字段。`index.ts` 已 `export * from "./interfaces"`，无需改导出。
- `packages/adapters/src/miaodong/split.ts` —（建）纯函数 `splitForParagraph`（按句切到 ≤1000 字符）。
- `packages/adapters/src/miaodong/split.test.ts` —（建）`splitForParagraph` 的 `node:test` 单测。
- `packages/adapters/src/miaodong/real.ts` —（建）`RealMiaodongAdapter`：getToken/createDoc/createParagraph/push。
- `packages/adapters/src/miaodong/stub.ts` —（改）push 签名同步加可选凭据参数。
- `packages/adapters/src/index.ts` —（改）导出 `RealMiaodongAdapter`。
- `packages/db/src/schema.ts` —（改）`docs` 表加 `miaodong_kb_id / miaodong_doc_id / miaodong_domain`；`packages/db/migrations/`（建）新迁移。
- `apps/web/app/api/confirm/route.ts` —（改）收凭据、调真实适配器、写远端引用。
- `apps/web/components/PushDialog.tsx` —（建）凭据弹框（非密项 localStorage 记忆）。
- `apps/web/components/DocDetail.tsx` —（改）按钮改为打开弹框、提交推送。
- `apps/web/app/globals.css` —（改）弹框样式。

---

## Task 1: 核心契约扩展

**Files:**
- Modify: `packages/core/src/interfaces.ts:35-49`
- Modify: `packages/adapters/src/miaodong/stub.ts`

- [ ] **Step 1: 改 `interfaces.ts` 的推送相关类型**

把 `interfaces.ts` 第 35-49 行（`PushPayload` / `PushResult` / `MiaodongAdapter`）整体替换为：

```ts
export interface MiaodongCredentials {
  domain: string; // 用户填，适配器内规范化成 https://<host>
  accessKeyId: string;
  accessKeySecret: string;
  knowledgeBaseId: string;
}

export interface PushPayload {
  docId: string;
  title: string;
  chunks: Chunk[];
}
export interface PushResult {
  ok: boolean;
  pushed: number; // 成功推送的段落数
  target: string; // "miaodong" | "stub"
  remoteDocId?: string; // 秒懂返回的文档 id
  knowledgeBaseId?: string;
  ref?: string; // 保留
}
/** 推送到秒懂的后端（默认实现：Stub；真实实现 RealMiaodongAdapter）。 */
export interface MiaodongAdapter {
  push(payload: PushPayload, creds: MiaodongCredentials): Promise<PushResult>;
}
```

- [ ] **Step 2: 改 stub 适配器签名**

把 `packages/adapters/src/miaodong/stub.ts` 整文件替换为：

```ts
import type { MiaodongAdapter, MiaodongCredentials, PushPayload, PushResult } from "@kb/core";

/** 秒懂推送占位实现：只打印、不真正推送（凭据参数忽略）。 */
export class StubMiaodongAdapter implements MiaodongAdapter {
  async push(payload: PushPayload, _creds?: MiaodongCredentials): Promise<PushResult> {
    console.warn(
      `[MiaodongAdapter:stub] 假装推送 doc=${payload.docId} title=${payload.title} chunks=${payload.chunks.length}`,
    );
    return { ok: true, pushed: payload.chunks.length, target: "stub" };
  }
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS（此时 `/api/confirm` 仍调 stub 的旧签名 `push({...})`——少传 creds 在 TS 里报错；若报错先不管，Task 5 会改路由。若想分步绿，可临时在 confirm 路由那行加 `as any`，Task 5 删除。）

> 说明：为避免本任务留下编译错误，本步骤 typecheck 仅校验 `packages/`。改 web 路由放在 Task 5，整体绿在 Task 8 验。可运行 `npx tsc -p packages/adapters/tsconfig.json --noEmit 2>/dev/null || npm run typecheck` 视情况。最稳妥：Task 1 与 Task 5 连续完成后再 commit + typecheck。

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/interfaces.ts packages/adapters/src/miaodong/stub.ts
git commit -m "feat(core): MiaodongAdapter.push 加凭据参数 + PushResult 远端引用字段"
```

---

## Task 2: `splitForParagraph` 纯函数（TDD）

**Files:**
- Create: `packages/adapters/src/miaodong/split.ts`
- Test: `packages/adapters/src/miaodong/split.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/adapters/src/miaodong/split.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForParagraph } from "./split";

test("短文本原样返回单段", () => {
  assert.deepEqual(splitForParagraph("你好世界"), ["你好世界"]);
});

test("空白返回空数组", () => {
  assert.deepEqual(splitForParagraph("   \n  "), []);
});

test("多句长文：每段 ≤1000 字符且保序拼回原文", () => {
  const long = "句子。".repeat(500); // 1500 字符（3*500），句界为「。」
  const parts = splitForParagraph(long, 1000);
  assert.ok(parts.length >= 2, "应切成多段");
  for (const p of parts) assert.ok(Array.from(p).length <= 1000);
  assert.equal(parts.join(""), long); // 无空白丢失，按序拼回
});

test("单句超长：硬切成定长块且拼回原文", () => {
  const s = "a".repeat(2500); // 无句界，整体一句
  const parts = splitForParagraph(s, 1000);
  assert.equal(parts.length, 3); // 1000+1000+500
  assert.ok(parts.every((p) => Array.from(p).length <= 1000));
  assert.equal(parts.join(""), s);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test packages/adapters/src/miaodong/split.test.ts`
Expected: FAIL（`Cannot find module './split'` 或 `splitForParagraph is not a function`）

- [ ] **Step 3: 写实现**

新建 `packages/adapters/src/miaodong/split.ts`：

```ts
/** 段落接口字数上限（秒懂：content ≤ 1000 字符）。 */
export const PARAGRAPH_MAX = 1000;

/** 按码点计字数（中文/emoji 更稳）。 */
function countChars(s: string): number {
  return Array.from(s).length;
}

/** 按句末标点切句，保留标点：中文。！？；、英文 .!? 、换行。 */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^。！？；\n.!?]*[。！？；\n.!?]+|[^。！？；\n.!?]+$/g);
  return parts ?? [text];
}

/** 把单个超长串按码点硬切成 ≤max 的块。 */
function hardSplit(s: string, max: number): string[] {
  const chars = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) {
    out.push(chars.slice(i, i + max).join(""));
  }
  return out;
}

/**
 * 把一段正文切成多个 ≤max 字符的段落文本：
 * 先按句切，贪心打包；单句仍超 max 则硬切。保序、不丢内容（首尾空白会 trim）。
 */
export function splitForParagraph(text: string, max = PARAGRAPH_MAX): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (countChars(trimmed) <= max) return [trimmed];

  const out: string[] = [];
  let buf = "";
  for (const s of splitSentences(trimmed)) {
    if (countChars(s) > max) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(...hardSplit(s, max));
      continue;
    }
    if (buf && countChars(buf) + countChars(s) > max) {
      out.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test packages/adapters/src/miaodong/split.test.ts`
Expected: PASS（4 测试全过）

> 注：第 3 个测试 `parts.join("")` 能拼回原文，是因为「句子。」之间无空白、末段以「。」结尾，`trim()` 不丢字符。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/miaodong/split.ts packages/adapters/src/miaodong/split.test.ts
git commit -m "feat(adapters): splitForParagraph 按句切到 ≤1000 字符（TDD）"
```

---

## Task 3: `RealMiaodongAdapter`

**Files:**
- Create: `packages/adapters/src/miaodong/real.ts`
- Modify: `packages/adapters/src/index.ts`

- [ ] **Step 1: 写适配器**

新建 `packages/adapters/src/miaodong/real.ts`：

```ts
import type {
  Chunk,
  MiaodongAdapter,
  MiaodongCredentials,
  PushPayload,
  PushResult,
} from "@kb/core";
import { splitForParagraph } from "./split";

/** 规范化用户填的域名为 https://<host>：去协议前缀和结尾斜杠。 */
function normalizeBase(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `https://${d}`;
}

/** POST JSON；非 2xx 抛 HTTP 错，响应非 JSON 也抛。 */
async function postJson(url: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * 秒懂推送真实实现：取 token → 建文档 → 顺序建段落。
 * 国内端点（insight.juzibot.com），不调 installProxyFromEnv（代理只给 302 海外端点）。
 */
export class RealMiaodongAdapter implements MiaodongAdapter {
  async push(payload: PushPayload, creds: MiaodongCredentials): Promise<PushResult> {
    const base = normalizeBase(creds.domain);

    // 1) 取 token
    let json: any;
    try {
      json = await postJson(`${base}/openapi/get-access-token`, {
        accessKeyId: creds.accessKeyId,
        accessKeySecret: creds.accessKeySecret,
      });
    } catch (e: any) {
      throw new Error(`秒懂取 token 失败: ${e?.message ?? e}`);
    }
    const token = json?.data?.accessToken;
    if (!token) {
      throw new Error(`秒懂取 token 失败: 响应无 accessToken（${JSON.stringify(json?.data ?? json)}）`);
    }

    // 2) 建文档（不传 metadata）
    try {
      json = await postJson(
        `${base}/openapi/knowledge-base/doc/create`,
        { knowledgeBaseId: creds.knowledgeBaseId, name: payload.title },
        token,
      );
    } catch (e: any) {
      throw new Error(`秒懂建文档失败: ${e?.message ?? e}`);
    }
    const remoteDocId = json?.data?.id;
    if (remoteDocId === undefined || remoteDocId === null) {
      throw new Error(`秒懂建文档失败: 响应无 docId（${JSON.stringify(json?.data ?? json)}）`);
    }

    // 3) 段落：上下文化 content，>1000 字符按句切分，顺序推送（保序）
    const paragraphs = payload.chunks.flatMap((c: Chunk) => splitForParagraph(c.content));
    let pushed = 0;
    for (const content of paragraphs) {
      try {
        await postJson(
          `${base}/openapi/knowledge-base/doc/paragraph/create`,
          { knowledgeBaseId: creds.knowledgeBaseId, docId: remoteDocId, content },
          token,
        );
      } catch (e: any) {
        throw new Error(
          `秒懂建段落失败（已成功 ${pushed}/${paragraphs.length}）: ${e?.message ?? e}`,
        );
      }
      pushed++;
    }

    return {
      ok: true,
      pushed,
      target: "miaodong",
      remoteDocId: String(remoteDocId),
      knowledgeBaseId: creds.knowledgeBaseId,
    };
  }
}
```

- [ ] **Step 2: 导出适配器**

在 `packages/adapters/src/index.ts` 中 `StubMiaodongAdapter` 那行下面加：

```ts
export { StubMiaodongAdapter } from "./miaodong/stub";
export { RealMiaodongAdapter } from "./miaodong/real";
```

（第一行已存在；只新增第二行。）

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS（adapters 编译通过；web 路由的不一致留待 Task 5）

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/src/miaodong/real.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): RealMiaodongAdapter 取token→建文档→顺序建段落"
```

---

## Task 4: DB 加远端引用列 + 迁移

**Files:**
- Modify: `packages/db/src/schema.ts:38-52`
- Create: `packages/db/migrations/000X_*.sql`（drizzle 生成）

- [ ] **Step 1: 确保数据库已起**

Run: `npm run db:up`
Expected: pgvector/pg16 容器 running（已起则提示 up-to-date）。

- [ ] **Step 2: 给 `docs` 表加三列**

在 `packages/db/src/schema.ts` 的 `docs` 表定义里、`pushedAt` 那行之后加：

```ts
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  miaodongKbId: text("miaodong_kb_id"),
  miaodongDocId: text("miaodong_doc_id"),
  miaodongDomain: text("miaodong_domain"),
});
```

（`pushedAt` 行原本就有，这里在其后追加三列、保留收尾的 `});`。）

- [ ] **Step 3: 生成迁移**

Run: `npm run db:generate`
Expected: 在 `packages/db/migrations/` 生成新 `000X_*.sql`，内容形如 `ALTER TABLE "docs" ADD COLUMN "miaodong_kb_id" text;`（三列）。

- [ ] **Step 4: 应用迁移**

Run: `npm run db:migrate`
Expected: 迁移成功、无报错。可验证：`docker compose exec -T db psql -U kb -d kbstudio -c "\d docs"` 能看到三个新列。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): docs 加 miaodong_kb_id/doc_id/domain（推送远端引用）"
```

---

## Task 5: 改 `/api/confirm` 调真实适配器

**Files:**
- Modify: `apps/web/app/api/confirm/route.ts`

- [ ] **Step 1: 重写路由**

把 `apps/web/app/api/confirm/route.ts` 整文件替换为：

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema, getDocWithChunks } from "@kb/db";
import { RealMiaodongAdapter } from "@kb/adapters";
import type { Chunk, MiaodongCredentials } from "@kb/core";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const docId: string | undefined = body?.docId;
    const creds: Partial<MiaodongCredentials> = body?.credentials ?? {};
    if (!docId) return NextResponse.json({ error: "缺少 docId" }, { status: 400 });

    const { domain, accessKeyId, accessKeySecret, knowledgeBaseId } = creds;
    if (!domain || !accessKeyId || !accessKeySecret || !knowledgeBaseId) {
      return NextResponse.json(
        { error: "缺少凭据（域名 / accessKeyId / accessKeySecret / knowledgeBaseId）" },
        { status: 400 },
      );
    }

    const data = await getDocWithChunks(docId);
    if (!data) return NextResponse.json({ error: "文档不存在" }, { status: 404 });

    const adapter = new RealMiaodongAdapter();
    const res = await adapter.push(
      { docId, title: data.doc.title, chunks: data.chunks as unknown as Chunk[] },
      { domain, accessKeyId, accessKeySecret, knowledgeBaseId },
    );

    await db
      .update(schema.docs)
      .set({
        status: "pushed",
        confirmedAt: new Date(),
        pushedAt: new Date(),
        miaodongKbId: knowledgeBaseId,
        miaodongDocId: res.remoteDocId ?? null,
        miaodongDomain: domain,
      })
      .where(eq(schema.docs.id, docId));

    return NextResponse.json({ ok: true, pushed: res.pushed, remoteDocId: res.remoteDocId });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: typecheck（含 web）**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web`
Expected: 两个都 PASS（root typecheck 不覆盖 web，必须单独跑 web）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/confirm/route.ts
git commit -m "feat(web): /api/confirm 调真实秒懂适配器 + 写远端引用"
```

---

## Task 6: 凭据弹框 `PushDialog`

**Files:**
- Create: `apps/web/components/PushDialog.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: 写弹框组件**

新建 `apps/web/components/PushDialog.tsx`：

```tsx
"use client";
import { useEffect, useState } from "react";

/** 非密三项记忆在 localStorage 这个 key 下（secret 不存）。 */
export const LS_KEY = "kb.miaodong.creds";

export type MiaodongCreds = {
  domain: string;
  accessKeyId: string;
  accessKeySecret: string;
  knowledgeBaseId: string;
};

export default function PushDialog({
  open,
  onClose,
  onSubmit,
  pushing,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (creds: MiaodongCreds) => void;
  pushing: boolean;
  error: string;
}) {
  const [domain, setDomain] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");

  // 打开时预填非密三项；secret 始终留空
  useEffect(() => {
    if (!open) return;
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      setDomain(saved.domain || "");
      setAccessKeyId(saved.accessKeyId || "");
      setKnowledgeBaseId(saved.knowledgeBaseId || "");
    } catch {}
    setAccessKeySecret("");
  }, [open]);

  if (!open) return null;

  const canSubmit = Boolean(domain && accessKeyId && accessKeySecret && knowledgeBaseId) && !pushing;

  return (
    <div className="overlay" onClick={pushing ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>推送到秒懂</h3>
        <label className="field">
          <span>域名</span>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="insight.juzibot.com" />
        </label>
        <label className="field">
          <span>accessKeyId</span>
          <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
        </label>
        <label className="field">
          <span>accessKeySecret</span>
          <input type="password" value={accessKeySecret} onChange={(e) => setAccessKeySecret(e.target.value)} />
        </label>
        <label className="field">
          <span>knowledgeBaseId</span>
          <input value={knowledgeBaseId} onChange={(e) => setKnowledgeBaseId(e.target.value)} />
        </label>
        {error && <p className="err">⚠ {error}</p>}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button className="ghost" onClick={onClose} disabled={pushing}>
            取消
          </button>
          <button
            onClick={() => canSubmit && onSubmit({ domain, accessKeyId, accessKeySecret, knowledgeBaseId })}
            disabled={!canSubmit}
          >
            {pushing ? "推送中…" : "确认推送"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 加弹框样式**

在 `apps/web/app/globals.css` 末尾追加：

```css
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: #fff; border-radius: 12px; padding: 22px 24px; width: 420px; max-width: calc(100vw - 32px); box-shadow: 0 12px 40px rgba(0,0,0,.18); }
.modal h3 { margin: 0 0 14px; font-size: 16px; color: #111827; }
.modal .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.modal .field span { font-size: 12px; color: #6b7280; }
.modal .field input { padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
button.ghost { background: #f3f4f6; color: #374151; }
```

- [ ] **Step 3: typecheck（web）**

Run: `npm run typecheck --workspace @kb/web`
Expected: PASS（`DocDetail` 还没引用它也不影响——组件自身类型正确）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/PushDialog.tsx apps/web/app/globals.css
git commit -m "feat(web): 秒懂推送凭据弹框 PushDialog（非密项 localStorage 记忆）"
```

---

## Task 7: `DocDetail` 接入弹框

**Files:**
- Modify: `apps/web/components/DocDetail.tsx`

- [ ] **Step 1: 顶部 import + 状态**

在 `DocDetail.tsx` 第 2 行 `import { useEffect, useState } from "react";` 下面加：

```ts
import PushDialog, { LS_KEY, type MiaodongCreds } from "./PushDialog";
```

在组件内 `const [pushing, setPushing] = useState(false);` 那行下面加两个状态：

```ts
  const [showDialog, setShowDialog] = useState(false);
  const [pushErr, setPushErr] = useState("");
```

- [ ] **Step 2: 用 doPush 替换旧 push 函数**

把现有的整个 `async function push() { ... }`（含函数体）替换为：

```ts
  async function doPush(creds: MiaodongCreds) {
    if (!docId || pushing) return;
    setPushing(true);
    setPushErr("");
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId, credentials: creds }),
      });
      const json = await res.json();
      if (json.ok) {
        // 记非密三项，secret 不存
        try {
          localStorage.setItem(
            LS_KEY,
            JSON.stringify({
              domain: creds.domain,
              accessKeyId: creds.accessKeyId,
              knowledgeBaseId: creds.knowledgeBaseId,
            }),
          );
        } catch {}
        setPushed(true);
        setShowDialog(false);
      } else {
        setPushErr(json.error ?? "推送失败");
      }
    } catch (e: any) {
      setPushErr(String(e?.message ?? e));
    }
    setPushing(false);
  }
```

- [ ] **Step 3: 按钮改为打开弹框 + 渲染弹框**

把这一行：

```tsx
          {pushed ? <span className="ok">✅ 已推送</span> : <button onClick={push} disabled={pushing}>确认推送秒懂</button>}
```

改为：

```tsx
          {pushed ? <span className="ok">✅ 已推送</span> : <button onClick={() => setShowDialog(true)}>确认推送秒懂</button>}
```

并在最外层 `</section>` 之前（紧跟 chunks 列表那个 `)}` 之后）加上弹框渲染：

```tsx
      <PushDialog
        open={showDialog}
        onClose={() => {
          if (!pushing) {
            setShowDialog(false);
            setPushErr("");
          }
        }}
        onSubmit={doPush}
        pushing={pushing}
        error={pushErr}
      />
```

- [ ] **Step 4: typecheck（web）**

Run: `npm run typecheck --workspace @kb/web`
Expected: PASS（无未用变量 `push`/`pushErr` 报错——已全部接上）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/DocDetail.tsx
git commit -m "feat(web): DocDetail 接入秒懂推送弹框"
```

---

## Task 8: 全量校验 + 手动验收

**Files:** 无（仅校验）

- [ ] **Step 1: 全量 typecheck + split 单测**

Run: `npm run typecheck && npm run typecheck --workspace @kb/web && npx tsx --test packages/adapters/src/miaodong/split.test.ts`
Expected: 三者全 PASS。

- [ ] **Step 2: 起 web 手动验收**

Run: `npm run dev --workspace @kb/web`（http://localhost:3001）

手动核对：
1. 上传一篇文档 → 进预览 → 点「确认推送秒懂」→ 弹框出现，四个输入框。
2. 填真实 域名/accessKeyId/accessKeySecret/knowledgeBaseId → 点「确认推送」→ 按钮变「推送中…」→ 成功后弹框关闭、显示「✅ 已推送」。
3. 去秒懂后台确认该知识库出现同名文档及段落。
4. 刷新页面、重新选中该 doc，仍显示「✅ 已推送」（库里 status=pushed、`miaodong_*` 三列已写）。可验证：`docker compose exec -T db psql -U kb -d kbstudio -c "select id,status,miaodong_kb_id,miaodong_doc_id,miaodong_domain from docs where status='pushed';"`。
5. 再次打开弹框：域名/accessKeyId/knowledgeBaseId 已预填，accessKeySecret 为空。
6. 故意填错 secret 推送 → 弹框显示错误文案（`秒懂取 token 失败: HTTP ...`），doc 不被标 pushed。

- [ ] **Step 3: 更新 CLAUDE.md 里程碑**

把 `CLAUDE.md` 里程碑 ⑥ 那行：

```
- [ ] ⑥ 秒懂 MiaodongAdapter 接真接口（替换 stub）
```

改为：

```
- [x] ⑥ **秒懂 MiaodongAdapter 接真接口 ✅**：web 点「确认推送秒懂」弹框填 域名/accessKeyId/accessKeySecret/knowledgeBaseId → `RealMiaodongAdapter` 取token→建文档→顺序建段落（上下文化 content，>1000 字符按句切分）；成功后 docs 标 pushed + 存远端引用（miaodong_kb_id/doc_id/domain）。非密凭据 localStorage 记忆。国内端点不走代理。
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): 里程碑⑥ 秒懂推送接真接口完成"
```

---

## Self-Review 记录

- **Spec 覆盖**：契约(Task1)、段落切分(Task2)、适配器三接口(Task3)、远端引用列(Task4)、路由凭据+写库(Task5)、弹框+非密记忆(Task6)、按钮接弹框(Task7)、typecheck+手动验收+里程碑(Task8) —— 规格各节均有对应任务。
- **凭据不记 secret**：Task6 useEffect 不读取/不回填 secret；Task7 localStorage 只写三项 —— 与规格一致。
- **不写秒懂 metadata**：Task3 createDoc 仅传 `{knowledgeBaseId, name}` —— 与规格修订一致。
- **类型一致**：`MiaodongCredentials`/`MiaodongCreds` 字段四项处处一致；`splitForParagraph` 签名 Task2 定义、Task3 调用一致；`PushResult.remoteDocId` Task1 定义、Task3 返回、Task5 写库一致；`LS_KEY`/`MiaodongCreds` 由 PushDialog 导出、DocDetail 导入。
- **占位符**：无 TBD/TODO；每个改代码的步骤都给了完整代码。
- **已知取舍**：失败不标 pushed、重试会建重复秒懂文档（规格「容错」已列，本期不做幂等）。
