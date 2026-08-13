import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_SPECS, formatPagesForModel, clampDocIds } from "./agent-tools";

test("五个工具规格齐全且各有 input_schema", () => {
  const names = TOOL_SPECS.map((t) => t.name).sort();
  assert.deepEqual(names, ["grep", "list_docs", "read_outline", "read_page", "search"]);
  for (const t of TOOL_SPECS) {
    assert.ok(t.description.length > 0, `${t.name} 缺 description`);
    assert.equal((t.input_schema as any).type, "object");
  }
});

test("clampDocIds：越权的 docId 被过滤掉，空入参回全部白名单", () => {
  const allowed = ["doc_1", "doc_2"];
  assert.deepEqual(clampDocIds(["doc_1", "doc_9"], allowed), ["doc_1"]);
  assert.deepEqual(clampDocIds(undefined, allowed), allowed);
  assert.deepEqual(clampDocIds(["doc_9"], allowed), []);
});

test("formatPagesForModel 超长时截断并提示可读续页", () => {
  const long = "字".repeat(50000);
  const out = formatPagesForModel([{ docId: "d", pageIndex: 3, title: "甲章", content: long }], 1000);
  assert.ok(out.includes("甲章"));
  assert.ok(out.includes("已截断"));
  assert.ok(out.length < long.length);
});

test("formatPagesForModel 截断不切坏落在切点上的 emoji 代理对", () => {
  // 构造：10 个 CJK 字 + 1 个 emoji（代理对）+ 20 个 CJK 字，maxTokens=11 时
  // 按字符比例算出的切点恰好落在 emoji 的高位代理之后、低位代理之前（验证脚本已确认，
  // 未修前 body.slice(0, 11) 结果末尾是裸的 \uD83D，经 UTF-8 序列化会变 U+FFFD 乱码）。
  const content = "字".repeat(10) + "\u{1F600}" + "字".repeat(20);
  const out = formatPagesForModel([{ docId: "d", pageIndex: 1, title: "章", content }], 11);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "不应含孤立的高位代理");
});
