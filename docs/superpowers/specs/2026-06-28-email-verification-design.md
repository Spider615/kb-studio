# 注册邮箱验证码 设计

日期：2026-06-28
状态：已确认，待出实现计划
前置：里程碑⑧（注册登录 + 纯 cookie 鉴权，见 `2026-06-28-auth-design.md`）已落地

## 目标与范围

注册时要求填**真实邮箱**并通过**邮箱验证码**校验，确保注册者拥有该邮箱。用户邮箱供应商任意（Gmail/QQ/163/Outlook/企业邮等）——验证码发到用户填写的地址，用户在自己的收件箱里读取，收件方与本系统无关；本系统只负责"向任意地址发一封信"。

确认的决策：
- **发信通道：SMTP（nodemailer）**，供应商无关；凭据由用户填入 `.env`。
- **流程：先验证再建号**——验证码校验通过才创建账号（账号建即已验证），库里不留未验证的半成品账号，`users` 表无需加列。
- 只作用于**注册**；登录仍是纯邮箱+密码，不涉及验证码。
- 既有已注册用户 grandfather，不受影响。

### 不做（YAGNI）
忘记密码邮件、按 IP 限流、邮件 HTML 模板美化（先纯文本）、对既有用户补验证。

## 架构总览

```
注册页 ──①POST /api/auth/send-code {email}──→ 生成6位码 → upsert email_verifications → mailer 发信(或 dev console 打印)
       ──②POST /api/auth/register {email,password,code}──→ 校验码 → 删验证行 → 建用户+session+cookie
```

- 发信基建与校验逻辑解耦：`mailer.ts`（只管发信）+ `email_verifications` 表（只管"已发待验证的码"）+ 校验逻辑（可单测的纯函数 + repo）。
- 两个接口都在中间件公开白名单内（无需登录即可访问）。

## 数据模型（迁移 0011）

**新表 `email_verifications`**（存"已发出待校验的码"）

| 列 | 类型 | 说明 |
|---|---|---|
| `email` | text PRIMARY KEY | 一个邮箱同时只有一个有效码；重发=upsert 覆盖 |
| `code_hash` | text not null | 6 位数字码的 sha256（复用 `auth-crypto` 的 `sha256`，不存明文） |
| `expires_at` | timestamptz not null | now + 10 分钟 |
| `attempts` | int not null default 0 | 输错次数；≥5 作废该码 |
| `last_sent_at` | timestamptz not null | 重发冷却（60 秒内不可再发） |
| `created_at` | timestamptz not null default now | |

schema 放 `packages/db/src/schema.ts`，导出 `EmailVerificationRow` 类型。

## 发信模块

`apps/web/lib/mailer.ts`：用 `nodemailer` 从 env 建 transport，导出 `sendVerificationCode(email: string, code: string): Promise<void>`。

新增 env（`.env`，gitignored，用户填）：
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE`(true/false) / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`

**dev 兜底**：若 SMTP 未配置（关键 env 缺失），不发真信，改为把验证码打到服务端 console：`[mailer] 验证码 <code> → <email>`。配了 SMTP 就走真发信。这让没填 SMTP 也能联调，并支撑集成测试闭环。

邮件内容：纯文本，含 6 位码 + 10 分钟有效期提示。

## Repo 函数（`packages/db/src/repo.ts`）

- `upsertEmailVerification({ email, codeHash, expiresAt, lastSentAt })` — 按 email upsert，重置 attempts=0
- `getEmailVerification(email)` — 取行（含 expiresAt/attempts/lastSentAt/codeHash）；不存在返回 null
- `incEmailVerificationAttempts(email)` — attempts+1
- `deleteEmailVerification(email)` — 验证成功/作废时删

## 接口

### `POST /api/auth/send-code`（公开）
1. 校验邮箱格式（不合法 → 400「邮箱格式不正确」）
2. 已注册（`findUserByEmail`）→ 409「该邮箱已注册」
3. 重发冷却：`getEmailVerification`，若存在且 `last_sent_at` 在 60 秒内 → 429「请稍后再试」
4. 生成 6 位数字码（`100000–999999`，加密随机）→ `upsertEmailVerification`（codeHash、expiresAt=now+10min、lastSentAt=now）
5. `sendVerificationCode(email, code)`（失败 → 500「验证码发送失败，请重试」）
6. 返回 `{ ok: true }`（不回显码）

