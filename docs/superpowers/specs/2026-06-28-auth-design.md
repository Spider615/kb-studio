# 注册登录 + 接口鉴权 设计

日期：2026-06-28
状态：已确认，待出实现计划

## 目标与范围

为 kb-studio Web 应用（`apps/web`，Next.js 15，端口 3001）从零加入认证与授权。当前所有 `/api/*` 路由都无鉴权、裸奔。

确认的产品决策：

- **多用户隔离**：每个用户只能看到、操作自己的数据（文档/分组/对话/秒懂凭据）。
- **双轨鉴权**：浏览器走 httpOnly cookie 会话；外部程序走 `Authorization: Bearer` API Token。
- **开放自助注册**：任何能访问页面的人都可自行注册。
- **邮箱 + 密码**登录。
- **自建实现**（方案 A）：贴合项目"自建、少依赖"的气质，不引入 NextAuth/Lucia。

### 不做（明确划界，YAGNI）

忘记密码、邮件验证、OAuth 第三方登录、管理员后台/角色、限流、团队 org 概念。schema 里保留了 `email`、`user_id`，将来要加这些有路可走。

## 架构总览

```
浏览器 ──cookie(session)──┐
                          ├─→ middleware(粗门禁) ─→ route handler ─→ requireAuth(细校验) ─→ @kb/db(按 userId 过滤)
外部程序 ─Bearer(token)──┘
```

- **middleware**（edge，粗粒度）：判断"有没有凭证"，无则页面 302 跳 `/login`、API 返回 401。不连 DB。
- **route handler**（nodejs，细粒度）：`requireAuth(req)` 真正校验会话/令牌有效性并解析出 `userId`，再把 `userId` 透传给 `@kb/db` 查询。
- **数据隔离**：所有读查询 `where user_id = :uid`；所有写入 `user_id = :uid`；单资源操作前校验归属。

### 代码分层

- `@kb/db`（纯数据存取）：用户/会话/令牌的 schema 与 repo 函数；现有查询函数加 `userId` 入参。
- `apps/web/lib/auth.ts`（Web 侧业务，不直接拼 SQL）：密码哈希、令牌生成与哈希、cookie 读写、`resolveAuth`/`requireAuth` 收口。
- `apps/web/middleware.ts`：粗门禁。
- `apps/web/app/api/auth/*`、`apps/web/app/api/tokens/*`：新路由。
- `apps/web/app/login`、`apps/web/app/register`：新页面。

## 数据模型（迁移 `0008`）

新增 3 张表，放 `packages/db/src/schema.ts`。

### `users`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | `usr_<nanoid>` |
| `email` | text unique not null | 登录标识，存小写归一化 |
| `password_hash` | text not null | bcryptjs |
| `display_name` | text | 默认取邮箱 `@` 前缀 |
| `created_at` | timestamptz not null default now | |

### `sessions`（浏览器会话）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | cookie 里 token 的 **SHA-256**（不是原 token） |
| `user_id` | text FK→users(on delete cascade) not null | |
| `expires_at` | timestamptz not null | 固定 30 天 |
| `created_at` | timestamptz not null default now | |

### `api_tokens`（外部程序）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | `tok_<nanoid>` |
| `user_id` | text FK→users(on delete cascade) not null | |
| `name` | text not null | 标签，如「脚本导入」 |
| `token_hash` | text not null | 原 token 的 SHA-256，明文只在创建时返回一次 |
| `prefix` | text not null | 前 8 位用于列表展示，如 `kbs_a1b2…` |
| `last_used_at` | timestamptz null | |
| `created_at` | timestamptz not null default now | |

### 现有表挂用户归属

- `docs` / `groups` / `conversations`：已有 `user_id` 列，从"留空"改为**写入当前用户 id**；所有读查询加 `where user_id = :uid`。
- `chunks`（属 doc）、`messages`（属 conversation）：**隔离随父表继承**，自身不加列。
- `miaodong_credentials`：**新增 `user_id` 列**（个人密钥，必须隔离），迁移 `0008` 一并加。

### 历史数据

库里旧的 `user_id=null` 行：**对所有用户不可见**（不匹配任何用户过滤）。当前是开发期、库内为可丢弃测试数据，不做"首个用户认领旧数据"。将来如需保留，单独写一次性 backfill 脚本指派给某用户。

## 鉴权核心

### `apps/web/lib/auth.ts`

- `hashPassword(pw)` / `verifyPassword(pw, hash)`：bcryptjs，cost 12（纯 JS，无原生编译坑，避开 `serverExternalPackages` 类问题）。
- `generateToken()` → `kbs_<32 字节 base64url>`；`sha256(raw)` 做哈希。
- cookie 读写：`setSessionCookie` / `clearSessionCookie`（httpOnly、sameSite=lax、prod 下 secure、path=/、maxAge 30d）。
- **`resolveAuth(req)` 收口**：先看 `Authorization: Bearer kbs_…` → 查 `api_tokens` by hash（命中回写 `last_used_at`）；否则看 session cookie → 查 `sessions`、校验未过期。返回 `{ userId } | null`。
- `requireAuth(req)`：包一层，null 时抛出 → 路由统一返回 401。

### `@kb/db` 新增 repo 函数

