import { NextResponse } from "next/server";
import { findUserById, updateUserPassword, deleteSessionsByUser } from "@kb/db";
import {
  verifyPassword,
  hashPassword,
  SESSION_COOKIE,
  cookieOptions,
} from "../../../../lib/auth-crypto";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

/**
 * 已登录改密码：验旧密码 → 换新 → 踢掉全部会话（含当前）并清 cookie。
 * 前端收到 ok 后应跳登录页。
 */
export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const oldPassword = String(body?.oldPassword ?? "");
    const newPassword = String(body?.newPassword ?? "");
    if (newPassword.length < 8)
      return NextResponse.json({ error: "新密码至少 8 位" }, { status: 400 });

    const user = await findUserById(auth.userId);
    if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

    if (!(await verifyPassword(oldPassword, user.passwordHash)))
      return NextResponse.json({ error: "当前密码不正确" }, { status: 400 });

    if (await verifyPassword(newPassword, user.passwordHash))
      return NextResponse.json({ error: "新密码不能与当前密码相同" }, { status: 400 });

    await updateUserPassword(user.id, await hashPassword(newPassword));
    const revoked = await deleteSessionsByUser(user.id); // 含当前这台
    console.log(`[change-password] ${user.id} 改密成功，踢掉 ${revoked} 个会话`);

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(new Date(0)), maxAge: 0 });
    return res;
  } catch (e: any) {
    console.error("[change-password] 失败:", e?.message ?? e);
    return NextResponse.json({ error: "修改失败，请重试" }, { status: 500 });
  }
}
