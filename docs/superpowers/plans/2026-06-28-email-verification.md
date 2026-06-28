# 注册邮箱验证码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 注册时要求填真实邮箱并通过 6 位邮箱验证码校验（验证通过才建号），发信走 SMTP/nodemailer，未配 SMTP 时验证码打到服务端 console 兜底。

**Architecture:** 新增 `email_verifications` 表存"已发待校验的码"（只存 sha256）。纯校验逻辑（生成码/判定/冷却）放可单测的 `verify-code.ts`；发信封装在 `mailer.ts`（nodemailer + dev console 兜底）。新增公开接口 `POST /api/auth/send-code`，并扩展 `POST /api/auth/register` 增加 `code` 校验。前端注册表单加"发送验证码"按钮（60s 倒计时）+ 验证码输入框。

**Tech Stack:** Next.js 15 (App Router) · drizzle-orm + Postgres · nodemailer · node:crypto · node:test（经 tsx）。

**参考规格：** `docs/superpowers/specs/2026-06-28-email-verification-design.md`

---

## File Structure

**新建：**
- `apps/web/lib/verify-code.ts` — 纯逻辑：`generateCode()`、`checkCode()`、`inCooldown()` + 常量 `CODE_TTL_MS`/`RESEND_COOLDOWN_MS`/`MAX_ATTEMPTS`。无 DB/网络依赖，可脱库单测。
- `apps/web/lib/verify-code.test.ts` — 上面的单测（node:test，无需 DB）。
- `apps/web/lib/mailer.ts` — nodemailer 发信 + dev console 兜底，导出 `sendVerificationCode`。
- `apps/web/app/api/auth/send-code/route.ts` — 发码接口。
- `packages/db/src/email-verify.integration.test.ts` — email_verifications repo 集成测试（需 DB up）。

**修改：**
- `packages/db/src/schema.ts` — 加 `emailVerifications` 表 + `EmailVerificationRow` 类型。
- `packages/db/src/index.ts` — 导出 `EmailVerificationRow`。
- `packages/db/src/repo.ts` — 加 upsert/get/incAttempts/delete 函数。
- `apps/web/app/api/auth/register/route.ts` — 加 `code` 校验。
- `apps/web/middleware.ts` — `PUBLIC` 白名单加 `/api/auth/send-code`。
- `apps/web/components/AuthForm.tsx` — 发送验证码按钮 + 验证码框 + 倒计时。
- `apps/web/app/globals.css` — 加 `.auth-row` 样式。
- `apps/web/next.config.mjs` — `serverExternalPackages` 加 `nodemailer`。
- `apps/web/package.json` — 加 `nodemailer` 依赖。
- `.env.example` — 加 SMTP 占位变量。
- 生成 `packages/db/migrations/0011_*.sql`。

---

## Task 1: 依赖 + schema + 迁移 + 配置

**Files:**
- Modify: `apps/web/package.json`, `apps/web/next.config.mjs`, `packages/db/src/schema.ts`, `packages/db/src/index.ts`, `.env.example`
- Generate: `packages/db/migrations/0011_*.sql`

- [ ] **Step 1: 装 nodemailer**

Run:
```bash
npm install nodemailer@^6.9.0 --workspace @kb/web
npm install -D @types/nodemailer@^6.4.0 --workspace @kb/web
```
Expected: `apps/web/package.json` dependencies 出现 `nodemailer`，devDependencies 出现 `@types/nodemailer`。

- [ ] **Step 2: next.config 把 nodemailer 列为外部包**

`apps/web/next.config.mjs` 的 `serverExternalPackages` 数组末尾加 `"nodemailer"`。当前数组：
```js
  serverExternalPackages: [
    "@anthropic-ai/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "@node-rs/jieba",
    "postgres",
    "undici",
    "drizzle-orm",
  ],
```
改为在 `"drizzle-orm",` 后加一行 `"nodemailer",`。

- [ ] **Step 3: schema 加 email_verifications 表**

在 `packages/db/src/schema.ts` 末尾（`export type SessionRow` 之后）追加（`integer`/`index` 等已在顶部 import，无需再加）：

