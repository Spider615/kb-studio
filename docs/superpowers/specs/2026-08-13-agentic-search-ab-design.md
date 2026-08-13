# 设计：wiki 化加工 + agentic search 检索，与现有 RAG 双栏 A/B

- 日期：2026-08-13
- 状态：已批准（待写实现计划）
- 范围：`packages/core`、`packages/db`、`packages/pipeline`、`apps/web`

## 1. 背景与目标

现有 kb-studio 是一条完整的传统 RAG 链路：解析 → 造结构 → 切片 → 上下文化 → 向量化入库，检索侧走 向量 + BM25 → RRF → Reranker → TopK → 单轮作答。

另一条技术路线是 **wiki 化 + agentic search**：不把资料切碎成 chunk，而是按语义主题分成自包含的「页」，另生成一篇目录页；检索时由模型多轮调用工具自己「翻资料」——先看目录、再读整章，而不是一次性捞回若干碎片。

两条路线孰优孰劣无法靠推理得出结论，需要在同一批真实问题上实测。本设计新增第二条链路，并提供双栏对比界面。

### 目标

1. 同一份上传文件，在现有 chunk 流水线之外，额外产出 wiki 页 + 目录页。
2. 新增一条 agentic search 检索链路，模型通过工具循环自主导航。
3. 新增 `/ab` 页面：同一个问题左右双栏并发出结果，各自显示耗时、token、命中/轨迹，支持逐轮打分。
4. 对比记录落库，跑够样本量后能统计胜率，而非凭印象。

### 非目标

- **不做 LLM 内容重写**（不生成 FAQ 问答对）。页正文逐字来自原文，零丢失风险。FAQ 层等这轮 A/B 结果出来再评估。
- 不做流式输出（第一版直接等结果，B 栏 10–15 秒转圈可接受）。
- 不做多轮对话（`/ab` 每次都是独立单轮提问；对话历史会给 A/B 引入噪声）。
- 不改动现有 `/chat` 生产链路。
- 不推送 wiki 页到秒懂（秒懂只接受现有 chunk 形态）。
- 不支持 `ArkLlmClient`（doubao）跑 agentic：多轮工具调用可靠性未验证，第一版只支持 302/Claude 后端。

  **由此推出一条硬约束**（写实现计划时核对 `factory.ts` 发现）：`makeLlm()` **默认返回豆包**，`KB_LLM=claude` 才回 302。若 A 栏走默认后端而 B 栏走 Claude，就是模型与链路两个变量同时变，A/B 直接失效。因此 `/api/ab` 不使用 `getDeps()` 的 llm，而是自建一个 `LlmClient`（302）供两栏共用。`/chat` 生产链路不受影响。代价是 `/ab` 测的是「同一模型下两条链路孰优」，而非「线上豆包配置有多好」——这正是本次要回答的问题。

### 通用性约束（沿用项目既有原则）

kb-studio 是通用工具。本设计所有逻辑必须领域无关——分页规则只依赖 markdown 结构（标题层级、表格、token 预算），不得硬编码任何行业术语、品牌名、列名或话术。文档中出现的行业例子仅为说明，不进入代码。

## 2. 决策记录（brainstorming 结论）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 两条路**在加工层分岔**，不是只换检索策略 | 用户要对比的是两条完整路线，不是单个组件 |
| 2 | wiki 产物 = **目录页 + 原文保真主题页**，不重写 | 零内容丢失，与 `structure()`「只输出标题清单、正文不重吐」同一哲学 |
| 3 | 分页边界**确定性按标题切**，无标题先跑现有 `structure()` | 边界可预测、可复现；复用已有能力，几乎零额外成本 |
| 4 | agent 工具集 = 导航 + BM25 + **向量检索** | 生产上最优形态；向量索引复用现有 embedding |
| 5 | 页向量化走**双层**：页内切块建索引，命中返回整页 | 索引精度 = 现有 RAG 水平，阅读单位 = 完整一页；实现成本最低 |
| 6 | 双栏 UI 落在**新建独立 `/ab` 页** | 不污染生产 `/chat`；评测台形态不同（要显示耗时/轨迹/评分） |
| 7 | agentic loop 走**独立 `AgentRunner`**，不塞进 `LlmBackend` | 保持 `LlmBackend`「五个高层任务方法」的抽象层次；A 栏链路一行不动 |

