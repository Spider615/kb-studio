import test from "node:test";
import assert from "node:assert/strict";
import { bm25Score, idf, type CorpusStats } from "./bm25-score";

/** 造一份语料统计：N 篇文档，指定各词的 DF 与平均长度。 */
const stats = (N: number, avgdl: number, df: Record<string, number>): CorpusStats => ({
  N,
  avgdl,
  df: new Map(Object.entries(df)),
});

test("IDF：词越罕见权重越高", () => {
  const N = 1000;
  const rare = idf(N, 2); // 只出现在 2 篇里
  const common = idf(N, 900); // 900 篇都有
  assert.ok(rare > common, `罕见词应更值钱: ${rare} vs ${common}`);
});

test("IDF：词几乎人人都有时趋近 0，且**不会变负**", () => {
  // 负 IDF 会让「命中烂大街的词」反而扣分，导致排序诡异翻转
  const v = idf(1000, 1000);
  assert.ok(v >= 0, `IDF 不应为负: ${v}`);
  assert.ok(v < 0.1, `应趋近 0: ${v}`);
});

test("核心场景：泛词高频 输不过 罕见词命中（这正是换掉 ts_rank_cd 的原因）", () => {
  // 语料 1000 篇；「产品」900 篇都有（泛词），「葡萄牙」只有 3 篇（关键词）
  const s = stats(1000, 100, { 产品: 900, 葡萄牙: 3 });
  const query = ["产品", "葡萄牙"];

  // A：把「产品」堆了 10 次，但完全没提葡萄牙
  const docA = [...Array(10).fill("产品"), ...Array(90).fill("其他")];
  // B：只提了 1 次葡萄牙
  const docB = [...Array(99).fill("其他"), "葡萄牙"];

  const a = bm25Score(query, docA, s);
  const b = bm25Score(query, docB, s);
  assert.ok(b > a, `罕见词命中 1 次应胜过泛词堆 10 次: B=${b} vs A=${a}`);
});

test("词频饱和：第 10 次出现的边际贡献远小于第 1 次", () => {
  const s = stats(1000, 100, { 甲: 10 });
  const one = bm25Score(["甲"], ["甲", ...Array(99).fill("x")], s);
  const ten = bm25Score(["甲"], [...Array(10).fill("甲"), ...Array(90).fill("x")], s);
  assert.ok(ten > one, "更多次数仍应更高");
  assert.ok(ten < one * 10, `应饱和而非线性: ${ten} 不该接近 ${one * 10}`);
});

test("长度归一化：同样命中 1 次，短文档得分更高", () => {
  const s = stats(1000, 100, { 甲: 10 });
  const short = bm25Score(["甲"], ["甲", ...Array(9).fill("x")], s); // 长度 10
  const long = bm25Score(["甲"], ["甲", ...Array(299).fill("x")], s); // 长度 300
  assert.ok(short > long, `短文档应占优: ${short} vs ${long}`);
});

test("未命中的查询词不贡献分数；空文档为 0", () => {
  const s = stats(100, 50, { 甲: 5, 乙: 5 });
  assert.equal(bm25Score(["乙"], ["甲", "甲"], s), 0);
  assert.equal(bm25Score(["甲"], [], s), 0);
});

test("查询词重复不重复计分", () => {
  const s = stats(100, 50, { 甲: 5 });
  const once = bm25Score(["甲"], ["甲", "x"], s);
  const twice = bm25Score(["甲", "甲"], ["甲", "x"], s);
  assert.equal(once, twice);
});

test("avgdl 为 0 时不产生 NaN/除零", () => {
  const v = bm25Score(["甲"], ["甲"], stats(1, 0, { 甲: 1 }));
  assert.ok(Number.isFinite(v), `应为有限值: ${v}`);
});