`createUser` / `findUserByEmail` / `findUserById` / `createSession` / `findSessionById` / `deleteSession` / `createApiToken` / `findApiTokenByHash` / `touchApiTokenUsed` / `listApiTokens` / `deleteApiToken`。现有查询函数全部加 `userId` 入参。

## 中间件 `apps/web/middleware.ts`（edge，粗粒度）

- **放行**：`/login`、`/register`、`/api/auth/login`、`/api/auth/register`、Next 静态资源（`_next` 等）。
- 其余**页面**请求无 session cookie → 302 跳 `/login`。
- 其余 **`/api/*`** 无 cookie 且无 Bearer → 直接返回 401 JSON。
- 中间件只做"有没有凭证"的轻判断（edge 不连 DB、不跑 bcrypt）；真正有效性校验在各路由 `requireAuth()` 里做。

## 新增路由

### 鉴权 `apps/web/app/api/auth/*`

| 路由 | 方法 | 行为 |
|---|---|---|
| `/api/auth/register` | POST | `{email,password}` → 邮箱查重(409) → 建 user → 建 session → 种 cookie → 返回 `{user}` |
| `/api/auth/login` | POST | 验密码 → 建 session → 种 cookie；失败一律 401「邮箱或密码错误」（不区分是哪错） |
| `/api/auth/logout` | POST | 删 session 行 + 清 cookie |
| `/api/auth/me` | GET | 返回当前 `{user}`，前端拿来显示登录态 |

### 个人 API Token `apps/web/app/api/tokens`

| 路由 | 方法 | 行为 |
|---|---|---|
| `/api/tokens` | GET | 列出当前用户 token（只回 `name/prefix/lastUsedAt/createdAt`，**不回明文**） |
| `/api/tokens` | POST | `{name}` → 生成 → 存 hash → **仅此一次返回明文** |
| `/api/tokens/[id]` | DELETE | 吊销（校验归属） |

## 现有路由改造（工作量主体）

每个受保护路由顶部 `const { userId } = await requireAuth(req)`，再把 `userId` 透传给对应 `@kb/db` 函数：

- 读：`listDocs` / `listGroups` / `listConversations` / `search` / `chat` 检索 → 一律 `where user_id=:uid`。
- 写：`upload`（建 doc）/ 建组 / 建会话 / 存凭据 → 写入 `user_id=:uid`。
- 单资源（`docs/[id]`、`groups/[id]`、`conversations/[id]`、`credentials/[id]`、`docs/[id]/file`）→ 操作前校验该行属当前用户，否则 **404**（不用 403，避免泄露存在性）。

涉及路由清单（13 个）：`docs`、`docs/[id]`、`docs/[id]/file`、`groups`、`groups/[id]`、`conversations`、`conversations/[id]`、`search`、`chat`、`upload`、`confirm`、`credentials`、`credentials/[id]`。

## 前端

### 登录/注册页（Claude 暖色风，沿用现有 CSS 变量）

- `/login`、`/register`：独立全屏页（不套 `app` 主框架），居中卡片，暖米白底 + 黏土橙主按钮 + 衬线标题。
- 登录：邮箱 / 密码 / 「登录」/ 去注册链接。
- 注册：邮箱 / 密码（前端最低 8 位校验）/ 「注册」/ 去登录链接。
- 提交走 `/api/auth/*`，成功后 `router.push("/")`。
- 错误内联红字提示。

### 登录态与用户区

- 主框架默认已登录（中间件已拦未登录页面请求）。
- **Sidebar 底部加用户区**：显示邮箱 + 下拉「API Tokens」「退出登录」。退出 → `POST /api/auth/logout` → 跳 `/login`。

### API Token 管理 UI

- 复用 `CredentialsDialog` 弹框模式，新建 `TokensDialog`：列出已有 token（名字 / `kbs_a1b2…` 前缀 / 最后使用时间）+「新建」+「吊销」。
- 新建后弹**明文一次性展示**框，提示「仅显示这一次，请立即复制」+ 复制按钮。

## 安全细节

- bcryptjs cost 12；session token 与 api token 都只存 SHA-256，DB 泄露拿不到活凭证。
- cookie：httpOnly + sameSite=lax + prod secure；session 固定 30 天过期（不滑动续期）。
- 登录失败统一文案，不区分"邮箱不存在 / 密码错"。
- 限流：内部工具暂不做（YAGNI），标注为未来项。

## 错误处理

- 注册邮箱重复 → 409；密码 <8 位 → 400。
- 会话过期/无效 → 401 + 清 cookie。
- 单资源不属当前用户 → 404。
- 所有 `/api/auth/*` 错误返回 `{error}`，前端表单内联提示。

## 测试（实现阶段走 TDD）

- 单元：`hashPassword/verifyPassword`、token 生成与哈希、session 过期判断。
- 集成：注册→登录→访问受保护路由→退出 全链路；Bearer token 访问 `/api/docs`。
- **隔离测试**（关键）：用户 A 看不到、也改不了用户 B 的 doc/group/conversation/credential。

## 风险与注意

- **typecheck 覆盖**：改 `apps/web` 要单独跑 `npm run typecheck --workspace @kb/web`（root typecheck 不覆盖 web）。
- **edge 中间件限制**：middleware 不能连 DB/跑 bcryptjs，故只做粗门禁；细校验落在 nodejs route handler。
- **改造面广**：13 个现有路由 + 对应 `@kb/db` 函数签名变更，需逐一过，避免漏过滤导致越权。
