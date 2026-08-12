# 部署上线注意事项

> 给执行部署的人或 AI 看。**本项目有多处「配错了不报错、只是功能悄悄失效」的地方**，
> 第 3 节逐条列了出来——那一节是本文档的重点，比部署步骤本身更容易出事。

---

## 0. 前置依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node | **≥ 18.18** | monorepo 用 npm workspaces，`"type": "module"` |
| Postgres | **≥ 14 + pgvector 扩展** | 可用 `docker compose up -d` 起（pgvector/pg16，库 `kbstudio`，role `kb/kb`），或用外部实例 |
| Docker | **daemon 必须可用，且运行 web 的用户要有权限执行 `docker run`** | 文件解析全部在容器里跑，没有 Docker 就完全不能上传文件 |
| 出网 | 能访问 `ark.cn-beijing.volces.com`（国内直连）和 `api.302.ai`（海外，可能需代理） | 见 §3.7 |

⚠️ **web 进程自己不在容器里**，它是在宿主机上 `docker run` 起解析沙箱。如果你把 web 也装进容器，
必须挂 `/var/run/docker.sock` 并保证容器内有 docker CLI，否则解析全部失败。

---

## 1. 环境变量

**`.env` 被 gitignore，不会随代码过来，必须在目标机器上重新创建一份。**

### 1.1 先建软链（最容易漏，漏了整个应用读不到任何配置）

Next.js 只读 `apps/web/.env.local`，项目靠一个**软链**把它指向根目录的 `.env`：

```bash
ln -sf ../../.env apps/web/.env.local
```

这个软链**也被 gitignore 了**（`.gitignore` 里的 `.env.*` 规则会匹配到它），所以克隆下来是没有的。
不建的话：应用能正常启动、页面能打开，但所有模型调用、数据库连接、发信全部失败。

### 1.2 变量清单

```bash
# ---- 数据库 ----
DATABASE_URL=postgres://kb:kb@localhost:5432/kbstudio

# ---- 火山方舟（对话层 + 解析层，国内直连）----
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=<火山方舟 API Key>
KB_MODEL_STRUCTURE=doubao-seed-2-0-lite-260428
KB_MODEL_CONTEXT=doubao-seed-2-0-lite-260428
KB_MODEL_VISION=doubao-seed-2-0-lite-260428
KB_MODEL_ANSWER=doubao-seed-2-0-pro-260215
KB_MODEL_PARSE=doubao-seed-2-0-code-preview-260215   # 未知格式兜底的 agent 解析

# ---- 302.ai（仅向量 + 重排仍在这里，需账户有余额）----
ANTHROPIC_BASE_URL=https://api.302.ai
ANTHROPIC_AUTH_TOKEN=<302 key>
EMBED_BASE_URL=https://api.302.ai/v1
EMBED_API_KEY=<302 key，同上>
EMBED_MODEL=BAAI/bge-m3          # 必须带 BAAI/ 前缀，裸名会 500
EMBED_DIM=1024
RERANK_MODEL=BAAI/bge-reranker-v2-m3

# ---- 关键词检索的自定义词典 ----
KB_JIEBA_WORDS=润度,润度生物       # 品牌/专有名词，改了必须 rebuild-tsv，见 §3.3

# ---- 发信（不配则验证码发不出去，且接口仍返回成功，见 §3.2）----
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<发件邮箱>
SMTP_PASS=<授权码，不是登录密码>
SMTP_FROM=<发件邮箱>

# ---- 管理后台（默认 admin/admin，生产必须改，见 §3.6）----
ADMIN_USER=<改掉>
ADMIN_PASS=<改掉>
ADMIN_SESSION_SECRET=<随机长字符串，用于 HMAC 签名>

# ---- collector 对接（用不到可省）----
COLLECTOR_SERVICE_SECRET=<随机串>
NEXT_PUBLIC_COLLECTOR_BASE_URL=https://<collector 域名>

# ---- 代理（仅当 302 海外端点直连不通时开；火山不受影响，见 §3.7）----
# HTTPS_PROXY=http://127.0.0.1:7897
```

---

## 2. 部署步骤（**顺序有依赖，不要跳**）

