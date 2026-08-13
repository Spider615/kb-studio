# CLAUDE.md — kb-studio

给自动化助手（Claude / Codex 等）的项目工作指南。中文注释 + 中文用户文案，代码标识符英文。

## 项目目的

全新独立的「知识库处理 + 自建 RAG」工具。把各类文件做 解析 → 造结构 → 切片 → 图片图→文 → 上下文化（Contextual Retrieval）→ 向量化，入本地 RAG（pgvector + BM25 + RRF + Reranker + Citations 检索）；Web 端预览 chunk 列表、人工确认后推送到「秒懂」知识库。秒懂是**可插拔的推送终点**，接口待提供，当前是 stub。

## 锁定决策（背景，别推翻）

- **全新独立 TS/Node 仓库**，不依赖、不参考其他项目（自带 git，不挂在用户 home 那个 git 下）。
- **B 方案：自建完整本地 RAG**；秒懂只是推送目标之一，不是检索后端。
- **模型分两家（里程碑 ⑪ 后）**：**对话层 + 解析层 = 火山方舟豆包**（base `https://ark.cn-beijing.volces.com/api/v3`，`ARK_API_KEY`，OpenAI 协议，**国内直连不走代理**）；**向量 + 重排仍在 302**（`EMBED_MODEL=BAAI/bge-m3` 1024 维、`RERANK_MODEL=BAAI/bge-reranker-v2-m3`，**带 `BAAI/` 前缀**，裸名会 500；海外端点经 Clash）。留在 302 的原因见 ⑪。302 key 仍填 `ANTHROPIC_AUTH_TOKEN`/`EMBED_API_KEY`（gitignored）。
- **文件解析 = 自己集成的 Claude Code**（Claude Agent SDK `@anthropic-ai/claude-agent-sdk`）跑在我们控制的沙箱/容器里，模型调用走 302（csv/xlsx 后改为同容器内的**确定性解析**，更快更保真，见 ④/注意）。**不用** 302 托管的 Claude Code 沙盒；第一方 `code_execution` 经网关也用不了。
- **模型分工（⑪ 后全是豆包）**：造结构 / 上下文化 / vision 用 `doubao-seed-2-0-lite-260428`（全模态，视觉强于 2.0-pro）；检索回答用 `doubao-seed-2-0-pro-260215`；解析层兜底的 agent 用 `doubao-seed-2-0-code-preview-260215`（代码专用）。**方舟是隐式缓存**（自动生效、不可关、不保证命中），没有 `cache_control` 可标。
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

**检索台**（文档1 §5 + 文档2 §4）：向量 + BM25 → RRF →（lexguard 候选并入）→ Reranker → TopK → 豆包 pro + 序号标记溯源 → `{answer, images, sources}`。

**关键词检索 = jieba 召回 + 真 Okapi BM25**（`packages/db/src/bm25-score.ts`，纯函数 8 个单测）。SQL 只负责**筛**（走 GIN 索引），**排**在 Node 侧做。三个要点：

- **已弃用 `ts_rank_cd`**：它是 cover density ranking，**没有 IDF**——「产品」这种满库都是的泛词与「葡萄牙」这种关键罕见词权重相同，谁词频高谁赢。实测踩过：某片段靠「润」「度」「产品」高频拿到全场最高分 2.000，而查询真正在问的「葡萄牙」在其中出现 0 次。换 BM25 后实测：查「西班牙」（文档里真实存在的罕见词）→ 命中片段 6.5175，比第二名高 80 倍；查「葡萄牙」（不存在）→ 全部 0.08 以下，不会有片段假性冒头。
- **专有名词必须进 jieba 词典**（env `KB_JIEBA_WORDS`，逗号分隔）：默认词典不认识的品牌会被切成单字（「润度」→「润」「度」），连「温度」「湿度」里的「度」都会误命中。**改这个变量后必须 `npm run rebuild-tsv`**——tsv_text 是入库时固化的分词，不重建则查询用新词、索引是旧词，**一条都匹配不上**，比不改更糟。
- **IDF 按全库统计、不受 docIds 限制**：词的稀有度是语料固有属性；按 scope 重算既拿不到缓存，又会让同一个词在「搜单篇」和「搜全库」时权重漂移。DF/avgdl 进程内缓存 5 分钟（`KB_BM25_STATS_TTL_MS`），`rebuildTsvText` 结束会自动清。首次查询约 40ms，缓存命中 2ms。
- **迁移 0016 加了 GIN 索引** `chunks_tsv_gin`：此前 chunks 上只有主键和 doc_id 索引，关键词检索是**全表扫描 + 逐行实时算 tsvector**。表达式索引必须与查询表达式逐字一致（同为 `'simple'`）才会被选中。

