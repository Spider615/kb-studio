# kb-studio 第二轮调整 — 设计文档

- **日期**：2026-06-27
- **范围**：`apps/web` + `packages/db`（schema/repo）+ `packages/pipeline`（ingest 进度回调）
- **目标**：8 项使用体验调整，分三组：A 处理体验、B 对话+小修、C 秒懂凭据+推送。
- **基线**：建立在已合（或待合）的 `ui-redesign-claude` Claude 暖色 UI 之上，沿用其设计系统类名。

## 锁定决策（已与用户确认）

1. **#1 进度**：阶段 + 百分比（最耗时的「上下文化」阶段显示 done/total）。
2. **#7 凭据存储**：**落到数据库**（新表 `miaodong_credentials`，含 accessKeySecret 明文——本地内部工具可接受）。
3. **#4 Markdown**：加依赖 `react-markdown` + `remark-gfm`。
4. **A 组架构**：上传改异步后台（Next 长驻进程内 detached 任务 + 内存 AbortController 注册表 + DB 进度），不引 pg-boss。

## 非目标

- 不引 pg-boss / 独立 worker（进程重启留下的孤儿 processing 文档由用户手动删，可接受）。
- 凭据不加密、不做编辑（只增/删；改＝删后重建）。
- 不改检索/问答管线逻辑、不动解析后端。

---

## A 组 · 处理体验（#1 进度、#2 列表删除/取消）

### 数据模型（`packages/db/src/schema.ts` · docs）
新增列：
- `progress jsonb` —— `{ stage: 'parsing'|'structuring'|'contextualizing'|'embedding'|'storing', done: number, total: number } | null`
- `error text` —— 失败原因（status=failed 时）
- `status` 文本值扩展：`processing`（处理中）、`failed`（失败），沿用 `ready`/`pushed`。无需迁移枚举（status 是 text）。

### repo 新增（`packages/db/src/repo.ts`）
- `createProcessingDoc(id, title, source)` —— 插入 `{id,title,source,status:'processing',progress:{stage:'parsing',done:0,total:0}}`。
- `setDocProgress(id, progress)` —— 更新 `progress` 列。
- `failDoc(id, error)` —— `status='failed', error=<msg>, progress=null`。
- `clearDocProgress(id)` —— `progress=null, error=null`（成功后清理）。
- `getDocStatus(id)` —— 返回 `{status} | null`（取消时判断用，避免取已删行报错）。
- `listDocs` 查询增加 `progress`、`error` 字段返回（`DocListItem` 同步加 `progress?`, `error?`）。

### `ingestDoc` 进度回调（`packages/pipeline/src/ingest.ts`）
- opts 增加 `onProgress?: (p: { stage: string; done: number; total: number }) => void | Promise<void>` 与 `signal?: AbortSignal`。
- 上报点：chunk 完成后 `stage='contextualizing', total=chunks.length`，上下文化每完成一个 chunk `done++` 上报；进入 embed 前 `stage='embedding'`；存库前 `stage='storing'`。
- 每个 chunk 处理前检查 `signal?.aborted`，若已取消则抛 `AbortError` 提前结束。

### 上传流程（`apps/web/app/api/upload/route.ts`）
- 解析 formData → 生成 docId → `createProcessingDoc` → **立即返回 `{ docId }`**（不等处理）。
- 后台（不 await 的 async IIFE，经 `lib/jobs.ts` 注册 AbortController）：
  1. `setDocProgress(stage:'parsing')` → 解析；
  2. 若需造结构 `setDocProgress(stage:'structuring')` → `llm.structure`；
  3. `ingestDoc(..., { onProgress: p => setDocProgress(docId,p)（节流）, signal })`；ingestDoc 末尾 `upsertDoc(status:'ready')`；
  4. 成功 `clearDocProgress(docId)`；失败（非 abort）`failDoc(docId, msg)`；abort 则静默退出（行已被删）。
  5. finally 从注册表注销。
- 进度写库**节流**：onProgress 仅在 `done===total` 或每 `max(1, ceil(total/20))` 个 chunk 写一次，避免高频写库。

### 任务注册表（新文件 `apps/web/lib/jobs.ts`）
- 模块级 `const jobs = new Map<string, AbortController>()`。
- `startJob(docId): AbortSignal`、`abortJob(docId): boolean`、`endJob(docId)`。
- 单 Node 进程内有效；进程重启即丢失（孤儿 processing 文档用户可删）。

### 删除 / 取消（`apps/web/app/api/docs/[id]/route.ts` DELETE）
- 先 `abortJob(id)`（若在处理中，触发后台提前退出），再 `deleteDoc(id)`（chunk 级联删）。返回 `{ok:true}`。
- 对就绪/失败文档：abortJob 无副作用，直接删。

