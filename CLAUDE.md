# CLAUDE.md — kb-studio

给自动化助手（Claude / Codex 等）的项目工作指南。中文注释 + 中文用户文案，代码标识符英文。

## 项目目的

全新独立的「知识库处理 + 自建 RAG」工具。把各类文件做 解析 → 造结构 → 切片 → 图片图→文 → 上下文化（Contextual Retrieval）→ 向量化，入本地 RAG（pgvector + BM25 + RRF + Reranker + Citations 检索）；Web 端预览 chunk 列表、人工确认后推送到「秒懂」知识库。秒懂是**可插拔的推送终点**，接口待提供，当前是 stub。

## 锁定决策（背景，别推翻）

- **全新独立 TS/Node 仓库**，不依赖、不参考其他项目（自带 git，不挂在用户 home 那个 git 下）。
- **B 方案：自建完整本地 RAG**；秒懂只是推送目标之一，不是检索后端。
- **全部模型走 302.ai 网关**（一个 key，base `https://api.302.ai`，直连可达）：Claude 走 `/v1/messages`，embedding/rerank 走 OpenAI 兼容端点。key 在 gitignored 的 `.env`。
- **文件解析 = 自己集成的 Claude Code**（Claude Agent SDK `@anthropic-ai/claude-agent-sdk`）跑在我们控制的沙箱/容器里，模型调用走 302。**不用** 302 托管的 Claude Code 沙盒；第一方 `code_execution` 经网关也用不了。
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
packages/adapters/  ClaudeCodeSandboxParser / OpenAICompatEmbedder / Reranker302 / LlmClient(302) / StubMiaodongAdapter / installProxyFromEnv
packages/pipeline/  ingestDoc（入库）+ retrieve（混合+rerank）—— worker 和 web 共用
apps/worker/        CLI demos（parse-one / chunk / structure / enrich / ingest / search / answer）
apps/web/           Next.js 15 前端（端口 3001）：上传 / chunk 预览 / 确认推送 + 检索台
```

内部包用 `@kb/core` `@kb/db` `@kb/adapters` 引用；exports 直接指向 `src/index.ts`，靠 tsx 跑、tsconfig paths 做类型检查（不预编译）。

## 数据契约（固定，见飞书切片文档 §4.3）

- **docs**：`id, title, source, mime, file_id, raw_text, structured_md, status(pending→…→ready→pushed/failed), org_id?, user_id?, created_at, confirmed_at, pushed_at`
- **chunks**：`id(可读 doc_42_c0007), doc_id, content(含上下文前缀), content_original, context_prefix, chunk_index, chunk_type(text|image_caption|table|code), token_estimate, metadata jsonb{heading_path[], page_num, image_url, image_id, prev/next_chunk_id}, embedding vector(1024)`
- `org_id/user_id` 先留空，多用户随时能加。

## 处理管线（worker 里每阶段一个 job，可单独重跑）

1. **ingest** 上传 → 建 doc 行 → 传 Files API
2. **parse**（沙箱）Claude code-exec 跑 Python 抽 文本+结构+图片；扫描/纯视觉 PDF 走 Claude PDF/vision 通道
3. **structure**（条件）无结构文档 → Haiku 造结构插 H2/H3
4. **chunk** 结构优先（标题/章节/表）→ >800 token 句切兜底（目标 400–800）→ overlap 50–100 → 写 metadata
5. **vision**（图片块）Haiku 图→文 生成描述 chunk，绑定 image_url
6. **contextualize** 每 chunk + 整份文档喂 Haiku（整份开 prompt caching）→ 50–100 字前缀 prepend
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
# DB：本机 pg17（brew），库 kbstudio。建表：npm run db:generate && npm run db:migrate
# 注：docker-compose.yml 里的 pgvector 服务现已不用（改本机 pg），保留备用
```

## 里程碑

- [x] **① 骨架 + 沙箱解析 + 容器化** — **全部验证**：宿主机 `npm run parse-one` 与**容器化** `bash scripts/parse-in-sandbox.sh samples/demo.csv`（Docker Desktop，`kb-sandbox` 镜像 714MB：非 root + `cap-drop ALL` + `no-new-privileges` + tmpfs + 输入只读挂载）都把 CSV 解析成 markdown 表；容器内 Claude Code 经宿主机 Clash 代理（`host.docker.internal:7897`）走 302。egress 进一步收紧（仅放行 api.302.ai 的 squid sidecar）是可选加固。
- [x] ② **chunker + 造结构 ✅**（均已验证：`npm run chunk-demo` 离线全过；`npm run structure-demo` 实跑 302 插标题+切片全过）。`LlmClient`（302 网关，含 `structure`/`contextualize`，在 `packages/adapters/src/llm/`）+ `installProxyFromEnv`（undici 代理）已建。
- [x] ③ **入库管线 ✅**：`npm run ingest-demo` 跑通 chunk→上下文化(302,Contextual Retrieval)→bge-m3→存 pgvector；BM25 用 jieba 分词写 `tsv_text` 列。DB = 本机 **pg17 + pgvector**（库 `kbstudio`，role `kb/kb`）。检索/rerank/citations 见 ⑤。
- [x] ④ **Web 应用 ✅**（`apps/web`，Next.js 15，端口 3001）：上传→Claude Code 解析→入库→**chunk 预览**（类型/heading_path/上下文前缀/原文）→确认推送(stub) + **检索台**（混合+rerank+Opus Citations）。`npm run dev --workspace @kb/web`；实测上传(CSV)+ /api/search 全通。env 走 `apps/web/.env.local`→root `.env` 软链；原生依赖 `serverExternalPackages`。
- [x] ⑤ **检索 + 问答全链路 ✅**：`npm run search-demo`（向量 / BM25 / RRF 三种对比）+ `npm run answer-demo`（混合检索 + Reranker `bge-reranker-v2-m3` + Opus Citations，**溯源经 302 透传成功**）。编排在 `apps/worker/src/pipeline/retrieve.ts`。
- [ ] ⑥ 秒懂 MiaodongAdapter 接真接口（替换 stub）

## 注意

- 默认解析后端 = `packages/adapters/src/parser/claude-code-sandbox.ts`（Agent SDK 起 Claude Code，模型走 302）。`claude-sandbox.ts`（第一方 code_execution）是不用的备选，仅在有真实 Anthropic key 时可用。
- 解析层是 `ParserBackend` 接口，可换实现。**当前 Claude Code 跑在宿主机，未隔离**；下一步包进锁死容器（非 root + 仅放行 api.302.ai 出网 + 预装 pdfplumber/python-docx/openpyxl）。本地跑 CSV 不需要这些库，所以 demo 能过；真实 pdf/docx/xlsx 要等容器。
- 扫描/纯视觉 PDF：让 Claude Code 在沙箱内识别（顶部写 `<!-- SCANNED -->`），后续走 vision 图→文 那条线。
- **代理坑**：Node 直连 302 海外端点必须走代理——SDK / `fetch`(undici) 默认不读 `HTTPS_PROXY`。`LlmClient` 构造时调 `installProxyFromEnv()`（undici `ProxyAgent` 装全局代理，读 host 的 `HTTPS_PROXY`；容器内不设则直连）；`embedder` 在 ③ 也要同样处理。Claude Code（解析那条）自己认代理，不受影响。