**分数尺度（易踩）**：`SearchHit.score` 一个字段承载多种来源——开 reranker 时是 0~1 相关性分，关掉则是 RRF 分（0.0x 量级），邻居扩展块固定 0。**lexguard 候选必须在 rerank 之前并入候选池**，否则它带的是 BM25 的 `ts_rank_cd`（无上限、只反映词频），与主命中不同尺度，前端并排显示会出现「2.000 排在 0.717 后面」这种没法解读的画面。现在 `retrieve()` 在有 reranker 时统一尺度并整体降序，前端直接按序渲染。另注意 `ts_rank_cd` **不是 BM25**：没有 IDF、默认无长度归一化，所以高频通用词（「产品」）和关键罕见词（「葡萄牙」）同等对待。

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
npm run answer-demo                         # 混合 + Reranker + Citations 问答
npm run ark-check                           # 火山方舟对话层自检（只打 LLM，不碰 302/DB，最快确认链路通不通）
npm run rebuild-tsv                         # 用当前分词规则重建全部 chunk 的 BM25 索引（改 KB_JIEBA_WORDS 后必跑）
npm run dev --workspace @kb/web             # Web 应用（http://localhost:3001 上传/预览/确认+检索台）
# DB = Postgres + pgvector：本仓库用 `docker compose up -d` 起 pgvector/pg16（库 kbstudio，role kb/kb；DATABASE_URL 见 .env），也可用本机 brew pg。建表：npm run db:generate && npm run db:migrate
# 构建解析镜像：docker build --build-arg HTTPS_PROXY=http://host.docker.internal:7897 -t kb-sandbox:latest .
```

## 部署

**部署到新环境前必读 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。** 本项目有多处「配错了不报错、
只是功能悄悄失效」的地方（`.env.local` 软链未建、SMTP 未配却返回成功、改词典没 `rebuild-tsv`、
改 python 脚本没重建镜像、admin 默认口令），该文档第 3 节逐条列出了现象与排查方法。

## 里程碑

- [x] **① 骨架 + 沙箱解析 + 容器化（已落地并接入 web）** — `kb-sandbox` 镜像（~797MB，预装 pdfplumber/pypdf/python-docx/openpyxl/pandas/pillow；非 root + `cap-drop ALL` + `no-new-privileges` + tmpfs + 输入只读挂载）。web 上传**默认走容器解析**（`SandboxDockerParser`，见 ④）；容器内 Claude Code 经宿主机 Clash（`host.docker.internal:7897`）走 302。**三个已修的坑**：(a) 新版 Claude Code 发的 `anthropic-beta`(oauth/thinking-token-count/prompt-caching-scope/advisor-tool) 被 302 拒 403 → 改 `x-api-key` + 进程内 `beta-sanitizing-proxy` 剥不支持的 beta；(b) 默认开 32k 扩展思考使解析 ~180s → `thinking:{type:"disabled"}` 降到 ~33s；(c) `@anthropic-ai/claude-agent-sdk`（原 claude-code SDK 更名后）**`systemPrompt` 默认变「空/minimal」**，不再自动注入 Claude Code 的 agent 系统提示 → 小模型(haiku)拿不到 cwd/工具用法框架，会乱猜绝对路径、且**偶发退化成聊天模式拒绝执行**（回「当前处于 agentic-coding OFF 模式，无法执行命令」这类幻觉）→ 不落盘 parsed.md、上层报「解析未产出」。修法：`options` 显式加 `systemPrompt:{type:"preset",preset:"claude_code"}`（`claude-code-sandbox.ts`）。**改这个文件后必须 `docker build ... -t kb-sandbox:latest` 重建镜像**，否则容器仍跑旧代码。附带把解析器改成「query 抛错(如 maxTurns)仍抢救已落盘的 parsed.md」，并把 prompt 收成「一次成型、写完即止别反复优化」+ maxTurns 12→20，防复杂 PDF 被 agent 过度折腾耗尽轮次。egress 进一步收紧（仅放行 api.302.ai 的 squid sidecar）是可选加固。
- [x] ② **chunker + 造结构 ✅**（`npm run chunk-demo` 离线全过；`structure-demo` 实跑 302）。`LlmClient`（302，含 `structure`/`contextualize`/`vision`，在 `packages/adapters/src/llm/`）+ `installProxyFromEnv` 已建。**造结构防大文档截断**：`structure()` 改为"模型只输出 JSON 标题清单 `[{before,level,title}]`、Node 把标题机械插回原文块"——正文不重吐 → 从构造上杜绝截断/丢内容（实测 12000 字零丢失）。**已接进 web 上传**：非表格、解析后无标题（headings==0）且≥4 块的文档自动造结构（`shouldStructure`，`KB_AUTO_STRUCTURE=off` 可关，失败退回原文）。
- [x] ③ **入库管线 ✅**：`npm run ingest-demo` 跑通 chunk→上下文化(302,Contextual Retrieval)→bge-m3→存 pgvector；BM25 用 jieba 分词写 `tsv_text` 列。DB = **Postgres + pgvector**（本仓库用 docker compose 起 pgvector/pg16，库 `kbstudio`，role `kb/kb`；也可本机 brew pg）。检索/rerank/citations 见 ⑤。
- [x] ④ **Web 应用 ✅**（`apps/web`，Next.js 15，端口 3001）：上传→解析→入库→**chunk 预览**（类型/heading_path/上下文前缀/原文）→确认推送(stub) + **检索台**（混合+rerank+Opus Citations）。**解析按文件类型分流**（`apps/web/lib/kb.ts` `getParser(filename)`）：csv/xlsx → **确定性解析**（`TabularSandboxParser`，容器内 openpyxl/csv 逐行转 markdown，全 sheet 全行、无模型、`--network none`、<1s、100% 保真）；其余 → 容器化 Claude Code（`SandboxDockerParser`）。**CSV/Excel 按数据行切片**（每 chunk 自带表头，`chunkMarkdown` 的 `tableRowChunks`，按扩展名开），行级 chunk 也走 LLM 上下文化。实测上传(CSV 多行/单+多 sheet xlsx)+ /api/search 全通。env 走 `apps/web/.env.local`→root `.env` 软链；原生依赖 `serverExternalPackages`。
- [x] ⑤ **检索 + 问答全链路 ✅**：`npm run search-demo`（向量 / BM25 / RRF 三种对比）+ `npm run answer-demo`（混合检索 + Reranker `bge-reranker-v2-m3` + Opus Citations，**溯源经 302 透传成功**）。编排在 `apps/worker/src/pipeline/retrieve.ts`。
- [x] ⑥ **秒懂 MiaodongAdapter 接真接口 ✅**：web 点「确认推送秒懂」弹框填 域名/accessKeyId/accessKeySecret/knowledgeBaseId → `RealMiaodongAdapter` 取token→建文档→顺序建段落（上下文化 content，>1000 字符按句切分）；成功后 docs 标 pushed + 存远端引用（miaodong_kb_id/doc_id/domain）。国内端点不走代理。（凭据存储后被 ⑦ 改为落库，见下。）
- [x] ⑦ **Web Claude 暖色风重做 + 体验打磨 ✅**：UI 整体重做成 Claude 暖色风（暖米白底 + 黏土橙强调 `#C96442` + 衬线标题 + **单一暖色侧栏**，纯 CSS 变量；旧 `Nav` 退役并入 `Sidebar`）。设计/计划存档于 `docs/superpowers/specs|plans/2026-06-27-*`。要点：
  - **上传改异步后台**：`POST /api/upload` 先建 `processing` doc 行即返回，后台 解析→造结构→`ingestDoc`(加 `onProgress`/`AbortSignal`)；docs 加 `progress/error` 列，前端轮询显示**阶段+百分比**；删处理中文档经内存注册表 `apps/web/lib/jobs.ts` abort（`docs/[id]` DELETE 先 `abortJob`）。
  - **原文件预览**：上传落盘到 `KB_UPLOAD_DIR`(默认 `.uploads/`，记到 `docs.file_id`)，`GET /api/docs/[id]/file` 流式返回；`FilePreview` 弹框按类型渲染 pdf=iframe / md=react-markdown / csv·xlsx=SheetJS / docx=mammoth（office 库动态 import）。
  - **凭据改落库**：新表 `miaodong_credentials`（取代 ⑥ 的 localStorage），`/api/credentials` 增删查改 + 查看(密钥可显隐)/编辑(留空 secret 不改)；GET 列表不回传 secret。
  - **推送多目标**：推送弹框多选凭据 → `/api/confirm {credentialIds[]}` 逐个推送、按 kbId 合并写 `docs.push_targets`(jsonb 数组)；详情显示已推送凭证名 + 推送按钮常驻 + 失败显示每凭证具体原因 + 成功顶部 toast（全局 `Toaster`）。
  - **其它**：对话助手气泡 react-markdown 渲染；新建对话防空对话堆叠（`listConversations` 带 `messageCount`）；列表/详情加载 spinner；chunk 预览改 `#序号`、去标题路径与「＋上下文」标签；`devIndicators:false` 去掉 dev 悬浮球。DB 迁移 `0005`（docs `progress/error/push_targets` + 凭据表）。
