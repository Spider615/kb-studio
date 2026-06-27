import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listConversations, createConversation } from "@kb/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ conversations: await listConversations() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const id = "conv_" + randomUUID().slice(0, 8);
    const conv = await createConversation(id);
    return NextResponse.json(conv);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
