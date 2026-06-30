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
  // 生产环境必须显式设置签名密钥：否则会回退到源码里写死的默认值，任何人都能伪造 kb_admin
  // 会话、读到全部用户邮箱。故生产缺失时直接抛错（fail closed），不暴露管理后台。
  if (process.env.NODE_ENV === "production") {
    throw new Error("[admin-auth] 生产环境必须设置 ADMIN_SESSION_SECRET（否则管理员会话可被伪造）");
  }
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
