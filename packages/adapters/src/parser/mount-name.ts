import { extname } from "node:path";

/**
 * 容器挂载用的安全文件名。
 *
 * 原始上传名可能含 `"` 、反引号、ASCII `:` 等字符——实测带半角双引号的文件名会破坏
 * docker `-v <host>:/work/<name>:ro` 单文件挂载的路径解析（`…规定".txt` 在容器内被截断成
 * `…规定"o`），导致解析进程 `ENOENT` 打不开文件、整篇「容器解析失败」。
 *
 * 这里统一把容器内文件名归一成 `input.<ext>`：扩展名决定解析分支（csv/xlsx 走确定性、pdf 判扫描、
 * 其余走 Claude Code），必须保留且小写化；原始文件名只用于展示/落库（docs.title），不影响解析结果。
 */
export function safeMountName(filename: string): string {
  const m = extname(filename).match(/^\.[A-Za-z0-9]+$/);
  return `input${m ? m[0].toLowerCase() : ".bin"}`;
}
