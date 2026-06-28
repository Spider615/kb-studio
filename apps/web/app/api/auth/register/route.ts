import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createUser, findUserByEmail, createSession } from "@kb/db";
import {
  hashPassword,
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (password.length < 8) return NextResponse.json({ error: "密码至少 8 位" }, { status: 400 });
    if (await findUserByEmail(email)) return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });

    const userId = "usr_" + randomUUID().slice(0, 8);
    const displayName = email.split("@")[0];
    await createUser({ id: userId, email, passwordHash: await hashPassword(password), displayName });

    const raw = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await createSession({ id: sha256(raw), userId, expiresAt });

    const res = NextResponse.json({ user: { id: userId, email, displayName } });
    res.cookies.set(SESSION_COOKIE, raw, cookieOptions(expiresAt));
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