- [x] ⑧ **注册登录 + 接口鉴权 ✅**：邮箱+密码自助注册/登录，httpOnly cookie 会话鉴权（密码 bcryptjs、session 只存 sha256）。新增 `users`/`sessions` 表 + `miaodong_credentials.user_id`（迁移 0008/0009；0010 移除了一度加过的 `api_tokens` 表/Bearer 机制——内部网页工具用不上，按需可再加回）。`apps/web/middleware.ts` 粗门禁（查 `kb_session` cookie），各路由 `resolveAuth(req)`（`apps/web/lib/auth.ts`）细校验。**全量多用户隔离**：docs/groups/conversations/credentials 按 `user_id` 过滤，单资源非本人 404，检索按 `listDocIdsForUser` 限定本人文档；零命中短路（search 路由 + chatTurn）避免空上下文网关 403。旧 `user_id=null` 行对任何用户不可见。设计/计划见 `docs/superpowers/specs|plans/2026-06-28-auth*`。 注册要求邮箱验证码（先验证再建号）：`email_verifications` 表（迁移 0011）+ `POST /api/auth/send-code`（6 位码、sha256 存储、10 分钟有效、60s 重发冷却、5 次作废）+ `mailer.ts`（nodemailer SMTP，未配则验证码打 console 兜底）+ register 增 `code` 校验。设计/计划见 `docs/superpowers/specs|plans/2026-06-28-email-verification*`。
- [x] **⑨ 管理后台（/admin，只读）✅**：独立 `/admin` 区，签名 cookie 鉴权（默认 admin/admin，可用 `ADMIN_USER/ADMIN_PASS/ADMIN_SESSION_SECRET` 覆盖；`apps/web/lib/admin-auth.ts` HMAC 无状态会话，不建会话表）。中间件加 admin 分支粗门禁、`app/admin/page.tsx` 服务端组件 `verifyAdminCookie` 细校验。仪表盘看：注册总数 + 用户列表（邮箱/昵称/注册时间/文档·对话·凭据数/最近登录）+ 系统统计（文档总数、按状态分布、chunk 总数、已推送秒懂文档数、近 7/30 天注册）。`users` 加真实 `last_login_at`（迁移 0013，登录成功写入）。`@kb/db` 新增全局只读 `adminCountUsers/adminListUsers/adminSystemStats`。设计/计划见 `docs/superpowers/specs|plans/2026-06-30-admin-dashboard*`。
- [x] **⑩ 修改密码 + 忘记密码 ✅**：两条线。**忘记密码**（免登录）登录页「忘记密码?」→ `/reset` → 邮箱收码 → 设新密码（`POST /api/auth/reset-password`）；**修改密码**（已登录）侧栏用户菜单 → `ChangePasswordDialog` 验旧密码换新（`POST /api/auth/change-password`）。**两者成功后都删该用户全部会话**（`deleteSessionsByUser`，含当前设备）+ 清 cookie，一律用新密码重登。关键改动：`email_verifications` 加 `purpose` 列（`register|reset`）、主键改复合 `(email, purpose)`——否则同邮箱的注册码与重置码互相覆盖（迁移 `0015`，**drizzle 生成的 SQL 有两处缺陷已手工修**：没 DROP 旧主键 `email_verifications_pkey`、且把建复合主键排在加列之前）。`send-code` 加 `purpose`（缺省 register 保持旧行为），两种用途对「邮箱是否已注册」要求相反：register 已注册→409、reset 未注册→404。`AuthForm` 加第三个 mode `reset`，原 `isLogin ? A : B` 二元判断改为 `CONFIG` 配置表驱动。`middleware.ts` 的 `PUBLIC` 需放行 `/reset` + `/api/auth/reset-password`。设计见 `docs/superpowers/specs/2026-08-12-password-reset-design.md`。**注意 `.env` 仍无 SMTP_\* 配置，验证码只打服务端 console 不真发信**（注册也一样），配法见该设计文档末节。

