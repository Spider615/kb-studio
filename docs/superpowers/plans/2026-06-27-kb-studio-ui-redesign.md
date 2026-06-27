# kb-studio Web UI 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web` 前端从冷灰后台风重做成 Claude 暖色风（单一暖色侧栏 + 黏土橙强调 + 衬线标题），功能/API/数据流不变。

**Architecture:** 纯前端表现层重构。`globals.css` 整体重写为一套浅色 CSS 变量 + 组件类（不引 Tailwind/组件库，零新依赖）。新增共享 `Sidebar` 外壳（品牌 + `知识库/对话` 分段切换 + 主操作 CTA + 列表区 + 设置入口），两个路由各自把列表组件作为 `children` 塞进 Sidebar；旧的深藏青 `Nav` 退役。各内容组件（DocList / ConversationList / DocDetail / ChatThread / PushDialog）改用新类名并做轻度 UX 优化（上传改单按钮触发隐藏 input、状态圆点、空状态衬线文案）。

**Tech Stack:** Next.js 15（App Router, client components）、React 19、纯 CSS。无测试框架——每个任务用 `npm run typecheck --workspace @kb/web` 守护类型，最后一个任务跑 dev server 截图做视觉验收。

**Spec:** `docs/superpowers/specs/2026-06-27-kb-studio-ui-redesign-design.md`（视觉以 `assets/2026-06-27-ui-redesign-mockup.html` 为准）。

**Branch:** 已在 `ui-redesign-claude`（spec 已提交于此分支）。

**关于中间态：** 这是整体换皮，单个小提交之间视觉可能短暂不一致（如 CSS 已换、某组件还没换类名）。每个任务保证 **typecheck 通过**；**视觉一致性由 Task 10 统一验收**。

---

### Task 1: 重写 globals.css —— 新设计系统

**Files:**
- Modify (整体替换): `apps/web/app/globals.css`

- [ ] **Step 1: 用下面的完整内容替换 `apps/web/app/globals.css`**

