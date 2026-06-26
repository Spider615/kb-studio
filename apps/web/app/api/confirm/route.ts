import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@kb/db";
import { StubMiaodongAdapter } from "@kb/adapters";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { docId } = await req.json();
    if (!docId) return NextResponse.json({ error: "缺少 docId" }, { status: 400 });

    const rows = await db.select().from(schema.chunks).where(eq(schema.chunks.docId, docId));
    const adapter = new StubMiaodongAdapter();
    const res = await adapter.push({ docId, title: docId, chunks: rows as any });

    await db
      .update(schema.docs)
      .set({ status: "pushed", confirmedAt: new Date(), pushedAt: new Date() })
      .where(eq(schema.docs.id, docId));

    return NextResponse.json({ ok: true, pushed: res.pushed, target: res.target });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
