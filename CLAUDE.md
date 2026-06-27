# CLAUDE.md — kb-studio

给自动化助手（Claude / Codex 等）的项目工作指南。中文注释 + 中文用户文案，代码标识符英文。

## 项目目的

全新独立的「知识库处理 + 自建 RAG」工具。把各类文件做 解析 → 造结构 → 切片 → 图片图→文 → 上下文化（Contextual Retrieval）→ 向量化，入本地 RAG（pgvector + BM25 + RRF + Reranker + Citations 检索）；Web 端预览 chunk 列表、人工确认后推送到「秒懂」知识库。秒懂是**可插拔的推送终点**，接口待提供，当前是 stub。

## 锁定决策（背景，别推翻）

- **全新独立 TS/Node 仓库**，不依赖、不参考其他项目（自带 git，不挂在用户 home 那个 git 下）。
- **B 方案：自建完整本地 RAG**；秒懂只是推送目标之一，不是检索后端。
- **全部模型走 302.ai 网关**（一个 key，base `https://api.302.ai`；本机经 Clash 代理出网，见「代理坑」）：Claude 走 `/v1/messages`，embedding/rerank 走 OpenAI 兼容端点（`EMBED_MODEL=BAAI/bge-m3`、`RERANK_MODEL=BAAI/bge-reranker-v2-m3`，**带 `BAAI/` 前缀**，裸名会 500）。key 同时填 `.env` 的 `ANTHROPIC_AUTH_TOKEN` 与 `EMBED_API_KEY`（gitignored）。
- **文件解析 = 自己集成的 Claude Code**（Claude Agent SDK `@anthropic-ai/claude-agent-sdk`）跑在我们控制的沙箱/容器里，模型调用走 302（csv/xlsx 后改为同容器内的**确定性解析**，更快更保真，见 ④/注意）。**不用** 302 托管的 Claude Code 沙盒；第一方 `code_execution` 经网关也用不了。
- **Claude 分工**：解析 / 造结构 / 上下文化 / vision 用 `claude-haiku-4-5-20251001`；检索回答 + Citations 用 `claude-opus-4-8`。整份文档上下文化时开 **prompt caching**（302 的 messages 支持）。
- **存储 = Postgres + pgvector**：一个库装 向量 + metadata + BM25 + pg-boss 任务队列。
- **Embedding = BGE-M3**（OpenAI 兼容 /embeddings 端点，1024 维；要原生图片向量再换 Voyage multimodal-3）。
- **Reranker = 先 Noop**，接口留好（可换 bge-reranker-v2-m3 / Cohere）。

## 方案出处（飞书，权威参考）

用 `lark-cli docs +fetch --doc <url>` 读：

- Contextual Retrieval（上下文化）：<https://juzihudong.feishu.cn/wiki/XZYYwvHgBicablksIvWcIaxInag>
- 文档切片与多模态处理：<https://juzihudong.feishu.cn/wiki/NoixwFuG8ibqpTkIkvIcv0oGnLe>

## 仓库布局（npm workspaces monorepo）

```
packages/core/      zod 数据契约 + 管线接口 + chunker + token 估算
packages/db/        drizzle schema（pg + pgvector）+ repo（向量/BM25/混合检索）+ bm25(jieba) + client
packages/adapters/  解析后端(ClaudeCodeSandboxParser / SandboxDockerParser / TabularSandboxParser + beta-sanitizing-proxy) / OpenAICompatEmbedder / Reranker302 / LlmClient(302) / StubMiaodongAdapter / installProxyFromEnv
packages/pipeline/  ingestDoc（入库，含行级表格上下文化+并发）+ retrieve（混合+rerank）—— worker 和 web 共用
apps/worker/        CLI demos（parse-one / chunk / structure / enrich / ingest / search / answer）+ python/tabular_to_md.py（确定性表格解析）
apps/web/           Next.js 15 前端（端口 3001）：上传 / chunk 预览 / 确认推送 + 检索台
```

内部包用 `@kb/core` `@kb/db` `@kb/adapters` 引用；exports 直接指向 `src/index.ts`，靠 tsx 跑、tsconfig paths 做类型检查（不预编译）。

## 数据契约（固定，见飞书切片文档 §4.3）

