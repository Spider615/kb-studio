import "dotenv/config";
import { LlmClient, OpenAICompatEmbedder, Reranker302 } from "@kb/adapters";
import { clearAll } from "@kb/db";
import { ingestDoc, retrieve } from "@kb/pipeline";

// ⑤ 全链路：入库 → 混合检索 + Reranker → Opus Citations 问答（带溯源）。
const md = `# 用户服务协议

## 平台简介

本平台面向中小商家提供在线开店工具，包含商品管理、订单处理与营销活动。

## 退款政策

退款申请需在购买后 7 日内提交，逾期视为自动放弃。虚拟商品一经售出原则上不支持退款。退款审核通常在三个工作日内完成，通过后款项原路退回到原支付账户。

## 隐私保护

我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据。

## 联系方式

客服热线 400-820-1234；投诉工单编号格式 KF-2024-XXXX，处理时限 5 个工作日。
`;

const llm = new LlmClient();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});
const reranker = new Reranker302();

await clearAll();
console.error("→ 入库…");
await ingestDoc({ docId: "doc_a", title: "用户服务协议", source: "answer-demo", markdown: md }, { llm, embedder });

const query = "退款审核要几个工作日，钱会退到哪里？";
console.error("→ 检索（混合 + rerank）…");
const top = await retrieve(query, { embedder, reranker }, { topK: 3, poolN: 8 });
console.log("检索 top: " + top.map((t) => `${t.heading_path.at(-1)}(${t.score.toFixed(3)})`).join("  ·  "));

console.error("→ Opus 引用问答…");
const { answer, sources } = await llm.answer(
  query,
  top.map((t) => ({ id: t.id, content: t.content, heading_path: t.heading_path })),
);

console.log("\n【回答】\n" + answer);
console.log("\n【溯源】" + (sources.map((s) => s.heading_path.join(" > ")).join("  |  ") || "(无 citations —— 可能 302 未透传 Citations)"));
process.exit(answer.length > 5 ? 0 : 1);
