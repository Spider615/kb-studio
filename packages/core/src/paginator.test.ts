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

test("Critical 1: 表格前有说明文字时不超预算", () => {
  const head = "这是表格的说明文字。".repeat(50); // 相对较大的前置说明
  const rows = Array.from({ length: 20 }, (_, i) => `| R${i} | ${i} |`);
  const md = ["## 数据表", head, "| 区域 | 数值 |", "| --- | --- |", ...rows].join("\n");
  const pages = paginate(md, { maxPageTokens: 150, minPageTokens: 0 });
  // 每页 token 数应该接近或略超 150，不能严重超预算
  for (const p of pages) {
    assert.ok(p.tokenEstimate <= 200, `页面 "${p.title}" 过度超预算：${p.tokenEstimate} > 200`);
  }
});

test("Critical 2: 超长单段落无空行时能被硬切", () => {
  // 单个超长段落，中间无空行分隔
  const longPara = "内容点。".repeat(500); // 单一段落，必然超预算
  const md = ["## 章节", longPara].join("\n");
  const pages = paginate(md, { maxPageTokens: 300, minPageTokens: 0 });
  // 应该能切成多页，不是直接原样返回 1 页
  assert.ok(pages.length > 1, "单段落超预算应被硬切，不能原样返回");
  // 每页都应该尽量接近预算上限
  for (const p of pages) {
    assert.ok(p.tokenEstimate <= 400, `页 "${p.title}" 过度超预算：${p.tokenEstimate} > 400`);
  }
});

test("Critical 2: 次级标题分支超预算的子页应被递归处理", () => {
  // 一个大章节，包含多个小节，其中某个小节自身就超预算
  const subLong = "小节内容。".repeat(500); // 单个小节就很长
  const md = [
    "## 大章",
    "### 小节 A",
    subLong,
    "### 小节 B",
    "短内容。",
  ].join("\n");
  const pages = paginate(md, { maxPageTokens: 500, minPageTokens: 0 });
  // 超长小节应被进一步切分，不能存在超预算页
  for (const p of pages) {
    assert.ok(p.tokenEstimate <= 700, `页 "${p.title}" 未能被递归处理，超预算：${p.tokenEstimate} > 700`);
  }
});

test("Important 3: 合并短页时取体量更大的标题", () => {
  // A 页很短，B 页很长，合并后应取 B 的标题
  const long = "长内容。".repeat(400);
  const md = ["## 短标题", "很短。", "## 长标题", long].join("\n");
  const pages = paginate(md, { minPageTokens: 300 });
  // 两个页面中，短页应该被并入长页；最终只有 1 页，标题应该是长页的
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.title, "长标题", "合并后应取体量更大的标题");
});

test("Critical 1: head 接近但未超预算时仍不应退化 budget", () => {
  // head 接近但未超过 maxPageTokens，但 head + header + 一行数据 = 超预算
  // 这种情况应该把 head 单独成页，而不是让 budget 退化到 1
  const head = "这是表格说明。".repeat(40); // 约 120 token，接近但未超 150
  const rows = Array.from({ length: 30 }, (_, i) => `| 数据${i} | ${i} |`);
  const md = ["## 表", head, "| 项目 | 值 |", "| --- | --- |", ...rows].join("\n");
  const pages = paginate(md, { maxPageTokens: 150, minPageTokens: 0 });
  // head 接近上限时，budget 被扣完、退化到 1，会切成 30 页
  // 修复后应该能切成较少的页数（head 单独一页），且每页合理
  assert.ok(pages.length < 20, `页数过多（${pages.length} > 20），说明 budget 仍退化`);
  for (const p of pages) {
    assert.ok(p.tokenEstimate <= 200, `页 "${p.title}" 超预算：${p.tokenEstimate} > 200`);
  }
});