```ts
/** 注册邮箱验证码（已发待校验；按 email 一行，重发 upsert 覆盖）。 */
export const emailVerifications = pgTable("email_verifications", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(), // 6 位码的 sha256，不存明文
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0), // 输错次数，≥5 作废
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(), // 重发冷却用
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type EmailVerificationRow = typeof emailVerifications.$inferSelect;
```

- [ ] **Step 4: index.ts 导出类型**

`packages/db/src/index.ts` 的 `export type { ... } from "./schema";` 块里加一行 `EmailVerificationRow,`（放在 `SessionRow,` 之后）：

```ts
export type {
  GroupRow,
  DocRow,
  ChunkRow,
  ConversationRow,
  MessageRow,
  DocProgress,
  PushTarget,
  MiaodongCredentialRow,
  UserRow,
  SessionRow,
  EmailVerificationRow,
} from "./schema";
```

- [ ] **Step 5: .env.example 加 SMTP 占位**

在 `.env.example`（仓库根；若不存在则创建）末尾追加：

```bash
# 注册邮箱验证码发信（SMTP）。不填则验证码打到服务端 console（dev 兜底）。
# 示例（QQ邮箱）：SMTP_HOST=smtp.qq.com SMTP_PORT=465 SMTP_SECURE=true，SMTP_PASS 填邮箱「授权码」非登录密码
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

- [ ] **Step 6: 生成并应用迁移**

Run（确保 `npm run db:up` 已起 pg）:
```bash
npm run db:generate && npm run db:migrate
```
Expected: 新增 `packages/db/migrations/0011_*.sql`，含 `CREATE TABLE "email_verifications"`（email 为 PK）；migrate 无报错；无任何 DROP/破坏性语句。

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/next.config.mjs packages/db/src/schema.ts packages/db/src/index.ts .env.example packages/db/migrations package-lock.json
git commit -m "feat(verify): email_verifications 表 + nodemailer 依赖/配置 + SMTP env 占位（迁移 0011）"
```

---

## Task 2: 纯校验逻辑 verify-code.ts（TDD）

**Files:**
- Create: `apps/web/lib/verify-code.ts`
- Test: `apps/web/lib/verify-code.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/web/lib/verify-code.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCode, checkCode, inCooldown, RESEND_COOLDOWN_MS } from "./verify-code";

const fakeHash = (s: string) => "H(" + s + ")"; // 确定性假哈希，便于断言

test("generateCode 是 6 位数字", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateCode();
    assert.match(c, /^\d{6}$/);
  }
});

test("checkCode：行不存在按过期处理", () => {
  assert.equal(checkCode(null, "123456", Date.now(), fakeHash), "expired");
});

test("checkCode：已过期返回 expired", () => {
  const row = { codeHash: fakeHash("123456"), expiresAt: new Date(1000), attempts: 0 };
  assert.equal(checkCode(row, "123456", 2000, fakeHash), "expired");
});

test("checkCode：码不匹配返回 wrong", () => {
  const row = { codeHash: fakeHash("123456"), expiresAt: new Date(9999999999999), attempts: 0 };
  assert.equal(checkCode(row, "000000", 1000, fakeHash), "wrong");
});

test("checkCode：码匹配且未过期返回 ok", () => {
  const row = { codeHash: fakeHash("123456"), expiresAt: new Date(9999999999999), attempts: 0 };
  assert.equal(checkCode(row, "123456", 1000, fakeHash), "ok");
});

test("inCooldown：冷却窗口内为 true，窗口外为 false", () => {
  const now = 1_000_000;
  assert.equal(inCooldown(new Date(now - RESEND_COOLDOWN_MS + 1), now), true);
  assert.equal(inCooldown(new Date(now - RESEND_COOLDOWN_MS - 1), now), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test apps/web/lib/verify-code.test.ts`
Expected: FAIL（`Cannot find module './verify-code'`）。

- [ ] **Step 3: 写实现**

`apps/web/lib/verify-code.ts`:

