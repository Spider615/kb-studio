import { NextResponse } from "next/server";
import { listDocs } from "@kb/db";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    return NextResponse.json({ docs: await listDocs(auth.userId) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
