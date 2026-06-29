import { NextResponse } from "next/server";
import { stat, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDoc } from "@kb/db";
import { OfficePdfConverter } from "@kb/adapters";
import { readOriginal, uploadDir } from "../../../../../lib/files";
import { resolveAuth } from "../../../../../lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// 同一文件并发预览只转一次（双击连点不会起多个 soffice 容器）。
const inflight = new Map<string, Promise<Buffer>>();

/**
 * 把 pptx/ppt/odp 用 LibreOffice 转成 PDF 返回（供前端 iframe 内联预览）。
 * 转换结果缓存到 .uploads/<fileId>.preview.pdf，二次预览直接命中缓存。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const doc = await getDoc(id);
    if (!doc || doc.userId !== auth.userId) return NextResponse.json({ error: "文档不存在" }, { status: 404 });
    if (!doc.fileId) return NextResponse.json({ error: "原文件不存在" }, { status: 404 });
    const name = doc.title || doc.fileId;
    if (!OfficePdfConverter.canConvert(name))
      return NextResponse.json({ error: "该格式无需/不支持 PDF 预览" }, { status: 400 });

    const cachePath = path.join(uploadDir(), path.basename(doc.fileId) + ".preview.pdf");
    let pdf: Buffer | null = null;
    try {
      const st = await stat(cachePath);
      if (st.size > 0) pdf = await readFile(cachePath);
    } catch {
      /* 无缓存，下面转 */
    }

    if (!pdf) {
      let p = inflight.get(cachePath);
      if (!p) {
        p = (async () => {
          const src = await readOriginal(doc.fileId!);
          const out = await new OfficePdfConverter().toPdf({ bytes: new Uint8Array(src), filename: name });
          const buf = Buffer.from(out);
          await mkdir(uploadDir(), { recursive: true }).catch(() => {});
          await writeFile(cachePath, buf).catch((e) => console.error("[preview-pdf] 写缓存失败:", e?.message ?? e));
          return buf;
        })();
        inflight.set(cachePath, p);
        p.finally(() => inflight.delete(cachePath));
      }
      pdf = await p;
    }

    const dl = encodeURIComponent(name.replace(/\.[^.]+$/, "") + ".pdf");
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename*=UTF-8''${dl}`,
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e: any) {
    console.error("[preview-pdf] 失败:", e?.message ?? e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
