import { NextResponse } from "next/server";
import { listDocs } from "@kb/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ docs: await listDocs() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
