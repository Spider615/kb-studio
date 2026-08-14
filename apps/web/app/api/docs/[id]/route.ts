import { NextResponse } from "next/server";
import { getDocWithChunks, getDoc, deleteDoc, setDocGroup, findCollectSubmission } from "@kb/db";
import { resolveAuth } from "../../../../lib/auth";
import { abortJob } from "../../../../lib/jobs";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const data = await getDocWithChunks(id);
    if (!data || data.doc.userId !== auth.userId)
      return NextResponse.json({ error: "文档不存在" }, { status: 404 });
    const chunks = data.chunks.map((r: any) => ({
      id: r.id,
      chunk_type: r.chunkType,
      token_estimate: r.tokenEstimate,
      context_prefix: r.contextPrefix,
      content_original: r.contentOriginal,
      heading_path: (r.metadata as any)?.heading_path ?? [],
    }));
    // 收集器来源：客户这次提交填的全部信息（含表单原样快照），供详情页展示
    const submission = data.doc.submissionId
      ? await findCollectSubmission(data.doc.submissionId, auth.userId)
      : null;
    return NextResponse.json({
      doc: {
        id: data.doc.id,
        title: data.doc.title,
        status: data.doc.status,
        progress: data.doc.progress ?? null,
        error: data.doc.error ?? null,
        pushTargets: data.doc.pushTargets ?? [],
        hasFile: !!data.doc.fileId,
        category: data.doc.category ?? null,
      },
      submission: submission
        ? {
            id: submission.id,
            company: submission.company,
            industry: submission.industry,
            agentPurpose: submission.agentPurpose,
            agentNotes: submission.agentNotes,
            form: submission.form ?? null,
            createdAt: submission.createdAt,
          }
        : null,
      chunks,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const doc = await getDoc(id);
    if (!doc || doc.userId !== auth.userId)
      return NextResponse.json({ error: "文档不存在" }, { status: 404 });
    abortJob(id);
    await deleteDoc(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const groupId = body?.groupId ? String(body.groupId) : null;
    await setDocGroup(id, groupId, auth.userId); // 限本人文档
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