test("Critical 2: 纯中文无标点无空行的硬切按正确 token 比例", () => {
  // 单个超长纯中文段落，无标点无空行，约 360 个字符 = 360 token（中文 1 字 1 token）
  // 之前用 chunkSize = maxPageTokens * 4 会得出 chunkSize = 100 * 4 = 400
  // 导致单次迭代就分到 400+ 字符、仅切 1 页，完全没切
  const longText = "这是一段很长的中文文本而且中间没有任何标点符号也没有空行".repeat(30);
  const md = ["## 长文", longText].join("\n");
  const pages = paginate(md, { maxPageTokens: 100, minPageTokens: 0 });
  assert.ok(pages.length > 1, `应该被切成多页，实际 ${pages.length} 页（硬切失效）`);
  // 每页都应该尊重预算（允许少量超标因为词的间隔不完美）
  for (const p of pages) {
    assert.ok(p.tokenEstimate <= 150, `页超预算：${p.tokenEstimate} > 150`);
  }
});

test("Critical 2/3: 硬切不会破坏 emoji 和 UTF-16 代理对", () => {
  // 含 emoji 的长文本，硬切后每页拼接应等于原文
  const emojiText = "工作中遇到困难😢需要调整策略🎯可以参考文档📄".repeat(50);
  const md = ["## 文本", emojiText].join("\n");
  const pages = paginate(md, { maxPageTokens: 200, minPageTokens: 0 });
  assert.ok(pages.length > 1, "含 emoji 的长文本应被切分");
  // 拼接后应与原文内容一致（排除标题和换行）
  const originalContent = emojiText;
  const concatenated = pages.map((p) => p.content).join("").split("\n").slice(1).join(""); // 跳过第一行标题
  assert.ok(concatenated.includes(originalContent), "切分后拼接不等于原文，可能代理对被切坏");
});

test("Critical 4: 递归多层后标题编号不撞车", () => {
  // 构造需要多层递归的输入：
  // 大章包含多个小节，其中某个小节超长需要再切
  const shortSub = "短小节。";
  const longSub = "长内容。".repeat(800); // 需要多层递归
  const md = [
    "## 大章 A",
    "### 小节 A1",
    shortSub,
    "### 小节 A2",
    longSub,
    "### 小节 A3",
    shortSub,
    "## 大章 B",
    shortSub,
  ].join("\n");
  const pages = paginate(md, { maxPageTokens: 500, minPageTokens: 0 });
  // 统计所有页的标题
  const titles = pages.map((p) => p.title);
  const titleCounts = new Map<string, number>();
  for (const t of titles) {
    titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
  }
  // 如果有重复标题，说明递归编号撞车
  for (const [title, count] of titleCounts.entries()) {
    assert.equal(count, 1, `标题 "${title}" 出现了 ${count} 次，说明递归编号撞车`);
  }
});

test("Important: renumberPages 不与原文真实标题撞车", () => {
  // 原文里真实存在「附录（续1）」这个标题，
  // 同时「附录」章节由于超长被拆成多页，也会被合成出「附录（续1）」
  // 修复前：两个不同内容的页会有相同标题「附录（续1）」
  const md = [
    "## 附录（续1）",
    "这是真正的附录续篇内容。",
    "## 附录",
    "正文内容。".repeat(150), // 使其超预算，需要拆分
  ].join("\n");

  const pages = paginate(md, { maxPageTokens: 300, minPageTokens: 0 });

  // 所有页的标题应该全局唯一，无重复
  const titles = pages.map((p) => p.title);
  const uniqueTitles = new Set(titles);
  assert.equal(
    uniqueTitles.size,
    titles.length,
    `页面标题中存在重复：${JSON.stringify(titles)}`
  );

  // 原文「附录（续1）」的那一页内容应该仍是「这是真正的附录续篇内容。」
  const originalAppendixPage = pages.find((p) => p.title === "附录（续1）" && p.content.includes("这是真正的"));
  assert.ok(originalAppendixPage, "原文中真实的「附录（续1）」页应该存在");
  assert.equal(originalAppendixPage?.content.includes("这是真正的附录续篇内容。"), true, "原文标题页内容应该正确");
});