```ts
import { randomInt } from "node:crypto";

export const CODE_TTL_MS = 10 * 60 * 1000; // 码 10 分钟有效
export const RESEND_COOLDOWN_MS = 60 * 1000; // 重发冷却 60 秒
export const MAX_ATTEMPTS = 5; // 单码最多试 5 次

/** 6 位数字验证码（100000–999999，加密随机，无前导 0）。 */
export function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

export type CodeCheck = "ok" | "expired" | "wrong";

/**
 * 判定验证码：
 * - 行不存在或已过期 → "expired"
 * - 码不匹配 → "wrong"
 * - 匹配且未过期 → "ok"
 * hash 注入便于单测；生产传 auth-crypto 的 sha256。
 */
export function checkCode(
  row: { codeHash: string; expiresAt: Date; attempts: number } | null,
  code: string,
  now: number,
  hash: (s: string) => string,
): CodeCheck {
  if (!row) return "expired";
  if (row.expiresAt.getTime() < now) return "expired";
  if (hash(code) !== row.codeHash) return "wrong";
  return "ok";
}

/** 重发冷却：距上次发送不足 RESEND_COOLDOWN_MS 则在冷却中。 */
export function inCooldown(lastSentAt: Date, now: number): boolean {
  return now - lastSentAt.getTime() < RESEND_COOLDOWN_MS;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test apps/web/lib/verify-code.test.ts`
Expected: PASS（6 个 test 全过）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/verify-code.ts apps/web/lib/verify-code.test.ts
git commit -m "feat(verify): 验证码纯逻辑 verify-code（生成/判定/冷却）+ 单测"
```

---

## Task 3: repo 函数 + 集成测试

**Files:**
- Modify: `packages/db/src/repo.ts`
- Test: `packages/db/src/email-verify.integration.test.ts`

- [ ] **Step 1: 加 repo 函数**

`packages/db/src/repo.ts` 顶部 import：
- 第 3 行 schema import 末尾加 `emailVerifications`（在 `sessions` 后）。
- 第 4 行 type import 末尾加 `EmailVerificationRow`（在 `SessionRow` 后）。

把第 3、4 行改为：
```ts
import { docs, chunks, conversations, messages, miaodongCredentials, groups, users, sessions, emailVerifications } from "./schema";
import type { DocRow, ChunkRow, MessageRow, DocProgress, PushTarget, MiaodongCredentialRow, GroupRow, UserRow, SessionRow, EmailVerificationRow } from "./schema";
```

在 `repo.ts` 末尾追加：

```ts
// ===== 注册邮箱验证码 =====

export interface EmailVerificationInput {
  email: string;
  codeHash: string;
  expiresAt: Date;
  lastSentAt: Date;
}

/** upsert 验证码（按 email；重发覆盖旧码并重置 attempts=0）。 */
export async function upsertEmailVerification(v: EmailVerificationInput): Promise<void> {
  await db
    .insert(emailVerifications)
    .values({ email: v.email, codeHash: v.codeHash, expiresAt: v.expiresAt, lastSentAt: v.lastSentAt, attempts: 0 })
    .onConflictDoUpdate({
      target: emailVerifications.email,
      set: { codeHash: v.codeHash, expiresAt: v.expiresAt, lastSentAt: v.lastSentAt, attempts: 0 },
    });
}

/** 取验证码行；不存在返回 null。 */
export async function getEmailVerification(email: string): Promise<EmailVerificationRow | null> {
  const rows = await db.select().from(emailVerifications).where(eq(emailVerifications.email, email));
  return rows[0] ?? null;
}

/** 输错一次：attempts+1。 */
export async function incEmailVerificationAttempts(email: string): Promise<void> {
  await db
    .update(emailVerifications)
    .set({ attempts: sql`${emailVerifications.attempts} + 1` })
    .where(eq(emailVerifications.email, email));
}

/** 删验证码行（验证成功消费 / 超次作废）。 */
export async function deleteEmailVerification(email: string): Promise<void> {
  await db.delete(emailVerifications).where(eq(emailVerifications.email, email));
}
```

- [ ] **Step 2: 写集成测试**

`packages/db/src/email-verify.integration.test.ts`（需 `npm run db:up`）:

```ts
// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。自清理。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql as pg } from "./client";
import {
  upsertEmailVerification,
  getEmailVerification,
  incEmailVerificationAttempts,
  deleteEmailVerification,
} from "./repo";

const email = "verify_test_" + randomUUID().slice(0, 8) + "@test.local";

after(async () => {
  await deleteEmailVerification(email);
  await pg.end();
});