### 2.1 第一原则：A 套一行不动

左栏必须是**未经改动的现状**，否则 A/B 失效。因此：

- `chunkMarkdown` 不改，chunk 边界不变，向量不变，`retrieve()` / `chatTurn()` 的检索与作答行为不变。
- page 层是纯增量：给已有 chunk 打「属于第几页」的标签，外加一张页正文表。
- `buildWiki` 是独立 job，失败不影响主入库流程。

**唯一允许的例外是只读的可观测性增量**：A 栏要显示 token 数，而 `chatTurn` 目前不透出 usage。因此允许给 `LlmClient.answer()` 与 `chatTurn()` 的返回值追加可选 `usage` 字段。该改动不触碰任何检索参数、提示词或作答逻辑，对现有 `/api/chat` 完全向后兼容（不读该字段即无感知）。除此之外 A 套链路不做任何修改。

### 2.2 归因分析

决策 5 使两套加工的**索引层完全共用**（同样的 chunk、同样的 bge-m3 向量、同样的 jieba BM25）。因此两栏差异被压缩成两个变量：

| | A 栏 | B 栏 |
|---|---|---|
| 索引 | chunks + 向量 + BM25 | **完全相同** |
| 返回粒度 | 碎片（TopK 个 chunk） | 整页 |
| 轮次 | 单轮 | 多轮导航 |

测出的差异可明确归因到「读整页 vs 读碎片」与「多轮 vs 单轮」。

## 3. 数据契约（DB 变更，迁移 `0017`）

### 3.1 新表 `wiki_pages`

```
id              text PK      -- page_<docId>_<idx>，仿 chunk id 的可读风格
doc_id          text NOT NULL FK → docs(id) ON DELETE CASCADE
page_index      int  NOT NULL -- 0 = 目录页，1..n = 主题页
title           text NOT NULL -- 页标题；目录页固定为「目录」
content         text NOT NULL -- 页正文，逐字取自原文；目录页为 LLM 生成
heading_path    jsonb        -- string[]，页在文档中的标题路径
token_estimate  int
created_at      timestamptz DEFAULT now()

UNIQUE (doc_id, page_index)
INDEX  (doc_id)
```

### 3.2 加列

```sql
ALTER TABLE chunks ADD COLUMN page_id text;              -- FK → wiki_pages(id) ON DELETE SET NULL
ALTER TABLE docs   ADD COLUMN wiki_status text;          -- null|pending|ready|failed
ALTER TABLE docs   ADD COLUMN wiki_error text;           -- wiki 化失败原因，与主 error 列互不干扰
CREATE INDEX chunks_page_id_idx ON chunks(page_id);
```

`chunks.page_id` 可空——为空表示该文档未跑 wiki 化。所有现有查询不带此列，零影响。

`docs.wiki_status` / `wiki_error` 与主 `status` / `error` 解耦：wiki 化失败不让文档变 `failed`，A 栏照常可用。

### 3.3 新表 `ab_runs`

```
id          text PK
user_id     text NOT NULL FK → users(id)
group_id    text          -- 提问时限定的分组（可空 = 全库）
query       text NOT NULL

a_answer    text
a_hits      jsonb         -- [{id, score, heading_path, content}]
a_ms        int
a_tokens    int
a_error     text

b_answer    text
b_trace     jsonb         -- [{step, tool, args, resultSummary, ms}]
b_ms        int
b_tokens    int
b_error     text

verdict     text          -- null|a|b|tie|neither，用户逐轮打分
created_at  timestamptz DEFAULT now()

INDEX (user_id, created_at DESC)
```

两栏各留 `*_error` 列：一栏失败另一栏仍记录，失败本身也是数据。

## 4. `packages/core` — 分页器

新文件 `packages/core/src/paginator.ts`。纯函数，无 LLM、无 IO，可离线测试。

