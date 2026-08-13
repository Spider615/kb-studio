import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "./paginator";

test("按出现最多的标题层级切页，前言并入第一页", () => {
  const md = [
    "# 管理制度",
    "本制度自发布之日起施行。",
    "## 第一章 总则",
    "第一条 适用范围如下。",
    "## 第二章 承保规则",
    "第二条 核保权限如下。",
    "## 第三章 免责条款",
    "第三条 下列情形不承担责任。",
  ].join("\n");

  const pages = paginate(md, { minPageTokens: 0 });

  assert.equal(pages.length, 3);
  assert.equal(pages[0]!.title, "第一章 总则");
  assert.equal(pages[0]!.pageIndex, 1);
  // 前言（H1 标题 + 施行说明）并入第一页，不单独成页
  assert.ok(pages[0]!.content.includes("本制度自发布之日起施行"));
  assert.ok(pages[0]!.content.includes("第一条 适用范围如下"));
  assert.equal(pages[2]!.title, "第三章 免责条款");
  assert.deepEqual(pages[2]!.headingPath, ["管理制度", "第三章 免责条款"]);
});

test("无标题文档整篇一页", () => {
  const md = "这是一段没有任何标题的说明文字。\n\n第二段。";
  const pages = paginate(md);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.title, "全文");
  assert.deepEqual(pages[0]!.headingPath, []);
});

test("过短的页并入相邻页，不产生碎页", () => {
  const long = "详细内容。".repeat(400); // 远超 minPageTokens
  const md = ["## A", "短。", "## B", long, "## C", "也短。"].join("\n");
  const pages = paginate(md, { minPageTokens: 300 });
  // A 太短 → 并入 B；C 太短 → 并入前一页
  assert.equal(pages.length, 1);
  assert.ok(pages[0]!.content.includes("短。"));
  assert.ok(pages[0]!.content.includes("也短。"));
});

test("代码块里的 # 不被当成标题", () => {
  const md = ["## 真标题", "```bash", "# 这是注释不是标题", "echo hi", "```", "## 另一个真标题", "正文"].join("\n");
  const pages = paginate(md, { minPageTokens: 0 });
  assert.equal(pages.length, 2);
  assert.equal(pages[1]!.title, "另一个真标题");
});

test("超长章节按次级标题再切，续页标 continued", () => {
  const filler = "内容。".repeat(1200); // 单段就超 maxPageTokens
  const md = ["## 大章", "### 小节一", filler, "### 小节二", filler, "## 小章", "短正文。"].join("\n");
  const pages = paginate(md, { maxPageTokens: 800, minPageTokens: 0 });
  // 大章被拆成至少两页，第二页起标 continued
  const fromBig = pages.filter((p) => p.title.startsWith("大章"));
  assert.ok(fromBig.length >= 2);
  assert.equal(fromBig[0]!.continued, undefined);
  assert.equal(fromBig[1]!.continued, true);
  assert.ok(fromBig[1]!.title.includes("续"));
});

test("超长表格按行分页且每页重复表头", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| R${i} | 型号${i} | ${i * 10} |`);
  const md = ["## 价格表", "| 区域 | 型号 | 价格 |", "| --- | --- | --- |", ...rows].join("\n");
  const pages = paginate(md, { maxPageTokens: 500, minPageTokens: 0 });
  assert.ok(pages.length >= 2);
  for (const p of pages) {
    assert.ok(p.content.includes("| 区域 | 型号 | 价格 |"), "每页都要带表头");
    assert.ok(p.content.includes("| --- | --- | --- |"), "每页都要带分隔行");
  }
  // 全部数据行都在，一行不丢
  const all = pages.map((p) => p.content).join("\n");
  for (let i = 0; i < 300; i++) assert.ok(all.includes(`| R${i} |`), `第 ${i} 行丢了`);
});
