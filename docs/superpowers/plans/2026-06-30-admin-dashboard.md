# kb-studio 管理后台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/web` 里新增一个只读的 `/admin` 管理后台，看到注册总数 / 邮箱列表 / 每用户活跃度 / 系统级数据统计，用默认 admin/admin 登录。

**Architecture:** 独立 `/admin` 路由段，签名 cookie（HMAC，无状态）鉴权，与普通用户 `kb_session` 完全隔离；中间件加 admin 分支做粗门禁，仪表盘服务端组件做细校验并直接查库；`@kb/db` 新增几个显式「全局只读」查询函数；`users` 表加真实 `last_login_at` 列。

**Tech Stack:** TypeScript / Node 18 / Next.js 15 (App Router) / drizzle-orm + Postgres / `node:crypto` HMAC / `node:test` + tsx 测试。

## Global Constraints

- 中文注释 + 中文用户文案；代码标识符英文。
- 只读后台：不做删除 / 改密码 / 封禁等破坏性操作；不下钻用户文档正文。
- 不新建会话表；仅为 `last_login_at` 加一次迁移（编号 `0013`，当前最新 `0012`）。
- 新查询函数必须显式「全局、跨用户、仅 admin 用」，与现有「都带 `userId` 入参」的按用户函数区分（命名带 `admin` 前缀 + 注释）。
- 不改任何现有用户侧流程，唯一增量是「登录成功时顺手写 `last_login_at`」。
- 默认账号密码 `admin` / `admin`，可用 `ADMIN_USER` / `ADMIN_PASS` 覆盖；签名密钥 `ADMIN_SESSION_SECRET`（未设回退开发默认并 `console.warn`）。
- 测试运行命令（DB 须在跑，`localhost:5432`）：`node --import tsx --test <文件路径>`。
- 提交信息中文，结尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## File Structure

**新建：**
- `apps/web/lib/admin-auth.ts` — 管理员鉴权：账号密码校验 + 签名 cookie 生成/校验 + cookie 选项。
- `apps/web/lib/admin-auth.test.ts` — admin-auth 单测（纯 `node:crypto`，不连库）。
- `apps/web/app/api/admin/login/route.ts` — 管理员登录接口（校验→种 cookie）。
- `apps/web/app/api/admin/logout/route.ts` — 管理员登出接口（清 cookie）。
- `apps/web/app/admin/login/page.tsx` — 管理员登录页（client 表单，复用 `auth-*` 样式）。
- `apps/web/app/admin/page.tsx` — 仪表盘（server component，细校验 + 卡片 + 用户表）。
- `apps/web/app/admin/AdminLogout.tsx` — 退出按钮（client，仪表盘 header 用）。
- `packages/db/src/admin.integration.test.ts` — 三个 admin 查询函数 + `touchUserLastLogin` 集成测试。

**修改：**
- `packages/db/src/schema.ts` — `users` 表加 `lastLoginAt` 列。
- `packages/db/migrations/0013_*.sql` — `db:generate` 生成。
- `packages/db/src/repo.ts` — 加 `touchUserLastLogin` / `adminCountUsers` / `adminListUsers` / `adminSystemStats` + 类型。
- `apps/web/app/api/auth/login/route.ts` — 登录成功后调 `touchUserLastLogin`。
- `apps/web/middleware.ts` — 加 admin 分支。
- `apps/web/app/globals.css` — 追加 `.admin-*` 样式。
- `.env.example` — 加管理后台环境变量块。
- `CLAUDE.md` — 追加里程碑 ⑨ 说明。

> 说明：`packages/db/src/index.ts` 用 `export * from "./repo"` 整体再导出，新函数与新类型（`AdminUserRow` / `AdminSystemStats`）自动随之导出，**无需改 index.ts**。

---

## Task 1: `last_login_at` 列 + 迁移 + `touchUserLastLogin` + 登录写入

**Files:**
- Modify: `packages/db/src/schema.ts:175-183`（`users` 表）
- Create: `packages/db/migrations/0013_*.sql`（`db:generate` 生成）
- Modify: `packages/db/src/repo.ts`（`touchUserLastLogin`，加在 `setUserCollectToken` 之后约 552 行附近）
- Modify: `apps/web/app/api/auth/login/route.ts`
- Test: `packages/db/src/admin.integration.test.ts`（本任务新建，仅含 touch 测试；Task 2 续写）

