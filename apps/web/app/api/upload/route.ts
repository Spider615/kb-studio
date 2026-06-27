import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ingestDoc } from "@kb/pipeline";
import { db, schema } from "@kb/db";
import { getDeps, getParser } from "../../../lib/kb";

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

    // 1. 解析（csv/xlsx 走确定性表格解析；其余走容器化 Claude Code）
    const parser = getParser(filename);
    const { markdown } = await parser.parse({ bytes, filename });

    // 2. 入库（chunk → 上下文化 → embed → 存）。CSV/Excel：表格按数据行切，每个 chunk 带表头
    const tableRowChunks = /\.(csv|xlsx?|tsv)$/i.test(filename);
    const docId = "doc_" + randomUUID().slice(0, 8);
    const { llm, embedder } = getDeps();
    const count = await ingestDoc(
      { docId, title: filename, source: filename, markdown },
      { llm, embedder },
      { tableRowChunks },
    );

    // 3. 读回 chunk 给前端预览
    const rows = await db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.docId, docId))
      .orderBy(schema.chunks.chunkIndex);
    const chunks = rows.map((r) => ({
      id: r.id,
      chunk_type: r.chunkType,
      token_estimate: r.tokenEstimate,
      context_prefix: r.contextPrefix,
      content_original: r.contentOriginal,
      heading_path: (r.metadata as any)?.heading_path ?? [],
    }));
    return NextResponse.json({ docId, count, markdown, chunks });
  } catch (e: any) {
    console.error("[upload] 处理失败:", e?.message ?? e); // 全量错误进服务端日志便于诊断
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
