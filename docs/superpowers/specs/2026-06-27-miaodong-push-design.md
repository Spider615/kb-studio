# 秒懂推送（MiaodongAdapter 接真接口）设计

里程碑 ⑥：把秒懂推送从 stub 换成真实接口。用户在 chunk 预览页点「确认推送秒懂」时弹框填凭据，确认后执行 取 token → 建文档 → 建段落，成功后本地标记已推送并存远端引用。

## 背景与现状

- `StubMiaodongAdapter.push(payload)` 当前只 `console.warn`，不真正推送。
- `apps/web/app/api/confirm/route.ts` 收 `{docId}` → 取 chunks → 调 stub → 把 `docs.status` 置 `pushed`。
- `apps/web/components/DocDetail.tsx` 的「确认推送秒懂」按钮**直接** POST `/api/confirm`，无弹框、无凭据。
- `docs` 表有 `status / confirmedAt / pushedAt`，**没有**远端引用字段。

## 秒懂真实接口（出处：https://jz-insight.apifox.cn/llms.txt）

base = 用户填的**域名**（规范化成 `https://<host>`，默认形如 `insight.juzibot.com`）。

1. **取 token** `POST {base}/openapi/get-access-token`
   - body `{ accessKeyId, accessKeySecret }`
   - 响应 `{ code, data: { accessToken, expiresIn } }`（token 有效 2h，服务端会复用）
2. **建文档** `POST {base}/openapi/knowledge-base/doc/create`
   - header `Authorization: Bearer <token>`
   - body `{ knowledgeBaseId, name, metadata? }`
   - 响应 `{ code, data: { id } }`（id = 秒懂文档 id）
3. **建段落** `POST {base}/openapi/knowledge-base/doc/paragraph/create`
   - header `Authorization: Bearer <token>`
   - body `{ knowledgeBaseId, docId, content }`，**content ≤ 1000 字符**
   - 响应 `{ code, data: { id } }`

## 锁定的设计决策（已与用户确认）

- **段落正文**：推**上下文化 `content`**（带上下文前缀，利于秒懂自身检索）；单 chunk >1000 字符时**按句切分**成多个段落。
- **推送标识**：**本地标 pushed + 存远端引用**——本地 `docs` 标 `status=pushed`/`pushedAt`（已有），并新增字段存远端 `knowledgeBaseId`、秒懂 `docId`、域名，避免重复推送、便于追溯。
- **凭据记忆**：**记非密字段，不记 secret**——域名/accessKeyId/knowledgeBaseId 存浏览器 `localStorage` 下次预填；`accessKeySecret` 每次重输。
- **方案**：推送编排放在 `@kb/adapters` 的 `RealMiaodongAdapter`（实现 `MiaodongAdapter`），保持「秒懂=可插拔推送终点」的锁定决策，worker 可复用。

## 组件设计

### 1. 契约 `packages/core/src/interfaces.ts`

```ts
export interface MiaodongCredentials {
  domain: string;          // 用户填，构造时规范化成 https://<host>
  accessKeyId: string;
  accessKeySecret: string;
  knowledgeBaseId: string;
}

export interface PushResult {
  ok: boolean;
  pushed: number;          // 成功推送的段落数
  target: string;          // "miaodong" | "stub"
  remoteDocId?: string;    // 秒懂返回的文档 id
  knowledgeBaseId?: string;
  ref?: string;            // 保留
}

export interface MiaodongAdapter {
  push(payload: PushPayload, creds: MiaodongCredentials): Promise<PushResult>;
}
```

`PushPayload` 不变（`{ docId, title, chunks }`）。`StubMiaodongAdapter.push` 同步加 `creds?` 参数（仍只打印）。

### 2. `RealMiaodongAdapter` `packages/adapters/src/miaodong/real.ts`

职责：用一组凭据把一篇文档的 chunks 推到秒懂知识库。

- 构造/调用时把 `domain` 规范化：去掉协议前缀和结尾 `/`，统一成 `https://<host>`；路径恒为 `/openapi/...`。
- **不调 `installProxyFromEnv()`**——秒懂是国内端点，代理只给 302 海外端点用。
- 内部方法：
  - `getToken(base, creds)` → 取 token。
  - `createDoc(base, token, creds, name)` → 返回秒懂 docId。**不**传 `metadata`（按用户选择：只在本地存远端引用，不往秒懂文档写来源标记）。
  - `createParagraph(base, token, creds, remoteDocId, content)` → 建单段落。
