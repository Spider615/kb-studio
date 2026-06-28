import { NextResponse } from "next/server";
import { getConversation, getMessages, deleteConversation, setConversationScope } from "@kb/db";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const conversation = await getConversation(id);
    if (!conversation) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const messages = await getMessages(id);
    return NextResponse.json({ conversation, messages });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteConversation(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const conv = await getConversation(id);
    if (!conv) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    // 互斥：分组优先；都空则清范围
    const scopeGroupId = body?.scopeGroupId ? String(body.scopeGroupId) : null;
    const scopeDocId = !scopeGroupId && body?.scopeDocId ? String(body.scopeDocId) : null;
    await setConversationScope(id, scopeDocId, scopeGroupId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
