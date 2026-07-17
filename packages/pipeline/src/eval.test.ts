import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCoverage, evaluateCoverage, type EvalCase } from "./eval";

test("checkCoverage：全部片段被某命中覆盖 → 通过", () => {
  const r = checkCoverage(["GSP-9050MBE", "4980"], ["...型号 GSP-9050MBE 出厂价 4980 元..."]);
  assert.equal(r.passed, true);
  assert.deepEqual(r.missing, []);
});

test("checkCoverage：连续片段仅空白/大小写差异也算命中", () => {
  // 片段是连续 verbatim 单元；只容忍源里的空白/大小写差异（跨了别的词则不算，需拆成多片段）
  const r = checkCoverage(["Model GSP-9050MBE"], ["规格 model\nGSP-9050MBE 隔水式"]);
  assert.equal(r.passed, true);
});

test("checkCoverage：缺失片段被列出", () => {
  const r = checkCoverage(["A123", "B456"], ["只有 A123 在这"]);
  assert.equal(r.passed, false);
  assert.deepEqual(r.missing, ["B456"]);
});

test("checkCoverage：纯数字片段有边界，不被更长数字误命中", () => {
  assert.equal(checkCoverage(["4980"], ["价格 14980 元"]).passed, false); // 14980 不算命中 4980
  assert.equal(checkCoverage(["4980"], ["价格 4980 元"]).passed, true);
});

test("checkCoverage：片段可分散在不同命中里", () => {
  const r = checkCoverage(["产品A", "价格9"], ["...产品A...", "...价格9..."]);
  assert.equal(r.passed, true);
});

test("evaluateCoverage：汇总 coverage@K 与 spanCoverage", async () => {
  const cases: EvalCase[] = [
    { query: "q1", mustInclude: ["a", "b"] }, // 全中
    { query: "q2", mustInclude: ["c", "d"] }, // 半中
  ];
  const fake = async (q: string) =>
    q === "q1" ? [{ content: "a and b" }] : [{ content: "only c here" }];
  const rep = await evaluateCoverage(cases, fake);
  assert.equal(rep.total, 2);
  assert.equal(rep.passed, 1); // 只有 q1 全中
  assert.equal(rep.coverageAtK, 0.5);
  assert.equal(rep.spanCoverage, 0.75); // 4 片段中命中 3（a,b,c）
  assert.deepEqual(rep.results[1]!.missing, ["d"]);
});
