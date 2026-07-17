import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "./chunker";

const table = `# sales
| region | product | units | revenue |
| --- | --- | --- | --- |
| APAC | Widget A | 120 | 3400 |
| APAC | Widget B | 90 | 2100 |
| APAC | Widget C | 45 | 1800 |
| EMEA | Widget A | 200 | 5600 |
| EMEA | Widget D | 30 | 900 |
| AMER | Widget A | 310 | 8800 |`;

test("表格模式：相邻行打包成多行 chunk（非一行一 chunk）", () => {
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: table }, { tableRowChunks: true, tableOverviewChunk: false });
  const rowChunks = cs.filter((c) => c.metadata.is_table_row);
  assert.ok(rowChunks.length >= 1 && rowChunks.length < 6, "应少于数据行数（打包）");
  // 同一 region 的行应落在同一个 chunk（分组列断开）
  const apac = rowChunks.find((c) => c.content.includes("Widget A") && c.content.includes("APAC"));
  assert.ok(apac && apac.content.includes("Widget B") && apac.content.includes("Widget C"), "APAC 三行应同块");
});

test("表格模式：生成通用概览 chunk（行列数 + 低基数列取值 + 数值区间）", () => {
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: table }, { tableRowChunks: true });
  const ov = cs.find((c) => c.content.includes("表格概览"));
  assert.ok(ov, "应有概览 chunk");
  assert.ok(ov!.content.includes("APAC") && ov!.content.includes("EMEA"), "低基数列 region 应列出取值");
  assert.ok(/30 ~ 310/.test(ov!.content), "数值列 units 应给区间");
});

test("表格模式：tableOverviewChunk=false 时不产概览", () => {
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: table }, { tableRowChunks: true, tableOverviewChunk: false });
  assert.ok(!cs.some((c) => c.content.includes("表格概览")));
});

test("非表格文档不受影响：标题层级 + 段落照常切", () => {
  const md = `# 标题\n\n## 小节\n\n这是一段正文内容。`;
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: md });
  assert.ok(cs.length >= 1);
  assert.ok(cs.some((c) => c.metadata.heading_path.includes("小节")));
  assert.ok(!cs.some((c) => c.metadata.is_table_row));
});

test("零领域假设：纯英文表、无中文也正常打包 + 概览", () => {
  const en = `# t\n| id | city | pop |\n| --- | --- | --- |\n| 1 | Tokyo | 37 |\n| 2 | Delhi | 32 |\n| 3 | Osaka | 19 |\n| 4 | Kyoto | 15 |`;
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: en }, { tableRowChunks: true });
  assert.ok(cs.some((c) => c.content.includes("表格概览"))); // 4 行 ≥ 概览门槛
  assert.ok(cs.some((c) => c.metadata.is_table_row && c.content.includes("Tokyo") && c.content.includes("Delhi")));
});

test("小表(<4行)不产概览噪声", () => {
  const small = `# t\n| k | v |\n| --- | --- |\n| a | 1 |\n| b | 2 |`;
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: small }, { tableRowChunks: true });
  assert.ok(!cs.some((c) => c.content.includes("表格概览")));
});

test("大表不崩：避免 Math.max(...大数组) 栈溢出", () => {
  const rows: string[] = [];
  for (let i = 0; i < 150000; i++) rows.push(`| A${i} | c${i % 5} | ${i} |`);
  const md = `# t\n| m | c | n |\n| --- | --- | --- |\n${rows.join("\n")}`;
  assert.doesNotThrow(() => chunkMarkdown({ docId: "d", docTitle: "t", markdown: md }, { tableRowChunks: true }));
});

test("含转义竖线的单元格不被切碎、行不丢失", () => {
  const md = `# t\n| m | note |\n| --- | --- |\n| A1 | x \\| y |\n| A2 | z |`;
  const cs = chunkMarkdown({ docId: "d", docTitle: "t", markdown: md }, { tableRowChunks: true, tableOverviewChunk: false });
  const body = cs.map((c) => c.content).join("\n");
  assert.ok(body.includes("A1") && body.includes("A2")); // 两行都在，未因错列丢数据
});