**Interfaces:**
- Produces: `touchUserLastLogin(userId: string): Promise<void>`；`users.lastLoginAt` 列（`Date | null`）。

- [ ] **Step 1: 给 `users` 表加列**

`packages/db/src/schema.ts` 的 `users` 定义改为（在 `collectToken` 与 `createdAt` 之间插一行）：

```ts
export const users = pgTable("users", {
  id: text("id").primaryKey(), // usr_xxxxxxxx
  email: text("email").notNull().unique(), // 小写归一
  passwordHash: text("password_hash").notNull(), // bcryptjs
  displayName: text("display_name"),
  // 专属收集链接 token（明文存：链接要能反复展示；低敏感，泄漏可一键重置）
  collectToken: text("collect_token"),
  // 最近一次登录时间（每次登录成功写 now()；存量行为 null）
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

（`timestamp` 已在文件顶部 import，无需新增 import。）

- [ ] **Step 2: 生成并应用迁移**

Run:
```bash
cd /Users/hukui/Desktop/workspace/kb-studio
npm run db:generate
npm run db:migrate
```
Expected: `packages/db/migrations/` 下新增 `0013_*.sql`（内容为 `ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;`），migrate 输出无报错。

- [ ] **Step 3: 写 `touchUserLastLogin` 的失败测试**

新建 `packages/db/src/admin.integration.test.ts`：

```ts
// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up 或本机 brew pg）。会自建并清理测试数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, conversations, miaodongCredentials, users } from "./schema";
import { eq } from "drizzle-orm";
import {
  createUser,
  findUserById,
  touchUserLastLogin,
} from "./repo";

const createdUsers: string[] = [];
const createdDocs: string[] = [];
const createdConvs: string[] = [];
const createdCreds: string[] = [];