```css
:root{
  --bg:#FAF9F5;          /* 工作区主底 暖奶白 */
  --sidebar:#F0EEE6;     /* 侧栏底 暖米色 */
  --surface:#FFFFFF;     /* 卡片/输入/模态 */
  --surface-2:#FBFAF6;   /* 次级抬升底 */
  --border:#E8E4DA;      /* 暖发丝线 */
  --border-strong:#DCD7C9;
  --text:#28261F;        /* 暖近黑 */
  --text-2:#6F6B5E;      /* 次级 */
  --text-3:#9B9686;      /* 弱化/占位 */
  --accent:#C96442;      /* 黏土橙 */
  --accent-hover:#B4573A;
  --accent-soft:#F4E8E1;
  --accent-text:#9A4A2E;
  --ok-bg:#EAF1E6; --ok-text:#506B46;
  --warn-bg:#FBF0E2; --warn-text:#956428;
  --err:#B5483A;
  --font-sans:-apple-system,"PingFang SC","Segoe UI",system-ui,sans-serif;
  --font-serif:Georgia,"Songti SC","Times New Roman",serif;
  --radius:12px;
}
*{box-sizing:border-box;}
html,body{height:100%;}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans);
     font-size:14px;-webkit-font-smoothing:antialiased;}

/* ===== 外壳：侧栏 + 工作区 ===== */
.app{display:flex;height:100vh;}
.side{width:264px;flex-shrink:0;background:var(--sidebar);border-right:1px solid var(--border);
      display:flex;flex-direction:column;padding:16px 12px;}
.brand{font-family:var(--font-serif);font-size:19px;font-weight:600;color:var(--text);
       padding:6px 8px 14px;display:flex;align-items:center;gap:8px;}
.brand .mark{color:var(--accent);}
.seg{display:flex;background:#E6E2D6;border-radius:10px;padding:3px;gap:3px;margin-bottom:14px;}
.seg a{flex:1;text-align:center;text-decoration:none;color:var(--text-2);font-size:13px;font-weight:600;
       padding:7px 0;border-radius:7px;}
.seg a.on{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(60,50,30,.10);}
.cta{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;background:var(--accent);
     color:#fff;border:0;border-radius:10px;padding:10px 14px;font-size:14px;font-weight:600;
     cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(150,70,40,.25);}
.cta:hover{background:var(--accent-hover);}
.cta:disabled{opacity:.6;cursor:default;}
.list-title{font-size:11px;color:var(--text-3);font-weight:700;letter-spacing:.08em;
            text-transform:uppercase;padding:18px 8px 8px;}
.list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin:0 -4px;padding:0 4px;}
.item{display:flex;align-items:center;border-radius:9px;}
.item:hover{background:#E7E2D5;}
.item.on{background:var(--accent-soft);}
.item.on:hover{background:var(--accent-soft);}
.item-main{flex:1;min-width:0;display:flex;align-items:center;gap:10px;background:transparent;border:0;
           padding:9px 10px;cursor:pointer;font-family:inherit;text-align:left;color:inherit;}
.item .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--ok-text);}
.item .dot.pending{background:#C8A24A;}
.item .txt{min-width:0;flex:1;display:flex;flex-direction:column;}
.item .t{font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.item .m{font-size:11.5px;color:var(--text-3);margin-top:2px;}
.item .x{opacity:0;color:var(--text-3);font-size:13px;padding:2px 8px;border-radius:6px;border:0;
         background:transparent;cursor:pointer;}
.item:hover .x{opacity:1;}
.item .x:hover{color:var(--err);}
.side-foot{border-top:1px solid var(--border);margin:10px -12px -16px;padding:12px 16px;}
.side-foot button{display:flex;align-items:center;gap:9px;color:var(--text-2);font-size:13px;
                  background:transparent;border:0;cursor:pointer;font-family:inherit;
                  padding:7px 8px;border-radius:8px;width:100%;text-align:left;}
.side-foot button:hover{background:#E7E2D5;}

/* ===== 工作区 ===== */
.work{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
.head{display:flex;align-items:center;gap:14px;padding:20px 28px 16px;border-bottom:1px solid var(--border);}
.head .h-main{min-width:0;flex:1;}
.head h1{font-size:18px;font-weight:600;margin:0;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.head .h-sub{font-size:12.5px;color:var(--text-3);margin-top:3px;}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
      padding:4px 11px;border-radius:999px;white-space:nowrap;}
.pill.ok{background:var(--ok-bg);color:var(--ok-text);}
.pill .d{width:6px;height:6px;border-radius:50%;background:currentColor;}
.btn{border:1px solid var(--border-strong);background:var(--surface);color:var(--text);
     border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.btn:hover{background:var(--surface-2);}
.btn:disabled{opacity:.5;cursor:default;}
.btn.primary{background:var(--accent);color:#fff;border-color:transparent;}
.btn.primary:hover{background:var(--accent-hover);}
.btn.primary:disabled{background:var(--accent);}
.btn.danger{color:var(--err);border-color:#E8CFC9;background:var(--surface);}
.btn.danger:hover{background:#FBEDEB;}
.btn.ghost{background:#F1EEE6;color:var(--text-2);border-color:transparent;}
.btn.ghost:hover{background:#E9E5DB;}

.scroll{flex:1;min-height:0;overflow-y:auto;padding:22px 28px;}
.chunks{display:flex;flex-direction:column;gap:14px;}
.chunk{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
       padding:15px 17px;box-shadow:0 1px 2px rgba(60,50,30,.04);}
.chunk-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
.badge{font-size:11px;font-weight:700;letter-spacing:.02em;padding:3px 9px;border-radius:6px;
       background:var(--accent-soft);color:var(--accent-text);}
.badge.table{background:#E9EEF2;color:#3E6079;}
.path{font-size:12px;color:var(--text-3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tok{margin-left:auto;font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap;}
.prefix{background:var(--warn-bg);border-left:3px solid #E0A655;color:var(--warn-text);
        font-size:12.5px;line-height:1.55;padding:8px 11px;border-radius:6px;margin-bottom:10px;}
.body{font-size:13.5px;line-height:1.7;color:#3a382f;white-space:pre-wrap;}

/* ===== 对话 ===== */
.scope{display:flex;align-items:center;gap:10px;padding:14px 28px;border-bottom:1px solid var(--border);background:var(--surface-2);}
.scope label{font-size:12.5px;color:var(--text-2);}
.scope select{background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;
              padding:7px 12px;font-size:13px;color:var(--text);font-family:inherit;flex:0 1 320px;}
.thread{flex:1;min-height:0;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column;gap:18px;}
.bub{max-width:80%;font-size:14px;line-height:1.75;}
.bub.user{align-self:flex-end;background:var(--accent);color:#fff;padding:11px 15px;
          border-radius:14px 14px 4px 14px;white-space:pre-wrap;}
.bub.asst{align-self:flex-start;display:flex;flex-direction:column;}
.bub.asst .a-body{background:var(--surface);border:1px solid var(--border);color:#33312a;
                  padding:13px 16px;border-radius:14px 14px 14px 4px;box-shadow:0 1px 2px rgba(60,50,30,.04);white-space:pre-wrap;}
.bub.asst .a-body.muted{color:var(--text-3);}
.src{font-size:12px;color:var(--text-3);margin-top:8px;padding-left:2px;}
.src .label{color:var(--accent-text);font-weight:600;}
details.det{margin-top:6px;padding-left:2px;}
details.det summary{font-size:12px;color:var(--text-3);cursor:pointer;}
.hit{border-top:1px solid var(--border);padding:8px 0;font-size:12.5px;}
.hit .score{color:var(--accent-text);font-weight:600;margin-right:8px;font-variant-numeric:tabular-nums;}
.hit-body{color:var(--text-3);margin-top:4px;}
.composer{display:flex;align-items:flex-end;gap:10px;padding:14px 24px 20px;border-top:1px solid var(--border);}
.composer input{flex:1;background:var(--surface);border:1px solid var(--border-strong);border-radius:14px;
                padding:12px 16px;font-size:14px;color:var(--text);font-family:inherit;box-shadow:0 1px 3px rgba(60,50,30,.05);}
.composer input::placeholder{color:var(--text-3);}
.send{width:40px;height:40px;border-radius:11px;border:0;background:var(--accent);color:#fff;
      font-size:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.send:hover{background:var(--accent-hover);}
.send:disabled{opacity:.5;cursor:default;}

/* ===== 通用文字 / 空状态 ===== */
.muted{color:var(--text-3);font-size:13px;}
.err{color:var(--err);font-size:13px;}
.ok{color:var(--ok-text);font-weight:600;}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
       color:var(--text-3);padding:40px;text-align:center;}
.empty .big{font-family:var(--font-serif);font-size:22px;color:var(--text-2);}

/* ===== 模态 ===== */
.overlay{position:fixed;inset:0;background:rgba(40,35,25,.35);display:flex;align-items:center;justify-content:center;z-index:50;}
.modal{background:var(--surface);border-radius:14px;padding:22px 24px;width:440px;max-width:calc(100vw - 32px);
       box-shadow:0 16px 50px rgba(40,30,15,.22);}
.modal h3{margin:0 0 16px;font-size:17px;color:var(--text);font-family:var(--font-serif);}
.modal .field{display:flex;flex-direction:column;gap:5px;margin-bottom:13px;}
.modal .field span{font-size:12px;color:var(--text-2);}
.modal .field input{padding:9px 12px;border:1px solid var(--border-strong);border-radius:9px;font-size:14px;
                    font-family:inherit;color:var(--text);background:var(--surface);}
.modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:18px;}
```

