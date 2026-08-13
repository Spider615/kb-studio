# wiki 化加工 + agentic search 双栏 A/B 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 chunk 流水线之外增加一条 wiki 化加工 + agentic search 检索链路，并提供 `/ab` 双栏页面在同一问题上实测对比两条路线。

**Architecture:** page 层是纯增量——分页器独立消费同一份 markdown，不触碰 `chunkMarkdown`；已有 chunk 只是被打上 `page_id` 标签。检索侧新增手写工具循环 `agentSearch`，通过 `list_docs`/`read_outline`/`read_page`/`grep`/`search` 五个工具自主导航；`search` 内部命中 chunk 但返回其所属整页。两栏在 `/api/ab` 里并发执行、各自计时与容错。

**Tech Stack:** TypeScript / Node 22 · npm workspaces monorepo · Drizzle ORM + Postgres 16 + pgvector · Next.js 15（apps/web，端口 3001）· `node:test` + `node:assert/strict` · Anthropic SDK 经 302 网关

## Global Constraints

- **A 套链路行为不变**：`chunkMarkdown` / `retrieve()` / `ingestDoc` 的切分、检索、作答逻辑一行不改。唯一例外是只读的 `usage` 透出（Task 5），不触碰任何检索参数或提示词。
- **通用工具，禁领域专属逻辑**：分页规则只依赖 markdown 结构（标题层级、表格、token 预算）。不得硬编码行业术语、品牌名、列名或话术。
- **中文注释 + 中文用户文案，代码标识符英文**。
- **内部包引用**用 `@kb/core` `@kb/db` `@kb/adapters` `@kb/pipeline`，不写相对路径跨包。
- **测试框架**：`node:test` + `node:assert/strict`。单个文件跑法 `npx tsx --test <路径>`。项目无 vitest，不要引入。
- **类型检查**：`npm run typecheck`（根 tsc + web workspace 各一次）。
- **DB 迁移**：改 `packages/db/src/schema.ts` 后跑 `npm run db:generate && npm run db:migrate`。drizzle 生成的 SQL 需人工核对（本项目有过生成 SQL 缺陷的先例，见 CLAUDE.md 里程碑 ⑩）。
- **提交信息**中文，结尾附 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- **不推送 wiki 页到秒懂**，秒懂链路完全不动。
- **两栏必须用同一个 LLM 后端**（见下方「较 spec 的两处修正」第 2 条）。这是 A/B 有效性的前提，不可妥协。

### 较 spec 的两处修正

**1. 取消 `PaginateOptions.tableSheetPerPage`（spec §4）**

`tabular_to_md.py` 输出的 markdown 里每个 sheet 本就是一个标题块，按标题切页天然实现「一个 sheet 一页」，无需额外开关。超长表格按行分页 + 每页重复表头改为分页器的内建行为（Task 1 Step 7）。

**2. 两栏强制同后端（修正 spec §7.1 的隐含假设）**

写计划时核对 `packages/adapters/src/llm/factory.ts` 发现：**`makeLlm()` 默认返回 `ArkLlmClient`（豆包），`KB_LLM=claude` 才回 302**。

spec §7.1 让 A 栏走 `getDeps()` 的默认后端、B 栏因不支持 runTools 而要求 302，这会导致 **A 栏跑豆包、B 栏跑 Claude**——模型和链路两个变量同时变，测出的差异无法归因，整个 A/B 失效。

修正：`/api/ab` **不使用 `getDeps()` 的 llm**，而是自行构造一个 `LlmClient`（302/Claude），两栏共用同一实例。`/chat` 生产链路仍走 `getDeps()` 的默认后端，不受影响。

代价：A 栏在 `/ab` 里跑的是 Claude 而非日常生产的豆包，所以 `/ab` 测的是「同一模型下两条链路孰优」，而不是「你的线上配置有多好」。这正是本次要回答的问题。若后续想测豆包上的表现，再给 `ArkLlmClient` 实现 `runTools`（豆包支持 OpenAI function calling），届时两栏一起切即可。

---

### Task 1: 分页器 paginate()

纯函数、无 IO、无 LLM。这是整个 B 套的地基，也是唯一能完全离线验证的部分。

**Files:**
- Create: `packages/core/src/paginator.ts`
- Test: `packages/core/src/paginator.test.ts`
- Modify: `packages/core/src/index.ts`（导出）

**Interfaces:**
- Consumes: `estimateTokens` from `./tokenize`
- Produces:
  ```ts
  export interface PaginateOptions { maxPageTokens?: number; minPageTokens?: number }
  export interface Page {
    pageIndex: number;      // 从 1 开始
    title: string;
    content: string;
    headingPath: string[];
    tokenEstimate: number;
    continued?: boolean;
  }
  export function paginate(markdown: string, opts?: PaginateOptions): Page[]
  ```

- [ ] **Step 1: 写失败测试——按最主要的标题层级切页**

Create `packages/core/src/paginator.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "./paginator";

test("按出现最多的标题层级切页，前言并入第一页", () => {
  const md = [
    "# 管理制度",
    "本制度自发布之日起施行。",
    "## 第一章 总则",
    "第一条 适用范围如下。",
    "## 第二章 承保规则",
    "第二条 核保权限如下。",
    "## 第三章 免责条款",
    "第三条 下列情形不承担责任。",
  ].join("\n");

  const pages = paginate(md, { minPageTokens: 0 });

  assert.equal(pages.length, 3);
  assert.equal(pages[0]!.title, "第一章 总则");
  assert.equal(pages[0]!.pageIndex, 1);
  // 前言（H1 标题 + 施行说明）并入第一页，不单独成页
  assert.ok(pages[0]!.content.includes("本制度自发布之日起施行"));
  assert.ok(pages[0]!.content.includes("第一条 适用范围如下"));
  assert.equal(pages[2]!.title, "第三章 免责条款");
  assert.deepEqual(pages[2]!.headingPath, ["管理制度", "第三章 免责条款"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test packages/core/src/paginator.test.ts`
Expected: FAIL — `Cannot find module './paginator'`

- [ ] **Step 3: 实现最小分页器**

Create `packages/core/src/paginator.ts`:

```ts
import { estimateTokens } from "./tokenize";

export interface PaginateOptions {
  maxPageTokens?: number; // 单页上限，超过则次级切分，默认 8000
  minPageTokens?: number; // 低于此值与相邻页合并，默认 300
}

export interface Page {
  pageIndex: number; // 从 1 开始；目录页由 buildWiki 另行插入为 0
  title: string;
  content: string; // 逐字取自入参 markdown
  headingPath: string[];
  tokenEstimate: number;
  continued?: boolean; // 由超长内容硬切产生的续页
}

interface HeadingLine {
  line: number;
  level: number;
  text: string;
}

/** 扫出所有 ATX 标题行（跳过围栏代码块内的 # 号）。 */
function scanHeadings(lines: string[]): HeadingLine[] {
  const out: HeadingLine[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const marker = fence[1]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) out.push({ line: i, level: h[1]!.length, text: h[2]!.trim() });
  }
  return out;
}

/**
 * 选切页层级：取出现次数最多的层级；次数并列时取更浅的层级。
 * 只出现一次的层级（通常是文档标题 H1）不作为切页层级，除非它是唯一的层级。
 */
function pickSplitLevel(headings: HeadingLine[]): number | null {
  if (headings.length === 0) return null;
  const count = new Map<number, number>();
  for (const h of headings) count.set(h.level, (count.get(h.level) ?? 0) + 1);
  const multi = [...count.entries()].filter(([, n]) => n >= 2);
  const pool = multi.length > 0 ? multi : [...count.entries()];
  pool.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pool[0]![0];
}

/** 给定行号，算出它所处的标题路径（各层级最近的一个标题）。 */
function headingPathAt(headings: HeadingLine[], line: number, splitLevel: number): string[] {
  const stack: string[] = [];
  for (const h of headings) {
    if (h.line > line) break;
    if (h.level > splitLevel) continue;
    stack.length = Math.max(0, h.level - 1);
    stack[h.level - 1] = h.text;
  }
  return stack.filter((s) => s != null);
}

export function paginate(markdown: string, opts: PaginateOptions = {}): Page[] {
  const minPageTokens = opts.minPageTokens ?? 300;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings = scanHeadings(lines);
  const splitLevel = pickSplitLevel(headings);

  // 无标题：整篇一页
  if (splitLevel === null) {
    const content = markdown.trim();
    if (!content) return [];
    return [{ pageIndex: 1, title: "全文", content, headingPath: [], tokenEstimate: estimateTokens(content) }];
  }

  const cuts = headings.filter((h) => h.level === splitLevel);
  // 切页层级只有一个标题：整篇一页
  if (cuts.length === 0) {
    const content = markdown.trim();
    return [{ pageIndex: 1, title: headings[0]!.text, content, headingPath: [headings[0]!.text], tokenEstimate: estimateTokens(content) }];
  }

  const raw: Array<{ title: string; content: string; headingPath: string[] }> = [];
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]!;
    // 第一页从文首开始，把前言并进来；其余从各自标题行开始
    const from = i === 0 ? 0 : cut.line;
    const to = i + 1 < cuts.length ? cuts[i + 1]!.line : lines.length;
    const content = lines.slice(from, to).join("\n").trim();
    if (!content) continue;
    raw.push({ title: cut.text, content, headingPath: headingPathAt(headings, cut.line, splitLevel) });
  }

  return numberPages(mergeShort(raw, minPageTokens));
}

/** 过短页与后一页合并（末页则并入前一页），避免产生大量碎页。 */
function mergeShort(
  pages: Array<{ title: string; content: string; headingPath: string[] }>,
  minPageTokens: number,
): Array<{ title: string; content: string; headingPath: string[] }> {
  if (minPageTokens <= 0 || pages.length <= 1) return pages;
  const out: typeof pages = [];
  for (const p of pages) {
    const prev = out[out.length - 1];
    if (prev && estimateTokens(prev.content) < minPageTokens) {
      prev.content = `${prev.content}\n\n${p.content}`;
      continue; // 合并后沿用前一页的标题与路径
    }
    out.push({ ...p });
  }
  // 末页仍过短则并入前一页
  if (out.length > 1 && estimateTokens(out[out.length - 1]!.content) < minPageTokens) {
    const last = out.pop()!;
    out[out.length - 1]!.content += `\n\n${last.content}`;
  }
  return out;
}

function numberPages(pages: Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }>): Page[] {
  return pages.map((p, i) => ({
    pageIndex: i + 1,
    title: p.title,
    content: p.content,
    headingPath: p.headingPath,
    tokenEstimate: estimateTokens(p.content),
    ...(p.continued ? { continued: true } : {}),
  }));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test packages/core/src/paginator.test.ts`
Expected: PASS 1/1

- [ ] **Step 5: 加无标题与过短页合并的测试**

Append to `packages/core/src/paginator.test.ts`:

