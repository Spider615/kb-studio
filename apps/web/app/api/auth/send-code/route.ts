import { NextResponse } from "next/server";
import { findUserByEmail, getEmailVerification, upsertEmailVerification } from "@kb/db";
import { sha256 } from "../../../../lib/auth-crypto";
import { generateCode, inCooldown, CODE_TTL_MS } from "../../../../lib/verify-code";
import { sendVerificationCode } from "../../../../lib/mailer";

export const runtime = "nodejs";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    if (await findUserByEmail(email)) return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });

    const existing = await getEmailVerification(email);
    if (existing && inCooldown(existing.lastSentAt, Date.now()))
      return NextResponse.json({ error: "请稍后再试" }, { status: 429 });

    const code = generateCode();
    const now = new Date();
    await upsertEmailVerification({
      email,
      codeHash: sha256(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      lastSentAt: now,
    });
    await sendVerificationCode(email, code); // 失败抛错 → 下方 catch 转 500
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[send-code] 失败:", e?.message ?? e);
    return NextResponse.json({ error: "验证码发送失败，请重试" }, { status: 500 });
  }
}
