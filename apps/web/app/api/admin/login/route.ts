import { NextResponse } from "next/server";
import {
  checkAdminCredentials,
  signAdminCookie,
  adminCookieOptions,
  ADMIN_COOKIE,
  ADMIN_TTL_MS,
} from "../../../../lib/admin-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const user = String(body?.user ?? "");
    const pass = String(body?.pass ?? "");
    if (!checkAdminCredentials(user, pass)) {
      return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
    }
    const expires = new Date(Date.now() + ADMIN_TTL_MS);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_COOKIE, signAdminCookie(), adminCookieOptions(expires));
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