async function makeUser() {
  const id = "usr_admtest_" + randomUUID().slice(0, 8);
  const email = id + "@test.local";
  await createUser({ id, email, passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return { id, email };
}

after(async () => {
  for (const id of createdCreds) await db.delete(miaodongCredentials).where(eq(miaodongCredentials.id, id));
  for (const id of createdConvs) await db.delete(conversations).where(eq(conversations.id, id));
  for (const id of createdDocs) await db.delete(docs).where(eq(docs.id, id));
  for (const id of createdUsers) await db.delete(users).where(eq(users.id, id));
  await pg.end();
});

test("touchUserLastLogin 写入 lastLoginAt", async () => {
  const u = await makeUser();
  const before = await findUserById(u.id);
  assert.equal(before?.lastLoginAt, null);
  await touchUserLastLogin(u.id);
  const afterRow = await findUserById(u.id);
  assert.ok(afterRow?.lastLoginAt instanceof Date);
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `node --import tsx --test packages/db/src/admin.integration.test.ts`
Expected: FAIL — `touchUserLastLogin` 未从 `./repo` 导出（import 报错 / `not a function`）。

- [ ] **Step 5: 实现 `touchUserLastLogin`**

`packages/db/src/repo.ts`，紧接 `setUserCollectToken` 函数之后加：

```ts
/** 记录最近登录时间（登录成功时调用）。 */
export async function touchUserLastLogin(userId: string): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `node --import tsx --test packages/db/src/admin.integration.test.ts`
Expected: PASS（1 test）。

- [ ] **Step 7: 登录成功时写入**

`apps/web/app/api/auth/login/route.ts`：
1. import 加 `touchUserLastLogin`：
```ts
import { findUserByEmail, createSession, touchUserLastLogin } from "@kb/db";
```
2. 在 `await createSession(...)` 这一行之后加一行（不阻塞登录，失败忽略）：
```ts
await createSession({ id: sha256(raw), userId: user.id, expiresAt });
void touchUserLastLogin(user.id).catch(() => {}); // 记录最近登录，失败不影响登录
```

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 9: 提交**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/src/repo.ts packages/db/src/admin.integration.test.ts apps/web/app/api/auth/login/route.ts
git commit -m "feat(admin): users 加 last_login_at + 登录写入 + touchUserLastLogin

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: admin 全局只读查询函数

**Files:**
- Modify: `packages/db/src/repo.ts`（在 `touchUserLastLogin` 之后加一节）
- Test: `packages/db/src/admin.integration.test.ts`（续写 Task 1 的文件）

**Interfaces:**
- Consumes: `users` / `docs` / `conversations` / `miaodongCredentials` / `chunks` 表（均已在 repo.ts 顶部 import）。
- Produces:
  - `adminCountUsers(): Promise<number>`
  - `type AdminUserRow = { id: string; email: string; displayName: string | null; createdAt: Date; lastLoginAt: Date | null; docCount: number; conversationCount: number; credentialCount: number }`
  - `adminListUsers(): Promise<AdminUserRow[]>`（按 `createdAt` 倒序）
  - `type AdminSystemStats = { totalUsers: number; totalDocs: number; docsByStatus: Record<string, number>; totalChunks: number; pushedDocCount: number; registrations7d: number; registrations30d: number }`
  - `adminSystemStats(): Promise<AdminSystemStats>`

- [ ] **Step 1: 写失败测试（续写 admin.integration.test.ts）**

把 import 行补上新函数：
```ts
import {
  createUser,
  findUserById,
  touchUserLastLogin,
  adminCountUsers,
  adminListUsers,
  adminSystemStats,
} from "./repo";
```

在文件末尾追加：
```ts
test("adminCountUsers 包含新建用户", async () => {
  const before = await adminCountUsers();
  await makeUser();
  const now = await adminCountUsers();
  assert.ok(now >= before + 1, "新建用户后总数应增加");
});

test("adminListUsers：计数 + lastLoginAt 正确", async () => {
  const u = await makeUser();
  // 该用户造：2 文档（其一已推送）/ 1 对话 / 1 凭据
  const d1 = "doc_admtest_" + randomUUID().slice(0, 8);
  const d2 = "doc_admtest_" + randomUUID().slice(0, 8);
  await db.insert(docs).values({ id: d1, title: "A", source: "A", userId: u.id, status: "ready" });
  await db.insert(docs).values({ id: d2, title: "B", source: "B", userId: u.id, status: "pushed", pushedAt: new Date() });
  createdDocs.push(d1, d2);
  const c1 = "conv_admtest_" + randomUUID().slice(0, 8);
  await db.insert(conversations).values({ id: c1, title: "t", userId: u.id });
  createdConvs.push(c1);
  const cr1 = "cred_admtest_" + randomUUID().slice(0, 8);
  await db.insert(miaodongCredentials).values({
    id: cr1, name: "n", domain: "d", accessKeyId: "k", accessKeySecret: "s",
    knowledgeBaseId: "kbid", userId: u.id,
  });
  createdCreds.push(cr1);
  await touchUserLastLogin(u.id);

  const rows = await adminListUsers();
  const row = rows.find((r) => r.id === u.id);
  assert.ok(row, "应包含该用户");
  assert.equal(row!.docCount, 2);
  assert.equal(row!.conversationCount, 1);
  assert.equal(row!.credentialCount, 1);
  assert.equal(row!.email, u.email);
  assert.ok(row!.lastLoginAt instanceof Date);
});

test("adminSystemStats：各项 >=0 且自洽", async () => {
  await makeUser();
  const s = await adminSystemStats();
  assert.ok(s.totalUsers >= 1);
  assert.ok(s.totalDocs >= 0);
  assert.equal(typeof s.docsByStatus, "object");
  assert.ok(s.totalChunks >= 0);
  assert.ok(s.pushedDocCount >= 0);
  assert.ok(s.registrations30d >= s.registrations7d, "30 天窗口应 >= 7 天窗口");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --import tsx --test packages/db/src/admin.integration.test.ts`
Expected: FAIL — `adminCountUsers` / `adminListUsers` / `adminSystemStats` 未导出。

- [ ] **Step 3: 实现三个函数**

`packages/db/src/repo.ts`，在 `touchUserLastLogin` 之后追加：

```ts
// ===== 管理后台（全局只读，跨用户，仅 /admin 用；区别于上方按 userId 隔离的函数）=====

/** 注册用户总数。 */
export async function adminCountUsers(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return rows[0]?.n ?? 0;
}

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

/** 每个用户一行：基本信息 + 文档/对话/凭据计数。按注册时间倒序。 */
export async function adminListUsers(): Promise<AdminUserRow[]> {
  const docCount = sql<number>`(select count(*)::int from ${docs} where ${docs.userId} = ${users.id})`;
  const convCount = sql<number>`(select count(*)::int from ${conversations} where ${conversations.userId} = ${users.id})`;
  const credCount = sql<number>`(select count(*)::int from ${miaodongCredentials} where ${miaodongCredentials.userId} = ${users.id})`;
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      docCount,
      conversationCount: convCount,
      credentialCount: credCount,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
  return rows;
}

export type AdminSystemStats = {
  totalUsers: number;
  totalDocs: number;
  docsByStatus: Record<string, number>;
  totalChunks: number;
  pushedDocCount: number;
  registrations7d: number;
  registrations30d: number;
};

/** 系统级统计。 */
export async function adminSystemStats(): Promise<AdminSystemStats> {
  const [userRow] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [docRow] = await db.select({ n: sql<number>`count(*)::int` }).from(docs);
  const [chunkRow] = await db.select({ n: sql<number>`count(*)::int` }).from(chunks);
  const [pushedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(docs)
    .where(sql`${docs.pushedAt} is not null`);
  const statusRows = await db
    .select({ status: docs.status, n: sql<number>`count(*)::int` })
    .from(docs)
    .groupBy(docs.status);
  const [reg7] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.createdAt} > now() - interval '7 days'`);
  const [reg30] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.createdAt} > now() - interval '30 days'`);
  const docsByStatus: Record<string, number> = {};
  for (const r of statusRows) docsByStatus[r.status] = r.n;
  return {
    totalUsers: userRow?.n ?? 0,
    totalDocs: docRow?.n ?? 0,
    docsByStatus,
    totalChunks: chunkRow?.n ?? 0,
    pushedDocCount: pushedRow?.n ?? 0,
    registrations7d: reg7?.n ?? 0,
    registrations30d: reg30?.n ?? 0,
  };
}
```

（`sql` / `desc` / `eq` 均已在 repo.ts 顶部 import。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --import tsx --test packages/db/src/admin.integration.test.ts`
Expected: PASS（4 tests：含 Task 1 的 touch 测试）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/db/src/repo.ts packages/db/src/admin.integration.test.ts
git commit -m "feat(admin): 全局只读查询 adminCountUsers/adminListUsers/adminSystemStats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 管理员鉴权 lib + 单测

**Files:**
- Create: `apps/web/lib/admin-auth.ts`
- Test: `apps/web/lib/admin-auth.test.ts`

**Interfaces:**
- Produces:
  - `ADMIN_COOKIE = "kb_admin"`，`ADMIN_TTL_MS`（7 天毫秒）
  - `checkAdminCredentials(user: string, pass: string): boolean`
  - `signAdminCookie(now?: number): string` → `"<issuedAt>.<hmac>"`
  - `verifyAdminCookie(value: string | null | undefined, now?: number): boolean`
  - `adminCookieOptions(expires: Date): { httpOnly; sameSite; secure; path; expires }`

- [ ] **Step 1: 写失败测试**

新建 `apps/web/lib/admin-auth.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdminCredentials,
  signAdminCookie,
  verifyAdminCookie,
  ADMIN_TTL_MS,
} from "./admin-auth";

test("checkAdminCredentials：默认 admin/admin 通过，其它拒绝", () => {
  assert.equal(checkAdminCredentials("admin", "admin"), true);
  assert.equal(checkAdminCredentials("admin", "wrong"), false);
  assert.equal(checkAdminCredentials("root", "admin"), false);
  assert.equal(checkAdminCredentials("", ""), false);
});

test("sign/verify 往返通过", () => {
  const now = 1_700_000_000_000;
  assert.equal(verifyAdminCookie(signAdminCookie(now), now), true);
});

test("篡改签名被拒", () => {
  const now = 1_700_000_000_000;
  const c = signAdminCookie(now);
  const tampered = c.slice(0, -1) + (c.endsWith("a") ? "b" : "a");
  assert.equal(verifyAdminCookie(tampered, now), false);
});

test("过期被拒", () => {
  const now = 1_700_000_000_000;
  const c = signAdminCookie(now);
  assert.equal(verifyAdminCookie(c, now + ADMIN_TTL_MS + 1), false);
});

test("空 / 畸形值被拒", () => {
  assert.equal(verifyAdminCookie(undefined), false);
  assert.equal(verifyAdminCookie(""), false);
  assert.equal(verifyAdminCookie("nodot"), false);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --import tsx --test apps/web/lib/admin-auth.test.ts`
Expected: FAIL — `./admin-auth` 不存在。

- [ ] **Step 3: 实现 admin-auth.ts**

新建 `apps/web/lib/admin-auth.ts`：

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "kb_admin";
export const ADMIN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function adminUser(): string {
  return process.env.ADMIN_USER || "admin";
}
function adminPass(): string {
  return process.env.ADMIN_PASS || "admin";
}

let warnedNoSecret = false;
function secret(): string {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (s) return s;
  if (!warnedNoSecret) {
    warnedNoSecret = true;
    console.warn("[admin-auth] ADMIN_SESSION_SECRET 未设置，使用开发默认值；生产务必设置真实密钥");
  }
  return "kb-studio-dev-admin-secret";
}

/** 常量时间字符串比较（长度不同直接 false）。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 校验管理员账号密码（两项都比，避免短路泄漏哪项错）。 */
export function checkAdminCredentials(user: string, pass: string): boolean {
  const okUser = safeEqual(user, adminUser());
  const okPass = safeEqual(pass, adminPass());
  return okUser && okPass;
}

function hmac(issuedAt: string): string {
  return createHmac("sha256", secret()).update(issuedAt).digest("hex");
}

/** 生成签名 cookie 值：`<issuedAt>.<hmac>`。 */
export function signAdminCookie(now: number = Date.now()): string {
  const issuedAt = String(now);
  return `${issuedAt}.${hmac(issuedAt)}`;
}

/** 校验签名 cookie：HMAC 比对 + 未过期 + 非未来时间。 */
export function verifyAdminCookie(value: string | null | undefined, now: number = Date.now()): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const issuedAt = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, hmac(issuedAt))) return false;
  const ts = Number(issuedAt);
  if (!Number.isFinite(ts)) return false;
  if (now - ts > ADMIN_TTL_MS) return false; // 过期
  if (ts > now + 60_000) return false;        // 容忍 1 分钟时钟偏移，更未来作废
  return true;
}

/** cookie 选项（与用户会话同风格）。 */
export function adminCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --import tsx --test apps/web/lib/admin-auth.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/lib/admin-auth.ts apps/web/lib/admin-auth.test.ts
git commit -m "feat(admin): admin-auth 签名cookie鉴权 + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: admin API 路由 + 中间件分支

**Files:**
- Create: `apps/web/app/api/admin/login/route.ts`
- Create: `apps/web/app/api/admin/logout/route.ts`
- Modify: `apps/web/middleware.ts`

**Interfaces:**
- Consumes: `ADMIN_COOKIE`、`ADMIN_TTL_MS`、`checkAdminCredentials`、`signAdminCookie`、`adminCookieOptions`（Task 3）。
- Produces: `POST /api/admin/login`（body `{user,pass}` → 成功种 `kb_admin` cookie / 失败 401）；`POST /api/admin/logout`（清 cookie）；中间件放行 `/admin/login` + `/api/admin/login`，其余 `/admin/*`、`/api/admin/*` 凭 `kb_admin` 存在性放行（否则页面跳 `/admin/login`、API 401）。

- [ ] **Step 1: 写登录路由**

新建 `apps/web/app/api/admin/login/route.ts`：

```ts
import { NextResponse } from "next/server";
import {
  checkAdminCredentials,
  signAdminCookie,
  adminCookieOptions,
  ADMIN_COOKIE,
  ADMIN_TTL_MS,
} from "../../../../lib/admin-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const user = String(body?.user ?? "");
    const pass = String(body?.pass ?? "");
    if (!checkAdminCredentials(user, pass)) {
      return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
    }
    const expires = new Date(Date.now() + ADMIN_TTL_MS);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_COOKIE, signAdminCookie(), adminCookieOptions(expires));
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: 写登出路由**

新建 `apps/web/app/api/admin/logout/route.ts`：

```ts
import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminCookieOptions } from "../../../../lib/admin-auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { ...adminCookieOptions(new Date(0)), maxAge: 0 });
  return res;
}
```

- [ ] **Step 3: 改中间件加 admin 分支**

`apps/web/middleware.ts` 整文件替换为：

```ts
import { NextRequest, NextResponse } from "next/server";

