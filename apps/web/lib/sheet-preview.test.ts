import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { workbookToHtml } from "./sheet-preview";

/** 造一个含「有数据 sheet + 无 !ref 空 sheet」的 workbook——复现 xlsx 带默认空 Sheet1 的情形。 */
function wbWithEmptySheet() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["产品", "价格"],
    ["振荡器", 100],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "数据");
  wb.SheetNames.push("Sheet1"); // 空 sheet：只挂个名字，无 !ref
  wb.Sheets["Sheet1"] = {};
  return wb;
}

test("workbookToHtml：含空 sheet（无 !ref）不抛错，空表渲染占位", () => {
  const wb = wbWithEmptySheet();
  const html = workbookToHtml(XLSX as any, wb as any);
  assert.ok(html.includes("产品"), "有数据的 sheet 应正常渲染");
  assert.ok(html.includes("（空表）"), "空 sheet 应渲染占位而非崩溃");
  // 多 sheet：两个 sheet 名都作为标题出现
  assert.ok(html.includes(">数据<") && html.includes(">Sheet1<"));
});

test("workbookToHtml：单个有数据 sheet 不加 sheet 标题", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), "only");
  const html = workbookToHtml(XLSX as any, wb as any);
  assert.ok(!html.includes("sheet-name"), "单 sheet 不应加标题");
  assert.ok(html.includes("x"));
});
