import { test } from "node:test";
import assert from "node:assert/strict";
import { modelTokens, tokenizeZh } from "./bm25";

test("modelTokens：抽字母数字编码作原子 token（型号/SKU/版本/零件号，领域无关）", () => {
  assert.deepEqual(modelTokens("GSP-9050MBE").sort(), ["gsp-9050mbe"]);
  const s = new Set(modelTokens("订单 YDS-2-35 与 Airsafe1300A2 以及 v1.2.0"));
  assert.ok(s.has("yds-2-35"));
  assert.ok(s.has("airsafe1300a2"));
  assert.ok(s.has("v1.2.0")); // 带字母的版本号
});

test("modelTokens：纯字母/纯数字/中文不误抽", () => {
  assert.deepEqual(modelTokens("hello 世界 12345 ABC"), []);
});

test("tokenizeZh：jieba 分词 + 追加型号原子 token", () => {
  const out = tokenizeZh("采购 GSP-9050MBE 一台");
  assert.ok(out.includes("gsp-9050mbe"), "应含型号原子 token");
  assert.ok(out.includes("采购") || out.includes("一台"), "应含 jieba 词");
});