// 普通用户放行清单（登录/注册页 + 这些 API + 静态资源由 matcher 排除）。
const PUBLIC = [
  "/login",
  "/register",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/send-code",
  "/api/ingest",
  "/api/collect-link/validate",
];

// 管理后台放行清单（登录页 + 登录接口）。
const ADMIN_PUBLIC = ["/admin/login", "/api/admin/login"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ===== 管理后台分支：与普通用户会话完全隔离 =====
  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    if (ADMIN_PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      return NextResponse.next();
    }
    // 粗门禁：只查 kb_admin cookie 在不在；HMAC 细校验在 /admin 服务端组件里做。
    if (req.cookies.has("kb_admin")) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/admin/login";
    return NextResponse.redirect(url);
  }

  // ===== 普通用户分支（原逻辑）=====
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  if (req.cookies.has("kb_session")) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // 排除 Next 静态资源与 favicon；其余全过中间件
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 手动验证（起 dev 服务）**

Run:
```bash
npm run dev --workspace @kb/web
```
另开一个终端验证（dev 下 `secure` 关，cookie 能种）：
```bash
# 错误密码 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3001/api/admin/login \
  -H 'content-type: application/json' -d '{"user":"admin","pass":"wrong"}'
# 期望 401

# 正确密码 → 200 且 Set-Cookie: kb_admin=
curl -s -i -X POST localhost:3001/api/admin/login \
  -H 'content-type: application/json' -d '{"user":"admin","pass":"admin"}' | grep -i 'set-cookie\|HTTP/'
# 期望 200 + set-cookie: kb_admin=...

# 未登录访问 /admin → 307/302 跳 /admin/login
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" localhost:3001/admin
# 期望 307，redirect_url 含 /admin/login

# 未登录访问受保护 admin API → 401
curl -s -o /dev/null -w "%{http_code}\n" localhost:3001/api/admin/logout -X POST
# 期望 401
```
Expected: 上述四条分别 401 / 200+set-cookie / 307→/admin/login / 401。验证完 Ctrl-C 停 dev。

