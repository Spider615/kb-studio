import { NextResponse } from "next/server";
import { deleteCredential, getCredential, updateCredential } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

/** 取单个凭据全字段（含 secret，供查看/编辑预填）。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const c = await getCredential(id);
    if (!c || c.userId !== auth.userId) return NextResponse.json({ error: "凭据不存在" }, { status: 404 });
    return NextResponse.json({
      credential: {
        id: c.id,
        name: c.name,
        domain: c.domain,
        accessKeyId: c.accessKeyId,
        accessKeySecret: c.accessKeySecret,
        knowledgeBaseId: c.knowledgeBaseId,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const cred = await getCredential(id);
    if (!cred || cred.userId !== auth.userId)
      return NextResponse.json({ error: "凭据不存在" }, { status: 404 });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }
    const name = String(body?.name ?? "").trim();
    const domain = String(body?.domain ?? "").trim();
    const accessKeyId = String(body?.accessKeyId ?? "").trim();
    const knowledgeBaseId = String(body?.knowledgeBaseId ?? "").trim();
    const accessKeySecret = String(body?.accessKeySecret ?? "").trim();
    if (!name || !domain || !accessKeyId || !knowledgeBaseId) {
      return NextResponse.json(
        { error: "缺少字段（凭证名称 / 域名 / accessKeyId / knowledgeBaseId）" },
        { status: 400 },
      );
    }
    await updateCredential(id, { name, domain, accessKeyId, knowledgeBaseId, accessKeySecret });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const cred = await getCredential(id);
    if (!cred || cred.userId !== auth.userId)
      return NextResponse.json({ error: "凭据不存在" }, { status: 404 });
    await deleteCredential(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