- **docs**：`id, title, source, mime, file_id, raw_text, structured_md, status(pending→…→ready→pushed/failed), org_id?, user_id?, created_at, confirmed_at, pushed_at`
- **chunks**：`id(可读 doc_42_c0007), doc_id, content(含上下文前缀), content_original, context_prefix, chunk_index, chunk_type(text|image_caption|table|code), token_estimate, metadata jsonb{heading_path[], page_num, image_url, image_id, prev/next_chunk_id, is_table_row?(CSV/Excel 行级 chunk 标记)}, embedding vector(1024)`
- `org_id/user_id` 先留空，多用户随时能加。

## 处理管线（worker 里每阶段一个 job，可单独重跑）

1. **ingest** 上传 → 建 doc 行 → 传 Files API
2. **parse**（容器沙箱）csv/xlsx → 确定性解析（openpyxl/csv 逐行）；其余 → Claude Code 跑 Python 抽 文本+结构+图片；扫描/纯视觉 PDF 走 Claude PDF/vision 通道
3. **structure**（条件）无结构文档 → Haiku 造结构插 H2/H3
4. **chunk** 结构优先（标题/章节/表）→ >800 token 句切兜底（目标 400–800）→ overlap 50–100 → 写 metadata。**CSV/Excel**（`tableRowChunks`）按数据行切，每 chunk = 表头 + 该行（标记 `is_table_row`）
5. **vision**（图片块）Haiku 图→文 生成描述 chunk，绑定 image_url
6. **contextualize** 每 chunk + 整份文档喂 Haiku（整份开 prompt caching，受限并发）→ 50–100 字前缀 prepend；行级表格 chunk 同样上下文化，一篇 >400 行则回退确定性前缀（《文档》· sheet/章节）
7. **embed** BGE-M3 向量 + jieba 分词建 BM25 → upsert 进 pgvector
8. **preview** status→ready，Web 展示 chunk 列表供审/改/确认
9. **confirm+push** 确认 → MiaodongAdapter.push（stub）→ 标 pushed

**检索台**（文档1 §5 + 文档2 §4）：向量 + BM25 → RRF → Reranker（可选）→ TopK → Opus 4.8 + Citations（顺序不 shuffle，block_index→chunk_id→metadata 反查）→ `{answer, images, sources}`。

## 命令

```bash
npm install
npm run typecheck
npm run parse-one -- <文件>                 # 宿主机沙箱解析（Claude Code 经 302）
bash scripts/parse-in-sandbox.sh <文件>     # 容器化解析（Docker 加固沙箱）
npm run chunk-demo                          # chunker（离线）
npm run structure-demo                      # 造结构（302）
npm run enrich-demo                         # 上下文化 + bge-m3（302）
npm run ingest-demo                         # 入库 + 向量检索（302 + pgvector）
npm run search-demo                         # 向量 / BM25 / 混合RRF 对比
npm run answer-demo                         # 混合 + Reranker + Opus Citations 问答
npm run dev --workspace @kb/web             # Web 应用（http://localhost:3001 上传/预览/确认+检索台）
# DB = Postgres + pgvector：本仓库用 `docker compose up -d` 起 pgvector/pg16（库 kbstudio，role kb/kb；DATABASE_URL 见 .env），也可用本机 brew pg。建表：npm run db:generate && npm run db:migrate
# 构建解析镜像：docker build --build-arg HTTPS_PROXY=http://host.docker.internal:7897 -t kb-sandbox:latest .
```

## 里程碑

