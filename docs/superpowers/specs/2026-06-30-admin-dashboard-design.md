# 设计：kb-studio 管理后台（Admin Dashboard）

- 日期：2026-06-30
- 状态：待实现
- 范围：在现有 `apps/web`（Next.js 15）中新增一个**只读**管理后台 `/admin`，给运营者俯瞰全量用户与系统数据。

## 1. 目标与背景

kb-studio 已有完整的「邮箱+密码」自助注册/登录（`users` / `sessions` / `email_verifications` 表，bcrypt + httpOnly 会话 cookie，全量按 `user_id` 隔离，见里程碑⑧）。本功能在其之上加一个**独立的管理视角**：

- 看到一共多少人注册、他们的邮箱；
- 每个用户的活跃情况（文档数 / 对话数 / 秒懂凭据数 / 注册时间 / 最近登录时间）；
- 系统级数据统计（文档总量、按状态分布、chunk 总量、已推送秒懂的文档数、近 7/30 天注册数）。

**只读**：不做删除/改密码/封禁等破坏性操作，不做未完成注册（验证码）追踪，不下钻查看用户文档**正文**（只统计数量）。

## 2. 锁定决策

1. **独立 `/admin` 区**：自带登录、自带 cookie、自带中间件分支；管理员不是 `users` 表里的真实用户，没有自己的文档。与普通用户登录（`kb_session`）完全隔离。
2. **签名 cookie 鉴权**：账号密码默认 `admin` / `admin`，可用环境变量覆盖；会话用 HMAC 签名的 httpOnly cookie，无状态，不建新会话表。
3. **真实 `lastLoginAt`**：在 `users` 表加 `last_login_at` 列（不是用「最近一次 session」做近似）；现有登录接口每次登录成功时写入。

## 3. 架构与边界

所有代码落在 `apps/web` 的新路由段 `/admin` 下，外加 `@kb/db` 的几个**显式全局**只读查询函数。原则：

- 不改任何现有用户侧流程（除「登录成功时顺手写 `last_login_at`」这一处增量）。
- 不新建会话表；只为 `last_login_at` 加一次迁移。
- 新查询函数命名带 `admin` 前缀、注释标明「全局、跨用户、仅管理后台用」，与现有「都带 `userId` 入参」的按用户函数区分，杜绝误用。

## 4. 数据库变更

### 4.1 schema（`packages/db/src/schema.ts`）

在 `users` 表追加一列：

```ts
lastLoginAt: timestamp("last_login_at", { withTimezone: true }), // 可空；每次登录成功写 now()
```

### 4.2 迁移

`npm run db:generate && npm run db:migrate` 生成 `0013_*.sql`（当前最新为 `0012`）。仅 `ALTER TABLE users ADD COLUMN last_login_at ...`，对存量行为 NULL（即「从未在本功能上线后登录过」），UI 显示「—」。

### 4.3 写入点

`packages/db/src/repo.ts` 新增：

```ts
export async function touchUserLastLogin(userId: string): Promise<void>
```

在现有 `apps/web/app/api/auth/login/route.ts` 校验密码成功、建 session 后调用（失败不阻塞登录，`void ...catch(()=>{})`）。

## 5. 管理员鉴权（签名 cookie）

新文件 `apps/web/lib/admin-auth.ts`：

- 读环境变量：`ADMIN_USER`（默认 `admin`）、`ADMIN_PASS`（默认 `admin`）、`ADMIN_SESSION_SECRET`（服务端密钥；未设时回退到一个固定开发默认值并在 server 端 `console.warn` 提醒生产必须覆盖）。
- `signAdminCookie(): string` → 值为 `<issuedAt>.<HMAC_SHA256(secret, issuedAt)>`（`issuedAt` 为毫秒时间戳）。
- `verifyAdminCookie(value): boolean` → 重算 HMAC 比对（用 `node:crypto` 的 `timingSafeEqual`）+ 校验未超 7 天 TTL；篡改/过期/格式错均返回 false。
- `checkAdminCredentials(user, pass): boolean` → 常量时间比对，避免计时旁路。
- cookie 名 `kb_admin`；选项：`httpOnly`、`sameSite=lax`、`secure`（仅生产）、`path=/`、`expires=now+7d`。复用 `auth-crypto.ts` 已有的 `sha256` 风格写法，必要时把通用项抽到一起。

### 5.1 接口

- `POST /api/admin/login`：body `{ user, pass }` → `checkAdminCredentials` 通过则 `Set-Cookie: kb_admin=...` 返回 200，否则 401。
- `POST /api/admin/logout`：清 `kb_admin` cookie。