```bash
# 1. 装依赖
npm install

# 2. 建配置 + 软链（见 §1）
vim .env
ln -sf ../../.env apps/web/.env.local

# 3. 数据库就绪（用自带的 compose，或指向外部实例）
docker compose up -d

# 4. 建表 + 索引 —— 迁移 0016 会创建关键词检索的 GIN 索引
npm run db:migrate

# 5. 构建解析沙箱镜像（不建 = 所有文件上传都失败）
docker build --build-arg HTTPS_PROXY=<宿主机代理，可省> -t kb-sandbox:latest .

# 6. 重建 BM25 索引 —— 仅当「库里已有数据」且「改过 KB_JIEBA_WORDS」时需要
npm run rebuild-tsv

# 7. 自检：只打火山对话层，不碰 302 和数据库，最快确认模型链路通
npm run ark-check

# 8. 构建 + 启动（默认 3001 端口）
npm run build --workspace @kb/web
npm run start --workspace @kb/web
```

---

## 3. ⚠️ 会「静默失败」的地方

**这一节是重点。** 下面每一条都不会报错、不会让服务起不来，只是某个功能悄悄不工作，
不主动去测就发现不了。

### 3.1 `.env.local` 软链没建

**现象**：服务正常启动，页面正常打开，但登录/上传/检索全部报错或转圈。
**原因**：Next.js 只认 `apps/web/.env.local`，而它是个 gitignored 的软链，克隆下来不存在。
**排查**：`ls -la apps/web/.env.local` 应指向 `../../.env`。
**验证**：启动日志里出现 `- Environments: .env.local` 才算读到了。

### 3.2 SMTP 未配置 —— 接口会**谎报成功**

**现象**：注册/忘记密码点「发送验证码」，前端提示已发送、接口返回 `{"ok":true}` HTTP 200，
但用户永远收不到邮件。
**原因**：`apps/web/lib/mailer.ts` 的设计是「缺 `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` 任一项
就打印到服务端 console 后直接 return」，这是给本地联调用的兜底，**在生产环境等于功能失效且无感知**。
**排查**：服务端日志里出现 `[mailer] ...（SMTP 未配置，dev 兜底打印）` 就是中招了。
**注意**：QQ 邮箱个人版有发信频率上限，注册量大建议用企业邮箱。

> 已知代码缺陷（尚未修复）：非开发环境缺 SMTP 时应该直接报错而不是静默兜底。
> 部署前请务必确认 SMTP 六个变量齐全并实际收一封测试邮件。

### 3.3 改了 `KB_JIEBA_WORDS` 却没重建索引 —— 关键词检索**全线失灵**

**现象**：搜任何词都搜不到结果，或结果明显变少。
**原因**：`chunks.tsv_text` 是**入库那一刻固化的分词结果**。改了自定义词典后，
查询会用新分词（`'润度'`）去撞索引里的旧分词（`'润' '度'`），两边对不上 → **一条都匹配不到**。
比不加词典还糟。
**修法**：

```bash
npm run rebuild-tsv     # 纯本地 CPU 重算分词，不调模型、不碰向量，千级 chunk 数秒完成
```

**什么时候必须跑**：改了 `KB_JIEBA_WORDS`、或改了 `packages/db/src/bm25.ts` 里任何影响
`tokenizeZh` 的逻辑之后。**数据迁移到新库后也要跑一次**。

### 3.4 改了 python 解析脚本却没重建镜像

**现象**：解析行为跟代码对不上；或某类文件解析报「脚本不存在」后**静默退回 Claude Code 兜底**
（日志里有 warn，但功能看起来还能用，只是变慢变贵）。
**原因**：`Dockerfile` 里 `COPY apps` 是**构建期**把脚本烤进镜像的，改了宿主机上的 `.py` 不会生效。
**涉及文件**：`apps/worker/python/` 下的 `pdf_to_md.py` / `pptx_to_md.py` / `docx_to_md.py` /
`tabular_to_md.py` / `pdf_render.py` / `extract_archive.py`。
**修法**：`docker build ... -t kb-sandbox:latest .` 重建。

### 3.5 忘了跑 `db:migrate` —— 性能悄悄劣化

迁移 **0016** 创建关键词检索的 GIN 索引 `chunks_tsv_gin`。不建索引功能仍然正常，
但每次关键词检索都是**全表扫描 + 逐行实时计算 tsvector**，语料一大就线性劣化。
**排查**：`SELECT indexname FROM pg_indexes WHERE tablename='chunks';` 应包含 `chunks_tsv_gin`。

