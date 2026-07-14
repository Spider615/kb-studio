import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./claude-code-sandbox";

test("buildPrompt：originalName 异于磁盘名 → 双名提示 + 指明按磁盘名读", () => {
  const p = buildPrompt("input.pdf", "2022年-精骐&捷美-产品价格表.csv");
  assert.ok(p.includes("input.pdf"));
  assert.ok(p.includes("2022年-精骐&捷美-产品价格表.csv"));
  assert.ok(p.includes("原始文件名"));
  assert.ok(p.includes("按这个读取"));
});

test("buildPrompt：无 originalName → 无补充提示（与旧行为一致）", () => {
  const p = buildPrompt("2022年-精骐&捷美-产品价格表.csv");
  assert.ok(p.includes("2022年-精骐&捷美-产品价格表.csv"));
  assert.ok(!p.includes("原始文件名"));
});

test("buildPrompt：originalName 等于磁盘名 → 跳过提示", () => {
  const p = buildPrompt("a.pdf", "a.pdf");
  assert.ok(!p.includes("原始文件名"));
});