test("upsert → get 往返，attempts 初始 0", async () => {
  const exp = new Date(Date.now() + 600_000);
  const sent = new Date();
  await upsertEmailVerification({ email, codeHash: "H1", expiresAt: exp, lastSentAt: sent });
  const row = await getEmailVerification(email);
  assert.equal(row?.codeHash, "H1");
  assert.equal(row?.attempts, 0);
  assert.ok(row!.expiresAt.getTime() > Date.now());
});

test("upsert 覆盖旧码并重置 attempts", async () => {
  await incEmailVerificationAttempts(email);
  await incEmailVerificationAttempts(email);
  let row = await getEmailVerification(email);
  assert.equal(row?.attempts, 2);
  // 重发：覆盖
  await upsertEmailVerification({ email, codeHash: "H2", expiresAt: new Date(Date.now() + 600_000), lastSentAt: new Date() });
  row = await getEmailVerification(email);
  assert.equal(row?.codeHash, "H2");
  assert.equal(row?.attempts, 0); // 重置
});

test("incAttempts 累加", async () => {
  await incEmailVerificationAttempts(email);
  const row = await getEmailVerification(email);
  assert.equal(row?.attempts, 1);
});

test("delete 后 get 为 null", async () => {
  await deleteEmailVerification(email);
  assert.equal(await getEmailVerification(email), null);
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx tsx --test packages/db/src/email-verify.integration.test.ts`
Expected: PASS（4 个 test 全过，行被清理）。

- [ ] **Step 4: typecheck + commit**

```bash
npm run typecheck
git add packages/db/src/repo.ts packages/db/src/email-verify.integration.test.ts
git commit -m "feat(verify): @kb/db 验证码 repo（upsert/get/incAttempts/delete）+ 集成测试"
```

---

## Task 4: 发信模块 mailer.ts

**Files:**
- Create: `apps/web/lib/mailer.ts`

- [ ] **Step 1: 写实现**

`apps/web/lib/mailer.ts`:

```ts
import nodemailer, { type Transporter } from "nodemailer";

/** 关键 SMTP env 是否齐备（缺则走 dev console 兜底）。 */
function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: String(process.env.SMTP_SECURE ?? "true") === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

/**
 * 发注册验证码。未配 SMTP → 打到服务端 console（dev 兜底，便于联调/测试）。
 * 发信失败抛错（由调用方转 500）。
 */
export async function sendVerificationCode(email: string, code: string): Promise<void> {
  if (!smtpConfigured()) {
    console.log(`[mailer] 验证码 ${code} → ${email}（SMTP 未配置，dev 兜底打印）`);
    return;
  }
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: "kb-studio 注册验证码",
    text: `你的注册验证码是 ${code}，10 分钟内有效。如非本人操作请忽略。`,
  });
}
```

- [ ] **Step 2: typecheck（web）**

Run: `npm run typecheck --workspace @kb/web`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/mailer.ts
git commit -m "feat(verify): mailer 发信模块（nodemailer + dev console 兜底）"
```

---

## Task 5: 发码接口 + 中间件放行

**Files:**
- Create: `apps/web/app/api/auth/send-code/route.ts`
- Modify: `apps/web/middleware.ts`

- [ ] **Step 1: send-code 路由**

`apps/web/app/api/auth/send-code/route.ts`:

```ts
import { NextResponse } from "next/server";
import { findUserByEmail, getEmailVerification, upsertEmailVerification } from "@kb/db";
import { sha256 } from "../../../../lib/auth-crypto";
import { generateCode, inCooldown, CODE_TTL_MS } from "../../../../lib/verify-code";
import { sendVerificationCode } from "../../../../lib/mailer";

export const runtime = "nodejs";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (await findUserByEmail(email)) return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });

    const existing = await getEmailVerification(email);
    if (existing && inCooldown(existing.lastSentAt, Date.now()))
      return NextResponse.json({ error: "请稍后再试" }, { status: 429 });

    const code = generateCode();
    const now = new Date();
    await upsertEmailVerification({
      email,
      codeHash: sha256(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      lastSentAt: now,
    });
    await sendVerificationCode(email, code); // 失败抛错 → 下方 catch 转 500
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[send-code] 失败:", e?.message ?? e);
    return NextResponse.json({ error: "验证码发送失败，请重试" }, { status: 500 });
  }
}
```

- [ ] **Step 2: 中间件白名单加 send-code**