- [x] **⑪ 迁移到火山方舟豆包（对话层 + 解析层）✅**：`KB_LLM=claude` 可整体退回 302 对比。
  - **为什么向量/重排留在 302**（实测依据）：方舟 `/rerank` 返回 **404**、129 个模型里 **0 个 rerank**（官方 reranker 在知识库产品线 `api-knowledgebase.mlp...`，要 **AK/SK 签名**，用 ARK key 实测 403，且协议非标）；向量只剩多模态版 `doubao-embedding-vision-*`，走 `/embeddings/multimodal`、**不兼容 OpenAI 格式、不支持批量**（传 N 段文本只回 1 个向量），换了要重写 adapter + 全量重嵌存量 chunk。**注意维度不是障碍**——显式传 `dimensions:1024` 实测就返回 1024 维（默认 2048），`vector(1024)` schema 不用改。
  - **契约**：`@kb/core` 新增 `LlmBackend` 接口，`LlmClient`(302/Anthropic) 与 `ArkLlmClient`(方舟/OpenAI) 两个实现可插拔；工厂 `makeLlm()` 在 `@kb/adapters`。提示词抽到 `llm/prompts.ts` 两边共用——**换后端不该顺带改模型看到的文字**，否则出了效果差异分不清是模型还是 prompt 的锅。
  - **Citations 无法平移**：方舟 `/chat/completions` 没有 document content block、没有 annotations（Responses API 的 `doc_citation` 只对托管在火山知识库的文档生效，与自建 pgvector 不兼容）。改用**序号标记法**（`llm/citations.ts`）：TopK 以 `[1][2]…` 编号喂入，模型在结论后标序号，本地解析回 chunk + **范围校验**（越界即判伪）。用序号而非 `doc_42_c0007` 是因为短标识符指令遵循率高一个量级。**丢失的保证**：不再有「cited_text 逐字来自原文」的协议级承诺。
  - **解析层协议翻译**：Agent SDK 只认 Anthropic 协议 → 新增 `parser/ark-anthropic-proxy.ts`（进程内反代）+ `parser/anthropic-openai-convert.ts`（纯函数，17 个单测）。`claude-code-sandbox.ts` **按模型名前缀自动选路**：`doubao-*` 起翻译反代，`claude-*` 起原来的 beta-sanitizing-proxy。三处必须做对：①必须流式；②必须定期发 ping（客户端对 base-url 连接有静默字节看门狗）；③必须设 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`（SDK 把不认识的模型名也当新模型发 `thinking:{type:"adaptive"}`，方舟不吃直接 400；`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 官方明说不管这个）。**已实测**：豆包 code 模型经反代驱动 Agent SDK 完整解析 docx，标题/段落/表格全对。
  - **主流格式改走确定性解析**：新增 `pdf_to_md.py`（pdfplumber 抽文本层+表格，表格区域从正文剔除防重复，按句末标点合并 PDF 视觉换行）、`pptx_to_md.py`（逐页标题/正文/表格/备注）、`PlainTextParser`（txt/md 直读）。`PdfParser` 的 fallback 从 Claude Code 换成 pdfplumber。**PDF 不推断标题层级**——只能靠字号猜且易误判，交给 `shouldStructure()`→LLM 造结构补。
  - **方舟三个静默坑**：`max_tokens` 默认仅 4096（造结构传 8000 必须显式带，否则静默截断）；豆包新模型**默认开深度思考**（等价于早年 Claude 32k thinking 让解析 180s 那个坑，一律显式 `thinking:{"type":"disabled"}`）；`proxy.ts` 原本是进程级全局装 ProxyAgent、无 host 白名单，会把火山国内请求塞进 Clash 出海再回国 → 改用 undici `EnvHttpProxyAgent` + noProxy 白名单。**注意 undici 对不以 `.` 开头的 noProxy 条目只做精确匹配**，子域必须写 `.volces.com`。
  - 顺带修了个既有缺陷：`structure-demo` 的测试文本是**单段无换行**的，`splitBlocks` 只得 1 块直接早退，**从 init commit 起就没真正调过模型**（一直空转）。
