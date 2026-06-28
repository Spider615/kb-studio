import { NextResponse } from "next/server";
import { findUserById } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const user = await findUserById(auth.userId);
    if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
    return NextResponse.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