- `push(payload, creds)` 流程：
  1. 由 `payload.chunks`（按 `chunk_index` 升序）逐条取 `content`，经 `splitForParagraph` 切成 ≤1000 字符的段落文本数组（保序）。
  2. `getToken` → `createDoc(name = payload.title)` 得 `remoteDocId`。
  3. **顺序**遍历段落文本 `createParagraph`（保序、规避限流），计数 `pushed`。
  4. 返回 `{ ok: true, pushed, target: "miaodong", remoteDocId, knowledgeBaseId: creds.knowledgeBaseId }`。
- **字符计数**用 `Array.from(text).length`（按码点），阈值 1000，留 1 字余量更稳。
- **切分** `splitForParagraph(text, max=1000)`：先按句界（。！？；\n 及英文 .!?）切句，再贪心打包进 ≤max 的段；单句仍 >max 则按 max 硬切。
- **错误处理**：每步检查 `res.ok` 且 `data` 存在，否则抛 `秒懂<步骤>失败: <status> <响应体文本>`。任一步抛错则整体失败（见下「容错」）。

### 3. DB `packages/db/src/schema.ts` + 迁移

`docs` 表新增三列（均可空 `text`）：

```ts
miaodongKbId:   text("miaodong_kb_id"),
miaodongDocId:  text("miaodong_doc_id"),
miaodongDomain: text("miaodong_domain"),
```

跑 `npm run db:generate && npm run db:migrate` 生成并应用迁移。

### 4. API `apps/web/app/api/confirm/route.ts`

- 收 `{ docId, credentials: { domain, accessKeyId, accessKeySecret, knowledgeBaseId } }`。
- 校验 `docId` 与四个凭据字段非空，缺则 400。
- 取该 doc 的 chunks（按 `chunk_index` 升序）+ doc 标题。
- `new RealMiaodongAdapter().push({ docId, title, chunks }, credentials)`。
- 成功：更新 `docs` 置 `status=pushed, confirmedAt=now, pushedAt=now, miaodongKbId=knowledgeBaseId, miaodongDocId=remoteDocId, miaodongDomain=规范化域名`，返回 `{ ok, pushed, remoteDocId }`。
- 失败：返回 `{ error }` 500，**不**改 status。

### 5. Web UI `apps/web/components/DocDetail.tsx` + 新增 `PushDialog.tsx`

- 「确认推送秒懂」按钮改为**打开弹框** `PushDialog`（不再直接 POST）。
- `PushDialog`：四个输入（域名 / accessKeyId / accessKeySecret / knowledgeBaseId）。
  - 挂载时从 `localStorage`（key 如 `kb.miaodong.creds`）预填**非密三项**；`accessKeySecret` 始终留空。
  - 「推送」提交 → POST `/api/confirm`，期间禁用按钮、显示「推送中…」；失败显示错误文案，弹框不关。
  - 成功：把**非密三项**写回 `localStorage`，关弹框，回调 `DocDetail` 置「已推送」。
- 复用现有样式（`.row`、`button`、`.err` 等），弹框用简单遮罩层即可，不引第三方组件。

## 数据流

```
点「确认推送秒懂」
  → PushDialog（预填非密项）→ 填 secret → 提交
  → POST /api/confirm {docId, credentials}
  → RealMiaodongAdapter.push:
      getToken → createDoc → 顺序 createParagraph*N
  → 成功：docs 置 pushed + 存远端引用
  → 前端写 localStorage(非密) + 显示「已推送」
```

## 容错

- 尽力而为、顺序推送。`createDoc` 成功但中途某段落失败 → 路由返回错误，**不**标 pushed。
- 已知取舍：重试会在秒懂再建一篇重复文档（里程碑⑥可接受）。后续可用「建文档前查 `docs.miaodongDocId`，已存在则跳过建文档、续推段落」做幂等，本期不做。

## 测试与验收

- `npm run typecheck`（root）+ `npm run typecheck --workspace @kb/web`（root typecheck 不覆盖 web）。
- `splitForParagraph` 单元自测：英文长文本 / 中文长句 / 单句超 1000 三种切分正确、每段 ≤1000、保序。
- 手动验收：web 上传一篇 → 预览 → 点推送 → 填真实凭据 → 看到「已推送」，秒懂后台出现该文档与段落；刷新后该 doc 仍显示已推送（库里 `miaodong_*` 已写）。
- 凭据记忆：再次打开弹框，非密三项已预填、secret 为空。

## 不做（YAGNI）

- 推送幂等/去重、断点续推。
- 凭据服务端持久化（只用浏览器 localStorage）。
- 秒懂其他接口（更新/删除文档、查询段落等）。
- 推送进度条/逐段落实时进度（仅整体「推送中/完成/失败」）。
