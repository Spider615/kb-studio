import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";

export const SESSION_COOKIE = "kb_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** bcrypt 哈希密码（cost 12）。 */
export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

/** 校验密码。 */
export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

/** 32 字节随机串（base64url）——会话 cookie / token 的原值。 */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 完整 API token 明文：kbs_<随机>。 */
export function apiTokenString(): string {
  return "kbs_" + randomToken();
}

/** SHA-256 十六进制（存储用，库泄露拿不到原 token）。 */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 会话 cookie 选项。 */
export function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}
