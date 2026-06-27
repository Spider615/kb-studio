import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listCredentials, createCredential } from "@kb/db";

export const runtime = "nodejs";

/** 列出凭据——不回传 accessKeySecret（推送在服务端按 id 取，客户端无需 secret）。 */
export async function GET() {
  try {
    const rows = await listCredentials();
    const creds = rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      accessKeyId: r.accessKeyId,
      knowledgeBaseId: r.knowledgeBaseId,
      createdAt: r.createdAt,
    }));
    return NextResponse.json({ credentials: creds });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }
    const name = String(body?.name ?? "").trim();
    const domain = String(body?.domain ?? "").trim();
    const accessKeyId = String(body?.accessKeyId ?? "").trim();
    const accessKeySecret = String(body?.accessKeySecret ?? "").trim();
    const knowledgeBaseId = String(body?.knowledgeBaseId ?? "").trim();
    if (!name || !domain || !accessKeyId || !accessKeySecret || !knowledgeBaseId) {
      return NextResponse.json(
        { error: "缺少字段（凭证名称 / 域名 / accessKeyId / accessKeySecret / knowledgeBaseId）" },
        { status: 400 },
      );
    }
    const id = "cred_" + randomUUID().slice(0, 8);
    await createCredential({ id, name, domain, accessKeyId, accessKeySecret, knowledgeBaseId });
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
