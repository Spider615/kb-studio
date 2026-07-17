import type { SearchHit } from "@kb/db";

/**
 * 检索质量评测（coverage@K）：通用、领域无关。
 * 用户给一组 {query, mustInclude} 用例，逐用例跑检索，检查每个「答案定位片段」是否出现在某个命中里。
 * 单事实问题 ≈「答案行被检索到」；多事实/比较问题 ≈「涉及的各片段都被检索到」。
 */
export interface EvalCase {
  query: string;
  mustInclude: string[]; // 答案定位片段（逐字取自原文）；全部被某命中覆盖才算通过
  docIds?: string[] | null; // 限定检索范围（可选）
  note?: string;
}

export interface CaseResult {
  query: string;
  passed: boolean;
  missing: string[]; // 未被任何命中覆盖的片段
  hitCount: number;
  note?: string;
}

export interface EvalReport {
  total: number;
  passed: number;
  coverageAtK: number; // 通过用例数 / 总用例数（主口径）
  spanCoverage: number; // 命中片段数 / 总片段数（更细粒度）
  results: CaseResult[];
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/**
 * 覆盖检查：每个 mustInclude 片段是否作为子串出现在某个命中内容里（空白无关、大小写无关）。
 * 空白无关是为了容忍切片/渲染的空格差异（如跨单元格的 "型号 价格"）。
 */
export function checkCoverage(mustInclude: string[], hitContents: string[]): { passed: boolean; missing: string[] } {
  const hays = hitContents.map(norm);
  const missing = mustInclude.filter((span) => {
    const n = norm(span);
    return n.length > 0 && !hays.some((h) => h.includes(n));
  });
  return { passed: missing.length === 0, missing };
}

/** 注入式检索函数：给 query（+可选 docIds）返回命中内容。生产传 retrieve 包装，测试传假实现。 */
export type RetrieveForEval = (query: string, docIds?: string[] | null) => Promise<Pick<SearchHit, "content">[]>;

/** 对一组用例跑 coverage@K 评测：逐用例检索 → 覆盖检查 → 汇总。 */
export async function evaluateCoverage(cases: EvalCase[], retrieveFn: RetrieveForEval): Promise<EvalReport> {
  const results: CaseResult[] = [];
  let spanTotal = 0;
  let spanHit = 0;
  for (const c of cases) {
    const hits = await retrieveFn(c.query, c.docIds);
    const { passed, missing } = checkCoverage(c.mustInclude, hits.map((h) => h.content));
    spanTotal += c.mustInclude.length;
    spanHit += c.mustInclude.length - missing.length;
    results.push({ query: c.query, passed, missing, hitCount: hits.length, note: c.note });
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    total: cases.length,
    passed,
    coverageAtK: cases.length ? passed / cases.length : 0,
    spanCoverage: spanTotal ? spanHit / spanTotal : 0,
    results,
  };
}