- [ ] **Step 2: 跑 typecheck 确认未破坏**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误（exit 0）。CSS 不参与类型检查，此步只确认没误删别的东西。

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "style(web): 重写 globals.css 为 Claude 暖色设计系统"
```

---

### Task 2: 新增共享 Sidebar 外壳 + 精简 layout

**Files:**
- Create: `apps/web/components/Sidebar.tsx`
- Modify (整体替换): `apps/web/app/layout.tsx`

> 说明：`Sidebar` 渲染 `<aside class="side">`（品牌 + 分段切换 + `children` + 底部设置）。设置按钮在 Task 8 才接 `CredentialsDialog`；本任务设置按钮是**不弹窗的占位**（无 state、无 onClick），避免引用未定义组件，也避免在渲染期 setState。

- [ ] **Step 1: 创建 `apps/web/components/Sidebar.tsx`**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const onChat = path.startsWith("/chat");

  return (
    <aside className="side" aria-label="主导航">
      <div className="brand">
        <span className="mark">✦</span> kb-studio
      </div>
      <nav className="seg">
        <Link href="/" className={onChat ? "" : "on"} aria-current={onChat ? undefined : "page"}>
          知识库
        </Link>
        <Link href="/chat" className={onChat ? "on" : ""} aria-current={onChat ? "page" : undefined}>
          对话
        </Link>
      </nav>
      {children}
      <div className="side-foot">
        {/* Task 8 接入 CredentialsDialog；本任务先放不弹窗的占位按钮 */}
        <button type="button">⚙ 设置 · 秒懂凭据</button>
      </div>
    </aside>
  );
}
```

> 注：设置按钮在 Task 8 会被整体替换为带 state + `<CredentialsDialog .../>` 的版本。

- [ ] **Step 2: 用下面内容整体替换 `apps/web/app/layout.tsx`**

