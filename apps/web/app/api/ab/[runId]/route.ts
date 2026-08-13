import { NextResponse } from "next/server";
import { setAbVerdict } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

const VALID = new Set(["a", "b", "tie", "neither"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { runId } = await params;
    const { verdict } = await req.json();
    if (!VALID.has(verdict)) return NextResponse.json({ error: "verdict 非法" }, { status: 400 });
    await setAbVerdict(runId, verdict, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