```ts
test("无标题文档整篇一页", () => {
  const md = "这是一段没有任何标题的说明文字。\n\n第二段。";
  const pages = paginate(md);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.title, "全文");
  assert.deepEqual(pages[0]!.headingPath, []);
});

test("过短的页并入相邻页，不产生碎页", () => {
  const long = "详细内容。".repeat(400); // 远超 minPageTokens
  const md = ["## A", "短。", "## B", long, "## C", "也短。"].join("\n");
  const pages = paginate(md, { minPageTokens: 300 });
  // A 太短 → 并入 B；C 太短 → 并入前一页
  assert.equal(pages.length, 1);
  assert.ok(pages[0]!.content.includes("短。"));
  assert.ok(pages[0]!.content.includes("也短。"));
});

test("代码块里的 # 不被当成标题", () => {
  const md = ["## 真标题", "```bash", "# 这是注释不是标题", "echo hi", "```", "## 另一个真标题", "正文"].join("\n");
  const pages = paginate(md, { minPageTokens: 0 });
  assert.equal(pages.length, 2);
  assert.equal(pages[1]!.title, "另一个真标题");
});
```

- [ ] **Step 6: 运行测试确认全部通过**

Run: `npx tsx --test packages/core/src/paginator.test.ts`
Expected: PASS 4/4

- [ ] **Step 7: 加超长页切分（含表格按行切、每页重复表头）**

先写测试，追加到 `packages/core/src/paginator.test.ts`:

```ts
test("超长章节按次级标题再切，续页标 continued", () => {
  const filler = "内容。".repeat(1200); // 单段就超 maxPageTokens
  const md = ["## 大章", "### 小节一", filler, "### 小节二", filler, "## 小章", "短正文。"].join("\n");
  const pages = paginate(md, { maxPageTokens: 800, minPageTokens: 0 });
  // 大章被拆成至少两页，第二页起标 continued
  const fromBig = pages.filter((p) => p.title.startsWith("大章"));
  assert.ok(fromBig.length >= 2);
  assert.equal(fromBig[0]!.continued, undefined);
  assert.equal(fromBig[1]!.continued, true);
  assert.ok(fromBig[1]!.title.includes("续"));
});

test("超长表格按行分页且每页重复表头", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| R${i} | 型号${i} | ${i * 10} |`);
  const md = ["## 价格表", "| 区域 | 型号 | 价格 |", "| --- | --- | --- |", ...rows].join("\n");
  const pages = paginate(md, { maxPageTokens: 500, minPageTokens: 0 });
  assert.ok(pages.length >= 2);
  for (const p of pages) {
    assert.ok(p.content.includes("| 区域 | 型号 | 价格 |"), "每页都要带表头");
    assert.ok(p.content.includes("| --- | --- | --- |"), "每页都要带分隔行");
  }
  // 全部数据行都在，一行不丢
  const all = pages.map((p) => p.content).join("\n");
  for (let i = 0; i < 300; i++) assert.ok(all.includes(`| R${i} |`), `第 ${i} 行丢了`);
});
```

- [ ] **Step 8: 运行测试确认失败**

Run: `npx tsx --test packages/core/src/paginator.test.ts`
Expected: FAIL 2 个新用例（当前 paginate 不做超长切分）

- [ ] **Step 9: 实现超长页切分**

In `packages/core/src/paginator.ts`, 把 `paginate` 结尾的 `return numberPages(mergeShort(raw, minPageTokens));` 改成：

```ts
  const maxPageTokens = opts.maxPageTokens ?? 8000;
  const merged = mergeShort(raw, minPageTokens);
  const split = merged.flatMap((p) => splitOversized(p, maxPageTokens, headings, splitLevel));
  return numberPages(split);
```

并在文件末尾追加：

```ts
/** 一段 markdown 里连续的表格行区间（含表头两行）。找不到表格返回 null。 */
function findTableBlock(lines: string[]): { start: number; end: number } | null {
  const isRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i] ?? "")) continue;
    let j = i;
    while (j < lines.length && isRow(lines[j] ?? "")) j++;
    if (j - i >= 3) return { start: i, end: j }; // 表头 + 分隔行 + 至少一行数据
    i = j;
  }
  return null;
}

/**
 * 超长页切分，按优先级：
 * 1) 页内有次级标题 → 按次级标题切
 * 2) 页主体是表格 → 按数据行切，每页重复表头两行
 * 3) 其余 → 按空行分段硬切
 * 续页标题追加「（续）」并标 continued。
 */
function splitOversized(
  page: { title: string; content: string; headingPath: string[]; continued?: boolean },
  maxPageTokens: number,
  headings: HeadingLine[],
  splitLevel: number,
): Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }> {
  if (estimateTokens(page.content) <= maxPageTokens) return [page];
  const lines = page.content.split("\n");

  // 1) 次级标题
  const subPattern = new RegExp(`^#{${splitLevel + 1}}\\s+\\S`);
  const subCuts = lines.map((l, i) => (subPattern.test(l) ? i : -1)).filter((i) => i >= 0);
  let parts: string[];
  if (subCuts.length >= 2) {
    parts = [];
    const bounds = [0, ...subCuts.slice(1), lines.length];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const seg = lines.slice(bounds[i]!, bounds[i + 1]!).join("\n").trim();
      if (seg) parts.push(seg);
    }
  } else {
    const table = findTableBlock(lines);
    if (table) {
      // 2) 表格按行切，每页重复表头两行
      const head = lines.slice(0, table.start).join("\n");
      const header = lines.slice(table.start, table.start + 2).join("\n");
      const dataRows = lines.slice(table.start + 2, table.end);
      const tail = lines.slice(table.end).join("\n").trim();
      const budget = Math.max(1, maxPageTokens - estimateTokens(`${head}\n${header}`));
      parts = [];
      let buf: string[] = [];
      for (const row of dataRows) {
        buf.push(row);
        if (estimateTokens(buf.join("\n")) >= budget) {
          parts.push([head, header, ...buf].filter(Boolean).join("\n").trim());
          buf = [];
        }
      }
      if (buf.length) parts.push([head, header, ...buf].filter(Boolean).join("\n").trim());
      if (tail) parts.push(tail);
    } else {
      // 3) 按空行分段硬切
      parts = [];
      let buf: string[] = [];
      for (const para of page.content.split(/\n\s*\n/)) {
        buf.push(para);
        if (estimateTokens(buf.join("\n\n")) >= maxPageTokens) {
          parts.push(buf.join("\n\n").trim());
          buf = [];
        }
      }
      if (buf.length) parts.push(buf.join("\n\n").trim());
    }
  }

  if (parts.length <= 1) return [page];
  return parts.map((content, i) => ({
    title: i === 0 ? page.title : `${page.title}（续${i}）`,
    content,
    headingPath: page.headingPath,
    ...(i > 0 ? { continued: true } : {}),
  }));
}
```

- [ ] **Step 10: 运行全部测试确认通过**

Run: `npx tsx --test packages/core/src/paginator.test.ts`
Expected: PASS 6/6

- [ ] **Step 11: 导出并类型检查**

In `packages/core/src/index.ts` 追加一行（放在其他 export 之后）：

```ts
export * from "./paginator";
```

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 12: 提交**

```bash
git add packages/core/src/paginator.ts packages/core/src/paginator.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
分页器 paginate()：按标题切页 + 超长切分 + 表格按行分页

wiki 化加工的地基。纯函数无 IO，与 chunkMarkdown 相互独立，
各自消费同一份 markdown，保证 A 套链路行为不变。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: DB schema + 迁移 0017

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0017_*.sql`（drizzle 生成）

**Interfaces:**
- Produces: `wikiPages` / `abRuns` 表对象与 `WikiPageRow` / `AbRunRow` 类型；`chunks.pageId`、`docs.wikiStatus`、`docs.wikiError` 列

- [ ] **Step 1: 加两张新表与三个新列**

In `packages/db/src/schema.ts`：

`docs` 表定义里，在 `groupId` 那一行之后追加：

```ts
  // wiki 化状态，与主 status 解耦：wiki 失败不让文档变 failed
  wikiStatus: text("wiki_status"), // null|pending|ready|failed
  wikiError: text("wiki_error"),
```

`chunks` 表定义里，在 `tsvText` 那一行之后追加：

```ts
  // 所属 wiki 页（null = 该文档未跑 wiki 化）。A 套查询不带此列，零影响。
  pageId: text("page_id"),
```

并把 chunks 的索引块改成：

```ts
  (t) => ({
    docIdx: index("chunks_doc_idx").on(t.docId),
    pageIdx: index("chunks_page_id_idx").on(t.pageId),
  }),
