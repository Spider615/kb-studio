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
