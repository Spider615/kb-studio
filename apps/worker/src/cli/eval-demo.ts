import "dotenv/config";
import { readFileSync } from "node:fs";
import { makeLlm, OpenAICompatEmbedder, Reranker302 } from "@kb/adapters";
import { clearAll } from "@kb/db";
import { ingestDoc, retrieve, evaluateCoverage, type EvalCase } from "@kb/pipeline";

// R-4 检索质量评测（coverage@K）：通用工装。
// 用法：npm run eval-demo            → 内置小样例（入库一张价目表 + 几条用例）
//       npm run eval-demo -- cases.json  → 对「现有库」跑用例文件（[{query, mustInclude[], docIds?}]）

const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});
const reranker = new Reranker302();

const casesPath = process.argv[2];
let cases: EvalCase[];
if (casesPath) {
  cases = JSON.parse(readFileSync(casesPath, "utf-8"));
  console.error(`→ 载入 ${cases.length} 条用例，对现有库检索评测…`);
} else {
  const llm = makeLlm();
  const md = `# 产品价目

| 型号 | 名称 | 出厂价 |
| --- | --- | --- |
| GSP-9050MBE | 隔水式培养箱 | 4980 |
| GSP-9080MBE | 隔水式培养箱 | 5480 |
| IMJ-54A | 高压灭菌锅 | 48833 |
`;
  await clearAll();
  console.error("→ 入库 demo 文档…");
  await ingestDoc(
    { docId: "doc_eval", title: "产品价目.csv", source: "eval-demo", markdown: md },
    { llm, embedder },
    { tableRowChunks: true },
  );
  cases = [
    { query: "GSP-9050MBE 多少钱", mustInclude: ["GSP-9050MBE", "4980"] },
    { query: "高压灭菌锅 IMJ-54A 价格", mustInclude: ["IMJ-54A", "48833"] },
    { query: "隔水式培养箱都有哪些型号", mustInclude: ["GSP-9050MBE", "GSP-9080MBE"] },
  ];
}

console.error("→ 逐用例检索 + 覆盖检查…");
const rep = await evaluateCoverage(cases, (q, docIds) =>
  retrieve(q, { embedder, reranker }, { topK: 5, docIds }).then((hits) => hits.map((h) => ({ content: h.content }))),
);

console.log(
  `\ncoverage@K = ${(rep.coverageAtK * 100).toFixed(1)}%  (${rep.passed}/${rep.total})   spanCoverage = ${(rep.spanCoverage * 100).toFixed(1)}%\n`,
);
for (const r of rep.results) {
  console.log(`  ${r.passed ? "✓" : "✗"} ${r.query}${r.missing.length ? `   缺片段: ${r.missing.join(" / ")}` : ""}`);
}
