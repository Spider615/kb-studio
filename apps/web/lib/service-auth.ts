import { timingSafeEqual } from "node:crypto";

/**
 * 校验服务端调用方（collector 等后端）的共享密钥（Bearer），常数时间比对防时序侧信道。
 * 用于无 cookie 的机器对机器接口（/api/ingest、/api/collect-link/validate）。
 */
export function serviceSecretOk(req: Request): boolean {
  const expected = process.env.COLLECTOR_SERVICE_SECRET ?? "";
  if (!expected) return false; // 未配置密钥 → 一律拒绝
  const header = req.headers.get("authorization") ?? "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
