import nodemailer, { type Transporter } from "nodemailer";
import type { VerificationPurpose } from "@kb/db";

/** 关键 SMTP env 是否齐备（缺则走 dev console 兜底）。 */
function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: String(process.env.SMTP_SECURE ?? "true") === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

/** 按用途区分邮件文案（注册 / 重置密码）。 */
const TEMPLATES: Record<VerificationPurpose, { subject: string; text: (code: string) => string }> = {
  register: {
    subject: "kb-studio 注册验证码",
    text: (code) => `你的注册验证码是 ${code}，10 分钟内有效。如非本人操作请忽略。`,
  },
  reset: {
    subject: "kb-studio 重置密码验证码",
    text: (code) =>
      `你正在重置 kb-studio 的登录密码，验证码是 ${code}，10 分钟内有效。\n` +
      `重置成功后所有设备都会退出登录，需要用新密码重新登录。\n` +
      `如非本人操作请忽略本邮件，你的密码不会被改动。`,
  },
};

/**
 * 发验证码。未配 SMTP → 打到服务端 console（dev 兜底，便于联调/测试）。
 * 发信失败抛错（由调用方转 500）。
 */
export async function sendVerificationCode(
  email: string,
  code: string,
  purpose: VerificationPurpose = "register",
): Promise<void> {
  const tpl = TEMPLATES[purpose];
  if (!smtpConfigured()) {
    console.log(`[mailer] ${tpl.subject} ${code} → ${email}（SMTP 未配置，dev 兜底打印）`);
    return;
  }
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: tpl.subject,
    text: tpl.text(code),
  });
}
