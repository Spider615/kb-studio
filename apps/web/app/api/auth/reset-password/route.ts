import { NextResponse } from "next/server";
import {
  findUserByEmail,
  getEmailVerification,
  incEmailVerificationAttempts,
  deleteEmailVerification,
  updateUserPassword,
  deleteSessionsByUser,
} from "@kb/db";
import { hashPassword, sha256 } from "../../../../lib/auth-crypto";
import { checkCode, MAX_ATTEMPTS } from "../../../../lib/verify-code";

export const runtime = "nodejs";

/**
 * 忘记密码重置：邮箱 + 验证码 + 新密码。无需登录。
 * 成功后删该用户全部会话——所有设备都要用新密码重登。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const code = String(body?.code ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (password.length < 8) return NextResponse.json({ error: "密码至少 8 位" }, { status: 400 });

    // 先验码再查用户：避免拿本接口当「邮箱是否注册」的探针
    const ver = await getEmailVerification(email, "reset");
    const result = checkCode(ver, code, Date.now(), sha256);
    if (result === "expired")
      return NextResponse.json({ error: "验证码已过期，请重新获取" }, { status: 400 });
    if (result === "wrong") {
      const n = await incEmailVerificationAttempts(email, "reset"); // 原子自增，返回新次数
      if (n >= MAX_ATTEMPTS) await deleteEmailVerification(email, "reset"); // 超次作废
      return NextResponse.json({ error: "验证码错误" }, { status: 400 });
    }

    // 码有效但用户在这期间被删了：作废该码，让流程从头再来
    const user = await findUserByEmail(email);
    if (!user) {
      await deleteEmailVerification(email, "reset");
      return NextResponse.json({ error: "该邮箱未注册" }, { status: 404 });
    }

    await updateUserPassword(user.id, await hashPassword(password));
    await deleteEmailVerification(email, "reset"); // 消费验证码，防重放
    const revoked = await deleteSessionsByUser(user.id); // 含可能存在的旧会话
    console.log(`[reset-password] ${user.id} 重置成功，踢掉 ${revoked} 个会话`);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[reset-password] 失败:", e?.message ?? e);
    return NextResponse.json({ error: "重置失败，请重试" }, { status: 500 });
  }
}
