import { NextResponse } from "next/server";
import { findUserByEmail, getEmailVerification, upsertEmailVerification } from "@kb/db";
import type { VerificationPurpose } from "@kb/db";
import { sha256 } from "../../../../lib/auth-crypto";
import { generateCode, inCooldown, CODE_TTL_MS } from "../../../../lib/verify-code";
import { sendVerificationCode } from "../../../../lib/mailer";

export const runtime = "nodejs";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();
    // 缺省 register：老前端不带该字段时行为不变
    const purpose: VerificationPurpose = body?.purpose === "reset" ? "reset" : "register";
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });

    // 两种用途对「邮箱是否已注册」的要求正好相反
    const user = await findUserByEmail(email);
    if (purpose === "register" && user)
      return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });
    if (purpose === "reset" && !user)
      return NextResponse.json({ error: "该邮箱未注册" }, { status: 404 });

    const existing = await getEmailVerification(email, purpose);
    if (existing && inCooldown(existing.lastSentAt, Date.now()))
      return NextResponse.json({ error: "请稍后再试" }, { status: 429 });

    const code = generateCode();
    const now = new Date();
    await upsertEmailVerification({
      email,
      purpose,
      codeHash: sha256(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      lastSentAt: now,
    });
    await sendVerificationCode(email, code, purpose); // 失败抛错 → 下方 catch 转 500
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[send-code] 失败:", e?.message ?? e);
    return NextResponse.json({ error: "验证码发送失败，请重试" }, { status: 500 });
  }
}
