import { NextResponse } from "next/server";
import { getConversation, getMessages, deleteConversation, setConversationScope } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const conversation = await getConversation(id);
    if (!conversation || conversation.userId !== auth.userId)
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const messages = await getMessages(id);
    return NextResponse.json({ conversation, messages });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const conv = await getConversation(id);
    if (!conv || conv.userId !== auth.userId)
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    await deleteConversation(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const conv = await getConversation(id);
    if (!conv || conv.userId !== auth.userId)
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const scopeGroupId = body?.scopeGroupId ? String(body.scopeGroupId) : null;
    const scopeDocId = !scopeGroupId && body?.scopeDocId ? String(body.scopeDocId) : null;
    await setConversationScope(id, scopeDocId, scopeGroupId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
