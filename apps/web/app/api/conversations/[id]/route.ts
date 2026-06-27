import { NextResponse } from "next/server";
import { getConversation, getMessages, deleteConversation } from "@kb/db";

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