- [x] **① 骨架 + 沙箱解析 + 容器化（已落地并接入 web）** — `kb-sandbox` 镜像（~797MB，预装 pdfplumber/pypdf/python-docx/openpyxl/pandas/pillow；非 root + `cap-drop ALL` + `no-new-privileges` + tmpfs + 输入只读挂载）。web 上传**默认走容器解析**（`SandboxDockerParser`，见 ④）；容器内 Claude Code 经宿主机 Clash（`host.docker.internal:7897`）走 302。**两个已修的坑**：(a) 新版 Claude Code 发的 `anthropic-beta`(oauth/thinking-token-count/prompt-caching-scope/advisor-tool) 被 302 拒 403 → 改 `x-api-key` + 进程内 `beta-sanitizing-proxy` 剥不支持的 beta；(b) 默认开 32k 扩展思考使解析 ~180s → `thinking:{type:"disabled"}` 降到 ~33s。egress 进一步收紧（仅放行 api.302.ai 的 squid sidecar）是可选加固。
- [x] ② **chunker + 造结构 ✅**（均已验证：`npm run chunk-demo` 离线全过；`npm run structure-demo` 实跑 302 插标题+切片全过）。`LlmClient`（302 网关，含 `structure`/`contextualize`，在 `packages/adapters/src/llm/`）+ `installProxyFromEnv`（undici 代理）已建。
- [x] ③ **入库管线 ✅**：`npm run ingest-demo` 跑通 chunk→上下文化(302,Contextual Retrieval)→bge-m3→存 pgvector；BM25 用 jieba 分词写 `tsv_text` 列。DB = **Postgres + pgvector**（本仓库用 docker compose 起 pgvector/pg16，库 `kbstudio`，role `kb/kb`；也可本机 brew pg）。检索/rerank/citations 见 ⑤。
- [x] ④ **Web 应用 ✅**（`apps/web`，Next.js 15，端口 3001）：上传→解析→入库→**chunk 预览**（类型/heading_path/上下文前缀/原文）→确认推送(stub) + **检索台**（混合+rerank+Opus Citations）。**解析按文件类型分流**（`apps/web/lib/kb.ts` `getParser(filename)`）：csv/xlsx → **确定性解析**（`TabularSandboxParser`，容器内 openpyxl/csv 逐行转 markdown，全 sheet 全行、无模型、`--network none`、<1s、100% 保真）；其余 → 容器化 Claude Code（`SandboxDockerParser`）。**CSV/Excel 按数据行切片**（每 chunk 自带表头，`chunkMarkdown` 的 `tableRowChunks`，按扩展名开），行级 chunk 也走 LLM 上下文化。实测上传(CSV 多行/单+多 sheet xlsx)+ /api/search 全通。env 走 `apps/web/.env.local`→root `.env` 软链；原生依赖 `serverExternalPackages`。
- [x] ⑤ **检索 + 问答全链路 ✅**：`npm run search-demo`（向量 / BM25 / RRF 三种对比）+ `npm run answer-demo`（混合检索 + Reranker `bge-reranker-v2-m3` + Opus Citations，**溯源经 302 透传成功**）。编排在 `apps/worker/src/pipeline/retrieve.ts`。
- [ ] ⑥ 秒懂 MiaodongAdapter 接真接口（替换 stub）

## 注意

- 解析层是 `ParserBackend` 接口，web 经 `getParser(filename)` 按类型选后端：
  - **csv/xlsx → `TabularSandboxParser`**（确定性，容器内跑 `apps/worker/python/tabular_to_md.py`；逐行保真、无模型、最快）；
  - **其余 → `SandboxDockerParser`**（容器化 Claude Code，处理 pdf/docx/复杂布局；模型走 302）；
  - `KB_PARSER=host` 强制退回宿主机 `ClaudeCodeSandboxParser`（调试用）；`claude-sandbox.ts`（第一方 code_execution）是不用的备选。
- **解析已容器化隔离**（`kb-sandbox` 镜像，里程碑①）：非 root + `cap-drop ALL` + `no-new-privileges` + tmpfs + 输入只读；确定性表格解析再加 `--network none`。镜像预装 pdfplumber/python-docx/openpyxl/pandas，真实 pdf/docx/xlsx 都能解析。egress 仅放行 api.302.ai 是可选加固。
- **宿主机 python 可能不可用**（如本机 homebrew python3.14 的 pyexpat 坏了），所以表格解析走容器而非宿主机。
- 扫描/纯视觉 PDF：让 Claude Code 在沙箱内识别（顶部写 `<!-- SCANNED -->`），后续走 vision 图→文 那条线。
- **代理坑**：302 海外端点本机要走 Clash（实测直连 ETIMEDOUT）——SDK / `fetch`(undici) 默认不读 `HTTPS_PROXY`。`LlmClient`/`embedder`/`reranker` 构造时调 `installProxyFromEnv()`（undici `ProxyAgent` 装全局代理，读 host 的 `HTTPS_PROXY`）。**容器内**：`SandboxDockerParser` 给子进程设 `HTTPS_PROXY=host.docker.internal:7897`，容器里的 Claude Code 与 `beta-sanitizing-proxy` 都经宿主机 Clash 到 302；确定性表格解析不联网（`--network none`）。
- **环境隔离坑**：解析子进程（Agent SDK）会从外层 Claude Code 会话继承 `CLAUDE_CODE_*` 等 env；本地代理需对子进程设 `NO_PROXY=127.0.0.1`，否则它把本地请求经 Clash 隧道出去。