### 前端
- **`apps/web/app/page.tsx`**：`load()` 后，若存在 `status==='processing'` 的文档，则启动 `setInterval` 每 1500ms 轮询 `/api/docs` 刷新；无处理中文档时清除轮询。上传成功（拿到 docId）后 `load()` + 选中该 docId。
- **`apps/web/components/DocList.tsx`**：
  - 上传按钮逻辑不变（已是隐藏 input + CTA）。
  - 列表项 meta 按 status 渲染：`processing` → 阶段中文 + 细进度条（用 `progress`），`failed` → 「失败」(红) ，`ready/pushed` → 现有文案。圆点：processing/failed 用 pending/err 色。
  - **每项加 hover ✕ 删除**（含处理中）：点击 → confirm → `DELETE /api/docs/[id]` → 通知父组件 `onDeleted` 刷新。新增 `onDeleted` prop。
- **`apps/web/components/DocDetail.tsx`**：docId 对应文档 `status==='processing'` 时，详情区显示进度（阶段 + 进度条）而非 chunk；`failed` 显示错误。需要从 `/api/docs/[id]` 返回 `status/progress/error`（GET 已返回 status，补 progress/error）。详情页轮询同上（处理中时）。

### 阶段中文映射（前端常量）
`parsing→解析中`、`structuring→生成结构中`、`contextualizing→上下文化中`、`embedding→向量化中`、`storing→写入中`。

---

## B 组 · 对话 + 小修（#3 #4 #5 #6）

### #3 新建对话守卫
- `listConversations`（repo）增加 `messageCount`（子查询 `count(messages)`）。返回类型加 `messageCount: number`。
- `apps/web/app/chat/page.tsx` `onNew`：先在 `items` 找 `messageCount===0` 的对话；找到则 `setSelectedId(它)` 直接返回（不 POST）；否则 POST 新建。
- `ConversationList`/`Conv` 类型加 `messageCount`。

### #4 Markdown 渲染
- `apps/web/package.json` 加 `react-markdown` + `remark-gfm`。
- `apps/web/components/ChatThread.tsx`：助手气泡 `.a-body` 内用 `<ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>`；用户气泡、`思考中…`、`溯源`、`命中片段` 保持纯文本。
- `globals.css` 加气泡内 markdown 排版：`.a-body h1/h2/h3`、`ul/ol/li`、`p`、`code`、`pre`、`table`、`a`、`strong`、`blockquote` 的暖色排版（紧凑、不溢出）。

### #5 下拉框样式（`globals.css` `.scope select`）
- `appearance:none` + 右侧自定义箭头（内联 SVG data-uri 背景）+ 暖色描边、hover/focus 用 accent 描边。与 `.btn`/输入风格统一。

### #6 去掉悬浮球（Next dev 指示器）
- `apps/web/next.config.mjs` 加 `devIndicators: false`（Next 15.5 支持；仅 dev 显示，关掉即消失）。

---

## C 组 · 秒懂凭据 + 推送（#7 #8）

### 数据模型
- **新表 `miaodong_credentials`**（schema.ts）：`id text pk, name text notNull, domain text notNull, accessKeyId text notNull, accessKeySecret text notNull, knowledgeBaseId text notNull, createdAt timestamptz default now`。
- **`docs` 加 `pushTargets jsonb`**：`Array<{ credentialId, credentialName, knowledgeBaseId, domain, remoteDocId: string|null, pushedAt: string }>`，默认 `[]`/null。旧 `miaodong*` 列保留不用（不破坏）。

### repo 新增
- `listCredentials()` → 全部凭据（含 secret，本地工具）。
- `createCredential({id,name,domain,accessKeyId,accessKeySecret,knowledgeBaseId})`。
- `deleteCredential(id)`。
- `getCredentials(ids: string[])` → 指定多个凭据（推送用）。
- `setDocPushTargets(docId, targets)` → 写 `pushTargets` + `status='pushed'` + `pushedAt=now`。
- `getDocWithChunks` 已返回整行 doc（含 pushTargets），详情 API 透传。

### 凭据 API
- 新 `apps/web/app/api/credentials/route.ts`：`GET`（列表）、`POST`（建，生成 `cred_xxx` id，必填校验）。
- 新 `apps/web/app/api/credentials/[id]/route.ts`：`DELETE`。