```ts
export interface PaginateOptions {
  maxPageTokens?: number;   // 单页上限，默认 8000
  minPageTokens?: number;   // 低于此值的相邻页合并，默认 300
  tableSheetPerPage?: boolean; // 表格：一个 sheet 一页，默认 true
}

export interface Page {
  pageIndex: number;      // 从 1 开始；目录页由 buildWiki 另行插入为 0
  title: string;
  content: string;        // 逐字取自入参 markdown
  headingPath: string[];
  tokenEstimate: number;
  continued?: boolean;    // 由超长章节硬切产生的续页
}

export function paginate(markdown: string, opts?: PaginateOptions): Page[];
```

### 4.1 分页规则

按优先级逐条应用：

1. **有标题**：以最高频的次顶层标题（通常 H2）为界，一个标题 = 一页。若文档只有 H1，则以 H1 为界。
2. **超长页**（> `maxPageTokens`）：按次级标题再分；仍超长则按段落边界硬切，续页标 `continued: true`，标题沿用并追加「（续）」。
3. **过短页**（< `minPageTokens`）：与相邻页合并，避免产生大量碎页。
4. **表格**：markdown 表格块整块不可分割。表格来源于 csv/xlsx 时（由调用方传 `tableSheetPerPage`），一个 sheet 一页；超 `maxPageTokens` 按行分页，**每页重复表头**。
5. **无标题**：`paginate` 本身不造标题——由调用方（`buildWiki`）先跑现有 `structure()` 造出标题再调用。整篇不足一页则返回单页。

### 4.2 与 chunker 的关系

`paginate` 与 `chunkMarkdown` 相互独立，各自消费同一份 markdown，互不影响。这是「A 套一行不动」的实现保证。

## 5. `packages/pipeline` — wiki 构建

新文件 `packages/pipeline/src/wiki.ts`。

```ts
export async function buildWiki(
  docId: string,
  markdown: string,
  deps: { llm: LlmBackend },
  opts?: { filename?: string; onProgress?: (p: WikiProgress) => void; signal?: AbortSignal },
): Promise<{ pageCount: number }>;
```

流程：

1. 若 markdown 无标题（`headings === 0`）→ 先调 `deps.llm.structure()` 造标题（复用 `shouldStructure` 同一判据）。
2. `paginate(markdown, opts)` → `Page[]`。
3. **生成目录页**：把各页的 `{pageIndex, title, 首 200 字}` 汇总，一次 LLM 调用产出目录页正文——每页一行「序号 · 标题 —— 一句话说明」。模型只写说明，不改标题、不新增页。失败则退回确定性目录（只列序号 + 标题，无说明）。
4. 写 `wiki_pages`（目录页 `page_index = 0`）。
5. **回填 `chunks.page_id`**：见 5.1。
6. 置 `docs.wiki_status = 'ready'`。

### 5.1 chunk → page 映射

规则：**chunk 的 `heading_path` 前缀命中哪一页的 `headingPath`，就归属该页**。

- 多页命中时取最长前缀匹配。
- 无命中（chunk 落在任何标题之前，如文档开头的前言）→ 归第 1 页。
- 一个 chunk 横跨两页时（chunker 打包相邻块可能跨标题）→ 归**起始页**。

映射在 SQL 层批量完成，不逐条往返。

### 5.2 触发时机

`apps/web/lib/kb.ts` 的后台处理流程里，`ingestDoc` 成功后追加一步：若 `KB_WIKI !== 'off'` 则跑 `buildWiki`。这一步**独立 try/catch**，失败只置 `wiki_status = 'failed'` 并把原因写进 `docs.wiki_error`，不触碰 `docs.status` / `docs.error`，整篇文档仍是 `ready`。

## 6. `packages/pipeline` — AgentRunner 与工具集

### 6.1 `agent-tools.ts`

五个工具，全部通用、领域无关。所有工具都受 `docIds` 白名单约束（多用户隔离，与现有 `listDocIdsForUser` 同一信任边界）。

```ts
list_docs(groupId?)          → [{docId, title, pageCount}]
read_outline(docId)          → 目录页全文
read_page(docId, pageIndex)  → 该页全文
grep(keyword, docIds?)       → BM25 命中 → [{docId, pageIndex, title, 片段}]
search(query, docIds?)       → 向量命中 chunk → 去重后返回所属整页列表
```

