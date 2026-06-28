import { NextResponse } from "next/server";
import { updateGroup, deleteGroup } from "@kb/db";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const patch: { name?: string; color?: string | null; sortOrder?: number } = {};
    if (typeof body?.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "分组名不能为空" }, { status: 400 });
      patch.name = name;
    }
    if ("color" in (body ?? {})) patch.color = body.color ?? null;
    if (typeof body?.sortOrder === "number") patch.sortOrder = body.sortOrder;
    await updateGroup(id, patch);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteGroup(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
