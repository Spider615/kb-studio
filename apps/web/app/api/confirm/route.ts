import { NextResponse } from "next/server";
import { getDocWithChunks, getCredentials, setDocPushTargets } from "@kb/db";
import type { PushTarget } from "@kb/db";
import { RealMiaodongAdapter } from "@kb/adapters";
import type { Chunk } from "@kb/core";

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
    const credentialIds: string[] = Array.isArray(body?.credentialIds) ? body.credentialIds : [];
    if (!docId) return NextResponse.json({ error: "缺少 docId" }, { status: 400 });
    if (credentialIds.length === 0)
      return NextResponse.json({ error: "请至少选择一个凭据" }, { status: 400 });

    const data = await getDocWithChunks(docId);
    if (!data) return NextResponse.json({ error: "文档不存在" }, { status: 404 });

    const creds = await getCredentials(credentialIds);
    if (creds.length === 0) return NextResponse.json({ error: "所选凭据不存在" }, { status: 400 });

    const adapter = new RealMiaodongAdapter();
    const results: Array<{ credentialId: string; credentialName: string; ok: boolean; error?: string }> = [];
    // 现有推送目标按 knowledgeBaseId 索引，便于去重更新
    const targets = new Map<string, PushTarget>();
    for (const t of (data.doc.pushTargets ?? []) as PushTarget[]) targets.set(t.knowledgeBaseId, t);

    for (const c of creds) {
      try {
        const res = await adapter.push(
          { docId, title: data.doc.title, chunks: data.chunks as unknown as Chunk[] },
          {
            domain: c.domain,
            accessKeyId: c.accessKeyId,
            accessKeySecret: c.accessKeySecret,
            knowledgeBaseId: c.knowledgeBaseId,
          },
        );
        targets.set(c.knowledgeBaseId, {
          credentialId: c.id,
          credentialName: c.name,
          knowledgeBaseId: c.knowledgeBaseId,
          domain: c.domain,
          remoteDocId: res.remoteDocId ?? null,
          pushedAt: new Date().toISOString(),
        });
        results.push({ credentialId: c.id, credentialName: c.name, ok: true });
      } catch (e: any) {
        results.push({ credentialId: c.id, credentialName: c.name, ok: false, error: String(e?.message ?? e) });
      }
    }

    const anyOk = results.some((r) => r.ok);
    if (anyOk) await setDocPushTargets(docId, [...targets.values()]);

    return NextResponse.json({ ok: anyOk, results });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