### 3.6 管理后台默认口令是 `admin/admin`

`/admin` 在未设置 `ADMIN_USER`/`ADMIN_PASS` 时**默认就是 admin/admin**，且能看到全部用户列表
和系统统计。生产环境必须改，并设一个随机的 `ADMIN_SESSION_SECRET`（用于签名 cookie，
不设的话会话签名可被伪造）。

### 3.7 代理配错方向

本项目同时调**国内**和**海外**两类服务，代理要求相反：

| 服务 | 出网方式 |
|---|---|
| 火山方舟 `*.volces.com` | **必须直连**。走代理会出海再回国，既慢又可能因出口 IP 触发 API Key 限制 |
| 302 `api.302.ai` | 视机房而定，海外端点可能需要代理 |

代码里已用 undici 的 `EnvHttpProxyAgent` 按 host 白名单分流（`packages/adapters/src/proxy.ts`），
只要正常设 `HTTPS_PROXY` 即可，火山会自动绕过。**额外的国内域名可用 `KB_NO_PROXY_HOSTS` 追加**
（注意：子域必须写成 `.example.com` 形式，不带点的条目 undici 只做精确匹配）。

### 3.8 302 账户余额不足

向量化和重排**仍然依赖 302**（对话层和解析层已迁到火山）。302 欠费时的现象是：
上传文件走到 `embedding` 阶段失败、文档标 `failed`；检索提问也失败。
错误信息 `err_code -10004 账户余额不足` 只出现在服务端日志里。

---

## 4. 上线后验证清单

按顺序逐项确认，任何一项不过都不要对外开放：

```bash
# ① 模型链路（只打火山，最快）
npm run ark-check
#    期望：上下文化 / 查询改写 / 引用溯源 / vision 全部 ✅

# ② 数据库与索引
psql "$DATABASE_URL" -c "SELECT indexname FROM pg_indexes WHERE tablename='chunks';"
#    期望：包含 chunks_tsv_gin

# ③ 解析沙箱镜像存在且脚本是最新的
docker run --rm --entrypoint ls kb-sandbox:latest /app/apps/worker/python/
#    期望：能看到 pdf_to_md.py、pptx_to_md.py
```

界面上再手工过一遍：

- [ ] **注册流程**：能收到验证码邮件（这一项专门验 §3.2）
- [ ] **上传一个 PDF**：进度走完、状态变 `ready`，chunk 预览有内容
- [ ] **上传一个 xlsx**：确定性解析，秒级完成
- [ ] **检索提问**：能返回答案且带溯源；命中片段分数应为 **0~1 且降序**
- [ ] **搜一个只在某篇文档里出现的罕见词**：该文档应以明显高分排第一（验 BM25 的 IDF 生效）
- [ ] **管理后台** `/admin`：确认已不是 admin/admin

---

## 5. 数据迁移到新库时的额外步骤

如果是把现有数据搬到新环境（而不是全新空库）：

1. 先 `npm run db:migrate` 补齐表结构和索引
2. 导入数据
3. **必跑** `npm run rebuild-tsv`——分词索引与代码里的词典必须一致，见 §3.3
4. 向量（`chunks.embedding`）**不需要**重算，只要 `EMBED_MODEL` 和 `EMBED_DIM` 没变。
   换 embedding 模型则必须全量重嵌（换模型 = 换向量空间，新旧向量不可混用）

---

## 6. 回退开关

出问题时可以快速切回旧路径，都是改 `.env` + 重启（**环境变量不热重载**）：

| 开关 | 作用 |
|---|---|
| `KB_LLM=claude` | 对话层退回 302 的 Claude（需 302 有余额） |
| `KB_MODEL_PARSE=claude-haiku-4-5-20251001` | 解析兜底退回 Claude Code 打 302 |
| `KB_PARSER=claude` | 所有文件类型都走 Claude Code 解析（放弃确定性解析） |
| `KB_AUTO_STRUCTURE=off` | 关掉「无标题文档自动造结构」 |
| `KB_ANSWER_THINKING=on` | 问答开启深度思考（默认关，reasoning token 按输出价计费） |
