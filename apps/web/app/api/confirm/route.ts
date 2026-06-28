import { NextResponse } from "next/server";
import { getDocWithChunks, getCredentials, setDocPushTargets, listDocIdsInGroup } from "@kb/db";
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
    const credentialIds: string[] = Array.isArray(body?.credentialIds) ? body.credentialIds : [];
    if (credentialIds.length === 0)
      return NextResponse.json({ error: "请至少选择一个凭证" }, { status: 400 });

    const creds = await getCredentials(credentialIds);
    if (creds.length === 0) return NextResponse.json({ error: "所选凭证不存在" }, { status: 400 });

    // 待推文档：单篇 {docId} 或整组 {groupId}（仅 ready/pushed）
    let docIds: string[];
    const isGroup = !!body?.groupId;
    if (isGroup) {
      docIds = await listDocIdsInGroup(String(body.groupId));
    } else if (body?.docId) {
      docIds = [String(body.docId)];
    } else {
      return NextResponse.json({ error: "缺少 docId 或 groupId" }, { status: 400 });
    }

    const adapter = new RealMiaodongAdapter();
    const perDoc: Array<{
      docId: string;
      title: string;
      status: string;
      ok: boolean;
      results: Array<{ credentialId: string; credentialName: string; ok: boolean; error?: string }>;
    }> = [];

    for (const docId of docIds) {
      const data = await getDocWithChunks(docId);
      if (!data) {
        perDoc.push({ docId, title: docId, status: "missing", ok: false, results: [] });
        continue;
      }
      // 整组推送跳过未就绪文档
      if (isGroup && data.doc.status !== "ready" && data.doc.status !== "pushed") {
        perDoc.push({ docId, title: data.doc.title, status: data.doc.status, ok: false, results: [] });
        continue;
      }
      const results: Array<{ credentialId: string; credentialName: string; ok: boolean; error?: string }> = [];
      const targets = new Map<string, PushTarget>();
      for (const t of (data.doc.pushTargets ?? []) as PushTarget[]) targets.set(t.knowledgeBaseId, t);
      for (const c of creds) {
        try {
          const res = await adapter.push(
            { docId, title: data.doc.title, chunks: data.chunks as unknown as Chunk[] },
            { domain: c.domain, accessKeyId: c.accessKeyId, accessKeySecret: c.accessKeySecret, knowledgeBaseId: c.knowledgeBaseId },
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
      const docOk = results.some((r) => r.ok);
      if (docOk) await setDocPushTargets(docId, [...targets.values()]);
      perDoc.push({ docId, title: data.doc.title, status: data.doc.status, ok: docOk, results });
    }

    if (isGroup) {
      const anyOk = perDoc.some((d) => d.ok);
      return NextResponse.json({ ok: anyOk, perDoc });
    }
    // 单篇：保持原响应形状 {ok, results}（DocDetail 依赖）
    const single = perDoc[0];
    return NextResponse.json({ ok: single?.ok ?? false, results: single?.results ?? [] });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
