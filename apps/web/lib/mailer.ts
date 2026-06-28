import nodemailer, { type Transporter } from "nodemailer";

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

/**
 * 发注册验证码。未配 SMTP → 打到服务端 console（dev 兜底，便于联调/测试）。
 * 发信失败抛错（由调用方转 500）。
 */
export async function sendVerificationCode(email: string, code: string): Promise<void> {
  if (!smtpConfigured()) {
    console.log(`[mailer] 验证码 ${code} → ${email}（SMTP 未配置，dev 兜底打印）`);
    return;
  }
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: "kb-studio 注册验证码",
    text: `你的注册验证码是 ${code}，10 分钟内有效。如非本人操作请忽略。`,
  });
}