```tsx
import "./globals.css";

export const metadata = { title: "kb-studio · 知识库处理台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。（旧 `Nav` 仍存在但已无人引用——Task 9 删除。）

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/Sidebar.tsx apps/web/app/layout.tsx
git commit -m "feat(web): 新增共享 Sidebar 外壳，layout 去掉独立 Nav"
```

---

### Task 3: 知识库 — DocList 改为侧栏 body + 接线 page.tsx

**Files:**
- Modify (整体替换): `apps/web/components/DocList.tsx`
- Modify (整体替换): `apps/web/app/page.tsx`

- [ ] **Step 1: 用下面内容整体替换 `apps/web/components/DocList.tsx`**

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
        await onUploaded(json.docId);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  const isReady = (d: DocItem) => d.status === "ready" || d.status === "pushed";
  function statusText(d: DocItem) {
    if (d.status === "pushed") return `${d.chunkCount} chunk · 已推送`;
    if (d.status === "ready") return `${d.chunkCount} chunk · 已就绪`;
    return d.status;
  }

  return (
    <>
      <input type="file" ref={fileRef} hidden onChange={upload} />
      <button className="cta" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? "处理中…" : "↑ 上传文档"}
      </button>
      {busy && <p className="muted" style={{ padding: "8px 4px 0" }}>解析→切片→上下文化→向量化…</p>}
      {err && <p className="err" style={{ padding: "8px 4px 0" }}>⚠ {err}</p>}
      <div className="list-title">文档</div>
      <div className="list">
        {docs.length === 0 && <p className="muted" style={{ padding: "4px 8px" }}>还没有文档，先上传一个</p>}
        {docs.map((d) => (
          <div key={d.id} className={d.id === selectedId ? "item on" : "item"}>
            <button className="item-main" onClick={() => onSelect(d.id)}>
              <span className={isReady(d) ? "dot" : "dot pending"} />
              <div className="txt">
                <div className="t">{d.title}</div>
                <div className="m">{statusText(d)}</div>
              </div>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: 用下面内容整体替换 `apps/web/app/page.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import DocList, { type DocItem } from "../components/DocList";
import DocDetail from "../components/DocDetail";

export default function KbPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/docs");
      const json = await res.json();
      setDocs(json.docs ?? []);
    } catch (e) {
      console.error("[kb] 加载文档列表失败:", e);
    }
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
    <div className="app">
      <Sidebar>
        <DocList docs={docs} selectedId={selectedId} onSelect={setSelectedId} onUploaded={onUploaded} />
      </Sidebar>
      <DocDetail docId={selectedId} onDeleted={onDeleted} />
    </div>
  );
}
```

- [ ] **Step 3: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/DocList.tsx apps/web/app/page.tsx
git commit -m "feat(web): DocList 改为侧栏 body（单按钮上传+状态圆点），知识库页接入 Sidebar"
```

---

### Task 4: 知识库 — DocDetail 套用新工作区样式

**Files:**
- Modify (整体替换): `apps/web/components/DocDetail.tsx`

> 逻辑（fetch / 删除 / 推送 / PushDialog 接线）与现状一致，只改 JSX 类名与状态展示。

- [ ] **Step 1: 用下面内容整体替换 `apps/web/components/DocDetail.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import PushDialog, { LS_KEY, type MiaodongCreds } from "./PushDialog";

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
  const [pushing, setPushing] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [pushErr, setPushErr] = useState("");

  useEffect(() => {
    if (!docId) {
      setChunks([]);
      setTitle("");
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setErr("");
    setPushed(false);
    setShowDialog(false);
    setPushErr("");
    setChunks([]);
    setTitle("");
    fetch(`/api/docs/${docId}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else {
          setChunks(json.chunks);
          setTitle(json.doc.title);
          setPushed(json.doc.status === "pushed");
        }
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [docId]);

  async function del() {
    if (!docId || !confirm("删除这篇文档及其所有 chunk？")) return;
    try {
      const res = await fetch(`/api/docs/${docId}`, { method: "DELETE" });
      const json = await res.json();
      if (json.ok) onDeleted(docId);
      else setErr(json.error ?? "删除失败");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

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
    } finally {
      setPushing(false);
    }
  }

  function openDialog() {
    setPushErr("");
    setShowDialog(true);
  }

  if (!docId)
    return (
      <section className="work">
        <div className="empty">
          <div className="big">从左侧选择一篇文档</div>
          <div>查看它的 chunk 切片与上下文</div>
        </div>
      </section>
    );

  return (
    <section className="work">
      <div className="head">
        <div className="h-main">
          <h1>{title || "（未命名）"}</h1>
          <div className="h-sub">
            {loading ? "加载中…" : `${chunks.length} chunk · 解析 → 切片 → 上下文化 → 已向量化`}
          </div>
        </div>
        <span className="pill ok">
          <span className="d" />
          {pushed ? "已推送" : "已就绪"}
        </span>
        {!pushed && (
          <button className="btn primary" onClick={openDialog}>
            推送到秒懂
          </button>
        )}
        <button className="btn danger" onClick={del}>
          删除
        </button>
      </div>
      <div className="scroll">
        {err && <p className="err">⚠ {err}</p>}
        {loading ? (
          <p className="muted">加载中…</p>
        ) : (
          <div className="chunks">
            {chunks.map((c) => (
              <div className="chunk" key={c.id}>
                <div className="chunk-head">
                  <span className={c.chunk_type === "table" ? "badge table" : "badge"}>{c.chunk_type}</span>
                  <span className="path">{c.heading_path.join(" › ") || "(根)"}</span>
                  <span className="tok">~{c.token_estimate} tok</span>
                </div>
                {c.context_prefix && (
                  <div className="prefix">
                    <b>＋上下文：</b>
                    {c.context_prefix}
                  </div>
                )}
                <div className="body">{c.content_original}</div>
              </div>
            ))}
          </div>
        )}
      </div>
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
    </section>
  );
}
```

- [ ] **Step 2: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/DocDetail.tsx
git commit -m "style(web): DocDetail 套用新工作区/状态pill/chunk卡片样式"
```

---

### Task 5: 对话 — ConversationList 改为侧栏 body + 接线 chat/page.tsx

**Files:**
- Modify (整体替换): `apps/web/components/ConversationList.tsx`
- Modify (整体替换): `apps/web/app/chat/page.tsx`

- [ ] **Step 1: 用下面内容整体替换 `apps/web/components/ConversationList.tsx`**

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
    <>
      <button className="cta" onClick={onNew}>
        ＋ 新建对话
      </button>
      <div className="list-title">最近对话</div>
      <div className="list">
        {items.length === 0 && <p className="muted" style={{ padding: "4px 8px" }}>还没有对话</p>}
        {items.map((c) => (
          <div key={c.id} className={c.id === selectedId ? "item on" : "item"}>
            <button className="item-main" onClick={() => onSelect(c.id)}>
              <div className="txt">
                <div className="t">{c.title}</div>
              </div>
            </button>
            <button className="x" onClick={() => onDelete(c.id)} aria-label="删除对话">
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: 用下面内容整体替换 `apps/web/app/chat/page.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import ConversationList, { type Conv } from "../../components/ConversationList";
import ChatThread from "../../components/ChatThread";

export default function ChatPage() {
  const [items, setItems] = useState<Conv[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const json = await res.json();
      setItems(json.conversations ?? []);
    } catch (e) {
      console.error("[kb] 加载会话列表失败:", e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((json) => setDocs((json.docs ?? []).map((d: { id: string; title: string }) => ({ id: d.id, title: d.title }))))
      .catch((e) => console.error("[kb] 加载文档列表失败:", e));
  }, []);

  const onNew = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      const json = await res.json();
      if (json.id) {
        await load();
        setSelectedId(json.id);
      }
    } catch (e) {
      console.error("[kb] 新建对话失败:", e);
    }
  }, [load]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm("删除这个对话？")) return;
      try {
        await fetch(`/api/conversations/${id}`, { method: "DELETE" });
        setSelectedId((s) => (s === id ? null : s));
        await load();
      } catch (e) {
        console.error("[kb] 删除对话失败:", e);
      }
    },
    [load],
  );

  const onTitle = useCallback((id: string, title: string) => {
    setItems((arr) => arr.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  return (
    <div className="app">
      <Sidebar>
        <ConversationList items={items} selectedId={selectedId} onSelect={setSelectedId} onNew={onNew} onDelete={onDelete} />
      </Sidebar>
      <ChatThread conversationId={selectedId} onTitle={onTitle} docs={docs} />
    </div>
  );
}
```

- [ ] **Step 3: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/ConversationList.tsx apps/web/app/chat/page.tsx
git commit -m "feat(web): ConversationList 改为侧栏 body，对话页接入 Sidebar"
```

---

### Task 6: 对话 — ChatThread 套用新 scope/气泡/composer

**Files:**
- Modify (整体替换): `apps/web/components/ChatThread.tsx`

> 逻辑（fetch / send / changeScope / 自动滚动）与现状一致，只改 JSX 类名与气泡结构。

- [ ] **Step 1: 用下面内容整体替换 `apps/web/components/ChatThread.tsx`**

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
  docs,
}: {
  conversationId: string | null;
  onTitle: (id: string, title: string) => void;
  docs: { id: string; title: string }[];
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [scopeDocId, setScopeDocId] = useState("");
  const rawScopeRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversationId) {
      setMsgs([]);
      return;
    }
    const ctrl = new AbortController();
    setErr("");
    setMsgs([]);
    fetch(`/api/conversations/${conversationId}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else {
          setMsgs(json.messages ?? []);
          const s = json.conversation?.scopeDocId ?? "";
          rawScopeRef.current = s;
          setScopeDocId(s && docs.some((d) => d.id === s) ? s : "");
        }
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      });
    return () => ctrl.abort();
  }, [conversationId]);

  useEffect(() => {
    const s = rawScopeRef.current;
    setScopeDocId(s && docs.some((d) => d.id === s) ? s : "");
  }, [docs]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, sending]);

  async function changeScope(v: string) {
    const prev = scopeDocId;
    setScopeDocId(v);
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeDocId: v || null }),
      });
      if (!res.ok) {
        setScopeDocId(prev);
        setErr(`保存知识库范围失败 (${res.status})`);
      } else {
        rawScopeRef.current = v;
      }
    } catch (e: any) {
      setScopeDocId(prev);
      setErr(String(e?.message ?? e));
    }
  }

  async function send() {
    if (!conversationId || !input.trim() || sending) return;
    const q = input.trim();
    const tmpId = "tmp_" + crypto.randomUUID();
    setInput("");
    setSending(true);
    setErr("");
    setMsgs((m) => [...m, { id: tmpId, role: "user", content: q, sources: null, hits: null }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, query: q }),
      });
      const json = await res.json();
      if (json.error) {
        setErr(json.error);
        setMsgs((m) => m.filter((x) => x.id !== tmpId));
        setInput(q);
      } else {
        setMsgs((m) => [
          ...m,
          { id: "a_" + crypto.randomUUID(), role: "assistant", content: json.answer, sources: json.sources, hits: json.hits },
        ]);
        if (json.title) onTitle(conversationId, json.title);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setMsgs((m) => m.filter((x) => x.id !== tmpId));
      setInput(q);
    } finally {
      setSending(false);
    }
  }

  if (!conversationId)
    return (
      <section className="work">
        <div className="empty">
          <div className="big">开始一段对话</div>
          <div>新建或选择左侧的对话，向知识库提问</div>
        </div>
      </section>
    );

  return (
    <section className="work">
      <div className="scope">
        <label htmlFor="scope-select">知识库范围</label>
        <select id="scope-select" value={scopeDocId} onChange={(e) => changeScope(e.target.value)}>
          <option value="">全部知识库</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </div>
      <div className="thread">
        {msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="bub user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="bub asst">
              <div className="a-body">{m.content}</div>
              {m.sources && m.sources.length > 0 && (
                <div className="src">
                  <span className="label">溯源：</span>
                  {m.sources.map((s) => s.heading_path.join(" › ")).join("  |  ")}
                </div>
              )}
              {m.hits && m.hits.length > 0 && (
                <details className="det">
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
          ),
        )}
        {sending && (
          <div className="bub asst">
            <div className="a-body muted">思考中…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {err && <p className="err" style={{ padding: "0 24px" }}>⚠ {err}</p>}
      <div className="composer">
        <input
          value={input}
          placeholder="问点什么…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="send" onClick={send} disabled={sending} aria-label="发送">
          {sending ? "…" : "↑"}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/ChatThread.tsx
git commit -m "style(web): ChatThread 套用新 scope/气泡/composer 样式"
```

---

### Task 7: PushDialog 套用新模态样式

**Files:**
- Modify (整体替换): `apps/web/components/PushDialog.tsx`

> 逻辑与字段（LS_KEY 预填、canSubmit 校验）完全不变，只改类名/按钮。

- [ ] **Step 1: 用下面内容整体替换 `apps/web/components/PushDialog.tsx`**

```tsx
"use client";
import { useEffect, useState, type FormEvent } from "react";

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

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit({ domain, accessKeyId, accessKeySecret, knowledgeBaseId });
  }

  return (
    <div className="overlay" onClick={pushing ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>推送到秒懂</h3>
        <form onSubmit={handleSubmit}>
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
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={pushing}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={!canSubmit}>
              {pushing ? "推送中…" : "确认推送"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/PushDialog.tsx
git commit -m "style(web): PushDialog 套用新模态/输入/按钮样式"
```

---

### Task 8: 新增 CredentialsDialog + 接进 Sidebar 设置入口

**Files:**
- Create: `apps/web/components/CredentialsDialog.tsx`
- Modify: `apps/web/components/Sidebar.tsx`（替换 Task 2 的临时占位）

> 这是本次重设计**唯一的功能新增**：侧栏底部「设置·秒懂凭据」打开一个轻量弹框，只编辑非密三项（domain / accessKeyId / knowledgeBaseId）写入 `LS_KEY`，与 PushDialog 复用同一存储。accessKeySecret 仍只在推送时单独填、不保存——推送行为不变。

- [ ] **Step 1: 创建 `apps/web/components/CredentialsDialog.tsx`**

```tsx
"use client";
import { useEffect, useState, type FormEvent } from "react";
import { LS_KEY } from "./PushDialog";

export default function CredentialsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [domain, setDomain] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      setDomain(s.domain || "");
      setAccessKeyId(s.accessKeyId || "");
      setKnowledgeBaseId(s.knowledgeBaseId || "");
    } catch {}
  }, [open]);

  if (!open) return null;

  function save(e: FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ domain, accessKeyId, knowledgeBaseId }));
      setSaved(true);
    } catch {}
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>秒懂凭据</h3>
        <p className="muted" style={{ margin: "-8px 0 14px" }}>
          这里只记非密三项；accessKeySecret 在每次推送时单独填写、不保存。
        </p>
        <form onSubmit={save}>
          <label className="field">
            <span>域名</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="insight.juzibot.com" />
          </label>
          <label className="field">
            <span>accessKeyId</span>
            <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
          </label>
          <label className="field">
            <span>knowledgeBaseId</span>
            <input value={knowledgeBaseId} onChange={(e) => setKnowledgeBaseId(e.target.value)} />
          </label>
          <div className="modal-actions">
            {saved && <span className="ok" style={{ marginRight: "auto" }}>✅ 已保存</span>}
            <button type="button" className="btn ghost" onClick={onClose}>
              关闭
            </button>
            <button type="submit" className="btn primary">
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 用下面内容整体替换 `apps/web/components/Sidebar.tsx`**（接上真正的弹框）

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import CredentialsDialog from "./CredentialsDialog";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const onChat = path.startsWith("/chat");
  const [showCreds, setShowCreds] = useState(false);

  return (
    <aside className="side" aria-label="主导航">
      <div className="brand">
        <span className="mark">✦</span> kb-studio
      </div>
      <nav className="seg">
        <Link href="/" className={onChat ? "" : "on"} aria-current={onChat ? undefined : "page"}>
          知识库
        </Link>
        <Link href="/chat" className={onChat ? "on" : ""} aria-current={onChat ? "page" : undefined}>
          对话
        </Link>
      </nav>
      {children}
      <div className="side-foot">
        <button onClick={() => setShowCreds(true)}>⚙ 设置 · 秒懂凭据</button>
      </div>
      <CredentialsDialog open={showCreds} onClose={() => setShowCreds(false)} />
    </aside>
  );
}
```

- [ ] **Step 3: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/CredentialsDialog.tsx apps/web/components/Sidebar.tsx
git commit -m "feat(web): 侧栏设置入口 + CredentialsDialog（只记非密三项）"
```

---

### Task 9: 删除退役的 Nav.tsx

**Files:**
- Delete: `apps/web/components/Nav.tsx`

- [ ] **Step 1: 确认无引用**

Run: `grep -rn "components/Nav\"\|from \"./Nav\"\|import Nav" apps/web --include=*.tsx`
Expected: 无输出（已无人 import Nav）。

- [ ] **Step 2: 删除文件**

Run: `git rm apps/web/components/Nav.tsx`

- [ ] **Step 3: 跑 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(web): 删除退役的 Nav 组件（功能并入 Sidebar）"
```

---

### Task 10: 视觉验收 —— 跑 dev server 截图比对 mockup

**Files:** 无（仅验证）

> 说明：这个仓库无单元测试，UI 重设计的真实验收 = 渲染出来与 mockup 一致、且现有交互不回归。`/api/docs` 等会连 DB；若想看真实数据，先 `docker compose up -d`（见 CLAUDE.md / 记忆 [[env-and-db-startup]]）。**不连 DB 也能验收外壳与样式**（列表走空状态，仍渲染暖色侧栏 + 工作区 + 空状态衬线文案）。

- [ ] **Step 1: 最终 typecheck**

Run: `npm run typecheck --workspace @kb/web`
Expected: 无错误。

- [ ] **Step 2: 后台启动 dev server**

Run（后台）: `npm run dev --workspace @kb/web`
等待编译，直到下面命令返回 200：
`until curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -q 200; do sleep 1; done; echo READY`

- [ ] **Step 3: 截图两个页面**

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="/private/tmp/claude-501/-Users-jerry-Desktop-product-kb-studio/5351dd02-1c60-40ee-9fe3-77094d1d8811/scratchpad"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,820 --screenshot="$OUT/verify-kb.png" "http://localhost:3001"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,820 --screenshot="$OUT/verify-chat.png" "http://localhost:3001/chat"
ls -la "$OUT"/verify-*.png
```

- [ ] **Step 4: 用 Read 工具看两张截图，逐项核对**

核对清单（对照 `docs/superpowers/specs/assets/2026-06-27-ui-redesign-mockup.png`）：
  - 暖米色单侧栏（无旧深藏青）；品牌 `✦ kb-studio` 衬线；`知识库/对话` 分段切换，当前页高亮。
  - CTA「↑ 上传文档」/「＋ 新建对话」黏土橙满宽。
  - 底部「⚙ 设置 · 秒懂凭据」可见。
  - 工作区空状态：衬线大标题居中（知识库「从左侧选择一篇文档」、对话「开始一段对话」）。
  - 右侧/整体背景暖奶白，分隔线为暖发丝色。
  - 点「设置」弹出 CredentialsDialog（暖白模态）。
  - 切换「知识库↔对话」分段，路由与高亮正确。

- [ ] **Step 5: （可选，连 DB）功能回归抽查**

若已 `docker compose up -d` 且库里有数据：上传一个文件→出现在列表（状态圆点）→点开看 chunk 卡片（badge/上下文前缀/正文）→「推送到秒懂」弹框→对话页提问出气泡+溯源。确认无交互回归。

- [ ] **Step 6: 关闭 dev server**

停掉后台 dev server 进程。

- [ ] **Step 7: 收尾说明（无需提交）**

截图存于 scratchpad，不入库。重设计已完成，分支 `ui-redesign-claude` 待合并（用 superpowers:finishing-a-development-branch 决定 merge/PR）。

---

## Self-Review

**1. Spec 覆盖**（逐节核对 spec）：
- 设计系统 token（颜色/字体/形状阴影）→ Task 1 全量落地 ✅
- 单一暖色侧栏布局 → Task 2（Sidebar 外壳 + layout）✅
- Sidebar 组件（品牌/分段/CTA/列表/设置）→ Task 2 + 3 + 5 + 8 ✅
- 工作区 Header/pill/按钮层级 → Task 4 ✅
- 知识库 chunk 卡片/徽章/table 区分/上下文 callout/空状态 → Task 4 ✅
- 对话 scope/气泡/composer/空状态 → Task 6 ✅
- PushDialog 模态换新 → Task 7 ✅
- 受影响文件表（Nav 退役）→ Task 9 ✅
- 验收标准（typecheck + 视觉 + 无回归 + 无新依赖）→ Task 10 ✅
- 非目标（不动 API/数据流、只浅色、零新依赖）→ 全程未触碰 `app/api/*`、`lib/`、`@kb/*`，未引依赖 ✅
- spec 里「DocList/ConversationList 合并方式留待计划定」→ 本计划已定：拆成「侧栏 body 片段（CTA+list）」作为 `Sidebar` 的 `children`，`Sidebar` 提供 `aside.side` 外壳 ✅

**2. 占位符扫描**：无 TBD/TODO；每个改代码步骤都给了完整文件内容。Task 2 的设置按钮是**不弹窗的占位**（无 state/onClick），已注明并在 Task 8 Step 2 整体替换为带 `CredentialsDialog` 的版本，不残留。

**3. 类型/命名一致性**：
- 类名贯穿一致：`app/side/brand/seg/cta/list-title/list/item/item-main/dot/txt/t/m/x/side-foot` 与 `work/head/h-main/h-sub/pill/btn(.primary/.danger/.ghost)/scroll/chunks/chunk/chunk-head/badge(.table)/path/tok/prefix/body/scope/thread/bub(.user/.asst)/a-body/src/det/hit/composer/send/empty/overlay/modal/field/modal-actions` 在 CSS（Task 1）与各组件 JSX 中一致。
- `LS_KEY` 由 `PushDialog` 导出，`DocDetail`（Task 4）与 `CredentialsDialog`（Task 8）都从 `./PushDialog` import，签名一致。
- `DocItem` / `Conv` / `MiaodongCreds` 类型与现有 props 一致，未改契约。
- `Sidebar` 接 `children: React.ReactNode`，两页传入对应列表组件，一致。
