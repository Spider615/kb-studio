import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listApiTokens, createApiToken } from "@kb/db";
import { resolveAuth } from "../../../lib/auth";
import { apiTokenString, sha256 } from "../../../lib/auth-crypto";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    return NextResponse.json({ tokens: await listApiTokens(auth.userId) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const body = await req.json().catch(() => null);
    const name = String(body?.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "请填 Token 名称" }, { status: 400 });

    const raw = apiTokenString(); // kbs_xxx 明文，仅此一次返回
    const id = "tok_" + randomUUID().slice(0, 8);
    await createApiToken({ id, userId: auth.userId, name, tokenHash: sha256(raw), prefix: raw.slice(0, 12) });
    return NextResponse.json({ token: { id, name, prefix: raw.slice(0, 12) }, secret: raw });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