### 5.2 中间件（`apps/web/middleware.ts`）

新增 admin 分支（放在现有用户门禁之前）：

- `/admin/login`、`/api/admin/login` 公开放行。
- 其余 `/admin/*` 与 `/api/admin/*`：检查 `kb_admin` cookie **是否存在**（粗门禁，沿用现有「中间件只查 cookie 在不在、路由里再细校验」的既定模式）。无则：页面 302 跳 `/admin/login`，API 返回 401 JSON。
- 现有 `kb_session` 用户门禁对所有非 `/admin` 路径保持原样。

真正的 HMAC 校验放在 `app/admin/layout.tsx`（用 `verifyAdminCookie`），无效则 `redirect("/admin/login")`——与现有路由 `resolveAuth` 的细校验位置一致。

> 说明：Next 中间件跑在 edge runtime，这里只做 cookie 存在性判断（不调 `node:crypto`），HMAC 校验在 Node 运行时的 layout/route 里做，两者职责与现有实现保持一致。

## 6. 数据层（`packages/db/src/repo.ts` 新增只读全局函数）

```ts
// 全局：注册总人数
export async function adminCountUsers(): Promise<number>

// 全局：每个用户一行 + 活跃计数
export type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  docCount: number;
  conversationCount: number;
  credentialCount: number;
};
export async function adminListUsers(): Promise<AdminUserRow[]>  // 按 createdAt 倒序

// 全局：系统级统计
export type AdminSystemStats = {
  totalUsers: number;
  totalDocs: number;
  docsByStatus: Record<string, number>; // pending/processing/ready/pushed/failed...
  totalChunks: number;
  pushedDocCount: number;               // docs.pushed_at 非空的数量
  registrations7d: number;
  registrations30d: number;
};
export async function adminSystemStats(): Promise<AdminSystemStats>
```

实现要点：

- `adminListUsers` 用相关子查询（或 `LEFT JOIN ... GROUP BY`）一次取齐 docCount / conversationCount / credentialCount；`lastLoginAt` 直接读 `users.last_login_at`。
- `docsByStatus` 用 `GROUP BY status`；近 7/30 天用 `created_at > now() - interval`。
- 计数针对全量（不按 `user_id` 过滤）。注意：历史 `user_id = null` 的孤儿行（旧数据）不计入任一用户行，但会进 `totalDocs` 等系统总量——可接受，必要时在 UI 注脚说明。

## 7. 页面（App Router，服务端组件直接查库）

- `app/admin/login/page.tsx`：登录表单（暖色风，对齐现有 `/login`），提交 `POST /api/admin/login`，成功后 `router.push("/admin")`。
- `app/admin/layout.tsx`：`verifyAdminCookie` 无效则 `redirect`；渲染外壳——标题「kb-studio 管理后台」+ 退出按钮（POST logout 后跳登录）。
- `app/admin/page.tsx`（服务端组件）：
  - **统计卡片行**：注册总数、文档总数、按状态分布（小标签组）、chunk 总数、已推送秒懂文档数、近 7 天 / 近 30 天注册数。
  - **用户表**：邮箱 / 昵称 / 注册时间 / 文档数 / 对话数 / 凭据数 / 最近登录（NULL 显示「—」）。
  - 数据在服务端组件内直接调用上述 repo 函数（无需额外 GET API）。

## 8. 样式

复用 `globals.css` 既有暖色 CSS 变量（黏土橙强调、暖米白底、衬线标题）。不引入新设计体系，组件尽量复用现有卡片/表格样式。

## 9. 测试

- `packages/db/src/admin.integration.test.ts`（仿 `auth.integration.test.ts`）：种入 users/docs/conversations/credentials/sessions 后断言 `adminCountUsers` / `adminListUsers`（含各计数与 `lastLoginAt`）/ `adminSystemStats`（各总量、按状态、近 7/30 天）。
- `admin-auth` 单测：`signAdminCookie`/`verifyAdminCookie` 的正常、篡改、过期三种路径；`checkAdminCredentials` 正确/错误。

## 10. 环境变量

`.env.example` 与文档补充：

```
ADMIN_USER=admin
ADMIN_PASS=admin
ADMIN_SESSION_SECRET=<生成一个随机串>
```

并注明：生产务必改默认密码、设置真实 `ADMIN_SESSION_SECRET`。

## 11. 明确不做（YAGNI）

- 删除用户 / 重置密码 / 封禁等破坏性操作。
- 未完成注册（验证码）追踪。
- 下钻查看用户文档**正文**（仅统计数量）。
- 多管理员 / 角色权限。
