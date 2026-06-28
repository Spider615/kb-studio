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
