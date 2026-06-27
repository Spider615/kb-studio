import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema, getDocWithChunks } from "@kb/db";
import { RealMiaodongAdapter } from "@kb/adapters";
import type { Chunk, MiaodongCredentials } from "@kb/core";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }
    const docId: string | undefined = body?.docId;
    const creds: Partial<MiaodongCredentials> = body?.credentials ?? {};
    if (!docId) return NextResponse.json({ error: "缺少 docId" }, { status: 400 });

    const { domain, accessKeyId, accessKeySecret, knowledgeBaseId } = creds;
    if (!domain || !accessKeyId || !accessKeySecret || !knowledgeBaseId) {
      return NextResponse.json(
        { error: "缺少凭据（域名 / accessKeyId / accessKeySecret / knowledgeBaseId）" },
        { status: 400 },
      );
    }

    const data = await getDocWithChunks(docId);
    if (!data) return NextResponse.json({ error: "文档不存在" }, { status: 404 });

    const adapter = new RealMiaodongAdapter();
    const res = await adapter.push(
      { docId, title: data.doc.title, chunks: data.chunks as unknown as Chunk[] },
      { domain, accessKeyId, accessKeySecret, knowledgeBaseId },
    );

    await db
      .update(schema.docs)
      .set({
        status: "pushed",
        confirmedAt: new Date(),
        pushedAt: new Date(),
        miaodongKbId: knowledgeBaseId,
        miaodongDocId: res.remoteDocId ?? null,
        miaodongDomain: domain,
      })
      .where(eq(schema.docs.id, docId));

    return NextResponse.json({ ok: true, pushed: res.pushed, remoteDocId: res.remoteDocId });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