`apps/web/middleware.ts` 的 `PUBLIC` 数组加 `"/api/auth/send-code"`：

```ts
const PUBLIC = ["/login", "/register", "/api/auth/login", "/api/auth/register", "/api/auth/send-code"];
```

- [ ] **Step 3: typecheck + 手动验证**

Run: `npm run typecheck --workspace @kb/web`，再（dev 起着 + DB 起着）:
```bash
TS=$(date +%s); EMAIL="vc_$TS@test.local"
echo "--- 发码（看 dev server 控制台会打印验证码）---"
curl -s -w "\nHTTP=%{http_code}\n" --max-time 30 -X POST http://localhost:3001/api/auth/send-code -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}"
echo "--- 立刻重发 → 冷却 429 ---"
curl -s -o /dev/null -w "重发=%{http_code}(期望429)\n" --max-time 20 -X POST http://localhost:3001/api/auth/send-code -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}"
echo "--- 邮箱格式不对 → 400 ---"
curl -s -o /dev/null -w "格式错=%{http_code}(期望400)\n" --max-time 20 -X POST http://localhost:3001/api/auth/send-code -H 'content-type: application/json' -d '{"email":"bad"}'
echo "--- DB 里确认有该 email 的验证行 ---"
docker exec kb-studio-db psql -U kb -d kbstudio -tAc "select email,attempts from email_verifications where email='$EMAIL'"
docker exec kb-studio-db psql -U kb -d kbstudio -tAc "delete from email_verifications where email='$EMAIL'" >/dev/null
```
Expected: 发码 `{"ok":true}` HTTP 200 且控制台打印 `[mailer] 验证码 xxxxxx → ...`；重发=429；格式错=400；DB 有该行 attempts=0。

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/auth/send-code apps/web/middleware.ts
git commit -m "feat(verify): /api/auth/send-code 发码接口 + 中间件放行"
```

---

## Task 6: register 加验证码校验

**Files:**
- Modify: `apps/web/app/api/auth/register/route.ts`

- [ ] **Step 1: 改 register 路由**

`apps/web/app/api/auth/register/route.ts` 整体替换为：

```ts
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  createUser,
  findUserByEmail,
  createSession,
  getEmailVerification,
  incEmailVerificationAttempts,
  deleteEmailVerification,
} from "@kb/db";
import {
  hashPassword,
  randomToken,
  sha256,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieOptions,
} from "../../../../lib/auth-crypto";
import { checkCode, MAX_ATTEMPTS } from "../../../../lib/verify-code";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const code = String(body?.code ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (password.length < 8) return NextResponse.json({ error: "密码至少 8 位" }, { status: 400 });

    // 校验验证码
    const ver = await getEmailVerification(email);
    const result = checkCode(ver, code, Date.now(), sha256);
    if (result === "expired")
      return NextResponse.json({ error: "验证码已过期，请重新获取" }, { status: 400 });
    if (result === "wrong") {
      await incEmailVerificationAttempts(email);
      if (ver && ver.attempts + 1 >= MAX_ATTEMPTS) await deleteEmailVerification(email); // 超次作废
      return NextResponse.json({ error: "验证码错误" }, { status: 400 });
    }

    if (await findUserByEmail(email)) return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });

    const userId = "usr_" + randomUUID().slice(0, 8);
    const displayName = email.split("@")[0];
    await createUser({ id: userId, email, passwordHash: await hashPassword(password), displayName });

    const raw = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await createSession({ id: sha256(raw), userId, expiresAt });
    await deleteEmailVerification(email); // 成功消费验证码

    const res = NextResponse.json({ user: { id: userId, email, displayName } });
    res.cookies.set(SESSION_COOKIE, raw, cookieOptions(expiresAt));
    return res;
  } catch (e: any) {
    if (e?.code === "23505") return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 }); // 唯一约束竞态
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: typecheck + 手动全链路验证**