- [ ] **Step 6: 提交**

```bash
git add apps/web/app/api/admin apps/web/middleware.ts
git commit -m "feat(admin): /api/admin 登录登出路由 + 中间件 admin 分支门禁

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 管理后台页面（登录页 + 仪表盘）+ 样式

**Files:**
- Create: `apps/web/app/admin/login/page.tsx`
- Create: `apps/web/app/admin/page.tsx`
- Create: `apps/web/app/admin/AdminLogout.tsx`
- Modify: `apps/web/app/globals.css`（文件末尾追加 `.admin-*` 一节）

**Interfaces:**
- Consumes: `ADMIN_COOKIE`、`verifyAdminCookie`（Task 3）；`adminCountUsers`、`adminListUsers`、`adminSystemStats`（Task 2，从 `@kb/db` 导入）。
- 结构说明：**不建 `app/admin/layout.tsx`**——登录页 `/admin/login` 与仪表盘 `/admin` 仅共享根 `app/layout.tsx`（极简，无侧栏），故 `app/admin/page.tsx` 自行做细校验+渲染外壳，不会与登录页形成重定向循环。

- [ ] **Step 1: 写登录页**

新建 `apps/web/app/admin/login/page.tsx`：

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminLoginPage() {
  const router = useRouter();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, pass }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "登录失败");
        return;
      }
      router.push("/admin");
      router.refresh();
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><span className="mark">✦</span> kb-studio</div>
        <h1 className="auth-title">管理后台登录</h1>
        <label className="auth-field">
          <span>账号</span>
          <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <div className="auth-err">{err}</div>}
        <button type="submit" className="btn primary auth-submit" disabled={busy}>
          {busy ? "请稍候…" : "登录"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: 写退出按钮组件**

新建 `apps/web/app/admin/AdminLogout.tsx`：

```tsx
"use client";
import { useRouter } from "next/navigation";

