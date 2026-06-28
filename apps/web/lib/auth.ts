import { findSessionById, deleteSession } from "@kb/db";
import { SESSION_COOKIE, sha256 } from "./auth-crypto";

/** 从请求 Cookie 头取某个 cookie 值（不依赖 next/headers，便于统一）。 */
function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/**
 * 解析当前请求的用户：查 session cookie → 校验未过期。
 * 返回 { userId } 或 null。
 */
export async function resolveAuth(req: Request): Promise<{ userId: string } | null> {
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const session = await findSessionById(sha256(raw));
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    void deleteSession(session.id).catch(() => {});
    return null;
  }
  return { userId: session.userId };
}