Run: `npm run typecheck --workspace @kb/web`，再（dev + DB 起着）:
```bash
TS=$(date +%s); EMAIL="reg_$TS@test.local"
echo "--- 1) 无码注册 → 400（码过期/缺失）---"
curl -s -o /dev/null -w "无码注册=%{http_code}(期望400)\n" --max-time 20 -X POST http://localhost:3001/api/auth/register -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"pw12345678\"}"
echo "--- 2) 发码（从 DB 反取明文不行，code 只存 hash；这里用已知 code 直接写一行测试）---"
CODE="246813"; HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$CODE').digest('hex'))")
docker exec kb-studio-db psql -U kb -d kbstudio -tAc "insert into email_verifications(email,code_hash,expires_at,attempts,last_sent_at) values('$EMAIL','$HASH', now()+interval '10 min',0, now()) on conflict(email) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at" >/dev/null
echo "--- 3) 错码 → 400 ---"
curl -s -o /dev/null -w "错码=%{http_code}(期望400)\n" --max-time 20 -X POST http://localhost:3001/api/auth/register -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"pw12345678\",\"code\":\"000000\"}"
echo "--- 4) 正确码 → 200 + 建号 + cookie ---"
curl -s -w "\nHTTP=%{http_code}\n" --max-time 30 -c /tmp/vc_jar -X POST http://localhost:3001/api/auth/register -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"pw12345678\",\"code\":\"$CODE\"}"
echo "--- 5) 验证码行已被消费删除 ---"
docker exec kb-studio-db psql -U kb -d kbstudio -tAc "select count(*) from email_verifications where email='$EMAIL'" | grep -q 0 && echo "✓ 验证行已删" || echo "✗ 验证行还在"
echo "--- 清理 ---"
docker exec kb-studio-db psql -U kb -d kbstudio -tAc "delete from email_verifications where email='$EMAIL'; delete from users where email='$EMAIL'" >/dev/null
```
Expected: 无码注册=400；错码=400；正确码返回 `{"user":...}` HTTP 200 并写 cookie；验证行被删（count=0）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/auth/register/route.ts
git commit -m "feat(verify): register 增加验证码校验（先验证再建号，超次作废）"
```

---

## Task 7: 前端注册表单

**Files:**
- Modify: `apps/web/components/AuthForm.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: 改 AuthForm**

`apps/web/components/AuthForm.tsx` 整体替换为：

```tsx
"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0); // 重发倒计时秒
  const isLogin = mode === "login";

  // 倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode() {
    setErr(null);
    if (!EMAIL_RE.test(email)) {
      setErr("请先填写正确的邮箱");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "发送失败");
        return;
      }
      setCooldown(60);
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!isLogin && password.length < 8) {
      setErr("密码至少 8 位");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${isLogin ? "login" : "register"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isLogin ? { email, password } : { email, password, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "操作失败");
        return;
      }
      router.push("/");
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
        <div className="auth-brand">
          <span className="mark">✦</span> kb-studio
        </div>
        <h1 className="auth-title">{isLogin ? "登录" : "注册"}</h1>
        <label className="auth-field">
          <span>邮箱</span>
          {isLogin ? (
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          ) : (
            <div className="auth-row">
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button type="button" className="btn" onClick={sendCode} disabled={busy || cooldown > 0}>
                {cooldown > 0 ? `重新发送(${cooldown}s)` : "发送验证码"}
              </button>
            </div>
          )}
        </label>
        {!isLogin && (
          <label className="auth-field">
            <span>验证码</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
        )}
        <label className="auth-field">
          <span>密码</span>
          <input
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isLogin ? undefined : 8}
          />
        </label>
        {err && <div className="auth-err">{err}</div>}
        <button type="submit" className="btn primary auth-submit" disabled={busy}>
          {busy ? "请稍候…" : isLogin ? "登录" : "注册"}
        </button>
        <div className="auth-alt">
          {isLogin ? (
            <>还没有账号？<Link href="/register">去注册</Link></>
          ) : (
            <>已有账号？<Link href="/login">去登录</Link></>
          )}
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: 加样式**

在 `apps/web/app/globals.css` 的 `/* ===== 登录 / 注册 ===== */` 块内（`.auth-field input:focus` 那行之后）追加：

```css
.auth-row{display:flex;gap:8px;}
.auth-row input{flex:1;min-width:0;}
.auth-row .btn{flex-shrink:0;white-space:nowrap;}
```

- [ ] **Step 3: typecheck + 手动验证**

Run: `npm run typecheck --workspace @kb/web`，再浏览器开 `http://localhost:3001/register`：
- 邮箱行右侧有「发送验证码」按钮；点击后（邮箱合法）按钮进入 `重新发送(59s)` 倒计时
- 有验证码输入框
- 从 dev server 控制台拿到打印的码，填入 + 密码 → 注册 → 跳首页
Expected: 倒计时生效；用控制台的码能注册成功进主界面。

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/AuthForm.tsx apps/web/app/globals.css
git commit -m "feat(verify): 注册表单加发送验证码按钮（60s 倒计时）+ 验证码输入框"
```

---

## Task 8: 收尾 —— 全量验证 + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md 里程碑⑧**

在 `CLAUDE.md` 里程碑⑧ 条目末尾（`设计/计划见 ...auth*。` 之前或之后）补一句：

```markdown
注册要求邮箱验证码（先验证再建号）：`email_verifications` 表（迁移 0011）+ `POST /api/auth/send-code`（6 位码、sha256 存储、10 分钟有效、60s 重发冷却、5 次作废）+ `mailer.ts`（nodemailer SMTP，未配则验证码打 console 兜底）+ register 增 `code` 校验。设计/计划见 `docs/superpowers/specs|plans/2026-06-28-email-verification*`。
```

- [ ] **Step 2: 跑全部自动化测试 + typecheck**

Run:
```bash
npx tsx --test apps/web/lib/verify-code.test.ts
npx tsx --test apps/web/lib/auth-crypto.test.ts
npx tsx --test packages/db/src/auth.integration.test.ts
npx tsx --test packages/db/src/email-verify.integration.test.ts
npm run typecheck && npm run typecheck --workspace @kb/web
```
Expected: 全部 PASS / 干净。

- [ ] **Step 3: 端到端冒烟（dev console 兜底，无需真 SMTP）**

Run（dev + DB 起着）：
- `/register` 浏览器：填邮箱 → 发送验证码 → 控制台取码 → 填码+密码 → 注册成功进主界面 → 退出登录
- 边界：错码 400、过期码 400（手动把 `expires_at` 改到过去再注册）、冷却 429、已注册邮箱发码 409
把实际结果贴到完成说明（verification-before-completion）。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 里程碑⑧ 补注册邮箱验证码"
```

