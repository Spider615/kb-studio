import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listConversations, createConversation } from "@kb/db";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    return NextResponse.json({ conversations: await listConversations(auth.userId) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const id = "conv_" + randomUUID().slice(0, 8);
    const conv = await createConversation(id, auth.userId);
    return NextResponse.json(conv);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