- [x] **⑫ wiki 化加工 + agentic 检索 + `/ab` 双栏对比 ✅**：给「一次性混合检索」加一条对照路径——把文档整篇分页成「维基」，让模型自己带工具翻页找答案，跟现有检索并排对比效果，供后续攒样本判断值不值得往生产推。
  - **wiki 化**（`packages/core/src/paginator.ts` 的 `paginate()` + `packages/pipeline/src/wiki.ts` 的 `buildWiki()`）：按标题层级把 markdown 切成若干「页」（目标 token 区间，过大章节递归再切、过小章节合并），额外生成一页**目录**（无标题文档先跑 `structure()` 造标题）。目录页优先用 `llm.answerRaw()` 生成「序号+标题+一句话说明」——这是 `WikiLlm` 上的可选扩展方法，只有 302 的 `LlmClient` 实现，豆包 `ArkLlmClient` 没有，**缺失时静默退回确定性目录**（只有序号+标题，没有说明），不报错。分页结果写 `wiki_pages` 表，并按 `heading_path` 最长前缀匹配把 `chunks.page_id` 回填到对应页（迁移 `0017` 建表/加列/加索引，`0018` 补两处外键约束）。**已接进上传后台流程**：`apps/web/lib/kb.ts` 的 `processDoc` 在 `ingestDoc` 成功、`status=ready` 之后另起一段**独立 `try/catch`** 跑 `buildWiki`，失败只把该文档标 `wiki_status=failed`，绝不牵连主流程或 A 套；`KB_WIKI=off` 可整体关闭。上传流程里的 `llm` 来自 `getDeps()`（默认豆包），所以**自动生成的目录页一律是确定性兜底**——要带一句话说明，整个 web 服务用 `KB_LLM=claude` 起，或事后 `KB_LLM=claude npm run wiki-demo -- <docId>` 补跑单篇。
  - **agentic 检索**（`packages/pipeline/src/agent-search.ts` 的 `agentSearch()` + `packages/pipeline/src/agent-tools.ts` 的五个工具 `list_docs`/`read_outline`/`read_page`/`grep`/`search`）：不再是一次性混合检索+作答，改成模型自主决定「先看目录、翻哪几页」的多轮循环，靠 `LlmClient.runTools()`（Anthropic `tool_use` 协议，302 专属）驱动。轮次上限（默认 12）与累计注入 token 预算（12 万）两道闸兜底，触顶强制模型基于已读内容收尾作答（结果标 `truncated`）。
  - **`/ab` 双栏对比页**（`apps/web/app/ab/page.tsx` + `apps/web/app/api/ab/route.ts`）：同一个问题并发跑 A 栏（现状 `chatTurn`）与 B 栏（`agentSearch`），并排展示答案/耗时/token，B 栏可展开完整工具轨迹，可逐轮打分（落 `ab_runs` 表）。**两栏必须显式指定同一模型**：`KB_MODEL_ANSWER`/`KB_MODEL_CONTEXT` 这类变量两个后端共用，真实 `.env` 里是豆包模型名，直接喂给 302 的 Anthropic 端点必错——两栏统一用 `KB_MODEL_AB`（默认 `claude-opus-4-8`）显式构造 `new LlmClient({ answerModel: AB_MODEL })`；agentSearch 内部工具调用同理走 `KB_MODEL_AGENT`（默认同为 `claude-opus-4-8`）。
  - **豆包后端不支持 B 栏**：`ArkLlmClient` 没有 `runTools`/`answerRaw`，agentic 检索与「带说明的目录页」都要求走 302 的 `LlmClient`——这是「对话层整体迁豆包」计划里唯一没迁完、也迁不动的一块（tool_use/文本纯生成协议豆包没有对等能力）。
  - **无需登录态的验证 CLI**：`npm run wiki-demo -- <docId>` 给已入库的存量文档补跑 wiki 化；`npm run ab-demo -- "问题" [docId1,docId2,...]`（不传 docId 默认取全部已 wiki 化的文档）在没有登录 cookie 的情况下也能直接跑通 A/B 两栏——依赖构造方式与 `/api/ab/route.ts` 逐字一致，是验证「302 tool use 转发是否真的通」最快的路径；**不写 `ab_runs` 表**（调试工具，不污染实验数据）。已实测：`claude-opus-4-8` 经 302 可用，工具调用循环真实工作（轨迹里能看到 `list_docs`→`read_outline`→连续多次 `read_page`）；同期发现 `claude-haiku-4-5` 当前在 302 上 503（"No available models currently"）——是模型级可用性问题，不是本功能的代码缺陷，`KB_MODEL_CONTEXT`/`KB_MODEL_AB` 等显式覆盖时要避开它。
  - **存量文档的一个真实缺口**（跑 `wiki-demo` 时发现）：`ingestDoc` 落库时只传 `title/source/status`，从未把解析出的 markdown 写回 `docs.raw_text`/`structured_md`（这两列在 schema 里一直存在，写入路径却缺失，像是更早期遗留的空实现，与本次改动无关）——`wiki-demo` 因此在这两列为空时退回按 `chunk_index` 顺序拼回 `chunks.content_original` 重建原文（chunker 没把标题行剥掉，拼接后仍能正常按标题分页；唯一代价是相邻文本 chunk 间 ~80 token 的 overlap 会在拼接处轻微重复，不影响正确性）。