### 凭据管理弹框（`CredentialsDialog.tsx` 重做）
- 改为 DB 驱动：打开时 `GET /api/credentials` 列出（名称 + 域名 + kbId + 删除按钮）；底部「新增凭据」表单含 **凭证名称** + 域名 + accessKeyId + accessKeySecret + knowledgeBaseId → `POST` → 刷新列表。删除 → `DELETE` → 刷新。
- 移除旧 `LS_KEY` localStorage 逻辑。

### 推送弹框（`PushDialog.tsx` 重做）
- 打开时 `GET /api/credentials`；列出凭据为**可勾选项（多选）**；无凭据时提示「请先到左下角设置添加凭据」。
- 确认 → `POST /api/confirm { docId, credentialIds: string[] }`。`onSubmit` 签名改为传 `credentialIds`。
- props 去掉手输 creds，改 `pushing/error` 保留。

### `/api/confirm` 重做
- 入参 `{ docId, credentialIds: string[] }`。`getCredentials(ids)` 取凭据；对每个凭据 `adapter.push(...)`；汇总结果。
- 合并进 `docs.pushTargets`：按 `knowledgeBaseId` 去重——已存在则更新 `remoteDocId/pushedAt/credentialName`，否则追加。`setDocPushTargets`。
- 任一成功即 `status='pushed'`；逐个返回成功/失败明细 `{ results: [{credentialName, ok, error?}] }`。

### #8 详情已推送展示（`DocDetail.tsx`）
- 读 `doc.pushTargets`；非空时头部显示 pill「已推送：名A、名B」（凭证名拼接）。
- **「推送到秒懂」按钮始终显示**（无论是否已推送），点开多选弹框可再次推送 / 推送到更多知识库。
- 推送成功后重新拉详情刷新 pushTargets。

---

## 受影响文件

| 文件 | 改动 |
|---|---|
| `packages/db/src/schema.ts` | docs 加 `progress/error/pushTargets`；新表 `miaodongCredentials` |
| `packages/db/src/repo.ts` | 进度/失败/凭据/pushTargets 等 helper；`listDocs`+progress/error；`listConversations`+messageCount |
| `packages/pipeline/src/ingest.ts` | `ingestDoc` 加 `onProgress` + `signal` |
| `apps/web/lib/jobs.ts` | **新增** 内存任务注册表 |
| `apps/web/app/api/upload/route.ts` | 改异步：建行→返回→后台处理+进度+取消 |
| `apps/web/app/api/docs/[id]/route.ts` | GET 补 progress/error；DELETE 先 abortJob |
| `apps/web/app/api/docs/route.ts` | 透传 progress/error（listDocs 已带） |
| `apps/web/app/api/conversations/route.ts` | 列表透传 messageCount（repo 已带） |
| `apps/web/app/api/credentials/route.ts` | **新增** GET/POST |
| `apps/web/app/api/credentials/[id]/route.ts` | **新增** DELETE |
| `apps/web/app/api/confirm/route.ts` | 改多凭据多目标推送 + pushTargets |
| `apps/web/app/page.tsx` | 处理中轮询 + onDeleted |
| `apps/web/app/chat/page.tsx` | 新建对话守卫（复用空对话） |
| `apps/web/components/DocList.tsx` | 进度/失败渲染 + 列表项删除 |
| `apps/web/components/DocDetail.tsx` | 处理中/失败视图 + pushTargets 展示 + 推送按钮常驻 |
| `apps/web/components/ChatThread.tsx` | react-markdown 渲染助手气泡 |
| `apps/web/components/ConversationList.tsx` | Conv 类型加 messageCount（渲染不变） |
| `apps/web/components/PushDialog.tsx` | 改凭据多选 |
| `apps/web/components/CredentialsDialog.tsx` | 改 DB 凭据管理（增删列表 + 名称） |
| `apps/web/app/globals.css` | 下拉框、markdown 排版、进度条样式 |
| `apps/web/next.config.mjs` | `devIndicators:false` |
| `apps/web/package.json` | + react-markdown, remark-gfm |

## 迁移
`npm run db:generate && npm run db:migrate`（docs 新列 + 新表 miaodong_credentials）。

## 验收标准
- 上传后列表立即出现处理中文档，显示阶段 + 上下文化百分比；完成转「就绪」。
- 处理中/就绪/失败文档都能从列表 hover ✕ 删除；删处理中的会中止后台任务。
- 连续点「新建对话」不再堆叠空对话（复用空的）。
- 助手回答按 markdown 渲染（标题/列表/表格/代码/粗体）。
- 知识库范围下拉框样式与设计统一；左下角不再有「N」悬浮球。
- 设置里可新增/删除多个命名凭据（落库）；推送弹框可多选凭据推送；已推送文档显示凭证名且推送按钮仍在、可再推。
- `npm run typecheck --workspace @kb/web` + root typecheck 通过。
