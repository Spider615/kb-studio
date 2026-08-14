import { NextResponse } from "next/server";
import { updateGroup, deleteGroup } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const patch: {
      name?: string;
      color?: string | null;
      sortOrder?: number;
      agentPurpose?: string | null;
      agentNotes?: string | null;
      industry?: string | null;
    } = {};
    if (typeof body?.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "分组名不能为空" }, { status: 400 });
      patch.name = name;
    }
    if ("color" in (body ?? {})) patch.color = body.color ?? null;
    if ("agentPurpose" in (body ?? {})) patch.agentPurpose = body.agentPurpose ?? null;
    if ("agentNotes" in (body ?? {})) patch.agentNotes = body.agentNotes ?? null;
    if ("industry" in (body ?? {})) patch.industry = body.industry ?? null;
    if (typeof body?.sortOrder === "number") patch.sortOrder = body.sortOrder;
    await updateGroup(id, patch, auth.userId);
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
    await deleteGroup(id, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