`search` 的关键行为：内部命中的是 chunk，**返回的是 chunk 所属整页**；多个 chunk 命中同一页只返回一次。

`grep` 同理：BM25 命中 chunk 后经 `page_id` 折算成页。两个工具都跳过未跑 wiki 化的文档（`page_id` 为空），`list_docs` 也只列 `wiki_status = 'ready'` 的文档——右栏只在 wiki 语料上工作，避免出现「能搜到但读不了」的半残状态。

**上下文预算**：单页上限 8000 token，12 轮全用于 `read_page` 时上下文约 96k，加系统提示与轨迹仍在 Claude 200k 之内。`agentSearch` 内部累计已注入的工具结果 token，超过 120k 时停止接受新的 `read_page`，转而提示模型基于已读内容作答（与轮次耗尽同一处理路径，`truncated = true`）。单次 `read_page` 超 `maxPageTokens` 时截断并提示「本页已截断，可读续页」。

### 6.2 `agent-search.ts`

```ts
export interface AgentSearchOptions {
  docIds?: string[] | null;
  maxTurns?: number;        // 默认 12
  model?: string;
}
export interface AgentSearchResult {
  answer: string;
  trace: Array<{ step: number; tool: string; args: unknown; resultSummary: string; ms: number }>;
  tokens: { input: number; output: number };
  turnsUsed: number;
  truncated: boolean;       // 轮次耗尽标记
}

export async function agentSearch(
  query: string,
  deps: { llm: LlmBackend; embedder: OpenAICompatEmbedder },
  opts?: AgentSearchOptions,
): Promise<AgentSearchResult>;
```

手写工具循环（约 150 行）。工具定义用中立结构声明，按后端类型分派成 Anthropic `tools` 或 OpenAI `function_call` 格式。**不修改 `LlmBackend` 接口**——所需的底层 messages 调用能力由 `LlmClient` 新增一个 `runTools()` 方法提供，`ArkLlmClient` 不实现（调用即抛明确错误）。

系统提示词要点（通用，不含领域词）：先用 `list_docs` / `search` / `grep` 定位到相关文档，再 `read_outline` 看结构，再 `read_page` 读完整章节；不要基于片段猜测，需要完整条款时读整页；信息足够即作答，不要无谓翻页。

## 7. `apps/web` — API 与页面

### 7.1 `POST /api/ab`

```
入参：{ query, groupId? }
出参：{ runId, a: {answer, hits, ms, tokens, error?}, b: {answer, trace, ms, tokens, turnsUsed, truncated, error?} }
```

流程：

1. `resolveAuth` 鉴权；按 `groupId` 收窄 `docIds`（复用 `/api/chat` 的隔离逻辑：先 `listDocIdsForUser` 再交集）。
1b. 自建 `new LlmClient({})` 供两栏共用（不取 `getDeps()` 的 llm，理由见 §1 非目标末尾）；`embedder` / `reranker` 仍取自 `getDeps()`。
2. `Promise.allSettled` 并发跑两条链：
   - A：`chatTurn([], query, deps, { topK: 4, poolN: 10, docIds })` —— 参数与 `/api/chat` 一致，保证是现状
   - B：`agentSearch(query, deps, { docIds, maxTurns: 12 })`
3. 各自计时、各自捕获异常，写 `ab_runs`，返回。

`runtime = "nodejs"`，`maxDuration = 300`。

### 7.2 `PATCH /api/ab/[runId]`

写 `verdict`（`a|b|tie|neither`）。

### 7.3 `/ab` 页面

沿用现有 Claude 暖色风（CSS 变量、暖米白底 + 黏土橙强调）。布局：

- 顶部：分组选择器（复用 `listGroups`）+ 提问输入框
- 主体：左右等宽双栏，各带标题条（`A 单轮 RAG` / `B wiki + agentic`）与指标行（耗时 · token）
- 各栏底部可折叠区：A 栏展开显示命中片段列表，B 栏展开显示工具轨迹（第几步、调了什么、参数、结果摘要、耗时）
- 底部：单选评分 `A 好 / B 好 / 差不多 / 都不行`，选中即 PATCH
- 窄屏（< 900px）：双栏改上下堆叠

