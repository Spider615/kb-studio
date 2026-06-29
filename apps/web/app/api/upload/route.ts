import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createProcessingDoc, groupBelongsToUser } from "@kb/db";
import { processDoc, isArchiveUpload, ingestArchive } from "../../../lib/kb";
import { saveOriginal } from "../../../lib/files";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const form = await req.formData();
    const file = form.get("file") as any;
    if (!file || typeof file.arrayBuffer !== "function")
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = (typeof file.name === "string" && file.name) || "upload.bin";

    // 目标分组：空 → 未分组(null)；非空必须属于当前用户
    const rawGroupId = form.get("groupId");
    const groupId = typeof rawGroupId === "string" && rawGroupId.trim() ? rawGroupId.trim() : null;
    if (groupId && !(await groupBelongsToUser(groupId, auth.userId)))
      return NextResponse.json({ error: "分组不存在" }, { status: 400 });

    // 压缩包：和 /api/ingest 同款——后台沙箱解压成多个 doc，立即返回（解压慢，避免请求超时）。
    // 解压出的每个文件走与直传单文件完全相同的 processDoc 流程（同一套解析/切片/入库）。
    if (isArchiveUpload(filename)) {
      void ingestArchive(bytes, filename, auth.userId, groupId);
      return NextResponse.json({ archive: true, queued: true });
    }

    const docId = "doc_" + randomUUID().slice(0, 8);
    // 落盘原文件（供预览）；失败不致命，仅预览不可用
    let fileId: string | null = null;
    try {
      fileId = await saveOriginal(docId, filename, bytes);
    } catch (e: any) {
      console.error("[upload] 存原文件失败:", e?.message ?? e);
    }
    // 先建处理中文档行，立即返回 docId；真正处理在后台异步跑（前端轮询进度）
    await createProcessingDoc(docId, filename, filename, fileId, auth.userId, groupId);
    void processDoc(docId, bytes, filename);
    return NextResponse.json({ docId });
  } catch (e: any) {
    console.error("[upload] 建任务失败:", e?.message ?? e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