export default function AdminLogout() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    router.push("/admin/login");
    router.refresh();
  }
  return <button className="btn ghost" onClick={logout}>退出</button>;
}
```

- [ ] **Step 3: 写仪表盘页**

新建 `apps/web/app/admin/page.tsx`：

```tsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminCountUsers, adminListUsers, adminSystemStats } from "@kb/db";
import { ADMIN_COOKIE, verifyAdminCookie } from "../../lib/admin-auth";
import AdminLogout from "./AdminLogout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 总是实时查库，不缓存

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  processing: "处理中",
  ready: "待确认",
  pushed: "已推送",
  failed: "失败",
};

function fmt(d: Date | null): string {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-card">
      <div className="admin-card-v">{value}</div>
      <div className="admin-card-l">{label}</div>
    </div>
  );
}

export default async function AdminDashboard() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!verifyAdminCookie(token)) redirect("/admin/login");

  const [count, usersList, stats] = await Promise.all([
    adminCountUsers(),
    adminListUsers(),
    adminSystemStats(),
  ]);

  return (
    <div className="admin">
      <header className="admin-head">
        <div className="brand"><span className="mark">✦</span> kb-studio 管理后台</div>
        <AdminLogout />
      </header>

      <div className="admin-body">
        <section className="admin-cards">
          <StatCard label="注册用户" value={count} />
          <StatCard label="文档总数" value={stats.totalDocs} />
          <StatCard label="Chunk 总数" value={stats.totalChunks} />
          <StatCard label="已推送秒懂文档" value={stats.pushedDocCount} />
          <StatCard label="近 7 天注册" value={stats.registrations7d} />
          <StatCard label="近 30 天注册" value={stats.registrations30d} />
        </section>

        <section className="admin-statusbar">
          <span className="admin-statusbar-title">文档状态分布</span>
          {Object.keys(stats.docsByStatus).length === 0 ? (
            <span className="admin-muted">暂无文档</span>
          ) : (
            Object.entries(stats.docsByStatus).map(([s, n]) => (
              <span className="pill ok" key={s}>{STATUS_LABEL[s] ?? s}: {n}</span>
            ))
          )}
        </section>

        <section className="admin-table-wrap">
          <h2 className="admin-h2">用户列表（{count}）</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th><th>昵称</th><th>注册时间</th>
                <th>文档</th><th>对话</th><th>凭据</th><th>最近登录</th>
              </tr>
            </thead>
            <tbody>
              {usersList.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.displayName ?? "—"}</td>
                  <td>{fmt(u.createdAt)}</td>
                  <td>{u.docCount}</td>
                  <td>{u.conversationCount}</td>
                  <td>{u.credentialCount}</td>
                  <td>{fmt(u.lastLoginAt)}</td>
                </tr>
              ))}
              {usersList.length === 0 && (
                <tr><td colSpan={7} className="admin-muted">还没有用户注册</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 追加样式**

`apps/web/app/globals.css` 文件**末尾**追加：

```css
/* ===== 管理后台 ===== */
.admin{min-height:100vh;display:flex;flex-direction:column;background:var(--bg);}
.admin-head{display:flex;align-items:center;justify-content:space-between;
            padding:16px 28px;border-bottom:1px solid var(--border);background:var(--sidebar);}
.admin-head .brand{font-family:var(--font-serif);font-size:18px;font-weight:600;color:var(--text);
                   display:flex;align-items:center;gap:8px;}
.admin-head .brand .mark{color:var(--accent);}
.admin-body{flex:1;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column;gap:22px;}
.admin-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;}
.admin-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
            padding:18px 18px 14px;}
.admin-card-v{font-family:var(--font-serif);font-size:28px;font-weight:600;color:var(--text);}
.admin-card-l{font-size:12.5px;color:var(--text-2);margin-top:4px;}
.admin-statusbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;}
.admin-statusbar-title{font-size:12.5px;color:var(--text-2);font-weight:600;margin-right:4px;}
.admin-h2{font-family:var(--font-serif);font-size:17px;font-weight:600;margin:0 0 12px;color:var(--text);}
.admin-table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;}
.admin-table{width:100%;border-collapse:collapse;font-size:13px;}
.admin-table th{text-align:left;color:var(--text-3);font-weight:700;font-size:11.5px;
                text-transform:uppercase;letter-spacing:.05em;padding:0 12px 10px;border-bottom:1px solid var(--border);}
.admin-table td{padding:11px 12px;border-bottom:1px solid var(--border);color:var(--text);}
.admin-table tr:last-child td{border-bottom:0;}
.admin-muted{color:var(--text-3);}
```

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 手动验证（端到端）**

Run: `npm run dev --workspace @kb/web`，浏览器访问 `http://localhost:3001/admin`：
1. 未登录 → 自动跳 `/admin/login`。
2. 输 `admin` / `admin` 登录 → 进仪表盘，看到统计卡片 + 用户表（至少能看到此前注册过的用户邮箱；若库里没人则显示「还没有用户注册」）。
3. 输错密码 → 显示「账号或密码错误」。
4. 点「退出」→ 回登录页；再直接访问 `/admin` 仍跳登录页。
5. 篡改 `kb_admin` cookie 值后刷新 `/admin` → HMAC 校验失败，跳回 `/admin/login`（验证细校验生效）。

Expected: 上述行为全部符合。验证完 Ctrl-C 停 dev。

- [ ] **Step 7: 提交**

```bash
git add apps/web/app/admin apps/web/app/globals.css
git commit -m "feat(admin): 管理后台登录页 + 仪表盘（统计卡片+用户表）+ 暖色样式

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 环境变量 + 文档

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Interfaces:**
- 无代码接口；交付文档与示例环境变量。

- [ ] **Step 1: 补 .env.example**

`.env.example` 文件**末尾**追加：

```
# ---- 管理后台（/admin）----
# 默认 admin/admin；生产务必改密码，并设置随机 ADMIN_SESSION_SECRET（openssl rand -base64 32）。
# 注意：web 运行时读 root .env（apps/web/.env.local → root .env 软链），本地这三项也要写进实际 .env。
ADMIN_USER=admin
ADMIN_PASS=admin
ADMIN_SESSION_SECRET=
```

- [ ] **Step 2: 把变量写进本地 .env（运行用，gitignored）**

在本地 `.env`（不提交）末尾加同样三行（`ADMIN_SESSION_SECRET` 本地可留空，会用开发默认值并打 warn）。若该文件不存在则跳过——dev 下不设也能用 admin/admin。

- [ ] **Step 3: 追加 CLAUDE.md 里程碑**

`CLAUDE.md` 的「## 里程碑」一节末尾追加一条：

```markdown
- [x] **⑨ 管理后台（/admin，只读）✅**：独立 `/admin` 区，签名 cookie 鉴权（默认 admin/admin，可用 `ADMIN_USER/ADMIN_PASS/ADMIN_SESSION_SECRET` 覆盖；`apps/web/lib/admin-auth.ts` HMAC 无状态会话，不建会话表）。中间件加 admin 分支粗门禁、`app/admin/page.tsx` 服务端组件 `verifyAdminCookie` 细校验。仪表盘看：注册总数 + 用户列表（邮箱/昵称/注册时间/文档·对话·凭据数/最近登录）+ 系统统计（文档总数、按状态分布、chunk 总数、已推送秒懂文档数、近 7/30 天注册）。`users` 加真实 `last_login_at`（迁移 0013，登录成功写入）。`@kb/db` 新增全局只读 `adminCountUsers/adminListUsers/adminSystemStats`。设计/计划见 `docs/superpowers/specs|plans/2026-06-30-admin-dashboard*`。
```

- [ ] **Step 4: 全量 typecheck 收尾**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add .env.example CLAUDE.md
git commit -m "docs(admin): .env.example 管理后台变量 + CLAUDE.md 里程碑⑨

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 验收（全部任务完成后）

- `node --import tsx --test packages/db/src/admin.integration.test.ts` → 4 tests pass
- `node --import tsx --test apps/web/lib/admin-auth.test.ts` → 5 tests pass
- `npm run typecheck` → 无错误
- `npm run dev --workspace @kb/web` → `/admin` 登录（admin/admin）后能看到注册数、邮箱列表、每用户活跃度、系统统计；退出 / 错误密码 / 篡改 cookie 行为正确。
