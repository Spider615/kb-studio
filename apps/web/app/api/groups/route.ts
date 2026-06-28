import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listGroups, createGroup } from "@kb/db";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const rows = await listGroups(auth.userId);
    const groups = rows.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color ?? null,
      sortOrder: g.sortOrder,
      docCount: g.docCount,
    }));
    return NextResponse.json({ groups });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const body = await req.json().catch(() => null);
    const name = (body?.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "分组名不能为空" }, { status: 400 });
    const id = "grp_" + randomUUID().slice(0, 8);
    await createGroup({ id, name, color: body?.color ?? null, userId: auth.userId });
    return NextResponse.json({ group: { id, name, color: body?.color ?? null, sortOrder: 0, docCount: 0 } });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