---

## Self-Review（写计划后自检）

**1. Spec coverage（逐条对规格）：**
- email_verifications 表（email PK/code_hash/expires_at/attempts/last_sent_at）→ Task 1 ✅
- mailer + SMTP env + dev console 兜底 → Task 4 + Task 1（env 占位）✅
- repo upsert/get/incAttempts/delete → Task 3 ✅
- send-code 接口（格式 400 / 已注册 409 / 冷却 429 / 发信 500 / 不回显码）→ Task 5 ✅
- register code 校验（过期 400 / 错码 400 + attempts / 超次作废 / 成功删行建号）→ Task 6 ✅
- 中间件放行 send-code → Task 5 ✅
- 前端发送验证码按钮 + 60s 倒计时 + 验证码框 + 只动 register 模式 → Task 7 ✅
- 限流参数（6 位 / 10 分钟 / 60s / 5 次）→ verify-code 常量 Task 2，路由用之 ✅
- 测试（纯逻辑单测 + repo 集成 + dev console 闭环 + 手动）→ Task 2/3/6/8 ✅
- 不做项（忘记密码/IP 限流/HTML 模板/改既有用户）→ 计划未引入 ✅
- nodemailer 进 serverExternalPackages → Task 1 ✅

**2. Placeholder scan：** 无 TBD/TODO；每个改动步骤均给完整代码或精确替换块。Task 1 Step 2/4/5 给的是"在何处加哪几行"的精确指令（数组/导出块/env 追加），非占位。

**3. Type consistency：** `checkCode(row|null, code, now, hash)→"ok"|"expired"|"wrong"`、`inCooldown(Date, now)`、`generateCode()→string`、常量 `CODE_TTL_MS/RESEND_COOLDOWN_MS/MAX_ATTEMPTS` 在 Task 2 定义、Task 5/6 引用一致；repo `upsertEmailVerification({email,codeHash,expiresAt,lastSentAt})`/`getEmailVerification(email)→EmailVerificationRow|null`/`incEmailVerificationAttempts(email)`/`deleteEmailVerification(email)` 在 Task 3 定义、Task 5/6 调用一致；`sendVerificationCode(email,code)` Task 4 定义、Task 5 调用一致。
