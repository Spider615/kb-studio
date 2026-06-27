import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/** 原文件存储目录（默认仓库内 .uploads/，可用 KB_UPLOAD_DIR 覆盖）。 */
export function uploadDir(): string {
  return process.env.KB_UPLOAD_DIR || path.join(process.cwd(), ".uploads");
}

/** 从文件名取小写扩展名（含点），无则空串。 */
export function extOf(filename: string): string {
  const m = /\.[a-z0-9]+$/i.exec(filename);
  return m ? m[0].toLowerCase() : "";
}

/** 落盘原文件，返回存储文件名（= docId+ext），用于 docs.fileId。 */
export async function saveOriginal(docId: string, filename: string, bytes: Uint8Array): Promise<string> {
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const stored = docId + extOf(filename);
  await writeFile(path.join(dir, stored), bytes);
  return stored;
}

/** 读原文件 bytes（不存在抛错）。stored 取 basename 防越权。 */
export async function readOriginal(stored: string): Promise<Buffer> {
  return readFile(path.join(uploadDir(), path.basename(stored)));
}

/** 扩展名 → content-type。 */
export function contentType(filename: string): string {
  const e = extOf(filename);
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[e] ?? "application/octet-stream";
}
