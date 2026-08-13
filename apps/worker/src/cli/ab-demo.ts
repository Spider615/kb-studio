// 无需登录态，验证 A/B 两栏端到端链路：npm run ab-demo -- "问题" [docId1,docId2,...]
// 依赖构造方式与 apps/web/app/api/ab/route.ts 完全一致（同一 AB_MODEL、同一 LlmClient 构造法、
// 同一 embedder 构造法），保证这里验证过的链路就是 /ab 页面真正会跑的链路。
// 不写 ab_runs 表——这是调试工具，不污染实验数据。
import "dotenv/config";
import { chatTurn, agentSearch, safeTruncateUtf16 } from "@kb/pipeline";
import { LlmClient, OpenAICompatEmbedder, Reranker302 } from "@kb/adapters";
import { listWikiReadyDocIds } from "@kb/db";

const query = process.argv[2];
if (!query) {
  console.error('用法：npm run ab-demo -- "问题" [docId1,docId2,...]');
  console.error("  不传 docId 时默认使用全部已 wiki 化（wiki_status=ready）的文档");
  process.exit(1);
}

// ⚠️ 与 route.ts 同理：KB_MODEL_ANSWER 是两个 LLM 后端（302/方舟）共用的变量，真实 .env 里
// 它是豆包模型名，不能直接拿来打 302 的 Anthropic /v1/messages 端点——必须显式指定模型。
const AB_MODEL = process.env.KB_MODEL_AB ?? "claude-opus-4-8";
const llm = new LlmClient({ answerModel: AB_MODEL });
// embedder 构造与 apps/web/lib/kb.ts 的 getDeps() 完全一致（bge-m3 1024 维，走 302）
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL ?? "https://api.302.ai/v1",
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL ?? "BAAI/bge-m3",
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});
const reranker = new Reranker302();

const explicitDocIds = process.argv[3]
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const docIds = explicitDocIds?.length ? explicitDocIds : await listWikiReadyDocIds();
if (docIds.length === 0) {
  console.error("没有可用文档：请先用 wiki-demo 给至少一篇文档生成 wiki，或显式传 docId");
  process.exit(1);
}
console.log(`模型：${AB_MODEL}`);
console.log(`docIds（${docIds.length} 篇）：${docIds.join(", ")}`);
console.log(`问题：${query}\n`);

const runA = async () => {
  const t0 = Date.now();
  const r = await chatTurn([], query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docIds });
  return {
    answer: r.answer,
    hits: r.hits.length,
    ms: Date.now() - t0,
    tokens: (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
  };
};

const runB = async () => {
  const t0 = Date.now();
  const r = await agentSearch(query, { llm: llm as any, embedder, docIds }, { maxTurns: 12, model: AB_MODEL });
  return {
    answer: r.answer,
    trace: r.trace,
    turnsUsed: r.turnsUsed,
    truncated: r.truncated,
    ms: Date.now() - t0,
    tokens: r.tokens.input + r.tokens.output,
  };
};

const [ra, rb] = await Promise.allSettled([runA(), runB()]);

console.log("==================== A 栏（chatTurn，现状生产链路）====================");
if (ra.status === "fulfilled") {
  const a = ra.value;
  console.log(`耗时：${a.ms}ms　token：${a.tokens}　命中片段：${a.hits}`);
  console.log(`答案：\n${a.answer}\n`);
} else {
  console.log(`❌ 失败：${safeTruncateUtf16(String((ra.reason as any)?.message ?? ra.reason), 2000)}\n`);
}

console.log("==================== B 栏（agentSearch，agentic 检索）====================");
if (rb.status === "fulfilled") {
  const b = rb.value;
  console.log(
    `耗时：${b.ms}ms　token：${b.tokens}　轮次：${b.turnsUsed}${b.truncated ? "（已截断）" : ""}`,
  );
  console.log(`工具轨迹（${b.trace.length} 步）：`);
  if (b.trace.length === 0) {
    console.log("  (空 — 模型零工具调用直接作答)");
  } else {
    for (const step of b.trace) {
      console.log(`  ${step.step}. ${step.tool}(${JSON.stringify(step.args)}) [${step.ms}ms]`);
      console.log(`     → ${step.resultSummary}`);
    }
  }
  console.log(`\n答案：\n${b.answer}\n`);
} else {
  console.log(`❌ 失败：${safeTruncateUtf16(String((rb.reason as any)?.message ?? rb.reason), 2000)}\n`);
}

process.exit(0);