```

在 `chunks` 表定义之后、`conversations` 之前插入两张新表：

```ts
/** wiki 页：按语义主题分的自包含大页，正文逐字取自原文。page_index=0 是 LLM 生成的目录页。 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(), // page_<docId>_<idx>
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(), // 0 = 目录页
    title: text("title").notNull(),
    content: text("content").notNull(),
    headingPath: jsonb("heading_path").$type<string[]>().notNull().default([]),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    docIdx: index("wiki_pages_doc_idx").on(t.docId),
    uniqDocPage: uniqueIndex("wiki_pages_doc_page_uniq").on(t.docId, t.pageIndex),
  }),
);
export type WikiPageRow = typeof wikiPages.$inferSelect;

/** A/B 对比记录：一次提问的两栏结果 + 人工评分。两栏各留 error 列，失败本身也是数据。 */
export const abRuns = pgTable(
  "ab_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    groupId: text("group_id"),
    query: text("query").notNull(),

    aAnswer: text("a_answer"),
    aHits: jsonb("a_hits"),
    aMs: integer("a_ms"),
    aTokens: integer("a_tokens"),
    aError: text("a_error"),

    bAnswer: text("b_answer"),
    bTrace: jsonb("b_trace"),
    bMs: integer("b_ms"),
    bTokens: integer("b_tokens"),
    bError: text("b_error"),

    verdict: text("verdict"), // null|a|b|tie|neither
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("ab_runs_user_idx").on(t.userId, t.createdAt),
  }),
);
export type AbRunRow = typeof abRuns.$inferSelect;
```

文件顶部的 drizzle 导入里补上 `uniqueIndex`：

```ts
import {
  pgTable, text, integer, timestamp, jsonb, index, uniqueIndex, customType, primaryKey,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: 生成迁移**

Run: `npm run db:generate`
Expected: 新增 `packages/db/migrations/0017_*.sql`

- [ ] **Step 3: 人工核对生成的 SQL**

Read 新生成的 `0017_*.sql`，逐条确认：
- `CREATE TABLE "wiki_pages"` 带 `doc_id` 外键 `ON DELETE cascade`
- `wiki_pages_doc_page_uniq` 唯一索引存在
- `CREATE TABLE "ab_runs"` 存在
- `ALTER TABLE "chunks" ADD COLUMN "page_id" text;` 存在
- `ALTER TABLE "docs" ADD COLUMN "wiki_status" text;` 与 `"wiki_error" text` 都存在
- 无任何 `DROP` 语句（有则说明生成有误，手工删掉该行）

本项目有过 drizzle 生成 SQL 缺陷的先例，这一步不能跳。

- [ ] **Step 4: 执行迁移**

Run: `npm run db:migrate`
Expected: 无报错

验证：

```bash
docker compose exec -T db psql -U kb -d kbstudio -c "\d wiki_pages" -c "\d ab_runs" -c "select column_name from information_schema.columns where table_name='chunks' and column_name='page_id';"
```
Expected: 两张表结构打印出来，`page_id` 有一行

- [ ] **Step 5: 类型检查并提交**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add packages/db/src/schema.ts packages/db/migrations/
git commit -m "$(cat <<'EOF'
DB 0017：wiki_pages / ab_runs 两表 + chunks.page_id + docs.wiki_status/wiki_error

page_id 与 wiki_status 均可空，现有查询不带这些列，A 套零影响。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: repo 层——wiki 页读写与 chunk→page 映射

**Files:**
- Modify: `packages/db/src/repo.ts`（追加，不改动任何现有函数）
- Modify: `packages/db/src/index.ts`（导出）
- Test: `packages/db/src/wiki.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `wikiPages` / `abRuns` 表对象
- Produces:
  ```ts
  insertWikiPages(pages: WikiPageInput[]): Promise<void>
  listWikiPages(docId: string): Promise<WikiPageRow[]>          // 按 pageIndex 升序
  getWikiPage(docId: string, pageIndex: number): Promise<WikiPageRow | null>
  getWikiOutline(docId: string): Promise<WikiPageRow | null>    // pageIndex=0
  listWikiDocs(docIds: string[]): Promise<Array<{ docId: string; title: string; pageCount: number }>>
  assignChunkPages(docId: string, mapping: Array<{ chunkId: string; pageId: string }>): Promise<void>
  listChunkHeadings(docId: string): Promise<Array<{ id: string; headingPath: string[]; chunkIndex: number }>>
  pageIdsForChunkIds(chunkIds: string[]): Promise<Map<string, string>>
  setWikiStatus(docId: string, status: string, error?: string | null): Promise<void>
  ```

- [ ] **Step 1: 写失败的集成测试**

Create `packages/db/src/wiki.integration.test.ts`:

```ts
// 需要本地 pgvector（npm run db:up）。跑法：npx tsx --test packages/db/src/wiki.integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { upsertDoc, insertWikiPages, listWikiPages, getWikiPage, getWikiOutline, listWikiDocs, setWikiStatus, deleteDoc } from "./repo";

const docId = "doc_test_" + randomUUID().slice(0, 8);

test("wiki 页写入、按序读出、目录页单独取", async () => {
  await upsertDoc({ id: docId, title: "测试文档", source: "test", status: "ready" } as any);
  await insertWikiPages([
    { id: `page_${docId}_0`, docId, pageIndex: 0, title: "目录", content: "1. 甲章\n2. 乙章", headingPath: [], tokenEstimate: 10 },
    { id: `page_${docId}_1`, docId, pageIndex: 1, title: "甲章", content: "甲章正文", headingPath: ["甲章"], tokenEstimate: 5 },
    { id: `page_${docId}_2`, docId, pageIndex: 2, title: "乙章", content: "乙章正文", headingPath: ["乙章"], tokenEstimate: 5 },
  ]);

  const pages = await listWikiPages(docId);
  assert.equal(pages.length, 3);
  assert.equal(pages[0]!.pageIndex, 0);
  assert.equal(pages[2]!.title, "乙章");

  const outline = await getWikiOutline(docId);
  assert.equal(outline?.title, "目录");

  const p2 = await getWikiPage(docId, 2);
  assert.equal(p2?.content, "乙章正文");

  const missing = await getWikiPage(docId, 99);
  assert.equal(missing, null);
});

test("listWikiDocs 只列 wiki_status=ready 的文档，pageCount 不含目录页", async () => {
  await setWikiStatus(docId, "ready");
  const docs = await listWikiDocs([docId]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.pageCount, 2); // 3 行减去目录页

  await setWikiStatus(docId, "failed", "分页失败");
  assert.equal((await listWikiDocs([docId])).length, 0);
});

test("删除文档级联清理 wiki 页", async () => {
  await deleteDoc(docId);
  assert.equal((await listWikiPages(docId)).length, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run db:up && npx tsx --test packages/db/src/wiki.integration.test.ts`
Expected: FAIL — `insertWikiPages is not a function`

- [ ] **Step 3: 实现 repo 函数**

Append to `packages/db/src/repo.ts`（文件末尾）：

```ts
// ───────────────────────── wiki 页（B 套加工产物） ─────────────────────────

export interface WikiPageInput {
  id: string;
  docId: string;
  pageIndex: number;
  title: string;
  content: string;
  headingPath: string[];
  tokenEstimate: number;
}

/** 整篇覆盖式写入：先清掉该文档已有的页，再插新页（重跑 wiki 化时幂等）。 */
export async function insertWikiPages(pages: WikiPageInput[]): Promise<void> {
  if (pages.length === 0) return;
  const docId = pages[0]!.docId;
  await db.delete(wikiPages).where(eq(wikiPages.docId, docId));
  await db.insert(wikiPages).values(pages);
}

export async function listWikiPages(docId: string): Promise<WikiPageRow[]> {
  return db.select().from(wikiPages).where(eq(wikiPages.docId, docId)).orderBy(asc(wikiPages.pageIndex));
}

export async function getWikiPage(docId: string, pageIndex: number): Promise<WikiPageRow | null> {
  const rows = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.docId, docId), eq(wikiPages.pageIndex, pageIndex)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWikiOutline(docId: string): Promise<WikiPageRow | null> {
  return getWikiPage(docId, 0);
}

/** 只列 wiki_status=ready 的文档；pageCount 不含目录页（page_index=0）。 */
export async function listWikiDocs(docIds: string[]): Promise<Array<{ docId: string; title: string; pageCount: number }>> {
  if (docIds.length === 0) return [];
  const rows = await db
    .select({ docId: docs.id, title: docs.title, pageIndex: wikiPages.pageIndex })
    .from(docs)
    .innerJoin(wikiPages, eq(wikiPages.docId, docs.id))
    .where(and(inArray(docs.id, docIds), eq(docs.wikiStatus, "ready")));

  // 在 Node 层聚合：页数不含目录页（page_index=0）
  const byDoc = new Map<string, { docId: string; title: string; pageCount: number }>();
  for (const r of rows) {
    const cur = byDoc.get(r.docId) ?? { docId: r.docId, title: r.title, pageCount: 0 };
    if (r.pageIndex > 0) cur.pageCount++;
    byDoc.set(r.docId, cur);
  }
  return [...byDoc.values()].sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

export async function setWikiStatus(docId: string, status: string, error: string | null = null): Promise<void> {
  await db.update(docs).set({ wikiStatus: status, wikiError: error }).where(eq(docs.id, docId));
}

/** 取该文档全部 chunk 的 heading_path（用于在 Node 层做 chunk→page 映射）。 */
export async function listChunkHeadings(docId: string): Promise<Array<{ id: string; headingPath: string[]; chunkIndex: number }>> {
  const rows = await db
    .select({ id: chunks.id, metadata: chunks.metadata, chunkIndex: chunks.chunkIndex })
    .from(chunks)
    .where(eq(chunks.docId, docId))
    .orderBy(asc(chunks.chunkIndex));
  return rows.map((r) => ({ id: r.id, headingPath: (r.metadata as any)?.heading_path ?? [], chunkIndex: r.chunkIndex }));
}

/**
 * 批量回填 chunks.page_id。按 pageId 分组，每组一条参数化 UPDATE
 * （页数通常几十，远少于 chunk 数；不拼 raw SQL）。
 */
export async function assignChunkPages(docId: string, mapping: Array<{ chunkId: string; pageId: string }>): Promise<void> {
  if (mapping.length === 0) return;
  const byPage = new Map<string, string[]>();
  for (const m of mapping) {
    const list = byPage.get(m.pageId) ?? [];
    list.push(m.chunkId);
    byPage.set(m.pageId, list);
  }
  for (const [pageId, chunkIds] of byPage) {
    await db
      .update(chunks)
      .set({ pageId })
      .where(and(eq(chunks.docId, docId), inArray(chunks.id, chunkIds)));
  }
}

/** chunkId → pageId 映射（agent 工具把命中的 chunk 折算成所属页时用）。 */
export async function pageIdsForChunkIds(chunkIds: string[]): Promise<Map<string, string>> {
  if (chunkIds.length === 0) return new Map();
  const rows = await db.select({ id: chunks.id, pageId: chunks.pageId }).from(chunks).where(inArray(chunks.id, chunkIds));
  const m = new Map<string, string>();
  for (const r of rows) if (r.pageId) m.set(r.id, r.pageId);
  return m;
}
```

文件顶部导入补齐（若尚未导入）：`wikiPages`、`WikiPageRow` from `./schema`，以及 drizzle 的 `asc`、`inArray`。本文件全部用 drizzle 查询构造器，不拼 raw SQL 字符串。

- [ ] **Step 4: 导出**

In `packages/db/src/index.ts`，确认 `export * from "./repo"` 与 `export * from "./schema"` 已覆盖新增内容（本项目用整包导出，通常无需改动；若是逐个具名导出则补上新函数名与 `WikiPageRow`/`AbRunRow`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test packages/db/src/wiki.integration.test.ts`
Expected: PASS 3/3

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add packages/db/src/repo.ts packages/db/src/index.ts packages/db/src/wiki.integration.test.ts
git commit -m "$(cat <<'EOF'
repo：wiki 页读写 + chunk→page 批量回填

全部为追加函数，未改动任何现有 repo 函数。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: buildWiki —— 分页 + 目录页 + 回填

**Files:**
- Create: `packages/pipeline/src/wiki.ts`
- Test: `packages/pipeline/src/wiki.test.ts`
- Modify: `packages/pipeline/src/index.ts`（导出）
- Modify: `packages/adapters/src/llm/prompts.ts`（目录页提示词）

**Interfaces:**
- Consumes: `paginate` / `Page`（Task 1）、`insertWikiPages` / `listChunkHeadings` / `assignChunkPages` / `setWikiStatus`（Task 3）、`LlmBackend.structure`
- Produces:
  ```ts
  export function mapChunksToPages(
    chunkHeadings: Array<{ id: string; headingPath: string[]; chunkIndex: number }>,
    pages: Page[],
  ): Array<{ chunkId: string; pageIndex: number }>
  export async function buildWiki(docId: string, markdown: string, deps: { llm: LlmBackend }, opts?: BuildWikiOptions): Promise<{ pageCount: number }>
  ```

- [ ] **Step 1: 写映射函数的失败测试**

Create `packages/pipeline/src/wiki.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapChunksToPages } from "./wiki";
import type { Page } from "@kb/core";

const pages: Page[] = [
  { pageIndex: 1, title: "甲章", content: "", headingPath: ["制度", "甲章"], tokenEstimate: 0 },
  { pageIndex: 2, title: "乙章", content: "", headingPath: ["制度", "乙章"], tokenEstimate: 0 },
];

test("按 heading_path 最长前缀匹配归属页", () => {
  const out = mapChunksToPages(
    [
      { id: "c1", headingPath: ["制度", "甲章", "第一条"], chunkIndex: 0 },
      { id: "c2", headingPath: ["制度", "乙章"], chunkIndex: 1 },
    ],
    pages,
  );
  assert.deepEqual(out, [
    { chunkId: "c1", pageIndex: 1 },
    { chunkId: "c2", pageIndex: 2 },
  ]);
});

test("无命中的 chunk（前言）归第一页", () => {
  const out = mapChunksToPages([{ id: "c0", headingPath: ["制度"], chunkIndex: 0 }], pages);
  assert.deepEqual(out, [{ chunkId: "c0", pageIndex: 1 }]);
});

test("跨页 chunk 归起始页：按 chunk_index 顺序，命中多页时取序号更小的页", () => {
  // c3 的路径同时能匹配甲章（前缀）——取最长前缀，若并列则取 pageIndex 更小者
  const out = mapChunksToPages([{ id: "c3", headingPath: ["制度", "甲章"], chunkIndex: 5 }], pages);
  assert.deepEqual(out, [{ chunkId: "c3", pageIndex: 1 }]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test packages/pipeline/src/wiki.test.ts`
Expected: FAIL — `Cannot find module './wiki'`

- [ ] **Step 3: 实现 wiki.ts**

Create `packages/pipeline/src/wiki.ts`:

```ts
import { paginate, estimateTokens, type Page, type LlmBackend } from "@kb/core";
import { insertWikiPages, listChunkHeadings, assignChunkPages, setWikiStatus } from "@kb/db";
import { buildOutlineUserPrompt, OUTLINE_SYSTEM } from "@kb/adapters";

export interface BuildWikiOptions {
  maxPageTokens?: number;
  minPageTokens?: number;
  signal?: AbortSignal;
  onProgress?: (p: { stage: "paginate" | "outline" | "persist"; done: number; total: number }) => void;
}

/**
 * buildWiki 需要的 LLM 能力：structure 来自 LlmBackend；answerRaw 是 LlmClient 的扩展方法
 * （Task 5 实现），豆包后端没有——所以声明为可选，缺失时目录页走确定性兜底。
 */
export type WikiLlm = LlmBackend & {
  answerRaw?: (system: string, user: string, opts?: { model?: string; maxTokens?: number }) => Promise<string>;
};

/**
 * chunk → page 映射：chunk 的 heading_path 与页的 headingPath 做最长前缀匹配。
 * 并列时取 pageIndex 更小者（跨页 chunk 归起始页）；无命中归第 1 页（文档前言）。
 * 纯函数，可离线测。
 */
export function mapChunksToPages(
  chunkHeadings: Array<{ id: string; headingPath: string[]; chunkIndex: number }>,
  pages: Page[],
): Array<{ chunkId: string; pageIndex: number }> {
  if (pages.length === 0) return [];
  const firstPage = pages[0]!.pageIndex;
  return chunkHeadings.map((c) => {
    let bestLen = -1;
    let bestPage = firstPage;
    for (const p of pages) {
      const ph = p.headingPath;
      if (ph.length === 0) continue;
      const isPrefix = ph.every((seg, i) => c.headingPath[i] === seg);
      if (!isPrefix) continue;
      if (ph.length > bestLen) {
        bestLen = ph.length;
        bestPage = p.pageIndex;
      }
    }
    return { chunkId: c.id, pageIndex: bestPage };
  });
}

/** 确定性目录（LLM 生成失败时的兜底）：只列序号 + 标题，不加说明。 */
function fallbackOutline(pages: Page[]): string {
  return pages.map((p) => `${p.pageIndex}. ${p.title}`).join("\n");
}

/**
 * 构建 wiki：分页 → 目录页 → 写 wiki_pages → 回填 chunks.page_id。
 * 无标题的文档先跑 structure() 造标题（与上传流程同一判据）。
 */
export async function buildWiki(
  docId: string,
  markdown: string,
  deps: { llm: WikiLlm },
  opts: BuildWikiOptions = {},
): Promise<{ pageCount: number }> {
  const headingCount = (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
  let md = markdown;
  if (headingCount === 0) {
    try {
      md = await deps.llm.structure(markdown);
    } catch {
      md = markdown; // 造结构失败退回原文，仍能整篇成一页
    }
  }
  opts.signal?.throwIfAborted();

  opts.onProgress?.({ stage: "paginate", done: 0, total: 1 });
  const pages = paginate(md, { maxPageTokens: opts.maxPageTokens, minPageTokens: opts.minPageTokens });
  if (pages.length === 0) throw new Error("分页结果为空（文档无正文）");
  opts.signal?.throwIfAborted();

  // 目录页：只让模型写一句话说明，不改标题、不新增页
  opts.onProgress?.({ stage: "outline", done: 0, total: 1 });
  let outlineContent: string;
  try {
    const listing = pages.map((p) => `${p.pageIndex}. ${p.title}\n${p.content.slice(0, 200)}`).join("\n\n");
    outlineContent = (await deps.llm.answerRaw?.(OUTLINE_SYSTEM, buildOutlineUserPrompt(listing))) ?? "";
    if (!outlineContent.trim()) outlineContent = fallbackOutline(pages);
  } catch {
    outlineContent = fallbackOutline(pages);
  }
  opts.signal?.throwIfAborted();

  opts.onProgress?.({ stage: "persist", done: 0, total: 2 });
  await insertWikiPages([
    {
      id: `page_${docId}_0`,
      docId,
      pageIndex: 0,
      title: "目录",
      content: outlineContent,
      headingPath: [],
      tokenEstimate: estimateTokens(outlineContent),
    },
    ...pages.map((p) => ({
      id: `page_${docId}_${p.pageIndex}`,
      docId,
      pageIndex: p.pageIndex,
      title: p.title,
      content: p.content,
      headingPath: p.headingPath,
      tokenEstimate: p.tokenEstimate,
    })),
  ]);

  const chunkHeadings = await listChunkHeadings(docId);
  const mapping = mapChunksToPages(chunkHeadings, pages).map((m) => ({
    chunkId: m.chunkId,
    pageId: `page_${docId}_${m.pageIndex}`,
  }));
  await assignChunkPages(docId, mapping);
  opts.onProgress?.({ stage: "persist", done: 2, total: 2 });

  await setWikiStatus(docId, "ready");
  return { pageCount: pages.length };
}
```

> `deps.llm.answerRaw` 在 Task 5 加到 `LlmClient` 上（一次无工具、无 citations 的纯文本调用）。此处用可选链 + 兜底，Task 5 完成前目录页走确定性兜底，不阻塞本任务。

- [ ] **Step 4: 加目录页提示词**

Append to `packages/adapters/src/llm/prompts.ts`:

```ts
/** 目录页：模型只写每页一句话说明，不得改标题、不得增删页。 */
export const OUTLINE_SYSTEM =
  "你在为一份文档生成目录页。输入是每一页的序号、标题和开头片段。\n" +
  "输出格式：每页一行，形如「序号. 标题 —— 一句话说明这页讲什么」。\n" +
  "严格要求：不得修改任何标题原文；不得增加或删除页；不得输出目录之外的任何内容；说明控制在 30 字以内。";

export function buildOutlineUserPrompt(listing: string): string {
  return `以下是各页的序号、标题与开头片段：\n\n${listing}\n\n请输出目录。`;
}
```

**这两个导出必须加进 `packages/adapters/src/index.ts`**，否则 Task 4 的 `from "@kb/adapters"` 导入会失败——该 index 是逐个具名导出，`prompts.ts` 的内容目前一个都没导出。在 `export { LlmClient } ...` 那一组附近追加：

```ts
// wiki 目录页提示词（buildWiki 用）
export { OUTLINE_SYSTEM, buildOutlineUserPrompt } from "./llm/prompts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test packages/pipeline/src/wiki.test.ts`
Expected: PASS 3/3

- [ ] **Step 6: 导出、类型检查、提交**

In `packages/pipeline/src/index.ts` 追加 `export * from "./wiki";`

Run: `npm run typecheck`

```bash
git add packages/pipeline/src/wiki.ts packages/pipeline/src/wiki.test.ts packages/pipeline/src/index.ts packages/adapters/src/llm/prompts.ts
git commit -m "$(cat <<'EOF'
buildWiki：分页 → 目录页 → 回填 chunks.page_id

chunk→page 用 heading_path 最长前缀匹配，在 Node 层做映射后批量 update
（heading_path 存在 metadata jsonb 里，SQL 前缀匹配不划算）。
目录页 LLM 失败时退回确定性目录，不阻塞入库。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: LlmClient.runTools() + usage 透出

**Files:**
- Modify: `packages/adapters/src/llm/llm-client.ts`
- Modify: `packages/adapters/src/llm/ark-llm-client.ts`
- Modify: `packages/core/src/interfaces.ts`
- Modify: `packages/pipeline/src/chat.ts`
- Test: `packages/adapters/src/llm/run-tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/interfaces.ts —— 新增类型，LlmBackend 接口本身不变
  export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown> }
  export interface ToolUseRequest { id: string; name: string; input: Record<string, unknown> }
  export interface RunToolsTurn {
    text: string;
    toolUses: ToolUseRequest[];
    usage: { input: number; output: number };
    stopReason: string;
  }
  export interface TokenUsage { input: number; output: number }
  // AnswerResult 追加可选字段
  export interface AnswerResult { answer: string; sources: AnswerSource[]; usage?: TokenUsage }

  // LlmClient 新增两个方法（不进 LlmBackend 接口）
  runTools(system: string, messages: any[], tools: ToolSpec[], opts?: { model?: string; maxTokens?: number }): Promise<RunToolsTurn>
  answerRaw(system: string, user: string, opts?: { model?: string; maxTokens?: number }): Promise<string>
  ```

- [ ] **Step 1: 加类型定义**

In `packages/core/src/interfaces.ts`，在 `AnswerResult` 定义处改为：

```ts
export interface TokenUsage {
  input: number;
  output: number;
}
export interface AnswerResult {
  answer: string;
  sources: AnswerSource[];
  usage?: TokenUsage; // 只读的可观测性字段，不读即无感知
}
```

在文件中 `LlmBackend` 接口定义之前追加：

```ts
/** 工具循环用的中立结构（不进 LlmBackend 接口，由具体客户端实现 runTools 消费）。 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ToolUseRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface RunToolsTurn {
  text: string;
  toolUses: ToolUseRequest[];
  usage: TokenUsage;
  stopReason: string;
}
```

- [ ] **Step 2: 写 runTools 的失败测试**

Create `packages/adapters/src/llm/run-tools.test.ts`:

```ts
// 只测响应解析，不发真实请求：注入一个假的 messages.create。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolsTurn } from "./llm-client";

test("解析出文本、工具调用与 usage", () => {
  const res = {
    content: [
      { type: "text", text: "我先看看目录。" },
      { type: "tool_use", id: "tu_1", name: "read_outline", input: { docId: "doc_1" } },
    ],
    usage: { input_tokens: 1200, output_tokens: 80 },
    stop_reason: "tool_use",
  };
  const turn = parseToolsTurn(res);
  assert.equal(turn.text, "我先看看目录。");
  assert.equal(turn.toolUses.length, 1);
  assert.equal(turn.toolUses[0]!.name, "read_outline");
  assert.deepEqual(turn.toolUses[0]!.input, { docId: "doc_1" });
  assert.deepEqual(turn.usage, { input: 1200, output: 80 });
  assert.equal(turn.stopReason, "tool_use");
});

test("没有工具调用时 toolUses 为空数组", () => {
  const turn = parseToolsTurn({
    content: [{ type: "text", text: "答案是三天。" }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  });
  assert.equal(turn.toolUses.length, 0);
  assert.equal(turn.text, "答案是三天。");
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx tsx --test packages/adapters/src/llm/run-tools.test.ts`
Expected: FAIL — `parseToolsTurn is not exported`

- [ ] **Step 4: 实现 parseToolsTurn / runTools / answerRaw**

In `packages/adapters/src/llm/llm-client.ts`，在 `LlmClient` 类定义之前追加导出函数：

```ts
/** 把 Anthropic messages 响应解析成中立的 RunToolsTurn。纯函数，可测。 */
export function parseToolsTurn(res: any): RunToolsTurn {
  let text = "";
  const toolUses: ToolUseRequest[] = [];
  for (const block of res?.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
  }
  return {
    text: text.trim(),
    toolUses,
    usage: { input: res?.usage?.input_tokens ?? 0, output: res?.usage?.output_tokens ?? 0 },
    stopReason: res?.stop_reason ?? "end_turn",
  };
}
```

在 `LlmClient` 类内部，`rewriteQuery` 之后追加两个方法：

```ts
  /** 一次无工具、无 citations 的纯文本调用（目录页生成等内部用途）。 */
  async answerRaw(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
    const res = await this.client.messages.create({
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 2048,
      system,
      messages: [{ role: "user", content: user }],
    });
    return firstText(res);
  }

  /** 带工具的单轮调用：返回本轮文本 + 模型请求的工具调用 + usage。循环由调用方（agentSearch）驱动。 */
  async runTools(
    system: string,
    messages: any[],
    tools: ToolSpec[],
    opts: { model?: string; maxTokens?: number } = {},
  ): Promise<RunToolsTurn> {
    const res: any = await this.client.messages.create({
      model: opts.model ?? process.env.KB_MODEL_ANSWER ?? "claude-opus-4-8",
      max_tokens: opts.maxTokens ?? 2048,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages,
    } as any);
    return parseToolsTurn(res);
  }
```

文件顶部的 `@kb/core` 导入补上 `ToolSpec, ToolUseRequest, RunToolsTurn`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx --test packages/adapters/src/llm/run-tools.test.ts`
Expected: PASS 2/2

- [ ] **Step 6: 透出 usage（A 栏要显示 token 数）**

In `packages/adapters/src/llm/llm-client.ts` 的 `answer()` 方法，把最后一行

```ts
    return { answer: answer.trim(), sources };
```

改成

```ts
    return {
      answer: answer.trim(),
      sources,
      usage: { input: res?.usage?.input_tokens ?? 0, output: res?.usage?.output_tokens ?? 0 },
    };
```

In `packages/adapters/src/llm/ark-llm-client.ts` 的 `answer()` 方法，同样在返回对象里补 `usage`（方舟返回体是 OpenAI 格式，字段为 `res.usage.prompt_tokens` / `res.usage.completion_tokens`）：

```ts
      usage: { input: res?.usage?.prompt_tokens ?? 0, output: res?.usage?.completion_tokens ?? 0 },
```

In `packages/pipeline/src/chat.ts`：`ChatTurnResult` 接口追加 `usage?: TokenUsage;`（从 `@kb/core` 导入类型），并把结尾的 return 改成携带 `usage: (await 的 answer 结果).usage`。具体做法——把

```ts
  const { answer, sources } = await deps.llm.answer(
```

改成

```ts
  const { answer, sources, usage } = await deps.llm.answer(
```

并把最后一行 `return { answer, sources, hits: shownHits, standaloneQuery };` 改成

```ts
  return { answer, sources, hits: shownHits, standaloneQuery, usage };
```

零命中分支的 return 保持不变（不加 usage，因为没调用 LLM）。

- [ ] **Step 7: 确认 A 套行为未变**

Run: `npx tsx --test packages/core/src/chunker.test.ts && npx tsx --test packages/pipeline/src/retrieve.test.ts && npx tsx --test packages/pipeline/src/eval.test.ts`
Expected: 全部 PASS，无用例数变化

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/interfaces.ts packages/adapters/src/llm/ packages/pipeline/src/chat.ts
git commit -m "$(cat <<'EOF'
LlmClient 新增 runTools/answerRaw；answer 透出 token usage

runTools 是 agentic 工具循环的底层原语，不进 LlmBackend 接口，
保持该接口「五个高层任务方法」的抽象层次。usage 为只读增量字段，
不读即无感知，A 套检索与作答行为不变。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: agent 工具集

**Files:**
- Create: `packages/pipeline/src/agent-tools.ts`
- Test: `packages/pipeline/src/agent-tools.test.ts`

**Interfaces:**
- Consumes: Task 3 的 repo 函数、`retrieve` 的底层 `hybridSearch`/`keywordSearch`
- Produces:
  ```ts
  export const TOOL_SPECS: ToolSpec[]
  export interface ToolDeps { embedder: OpenAICompatEmbedder; docIds: string[] }
  export async function runTool(name: string, input: any, deps: ToolDeps): Promise<string>
  ```

`runTool` 返回**字符串**（喂回模型的工具结果）。所有工具都受 `deps.docIds` 白名单约束。

- [ ] **Step 1: 写工具白名单与错误处理的失败测试**

Create `packages/pipeline/src/agent-tools.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_SPECS, formatPagesForModel, clampDocIds } from "./agent-tools";

test("五个工具规格齐全且各有 input_schema", () => {
  const names = TOOL_SPECS.map((t) => t.name).sort();
  assert.deepEqual(names, ["grep", "list_docs", "read_outline", "read_page", "search"]);
  for (const t of TOOL_SPECS) {
    assert.ok(t.description.length > 0, `${t.name} 缺 description`);
    assert.equal((t.input_schema as any).type, "object");
  }
});

test("clampDocIds：越权的 docId 被过滤掉，空入参回全部白名单", () => {
  const allowed = ["doc_1", "doc_2"];
  assert.deepEqual(clampDocIds(["doc_1", "doc_9"], allowed), ["doc_1"]);
  assert.deepEqual(clampDocIds(undefined, allowed), allowed);
  assert.deepEqual(clampDocIds(["doc_9"], allowed), []);
});

test("formatPagesForModel 超长时截断并提示可读续页", () => {
  const long = "字".repeat(50000);
  const out = formatPagesForModel([{ docId: "d", pageIndex: 3, title: "甲章", content: long }], 1000);
  assert.ok(out.includes("甲章"));
  assert.ok(out.includes("已截断"));
  assert.ok(out.length < long.length);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test packages/pipeline/src/agent-tools.test.ts`
Expected: FAIL — `Cannot find module './agent-tools'`

- [ ] **Step 3: 实现 agent-tools.ts**

Create `packages/pipeline/src/agent-tools.ts`:

```ts
import type { ToolSpec } from "@kb/core";
import { estimateTokens } from "@kb/core";
import {
  hybridSearch,
  keywordSearch,
  listWikiDocs,
  listWikiPages,
  getWikiPage,
  getWikiOutline,
  pageIdsForChunkIds,
} from "@kb/db";
import type { OpenAICompatEmbedder } from "@kb/adapters";

/** 单次 read_page 注入模型的 token 上限（超出截断并提示可读续页）。 */
const MAX_PAGE_TOKENS = 8000;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_docs",
    description: "列出当前可检索范围内的全部文档（标题与页数）。不知道该从哪份资料入手时先调它。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_outline",
    description: "读某份文档的目录页，了解它分几页、每页讲什么。决定读哪一页之前先调它。",
    input_schema: {
      type: "object",
      properties: { docId: { type: "string", description: "文档 id" } },
      required: ["docId"],
    },
  },
  {
    name: "read_page",
    description: "读某份文档某一页的完整正文。需要完整条款、完整流程时用它，不要只凭检索片段作答。",
    input_schema: {
      type: "object",
      properties: {
        docId: { type: "string", description: "文档 id" },
        pageIndex: { type: "number", description: "页序号，从 1 开始；0 是目录页" },
      },
      required: ["docId", "pageIndex"],
    },
  },
  {
    name: "grep",
    description: "关键词精确检索，适合查具体型号、编号、金额、专有名词。返回命中所在的页。",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键词" },
        docIds: { type: "array", items: { type: "string" }, description: "限定文档，省略则全范围" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "search",
    description: "语义检索，适合用自然语言描述的问题。返回命中内容所在的页（不是碎片）。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言查询" },
        docIds: { type: "array", items: { type: "string" }, description: "限定文档，省略则全范围" },
      },
      required: ["query"],
    },
  },
];

export interface ToolDeps {
  embedder: OpenAICompatEmbedder;
  docIds: string[]; // 白名单：本次会话可访问的全部文档
}

/** 把模型传来的 docIds 收窄到白名单内；未传则用全部白名单。 */
export function clampDocIds(requested: string[] | undefined, allowed: string[]): string[] {
  if (!requested || requested.length === 0) return allowed;
  const set = new Set(allowed);
  return requested.filter((id) => set.has(id));
}

/** 把页列表渲染成喂回模型的文本，单页超预算则截断并提示。 */
export function formatPagesForModel(
  pages: Array<{ docId: string; pageIndex: number; title: string; content: string }>,
  maxTokens = MAX_PAGE_TOKENS,
): string {
  return pages
    .map((p) => {
      let body = p.content;
      if (estimateTokens(body) > maxTokens) {
        // 粗略按字符比例截断（estimateTokens 与字符数近似线性）
        const ratio = maxTokens / estimateTokens(body);
        body = body.slice(0, Math.max(1, Math.floor(body.length * ratio))) + "\n\n…（本页已截断，可读下一页续页）";
      }
      return `【${p.docId} 第${p.pageIndex}页 · ${p.title}】\n${body}`;
    })
    .join("\n\n---\n\n");
}

/** 命中的 chunk id 折算成所属页，去重后按页返回。未跑 wiki 化的 chunk（无 page_id）被跳过。 */
async function chunksToPages(chunkIds: string[]): Promise<Array<{ docId: string; pageIndex: number; title: string; content: string }>> {
  const pageIdByChunk = await pageIdsForChunkIds(chunkIds);
  const seen = new Set<string>();
  const out: Array<{ docId: string; pageIndex: number; title: string; content: string }> = [];
  for (const cid of chunkIds) {
    const pid = pageIdByChunk.get(cid);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    // page id 形如 page_<docId>_<idx>，末段是序号，其余是 docId
    const lastUnderscore = pid.lastIndexOf("_");
    const docId = pid.slice("page_".length, lastUnderscore);
    const pageIndex = Number(pid.slice(lastUnderscore + 1));
    const page = await getWikiPage(docId, pageIndex);
    if (page) out.push({ docId, pageIndex, title: page.title, content: page.content });
  }
  return out;
}

/** 执行一个工具，返回喂回模型的文本。工具自身的错误也以文本返回，让模型自纠而不是中断循环。 */
export async function runTool(name: string, input: any, deps: ToolDeps): Promise<string> {
  try {
    switch (name) {
      case "list_docs": {
        const docs = await listWikiDocs(deps.docIds);
        if (docs.length === 0) return "当前范围内没有已生成 wiki 页的文档。";
        return docs.map((d) => `${d.docId} · ${d.title}（${d.pageCount} 页）`).join("\n");
      }
      case "read_outline": {
        const docId = String(input?.docId ?? "");
        if (!deps.docIds.includes(docId)) return `错误：文档 ${docId} 不在可访问范围内。请先用 list_docs 查看可用文档。`;
        const outline = await getWikiOutline(docId);
        if (!outline) return `错误：文档 ${docId} 没有目录页（可能未生成 wiki）。`;
        const pages = await listWikiPages(docId);
        const maxIndex = Math.max(...pages.map((p) => p.pageIndex));
        return `【${docId} 目录】共 ${maxIndex} 页\n${outline.content}`;
      }
      case "read_page": {
        const docId = String(input?.docId ?? "");
        const pageIndex = Number(input?.pageIndex);
        if (!deps.docIds.includes(docId)) return `错误：文档 ${docId} 不在可访问范围内。`;
        if (!Number.isInteger(pageIndex) || pageIndex < 0) return `错误：pageIndex 必须是不小于 0 的整数，收到 ${input?.pageIndex}。`;
        const page = await getWikiPage(docId, pageIndex);
        if (!page) {
          const pages = await listWikiPages(docId);
          const maxIndex = pages.length ? Math.max(...pages.map((p) => p.pageIndex)) : 0;
          return `错误：文档 ${docId} 没有第 ${pageIndex} 页，有效范围是 0-${maxIndex}。`;
        }
        return formatPagesForModel([{ docId, pageIndex, title: page.title, content: page.content }]);
      }
      case "grep": {
        const keyword = String(input?.keyword ?? "").trim();
        if (!keyword) return "错误：keyword 不能为空。";
        const scope = clampDocIds(input?.docIds, deps.docIds);
        if (scope.length === 0) return "错误：指定的文档都不在可访问范围内。";
        const hits = await keywordSearch(keyword, 10, scope);
        const pages = await chunksToPages(hits.map((h) => h.id));
        if (pages.length === 0) return `没有命中「${keyword}」。`;
        return pages.map((p) => `${p.docId} 第${p.pageIndex}页 · ${p.title}`).join("\n");
      }
      case "search": {
        const query = String(input?.query ?? "").trim();
        if (!query) return "错误：query 不能为空。";
        const scope = clampDocIds(input?.docIds, deps.docIds);
        if (scope.length === 0) return "错误：指定的文档都不在可访问范围内。";
        const [qv] = await deps.embedder.embed([query]);
        const hits = await hybridSearch(query, qv!, 10, 10, scope);
        const pages = await chunksToPages(hits.map((h) => h.id));
        if (pages.length === 0) return `没有检索到与「${query}」相关的页。`;
        return pages.map((p) => `${p.docId} 第${p.pageIndex}页 · ${p.title}`).join("\n");
      }
      default:
        return `错误：未知工具 ${name}。可用工具：${TOOL_SPECS.map((t) => t.name).join("、")}。`;
    }
  } catch (e: any) {
    return `工具 ${name} 执行出错：${String(e?.message ?? e).slice(0, 300)}`;
  }
}
```

> `grep` / `search` 只返回**页的定位信息**（哪份文档第几页），不直接灌正文——让模型自己决定读哪页，这是「导航」而非「检索」的关键。正文由 `read_page` 提供。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test packages/pipeline/src/agent-tools.test.ts`
Expected: PASS 3/3

- [ ] **Step 5: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add packages/pipeline/src/agent-tools.ts packages/pipeline/src/agent-tools.test.ts
git commit -m "$(cat <<'EOF'
agent 工具集：list_docs / read_outline / read_page / grep / search

grep 与 search 只返回页的定位信息不灌正文，正文由 read_page 提供——
这是「导航」而非「检索」的关键。全部工具受 docIds 白名单约束，
工具自身错误以文本返回让模型自纠，不中断循环。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: agentSearch 工具循环

**Files:**
- Create: `packages/pipeline/src/agent-search.ts`
- Test: `packages/pipeline/src/agent-search.test.ts`
- Modify: `packages/pipeline/src/index.ts`

**Interfaces:**
- Consumes: Task 5 的 `runTools`、Task 6 的 `TOOL_SPECS` / `runTool`
- Produces:
  ```ts
  export interface AgentSearchResult {
    answer: string;
    trace: Array<{ step: number; tool: string; args: unknown; resultSummary: string; ms: number }>;
    tokens: { input: number; output: number };
    turnsUsed: number;
    truncated: boolean;
  }
  export async function agentSearch(query: string, deps: AgentSearchDeps, opts?: AgentSearchOptions): Promise<AgentSearchResult>
  ```

- [ ] **Step 1: 写循环行为的失败测试（假 LLM + 假工具）**

Create `packages/pipeline/src/agent-search.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSearch } from "./agent-search";

/** 假 LLM：按预设脚本逐轮返回。 */
function fakeLlm(script: Array<{ text: string; toolUses: Array<{ id: string; name: string; input: any }>; stopReason?: string }>) {
  let i = 0;
  return {
    async runTools() {
      const turn = script[Math.min(i, script.length - 1)]!;
      i++;
      return {
        text: turn.text,
        toolUses: turn.toolUses,
        usage: { input: 100, output: 20 },
        stopReason: turn.stopReason ?? (turn.toolUses.length ? "tool_use" : "end_turn"),
      };
    },
  } as any;
}

const noopDeps = { embedder: {} as any, docIds: ["doc_1"] };

test("模型不再请求工具时循环终止并返回答案", async () => {
  const llm = fakeLlm([
    { text: "", toolUses: [{ id: "t1", name: "list_docs", input: {} }] },
    { text: "答案是三天。", toolUses: [] },
  ]);
  const r = await agentSearch("多久到账？", { llm, ...noopDeps }, { runToolFn: async () => "doc_1 · 手册（3 页）" });
  assert.equal(r.answer, "答案是三天。");
  assert.equal(r.trace.length, 1);
  assert.equal(r.trace[0]!.tool, "list_docs");
  assert.equal(r.truncated, false);
  assert.equal(r.tokens.input, 200); // 两轮各 100
});

test("maxTurns 耗尽时不报错，强制作答并标 truncated", async () => {
  const llm = fakeLlm([{ text: "", toolUses: [{ id: "t", name: "list_docs", input: {} }] }]); // 永远要工具
  const r = await agentSearch("问题", { llm, ...noopDeps }, { maxTurns: 3, runToolFn: async () => "结果" });
  assert.equal(r.truncated, true);
  assert.equal(r.turnsUsed, 3);
  assert.ok(r.trace.length >= 3);
});

test("工具报错不中断循环，错误文本回灌给模型", async () => {
  const llm = fakeLlm([
    { text: "", toolUses: [{ id: "t1", name: "read_page", input: { docId: "doc_1", pageIndex: 99 } }] },
    { text: "改读第 1 页后得到答案。", toolUses: [] },
  ]);
  const r = await agentSearch("问题", { llm, ...noopDeps }, { runToolFn: async () => "错误：没有第 99 页，有效范围是 0-3。" });
  assert.equal(r.answer, "改读第 1 页后得到答案。");
  assert.ok(r.trace[0]!.resultSummary.includes("错误"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test packages/pipeline/src/agent-search.test.ts`
Expected: FAIL — `Cannot find module './agent-search'`

- [ ] **Step 3: 实现 agent-search.ts**

Create `packages/pipeline/src/agent-search.ts`:

```ts
import { estimateTokens } from "@kb/core";
import type { OpenAICompatEmbedder } from "@kb/adapters";
import { TOOL_SPECS, runTool, type ToolDeps } from "./agent-tools";

/** 累计注入的工具结果 token 上限：超过则停止接受新工具调用，转为强制作答。 */
const CONTEXT_BUDGET_TOKENS = 120_000;

export const AGENT_SYSTEM =
  "你是知识库检索助手，通过工具自主查阅资料后作答。\n" +
  "工作方式：先用 list_docs / search / grep 定位到相关文档，再用 read_outline 看它的结构，" +
  "再用 read_page 读完整的一页。需要完整条款或完整流程时必须读整页，不要只凭检索到的定位信息猜测内容。\n" +
  "涉及多个主题时分别读对应的页，注意页与页之间的关联（例如某页的规则是否被另一页修正）。\n" +
  "信息足够就立即作答，不要无谓翻页。作答只依据读到的资料，不编造；说明依据来自哪份文档的哪一页。";

export interface AgentSearchDeps {
  llm: { runTools: (system: string, messages: any[], tools: any[], opts?: any) => Promise<any> };
  embedder: OpenAICompatEmbedder;
  docIds: string[];
}

export interface AgentSearchOptions {
  maxTurns?: number;
  model?: string;
  /** 注入式工具执行器（测试用假实现；生产默认走 agent-tools 的 runTool）。 */
  runToolFn?: (name: string, input: any, deps: ToolDeps) => Promise<string>;
}

export interface AgentTraceStep {
  step: number;
  tool: string;
  args: unknown;
  resultSummary: string;
  ms: number;
}

export interface AgentSearchResult {
  answer: string;
  trace: AgentTraceStep[];
  tokens: { input: number; output: number };
  turnsUsed: number;
  truncated: boolean;
}

export async function agentSearch(
  query: string,
  deps: AgentSearchDeps,
  opts: AgentSearchOptions = {},
): Promise<AgentSearchResult> {
  const maxTurns = opts.maxTurns ?? 12;
  const exec = opts.runToolFn ?? runTool;
  const toolDeps: ToolDeps = { embedder: deps.embedder, docIds: deps.docIds };

  const messages: any[] = [{ role: "user", content: query }];
  const trace: AgentTraceStep[] = [];
  const tokens = { input: 0, output: 0 };
  let injected = 0; // 已注入的工具结果 token
  let truncated = false;
  let answer = "";
  let turnsUsed = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    const budgetExhausted = injected >= CONTEXT_BUDGET_TOKENS;
    // 预算耗尽或最后一轮：不再给工具，强制模型基于已读内容作答。
    // 一旦进入强制作答，本次结果就是「信息可能不全」的，标 truncated。
    const forceAnswer = budgetExhausted || turn === maxTurns - 1;
    if (forceAnswer) truncated = true;
    const res = await deps.llm.runTools(
      forceAnswer ? `${AGENT_SYSTEM}\n\n注意：不能再查阅资料了，请基于已读到的内容直接作答；若信息不足，如实说明缺什么。` : AGENT_SYSTEM,
      messages,
      forceAnswer ? [] : TOOL_SPECS,
      { model: opts.model },
    );
    tokens.input += res.usage?.input ?? 0;
    tokens.output += res.usage?.output ?? 0;

    if (!res.toolUses || res.toolUses.length === 0) {
      answer = res.text;
      break;
    }

    // 模型请求工具：本轮把 assistant 的 tool_use 块与工具结果一并追加进 messages
    messages.push({
      role: "assistant",
      content: [
        ...(res.text ? [{ type: "text", text: res.text }] : []),
        ...res.toolUses.map((t: any) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
      ],
    });

    const results: any[] = [];
    for (const t of res.toolUses) {
      const started = Date.now();
      const out = await exec(t.name, t.input, toolDeps);
      const ms = Date.now() - started;
      injected += estimateTokens(out);
      trace.push({
        step: trace.length + 1,
        tool: t.name,
        args: t.input,
        resultSummary: out.length > 200 ? `${out.slice(0, 200)}…` : out,
        ms,
      });
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }

  if (!answer) {
    answer = "未能在限定轮次内得出答案。";
    truncated = true;
  }
  return { answer, trace, tokens, turnsUsed, truncated };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test packages/pipeline/src/agent-search.test.ts`
Expected: PASS 3/3

- [ ] **Step 5: 导出、类型检查、提交**

In `packages/pipeline/src/index.ts` 追加：

```ts
export * from "./agent-search";
export * from "./agent-tools";
```

Run: `npm run typecheck`

```bash
git add packages/pipeline/src/agent-search.ts packages/pipeline/src/agent-search.test.ts packages/pipeline/src/index.ts
git commit -m "$(cat <<'EOF'
agentSearch：手写工具循环 + 轮次/上下文双闸

轮次耗尽或注入 token 超 120k 时不报错，撤掉工具让模型基于已读内容作答
并标 truncated。工具执行器可注入，便于用假实现离线测循环行为。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: /api/ab 路由 + ab_runs repo

**Files:**
- Modify: `packages/db/src/repo.ts`（追加 ab_runs CRUD）
- Create: `apps/web/app/api/ab/route.ts`
- Create: `apps/web/app/api/ab/[runId]/route.ts`

**Interfaces:**
- Consumes: `chatTurn`（A 栏）、`agentSearch`（B 栏）、Task 3 的 repo
- Produces:
  ```ts
  insertAbRun(r: AbRunInput): Promise<void>
  setAbVerdict(id: string, verdict: string, userId: string): Promise<void>
  // POST /api/ab  → { runId, a: {...}, b: {...} }
  // PATCH /api/ab/[runId]  body { verdict }
  ```

- [ ] **Step 1: 加 ab_runs repo 函数**

Append to `packages/db/src/repo.ts`:

```ts
// ───────────────────────── A/B 对比记录 ─────────────────────────

export interface AbRunInput {
  id: string;
  userId: string;
  groupId?: string | null;
  query: string;
  aAnswer?: string | null;
  aHits?: unknown;
  aMs?: number | null;
  aTokens?: number | null;
  aError?: string | null;
  bAnswer?: string | null;
  bTrace?: unknown;
  bMs?: number | null;
  bTokens?: number | null;
  bError?: string | null;
}

export async function insertAbRun(r: AbRunInput): Promise<void> {
  await db.insert(abRuns).values(r as any);
}

/** 只允许本人改自己的评分。 */
export async function setAbVerdict(id: string, verdict: string, userId: string): Promise<void> {
  await db.update(abRuns).set({ verdict }).where(and(eq(abRuns.id, id), eq(abRuns.userId, userId)));
}
```

顶部导入补 `abRuns`。

- [ ] **Step 2: 实现 POST /api/ab**

Create `apps/web/app/api/ab/route.ts`:

```ts
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatTurn, agentSearch } from "@kb/pipeline";
import { listDocIdsInGroup, listDocIdsForUser, insertAbRun } from "@kb/db";
import { LlmClient } from "@kb/adapters";
import { getDeps } from "../../../lib/kb";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { query, groupId } = await req.json();
    if (!query || typeof query !== "string") return NextResponse.json({ error: "缺少 query" }, { status: 400 });

    // 两栏共用同一个 LLM 后端，否则模型与链路两个变量同时变，A/B 失效。
    // getDeps() 默认返回豆包（ArkLlmClient，不支持 runTools），这里显式构造 302/Claude 客户端。
    // /chat 生产链路仍走 getDeps() 的默认后端，不受影响。
    const { embedder, reranker } = getDeps();
    const llm = new LlmClient({});

    // 检索隔离：与 /api/chat 同一信任边界
    const allowed = new Set(await listDocIdsForUser(auth.userId));
    let docIds: string[];
    if (groupId) docIds = (await listDocIdsInGroup(groupId)).filter((id) => allowed.has(id));
    else docIds = [...allowed];
    if (docIds.length === 0) docIds = ["__none__"];

    const runA = async () => {
      const t0 = Date.now();
      // 参数与 /api/chat 完全一致，保证 A 栏是现状
      const r = await chatTurn([], query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docIds });
      return {
        answer: r.answer,
        hits: r.hits.map((h) => ({ id: h.id, score: h.score, heading_path: h.heading_path, content: h.content })),
        ms: Date.now() - t0,
        tokens: (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
      };
    };

    const runB = async () => {
      const t0 = Date.now();
      const r = await agentSearch(query, { llm: llm as any, embedder, docIds }, { maxTurns: 12 });
      return {
        answer: r.answer,
        trace: r.trace,
        turnsUsed: r.turnsUsed,
        truncated: r.truncated,
        ms: Date.now() - t0,
        tokens: r.tokens.input + r.tokens.output,
      };
    };

    const [ra, rb] = await Promise.allSettled([runA(), runB()]);
    const a = ra.status === "fulfilled" ? ra.value : { error: String((ra.reason as any)?.message ?? ra.reason) };
    const b = rb.status === "fulfilled" ? rb.value : { error: String((rb.reason as any)?.message ?? rb.reason) };

    const runId = "ab_" + randomUUID().slice(0, 8);
    await insertAbRun({
      id: runId,
      userId: auth.userId,
      groupId: groupId ?? null,
      query,
      aAnswer: (a as any).answer ?? null,
      aHits: (a as any).hits ?? null,
      aMs: (a as any).ms ?? null,
      aTokens: (a as any).tokens ?? null,
      aError: (a as any).error ?? null,
      bAnswer: (b as any).answer ?? null,
      bTrace: (b as any).trace ?? null,
      bMs: (b as any).ms ?? null,
      bTokens: (b as any).tokens ?? null,
      bError: (b as any).error ?? null,
    });

    return NextResponse.json({ runId, a, b });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: 实现 PATCH /api/ab/[runId]**

Create `apps/web/app/api/ab/[runId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { setAbVerdict } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

const VALID = new Set(["a", "b", "tie", "neither"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { runId } = await params;
    const { verdict } = await req.json();
    if (!VALID.has(verdict)) return NextResponse.json({ error: "verdict 非法" }, { status: 400 });
    await setAbVerdict(runId, verdict, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

> Next.js 15 的动态路由 `params` 是 Promise，必须 await。参照现有 `apps/web/app/api/docs/[id]/route.ts` 的写法确认签名一致。

- [ ] **Step 4: 放行中间件**

In `apps/web/middleware.ts`，确认 `/ab` 与 `/api/ab` 不在 `PUBLIC` 白名单里（它们需要登录），且不被其他规则误拦。若中间件用的是「非 PUBLIC 即需登录」的逻辑，无需改动——确认即可。

- [ ] **Step 5: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add packages/db/src/repo.ts apps/web/app/api/ab/
git commit -m "$(cat <<'EOF'
/api/ab：两栏并发执行 + 各自容错 + 记录落库

Promise.allSettled 让一栏失败不影响另一栏，失败原因写进 a_error/b_error。
A 栏参数与 /api/chat 完全一致，保证测的是现状。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: /ab 双栏页面

**Files:**
- Create: `apps/web/app/ab/page.tsx`
- Create: `apps/web/components/AbPanel.tsx`

**Interfaces:**
- Consumes: `POST /api/ab`、`PATCH /api/ab/[runId]`、`GET /api/groups`

> **样式约定（有意偏离项目惯例，勿判为缺陷）**：本页用内联 `style` + 现有 CSS 变量（`--border` / `--card` / `--muted` / `--accent`），不往 `globals.css` 加新 class。理由：`/ab` 是内部评测台、不进生产 UI 体系，两栏布局是它独有的，加进全局样式表只会污染生产页面的样式命名空间。颜色一律走既有 CSS 变量，保证暖色主题一致。

- [ ] **Step 1: 实现单栏组件**

Create `apps/web/components/AbPanel.tsx`:

```tsx
"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

export interface AbSide {
  answer?: string;
  hits?: Array<{ id: string; score: number; heading_path: string[]; content: string }>;
  trace?: Array<{ step: number; tool: string; args: unknown; resultSummary: string; ms: number }>;
  turnsUsed?: number;
  truncated?: boolean;
  ms?: number;
  tokens?: number;
  error?: string;
}

export function AbPanel({ label, side, loading }: { label: string; side: AbSide | null; loading: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--card)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
          {loading ? "运行中…" : side ? `${((side.ms ?? 0) / 1000).toFixed(1)}s · ${(side.tokens ?? 0).toLocaleString()} token${side.turnsUsed ? ` · ${side.turnsUsed} 轮` : ""}${side.truncated ? " · 已截断" : ""}` : "—"}
        </div>
      </header>

      <div style={{ padding: 14, flex: 1, overflowX: "auto" }}>
        {side?.error ? (
          <div style={{ color: "var(--danger, #b3261e)", fontSize: 14 }}>失败：{side.error}</div>
        ) : side?.answer ? (
          <ReactMarkdown>{side.answer}</ReactMarkdown>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: 14 }}>{loading ? "…" : "尚未提问"}</div>
        )}
      </div>

      {(side?.hits?.length || side?.trace?.length) && (
        <footer style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ width: "100%", padding: "8px 14px", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--muted)" }}
          >
            {side.hits ? `命中 ${side.hits.length} 个片段` : `工具轨迹 ${side.trace!.length} 步`} {open ? "▴" : "▾"}
          </button>
          {open && (
            <div style={{ padding: "0 14px 14px", fontSize: 13, maxHeight: 320, overflow: "auto" }}>
              {side.hits?.map((h, i) => (
                <div key={h.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ color: "var(--muted)" }}>#{i + 1} · {h.heading_path.join(" / ") || "—"} · {h.score?.toFixed(3)}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{h.content.slice(0, 300)}</div>
                </div>
              ))}
              {side.trace?.map((t) => (
                <div key={t.step} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ color: "var(--muted)" }}>
                    {t.step}. <code>{t.tool}</code>({JSON.stringify(t.args)}) · {t.ms}ms
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{t.resultSummary}</div>
                </div>
              ))}
            </div>
          )}
        </footer>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 实现 /ab 页面**

Create `apps/web/app/ab/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { AbPanel, type AbSide } from "../../components/AbPanel";

interface GroupItem { id: string; name: string }

export default function AbPage() {
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [groupId, setGroupId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [a, setA] = useState<AbSide | null>(null);
  const [b, setB] = useState<AbSide | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => r.json())
      .then((d) => setGroups(d.groups ?? d ?? []))
      .catch(() => {});
  }, []);

  async function ask() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setA(null);
    setB(null);
    setRunId(null);
    setVerdict(null);
    try {
      const res = await fetch("/api/ab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, groupId: groupId || undefined }),
      });
      const d = await res.json();
      if (d.error) {
        setA({ error: d.error });
        setB({ error: d.error });
      } else {
        setA(d.a);
        setB(d.b);
        setRunId(d.runId);
      }
    } catch (e: any) {
      setA({ error: String(e?.message ?? e) });
      setB({ error: String(e?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }

  async function rate(v: string) {
    if (!runId) return;
    setVerdict(v);
    await fetch(`/api/ab/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: v }),
    }).catch(() => {});
  }

  return (
    <main style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ fontFamily: "var(--font-serif, serif)", fontSize: 24, marginBottom: 4 }}>A/B 检索对比</h1>
      <p style={{ color: "var(--muted)", fontSize: 14, marginBottom: 16 }}>
        同一个问题分别走单轮 RAG 与 wiki + agentic 两条链路。每次提问相互独立，不带对话历史。
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)" }}>
          <option value="">全部知识库</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="输入一个坐席会真的问的问题…"
          style={{ flex: 1, minWidth: 260, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)" }}
        />
        <button onClick={ask} disabled={loading || !query.trim()} style={{ padding: "8px 20px", borderRadius: 6, border: "none", background: "var(--accent, #C96442)", color: "#fff", cursor: loading ? "default" : "pointer" }}>
          {loading ? "运行中…" : "对比"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }} className="ab-columns">
        <AbPanel label="A · 单轮 RAG" side={a} loading={loading} />
        <AbPanel label="B · wiki + agentic" side={b} loading={loading} />
      </div>

      {runId && (
        <div style={{ marginTop: 20, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, color: "var(--muted)" }}>这轮谁更好：</span>
          {[
            { v: "a", label: "A 好" },
            { v: "b", label: "B 好" },
            { v: "tie", label: "差不多" },
            { v: "neither", label: "都不行" },
          ].map((o) => (
            <button
              key={o.v}
              onClick={() => rate(o.v)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: verdict === o.v ? "var(--accent, #C96442)" : "transparent",
                color: verdict === o.v ? "#fff" : "inherit",
                cursor: "pointer",
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      <style>{`@media (max-width: 900px) { .ab-columns { flex-direction: column; } }`}</style>
    </main>
  );
}
```

- [ ] **Step 3: 加侧栏入口**

In `apps/web/components/Sidebar.tsx`：现有的 `const onChat = path.startsWith("/chat");`（第 12 行附近）是二元判断，加第三项要改成按当前路径匹配。

把第 12 行改成：

```tsx
  const onChat = path.startsWith("/chat");
  const onAb = path.startsWith("/ab");
  const onKb = !onChat && !onAb;
```

把 `<nav className="seg">` 那一整块（第 75–82 行）替换为：

```tsx
      <nav className="seg">
        <Link href="/" className={onKb ? "on" : ""} aria-current={onKb ? "page" : undefined}>
          知识库
        </Link>
        <Link href="/chat" className={onChat ? "on" : ""} aria-current={onChat ? "page" : undefined}>
          对话
        </Link>
        <Link href="/ab" className={onAb ? "on" : ""} aria-current={onAb ? "page" : undefined}>
          A/B 对比
        </Link>
      </nav>
```

`.seg` 的现有 CSS 若是按两项等分写死的（检查 `apps/web/app/globals.css` 里的 `.seg` 规则），改成 `flex: 1` 均分或直接让它自适应；三项挤不下时缩小字号，不要改成换行。

- [ ] **Step 4: 起服务手工验证**

Run: `npm run dev --workspace @kb/web`

浏览器打开 `http://localhost:3001/ab`：
- 分组下拉能加载
- 输入问题点「对比」，双栏各自出结果或各自报错
- 展开 A 栏「命中 N 个片段」、B 栏「工具轨迹 N 步」
- 点评分按钮后按钮高亮，刷新页面后重新提问不受影响
- 窗口拉窄到 900px 以下，双栏变上下堆叠

- [ ] **Step 5: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add apps/web/app/ab/ apps/web/components/AbPanel.tsx apps/web/components/Sidebar.tsx
git commit -m "$(cat <<'EOF'
/ab 双栏对比页：两栏并排 + 耗时/token 指标 + 轨迹展开 + 逐轮评分

窄屏改上下堆叠。评分即时 PATCH 落库，供后续统计胜率。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 接进上传流程 + 端到端验证

**Files:**
- Modify: `apps/web/lib/kb.ts`
- Create: `apps/worker/src/cli/wiki-demo.ts`
- Modify: `package.json`（加脚本）

**Interfaces:**
- Consumes: `buildWiki`（Task 4）

- [ ] **Step 1: 在后台处理流程末尾接上 buildWiki**

In `apps/web/lib/kb.ts`，找到后台处理函数里 `ingestDoc` 成功之后、置 `status=ready` 之后的位置，追加：

```ts
    // wiki 化（B 套加工）：独立 try/catch，失败不影响主流程与 A 套
    if (process.env.KB_WIKI !== "off") {
      try {
        await setWikiStatus(docId, "pending");
        const { buildWiki } = await import("@kb/pipeline");
        await buildWiki(docId, markdown, { llm }, { signal });
      } catch (e: any) {
        console.warn(`[wiki] doc ${docId} 生成失败：`, e?.message ?? e);
        await setWikiStatus(docId, "failed", String(e?.message ?? e).slice(0, 500));
      }
    }
```

顶部导入补 `setWikiStatus` from `@kb/db`。`markdown` 用的是入库时那份（造过结构的）；`signal` 是现有 abort 信号变量——先 Read 该函数确认这两个变量的实际名称再写。

注意这里的 `llm` 来自 `getDeps()`，**默认是豆包**（无 `answerRaw`），所以上传流程生成的目录页会走确定性兜底：只有「序号. 标题」，没有一句话说明。页正文不受影响（分页是确定性的）。要带说明的目录，把整个 web 服务用 `KB_LLM=claude` 起，或事后用 `KB_LLM=claude npm run wiki-demo -- <docId>` 补跑该文档。

- [ ] **Step 2: 加一个能对已有文档补跑 wiki 的 CLI**

Create `apps/worker/src/cli/wiki-demo.ts`:

```ts
// 给已入库的文档补跑 wiki 化：npm run wiki-demo -- <docId>
import "dotenv/config";
import { buildWiki } from "@kb/pipeline";
import { getDoc, listWikiPages, setWikiStatus } from "@kb/db";
import { makeLlm } from "@kb/adapters";

const docId = process.argv[2];
if (!docId) {
  console.error("用法：npm run wiki-demo -- <docId>");
  process.exit(1);
}

const doc = await getDoc(docId);
if (!doc) {
  console.error(`找不到文档 ${docId}`);
  process.exit(1);
}
const markdown = doc.structuredMd ?? doc.rawText ?? "";
if (!markdown.trim()) {
  console.error("文档没有可用正文（structured_md / raw_text 都为空）");
  process.exit(1);
}

await setWikiStatus(docId, "pending");
const llm = makeLlm();
const { pageCount } = await buildWiki(docId, markdown, { llm }, { onProgress: (p) => console.log(`  ${p.stage} ${p.done}/${p.total}`) });
console.log(`\n✅ 生成 ${pageCount} 页（另加 1 页目录）`);

for (const p of await listWikiPages(docId)) {
  console.log(`  ${p.pageIndex}. ${p.title}（${p.tokenEstimate} token）`);
}
process.exit(0);
```

> `makeLlm` 定义在 `packages/adapters/src/llm/factory.ts`，已由 `@kb/adapters` 导出。注意它**默认返回豆包**（`ArkLlmClient`）——豆包没有 `answerRaw`，所以补跑 wiki 时目录页会走确定性兜底（只有序号+标题，没有一句话说明）。想要带说明的目录，跑之前设 `KB_LLM=claude`：
>
> ```bash
> KB_LLM=claude npm run wiki-demo -- <docId>
> ```

In `package.json` 的 `scripts` 里追加：

```json
    "wiki-demo": "tsx apps/worker/src/cli/wiki-demo.ts",
```

- [ ] **Step 3: 对一份真实文档跑通 wiki 化**

先找一份已入库、章节结构清晰的文档：

```bash
docker compose exec -T db psql -U kb -d kbstudio -c "select id, title, length(coalesce(structured_md, raw_text)) as len from docs where status='ready' order by created_at desc limit 10;"
```

挑一个 len 较大的，跑：

Run: `npm run wiki-demo -- <docId>`
Expected: 打印各页标题与 token 数，页数合理（不是 1 页也不是几百页）

验证 chunk 回填：

```bash
docker compose exec -T db psql -U kb -d kbstudio -c "select count(*) total, count(page_id) mapped from chunks where doc_id='<docId>';"
```
Expected: `mapped` 等于 `total`（全部回填）

- [ ] **Step 4: 端到端跑一次 A/B**

Run: `npm run dev --workspace @kb/web`

在 `/ab` 提一个**需要跨章节综合**的问题（针对刚才那份文档），确认：
- 两栏都出答案
- B 栏轨迹里能看到 `read_outline` + 至少两次 `read_page`
- B 栏耗时明显长于 A 栏、token 明显多于 A 栏（这是预期的，不是 bug）

- [ ] **Step 5: 全量回归**

Run:
```bash
npx tsx --test packages/core/src/chunker.test.ts
npx tsx --test packages/core/src/paginator.test.ts
npx tsx --test packages/pipeline/src/retrieve.test.ts
npx tsx --test packages/pipeline/src/eval.test.ts
npx tsx --test packages/pipeline/src/wiki.test.ts
npx tsx --test packages/pipeline/src/agent-tools.test.ts
npx tsx --test packages/pipeline/src/agent-search.test.ts
npx tsx --test packages/adapters/src/llm/run-tools.test.ts
npm run typecheck
```
Expected: 全部 PASS，typecheck 无错误

再手工验证 A 套没被动过：打开 `/chat`，提一个问题，确认回答与引用正常（与本次改动前行为一致）。

- [ ] **Step 6: 更新 CLAUDE.md 里程碑并提交**

In `CLAUDE.md` 的「里程碑」列表末尾追加一条 ⑪，记录：wiki 化加工（paginate + buildWiki）、agentic 检索（agentSearch + 五工具）、`/ab` 双栏对比页、迁移 0017、`KB_WIKI=off` 可关、方舟后端不支持 B 栏。照现有里程碑条目的详略程度写。

```bash
git add apps/web/lib/kb.ts apps/worker/src/cli/wiki-demo.ts package.json CLAUDE.md
git commit -m "$(cat <<'EOF'
接进上传流程 + wiki-demo CLI + 里程碑 ⑪

上传后自动跑 wiki 化（KB_WIKI=off 可关），独立 try/catch 失败不影响主流程。
wiki-demo 可给存量文档补跑。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 附：跑完之后怎么用

这套东西的价值在于**积累样本**，不是跑一次就下结论。建议：

1. 从企微聊天记录里挖 30–50 条**坐席真实问过的疑难问题**（不是普通客户咨询）。
2. 在 `/ab` 逐条跑，每条都打分。
3. 统计胜率：

```sql
select verdict, count(*) from ab_runs where verdict is not null group by verdict;
select avg(a_ms)::int a_ms, avg(b_ms)::int b_ms, avg(a_tokens)::int a_tok, avg(b_tokens)::int b_tok from ab_runs;
```

判读：B 栏胜率不到 40% 说明 agentic 这条路在你的语料上不值当，瓶颈更可能在加工层；超过 60% 则值得往生产推，并考虑「A 栏先出初稿、B 栏后台深挖」的双轨形态。成本列同时告诉你这个提升要花多少钱。
