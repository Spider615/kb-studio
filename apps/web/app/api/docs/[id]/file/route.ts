import { NextResponse } from "next/server";
import { getDoc } from "@kb/db";
import { readOriginal, contentType } from "../../../../../lib/files";

export const runtime = "nodejs";

/** 流式返回文档的原始文件（供前端预览/下载）。 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const doc = await getDoc(id);
    if (!doc || !doc.fileId) return NextResponse.json({ error: "原文件不存在" }, { status: 404 });
    let buf: Buffer;
    try {
      buf = await readOriginal(doc.fileId);
    } catch {
      return NextResponse.json({ error: "原文件已丢失" }, { status: 404 });
    }
    const name = encodeURIComponent(doc.title || doc.fileId);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": contentType(doc.title || doc.fileId),
        "content-disposition": `inline; filename*=UTF-8''${name}`,
        "cache-control": "private, max-age=60",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
