// xlsx workbook → 拼接的预览 HTML。
// XLSX 模块由调用方（FilePreview）动态 import 后传进来——这样本模块不静态依赖 xlsx，
// 不会把重库打进主 bundle，同时纯函数可被 node:test 单测。

// 形参用 any 而非 unknown：xlsx 真实签名是 (ws: WorkSheet) => string，
// strictFunctionTypes 下形参逆变，unknown 会让真实模块不可赋值给本类型。
type XLSXModule = {
  utils: { sheet_to_html: (sheet: any) => string };
};

type WorkbookLike = {
  SheetNames: string[];
  Sheets: Record<string, { "!ref"?: string } | undefined>;
};

/**
 * 把 workbook 各 sheet 转成拼好的 HTML。
 * 空 sheet（无 `!ref` 数据范围）会让 SheetJS 的 `sheet_to_html` 崩（`decode_range(undefined)`），
 * 这里显式跳过、渲染占位——xlsx 常带默认空 `Sheet1`，不处理会让整篇预览挂掉。
 * 多 sheet 时给每个 sheet 加标题。
 */
export function workbookToHtml(XLSX: XLSXModule, wb: WorkbookLike): string {
  const multi = wb.SheetNames.length > 1;
  const parts = wb.SheetNames.map((n) => {
    const sheet = wb.Sheets[n];
    // 无 !ref 的空 sheet 会崩 sheet_to_html（decode_range(undefined)）——跳过、渲染占位
    const table = sheet && sheet["!ref"] ? XLSX.utils.sheet_to_html(sheet) : '<p class="muted">（空表）</p>';
    return multi ? `<h4 class="sheet-name">${n}</h4>${table}` : table;
  });
  return parts.join("\n");
}
