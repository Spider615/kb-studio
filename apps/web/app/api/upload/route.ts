import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ingestDoc } from "@kb/pipeline";
import { createProcessingDoc, setDocProgress, failDoc, clearDocProgress, getDocStatus } from "@kb/db";
import { getDeps, getParser, shouldStructure } from "../../../lib/kb";
import { startJob, endJob } from "../../../lib/jobs";
import { saveOriginal } from "../../../lib/files";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file") as any;
    if (!file || typeof file.arrayBuffer !== "function")
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = (typeof file.name === "string" && file.name) || "upload.bin";

    const docId = "doc_" + randomUUID().slice(0, 8);
    // 落盘原文件（供预览）；失败不致命，仅预览不可用
    let fileId: string | null = null;
    try {
      fileId = await saveOriginal(docId, filename, bytes);
    } catch (e: any) {
      console.error("[upload] 存原文件失败:", e?.message ?? e);
    }
    // 先建处理中文档行，立即返回 docId；真正处理在后台异步跑（前端轮询进度）
    await createProcessingDoc(docId, filename, filename, fileId);
    void processUpload(docId, bytes, filename);
    return NextResponse.json({ docId });
  } catch (e: any) {
    console.error("[upload] 建任务失败:", e?.message ?? e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

/** 后台处理：解析 → (造结构) → 入库(带进度)。可被 abortJob 中止。 */
async function processUpload(docId: string, bytes: Uint8Array, filename: string) {
  const signal = startJob(docId);
  try {
    const tableRowChunks = /\.(csv|xlsx?|tsv)$/i.test(filename);
    const { llm, embedder } = getDeps();

    // 1. 解析
    await setDocProgress(docId, { stage: "parsing", done: 0, total: 0 });
    const parser = getParser(filename);
    let markdown = (await parser.parse({ bytes, filename })).markdown;
    if (signal.aborted) return;

    // 2. 造结构（条件，失败不致命）
    if (!tableRowChunks && shouldStructure(markdown)) {
      await setDocProgress(docId, { stage: "structuring", done: 0, total: 0 });
      try {
        markdown = await llm.structure(markdown);
      } catch (e: any) {
        console.error("[upload] structure 失败，按原文入库:", e?.message ?? e);
      }
    }
    if (signal.aborted) return;

    // 3. 入库（chunk → 上下文化(进度) → embed → 存）；ingestDoc 末尾把 status 置 ready
    await ingestDoc(
      { docId, title: filename, source: filename, markdown },
      { llm, embedder },
      {
        tableRowChunks,
        signal,
        onProgress: (p) => setDocProgress(docId, p),
      },
    );

    if (signal.aborted) return;
    await clearDocProgress(docId);
  } catch (e: any) {
    if (e?.name === "AbortError" || signal.aborted) return; // 被取消：行已删，静默
    // 行可能已被用户删除（删处理中文档）；还在才标失败
    const st = await getDocStatus(docId).catch(() => null);
    if (st) await failDoc(docId, String(e?.message ?? e)).catch(() => {});
    console.error("[upload] 处理失败:", e?.message ?? e);
  } finally {
    endJob(docId);
  }
}