### `POST /api/auth/register`（在现有路由上扩展，增加 `code` 校验）
1. 校验邮箱格式 + 密码 ≥8 位（原有）
2. **校验验证码**：`getEmailVerification(email)`
   - 不存在 / `expires_at < now` → 400「验证码已过期，请重新获取」
   - `sha256(code) !== code_hash` → `incEmailVerificationAttempts`；若 attempts+1 ≥ 5 则 `deleteEmailVerification`（作废）→ 400「验证码错误」
3. 邮箱已注册 → 409（原有，含唯一约束竞态 `23505` 兜底）
4. 全部通过 → `deleteEmailVerification(email)` + 建用户(已验证) + 建 session + 种 cookie + 返回 `{ user }`（原有逻辑）

### 中间件
`apps/web/middleware.ts` 的 `PUBLIC` 白名单加 `/api/auth/send-code`（`/api/auth/login`、`/api/auth/register`、`/login`、`/register` 已在）。

### 限流小结
单邮箱重发冷却 60s、码 10 分钟过期、单码最多试 5 次。更强的按 IP 限流 YAGNI。

## 前端（`apps/web/components/AuthForm.tsx`，只动 register 模式）

- 邮箱行改为横向 `[邮箱输入框] [发送验证码按钮]`（小 `.auth-row` flex）
- 点「发送验证码」：先做邮箱格式校验 → `POST /api/auth/send-code` → 成功后按钮进入 60 秒倒计时（`重新发送(59s)`），期间禁用
- 邮箱下方加验证码输入框（6 位数字，单独一行）
- 「注册」提交改发 `{ email, password, code }`
- 错误内联红字（复用 `.auth-err`）：邮箱已注册 / 码错 / 码过期 / 发信失败 / 冷却中
- login 模式完全不变
- 样式沿用现有暖色变量；新增 `.auth-row`

## 错误处理汇总

| 场景 | 状态码 | 文案 |
|---|---|---|
| 邮箱格式不对（send-code/register） | 400 | 邮箱格式不正确 |
| 已注册（send-code） | 409 | 该邮箱已注册 |
| 重发冷却中 | 429 | 请稍后再试 |
| 发信失败 | 500 | 验证码发送失败，请重试 |
| 码过期/不存在（register） | 400 | 验证码已过期，请重新获取 |
| 码错误（register） | 400 | 验证码错误 |
| 密码 <8 位 | 400 | 密码至少 8 位 |
| 已注册竞态（register insert 23505） | 409 | 该邮箱已注册 |

## 测试

- **单元（node:test）**：6 位码生成（范围/长度/随机）；验证判定纯函数（匹配/过期/attempts 超限作废）。
- **集成（DB up）**：`upsertEmailVerification`/`getEmailVerification`/attempts/冷却/过期 往返；自清理。
- **dev console 兜底闭环**：未配 SMTP 时，集成/手动测试从 console 取码完成"发码→注册"，不依赖真实 SMTP。
- **手动 curl + 浏览器**：发码（console 取码）→ 带码注册成功；错码 400 / 过期 400 / 冷却 429 / 已注册 409；浏览器注册页倒计时与提交。

## 风险与注意

- **投递率**：事务验证码多数可达；个别严格邮箱（尤其企业邮）可能进垃圾箱——用正规 SMTP + 合规 `SMTP_FROM` 域名改善。
- **nodemailer 打包**：Next 下把 `nodemailer` 加进 `serverExternalPackages`（与现有原生/重依赖一致），避免打包问题。
- **web typecheck 单独跑**：改 web 要 `npm run typecheck --workspace @kb/web`。
- **send-code 会暴露邮箱是否已注册**（409）——注册场景下可接受、且体验更好，符合内部工具定位。
