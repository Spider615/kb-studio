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
    // setAbVerdict 返回是否真的改到了行：id 不存在或不属于本人时不能无条件回 ok，
    // 否则评分数据静默丢失、用户还以为已保存。
    const ok = await setAbVerdict(runId, verdict, auth.userId);
    if (!ok) return NextResponse.json({ error: "记录不存在或无权限" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