## 注意

- 解析层是 `ParserBackend` 接口，web 经 `getParser(filename)` 按类型选后端（⑪ 后主流格式全不依赖 Claude）：
  - **csv/xlsx → `TabularSandboxParser`**（确定性，`tabular_to_md.py`，逐行保真、无模型、最快）；
  - **docx → `DocxSandboxParser`**（`docx_to_md.py`，产出过少才退兜底）；
  - **pdf → `PdfParser`**：有文本层 → `pdf_to_md.py`（pdfplumber 确定性）；扫描件/字体 cmap 坏 → 豆包 vision 逐页 OCR；
  - **pptx → `ScriptSandboxParser`**（`pptx_to_md.py`）；**txt/md → `PlainTextParser`**（直读，不起容器）；
  - **其余未知格式 → `SandboxDockerParser`**（容器化 Claude Code，模型是 `KB_MODEL_PARSE`；填 doubao-* 则经协议翻译反代打方舟）——这是 agent 唯一真正划算的场景，故保留；
  - `KB_PARSER=claude` 让所有格式都走 Claude Code（效果对比）；`=host` 走宿主机 `ClaudeCodeSandboxParser`；`claude-sandbox.ts`（第一方 code_execution）是不用的备选。
- **解析已容器化隔离**（`kb-sandbox` 镜像，里程碑①）：非 root + `cap-drop ALL` + `no-new-privileges` + tmpfs + 输入只读；确定性表格解析再加 `--network none`。镜像预装 pdfplumber/python-docx/openpyxl/pandas，真实 pdf/docx/xlsx 都能解析。egress 仅放行 api.302.ai 是可选加固。
- **宿主机 python 可能不可用**（如本机 homebrew python3.14 的 pyexpat 坏了），所以表格解析走容器而非宿主机。
- **改/加 `apps/worker/python/*.py`（`tabular_to_md.py` / `docx_to_md.py` / `pdf_render.py` 等确定性解析脚本）后必须 `docker build ... -t kb-sandbox:latest` 重建镜像**（Dockerfile `COPY apps` 在 build 时把脚本烤进镜像）。否则容器内跑的是旧脚本、甚至新脚本不存在——如 `docx_to_md.py` 缺失会让每篇 docx 静默退回 Claude Code（DocxSandboxParser 有 warn 日志但确定性路径实际从未运行）。
- 扫描/纯视觉 PDF：让 Claude Code 在沙箱内识别（顶部写 `<!-- SCANNED -->`），后续走 vision 图→文 那条线。
- **代理坑**：302 海外端点本机要走 Clash（实测直连 ETIMEDOUT）——SDK / `fetch`(undici) 默认不读 `HTTPS_PROXY`。`LlmClient`/`embedder`/`reranker` 构造时调 `installProxyFromEnv()`（undici `ProxyAgent` 装全局代理，读 host 的 `HTTPS_PROXY`）。**容器内**：`SandboxDockerParser` 给子进程设 `HTTPS_PROXY=host.docker.internal:7897`，容器里的 Claude Code 与 `beta-sanitizing-proxy` 都经宿主机 Clash 到 302；确定性表格解析不联网（`--network none`）。
- **环境隔离坑**：解析子进程（Agent SDK）会从外层 Claude Code 会话继承 `CLAUDE_CODE_*` 等 env；本地代理需对子进程设 `NO_PROXY=127.0.0.1`，否则它把本地请求经 Clash 隧道出去。
- **本机 DB 坑**：在这台开发机上 `localhost:5432` 是**原生 Homebrew postgres**（`DATABASE_URL` 指向它，装的是真实数据），`npm run db:up` 起的 Docker 容器（`docker compose exec ... db`）是**空壳**，装不了业务表。手工排查一律 `psql "$DATABASE_URL"` 连，**绝不要**用 `docker compose exec ... psql`——后者会返回「relation does not exist」这类看着像真问题、实则只是连错库的假阴性，此前排查任务上真被坑过、浪费过时间。