新组件 `components/AbPanel.tsx`（单栏渲染，左右各用一次）。

## 8. 错误处理

隔离是原则——**一栏失败不影响另一栏**。

| 情况 | 行为 |
|---|---|
| B 栏工具循环报错 / 模型报错 | 只 B 栏显示错误，A 栏正常出结果；`b_error` 落库 |
| `maxTurns` 耗尽 | **不报错**，强制模型基于已读内容作答，`truncated = true`，轨迹标注「轮次耗尽」 |
| 工具参数非法（读不存在的页） | 把错误信息作为工具结果返回给模型让它自纠，不中断循环 |
| `buildWiki` 失败 | `wiki_status = 'failed'`；右栏提示「该文档未生成 wiki 页」，A 栏不受影响 |
| 302 凭据缺失或网关不可达 | 两栏一起失败（共用同一客户端），各自显示错误；`/chat` 走豆包不受影响 |
| 上传时 `buildWiki` 拿到的是豆包后端 | 豆包无 `answerRaw`，目录页退回确定性目录（只有序号+标题）。页正文不受影响，可事后用 `KB_LLM=claude npm run wiki-demo -- <docId>` 补跑 |
| 零命中 | 与现有 `chatTurn` 一致，不调 LLM 作答，直接返回「没有找到相关内容」 |

## 9. 测试

**离线单测（无网络）**

- `paginator.test.ts`：五种输入——有标题 / 无标题 / 超长章节触发次级切分与硬切 / 表格（含超长按行分页且每页带表头）/ 整篇不足一页
- chunk→page 映射：正常归属、最长前缀匹配、无命中归第 1 页、跨页 chunk 归起始页
- `agent-search.test.ts`：假 LLM + 假工具——循环正常终止、`maxTurns` 生效且 `truncated` 置位、工具报错不中断循环、`docIds` 白名单越权访问被拒

**集成测试**

- `wiki.integration.test.ts`：真实 DB，`buildWiki` 后 `wiki_pages` 行数正确、`chunks.page_id` 全部回填、删除 doc 级联清理
- `ab_runs` CRUD 与 `verdict` 更新

**端到端**

传一份章节结构清晰的真实 PDF → `wiki_status` 变 `ready` → `/ab` 提一个需要跨章节综合的问题 → 两栏都出结果、B 栏轨迹含 `read_outline` + 至少两次 `read_page`。

## 10. 影响面

**增**

- `packages/core/src/paginator.ts`
- `packages/pipeline/src/{wiki,agent-search,agent-tools}.ts`
- `apps/web/app/api/ab/route.ts`、`apps/web/app/api/ab/[runId]/route.ts`
- `apps/web/app/ab/page.tsx`、`apps/web/components/AbPanel.tsx`
- DB：`wiki_pages`、`ab_runs` 两张表 + `chunks.page_id` + `docs.wiki_status` + `docs.wiki_error`（迁移 `0017`）

**改**

- `packages/db/src/{schema,repo,index}.ts`：新表 CRUD + 页级查询
- `packages/adapters/src/llm/llm-client.ts`：新增 `runTools()` 方法（`LlmBackend` 接口不变）；`answer()` 返回值追加可选 `usage`
- `packages/pipeline/src/chat.ts`：`ChatTurnResult` 追加可选 `usage`，透传自 `answer()`——纯增量，不改检索与作答行为（见 §2.1）
- `apps/web/lib/kb.ts`：后台流程末尾追加 `buildWiki` 步骤（独立 try/catch）
- `apps/web/components/Sidebar.tsx`：加 `/ab` 入口

**不动**

- `packages/core/src/chunker.ts`、`packages/pipeline/src/{retrieve,ingest}.ts`
- `LlmBackend` 接口、`ArkLlmClient`
- `/api/chat` 路由、`/chat` 页面（`chatTurn` 多返回一个字段，不读即无感知）
- 秒懂推送全链路
