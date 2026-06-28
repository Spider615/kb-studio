import { NextResponse } from "next/server";
import { findUserByEmail, createSession } from "@kb/db";
import {
  verifyPassword,
  randomToken,
  sha256,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieOptions,
} from "../../../../lib/auth-crypto";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const user = await findUserByEmail(email);
    // 不区分"邮箱不存在 / 密码错"，统一 401
    if (!user || !(await verifyPassword(password, user.passwordHash)))
      return NextResponse.json({ error: "邮箱或密码错误" }, { status: 401 });

    const raw = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await createSession({ id: sha256(raw), userId: user.id, expiresAt });

    const res = NextResponse.json({
      user: { id: user.id, email: user.email, displayName: user.displayName },
    });
    res.cookies.set(SESSION_COOKIE, raw, cookieOptions(expiresAt));
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
