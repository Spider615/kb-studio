import "dotenv/config";
import { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import { vectorSearch } from "@kb/db";
import { ingestDoc } from "@kb/pipeline";

// 端到端：入库一篇文档（chunk→上下文化→embed→存 pgvector）→ 向量检索。
const md = `# 用户服务协议

## 平台简介

本平台面向中小商家提供在线开店工具，包含商品管理、订单处理与营销活动，注册即可搭建店铺。

## 退款政策

退款申请需在购买后 7 日内提交，逾期视为自动放弃。虚拟商品一经售出原则上不支持退款。退款审核通常在三个工作日内完成，通过后款项原路退回到原支付账户。

## 隐私保护

我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据，用户可随时查询、更正或删除个人信息。
`;

const llm = new LlmClient();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});

console.error("→ 入库（上下文化 + 向量化 + 存库）…");
const n = await ingestDoc({ docId: "doc_kb", title: "用户服务协议", source: "ingest-demo", markdown: md }, { llm, embedder });
console.log(`✅ 入库 ${n} 个 chunk\n`);

const query = "退款多久能到账，钱退到哪里？";
console.error(`→ 检索「${query}」…`);
const [qvec] = await embedder.embed([query]);
const hits = await vectorSearch(qvec!, 3);

console.log(`检索结果（cosine 相似度）:`);
for (const h of hits) {
  console.log(`  ${h.score.toFixed(3)} | ${h.heading_path.join(" > ")}`);
  console.log(`        ${h.content.replace(/\n+/g, " ").slice(0, 60)}…`);
}

const top = hits[0];
const ok = hits.length > 0 && top!.heading_path.some((h) => h.includes("退款"));
console.log("\n" + (ok ? "✅ 入库 + 向量检索 跑通（退款问题命中退款节）" : "❌ 检索未命中预期"));
process.exit(ok ? 0 : 1);
