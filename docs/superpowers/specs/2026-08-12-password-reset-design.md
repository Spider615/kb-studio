# 修改密码 / 忘记密码 —— 设计

日期：2026-08-12

## 背景

用户登录时会忘记密码，此前无自助途径——只能由管理员在库里手改。
注意「修改密码」与「忘记密码」是两件事：忘记密码的人登录不进去，也就打不开任何需要登录的设置页，
所以只做「已登录改密码」救不了这个场景。两个都做。

## 已定决策

| 问题 | 结论 |
|---|---|
| 功能范围 | 忘记密码（邮箱验证码重置）+ 已登录修改密码，两个都做 |
| 改密码后的会话 | **全部踢掉，含当前设备**，一律用新密码重新登录 |
| 忘记密码填了未注册邮箱 | 直说「该邮箱未注册」。注册用的 send-code 本来就会对已注册邮箱回 409，枚举信息早已暴露，此处再藏是自欺欺人 |
| SMTP | 暂不配置，验证码继续走 console 兜底（见文末「待办」） |

## 架构

三层改动。核心约束：`email_verifications` 表原先以 `email` 为主键、无用途字段，
注册码与重置码会互相覆盖——用户点了「忘记密码」再去注册，前一个码就废了。

### 数据层 `packages/db`

- `emailVerifications` 加 `purpose` 列（`text notNull default 'register'`，取值 `register | reset`），
  主键改为复合 `(email, purpose)`。同一邮箱两种码并存互不干扰。
- 迁移 `0015`：drizzle 生成结果有两处缺陷，已手工修正——它没有 DROP 旧主键（自己注释掉了，要求手填约束名
  `email_verifications_pkey`），且把建复合主键排在加列之前（引用尚不存在的 `purpose` 列会直接报错）。
  修正后顺序为：加列 → 删旧主键 → 建复合主键。存量行由 default 落到 `register`，不丢数据。
- 四个验证码函数（`upsert` / `get` / `incAttempts` / `deleteEmailVerification`）统一加 `purpose` 参数。
- 新增 `updateUserPassword(userId, hash)`、`deleteSessionsByUser(userId)`（返回删除行数，供日志）。

### 接口层 `apps/web/app/api/auth`

| 路由 | 说明 |
|---|---|
| `send-code`（改） | 加 `purpose` 字段，缺省 `register` 保持旧行为。两种用途对「邮箱是否已注册」的要求正好相反：`register` 要求未注册（否则 409），`reset` 要求已注册（否则 404）。60s 重发冷却与 5 次作废逻辑原样复用 |
| `reset-password`（新） | 免登录。`{email, code, password}` → 验码 → 换 hash → 消费验证码 → 删该用户全部会话 |
| `change-password`（新） | 需登录。`{oldPassword, newPassword}` → 验旧密码 → 拒绝新旧相同 → 换 hash → 删全部会话（含当前）→ 清 cookie |

`reset-password` 先验码再查用户，避免本接口被当成「邮箱是否注册」的探针；
验证码在成功后立即删除，防重放。

### 前端 `apps/web`

- `AuthForm` 加第三个 mode `reset`。原组件通篇是 `isLogin ? A : B` 二元判断，加第三种模式后
  全线失效，故把差异收进一张 `CONFIG` 配置表（标题 / 接口 / 是否要验证码 / 密码框文案与校验 / 成功跳转）。
  注册模式的表单结构（邮箱+发码按钮+60s 倒计时+验证码框+密码框）与重置所需完全一致，直接复用，省掉一个页面。
- `app/reset/page.tsx`：4 行，同 register 页写法。
- `ChangePasswordDialog`：仿 `CredentialsDialog` 的弹框模式，挂在侧栏用户菜单，
  含「确认新密码」二次输入与「显示密码」勾选；成功后跳 `/login?reset=1`。
- `middleware.ts` 的 `PUBLIC` 白名单加 `/reset` 与 `/api/auth/reset-password`，否则会被重定向回登录页。
- `.auth-notice` 加左侧强调边——它与上方 input 同底同框等宽，实测会被看成又一个输入框。

## 错误处理

| 场景 | 响应 |
|---|---|
| 重置码错 | 400「验证码错误」，`attempts+1`，满 5 次作废该码 |
| 重置码过期 / 已作废 | 400「验证码已过期，请重新获取」 |
| 同一码重放 | 400（成功时已消费删除） |
| 码有效但用户期间被删 | 404，并作废该码 |
| 旧密码错 | 400「当前密码不正确」 |
| 新旧密码相同 | 400「新密码不能与当前密码相同」 |
| 新密码不足 8 位 | 400 |
| 未登录调 change-password | 401 |

## 测试

- `packages/db/src/email-verify.integration.test.ts`：新增「同邮箱 register / reset 两码互不干扰」用例，
  覆盖并存、试错次数各记各的、消费其一另一个仍在。5 个用例全过。
- 端到端脚本实跑 20 项断言全过：注册 → 用途校验（409/404）→ 登录 → 改密码三个负面用例 + 正面
  → 会话全踢 + 旧密码失效 + 新密码可用 → 重置（错码/正确/重放）→ 会话全踢 → 新密码可用 → `/reset` 免登录可达。
- 浏览器实跑：登录页「忘记密码?」入口、`/reset` 页、侧栏「修改密码」菜单与弹框、
  改密码后跳登录页并显示「密码已重置，请用新密码登录」、新密码登录成功。

## 待办：配置 SMTP

当前 `.env` 无任何 `SMTP_*`，`mailer.ts` 走 console 兜底——**验证码不会真的发出去**，
注册与重置都得从服务端终端读码转告用户。要真正可用，在 `.env` 补：

```
SMTP_HOST=smtp.qq.com      # 163 为 smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱@qq.com
SMTP_PASS=授权码           # 非登录密码：QQ 邮箱 设置→账户→POP3/SMTP 生成
SMTP_FROM=你的邮箱@qq.com  # 可选，缺省用 SMTP_USER
```

配完无需改代码，`smtpConfigured()` 自动切到真实发信。
