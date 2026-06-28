import { NextResponse } from "next/server";
import { deleteSession } from "@kb/db";
import { SESSION_COOKIE, sha256, cookieOptions } from "../../../../lib/auth-crypto";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const raw = readCookie(req, SESSION_COOKIE);
    if (raw) await deleteSession(sha256(raw)).catch(() => {});
    const res = NextResponse.json({ ok: true });
    // 清 cookie：立即过期
    res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(new Date(0)), maxAge: 0 });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
