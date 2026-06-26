import "dotenv/config";
import { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import { clearAll, vectorSearch, keywordSearch, hybridSearch } from "@kb/db";
import { ingestDoc } from "@kb/pipeline";

// 对比 向量 / 关键词(BM25) / 混合(RRF) 三种检索。
const md = `# 用户服务协议

## 平台简介

本平台面向中小商家提供在线开店工具，包含商品管理、订单处理与营销活动，注册即可搭建店铺。

## 退款政策

退款申请需在购买后 7 日内提交，逾期视为自动放弃。虚拟商品一经售出原则上不支持退款。退款审核通常在三个工作日内完成，通过后款项原路退回到原支付账户。

## 隐私保护

我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据，用户可随时查询、更正或删除个人信息。

## 联系方式

如有疑问请联系客服热线 400-820-1234；投诉工单编号格式为 KF-2024-XXXX，工单处理时限为 5 个工作日。
`;

const llm = new LlmClient();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});

await clearAll();
console.error("→ 入库…");
const n = await ingestDoc({ docId: "doc_s", title: "用户服务协议", source: "search-demo", markdown: md }, { llm, embedder });
console.log(`入库 ${n} 个 chunk\n`);

const last = (h: { heading_path: string[] }) => h.heading_path.at(-1) ?? "(根)";
const fmt = (hits: { heading_path: string[] }[]) => hits.map(last).join("  ·  ") || "(空)";

async function show(label: string, query: string) {
  const [qv] = await embedder.embed([query]);
  const [v, k, h] = await Promise.all([vectorSearch(qv!, 3), keywordSearch(query, 3), hybridSearch(query, qv!, 3)]);
  console.log(`【${label}】「${query}」`);
  console.log(`  向量    : ${fmt(v)}`);
  console.log(`  关键词  : ${fmt(k)}`);
  console.log(`  混合RRF : ${fmt(h)}\n`);
  return h;
}

await show("语义类", "退款多久能到账，钱退到哪里");
const h2 = await show("编号/关键词类", "KF-2024 工单编号怎么查，处理要几天");

const ok = h2[0] !== undefined && h2[0].heading_path.some((x) => x.includes("联系"));
console.log(ok ? "✅ 混合检索跑通（编号类问题命中『联系方式』节，关键词补了向量的短板）" : "⚠️ 看上面三种对比");
process.exit(0);
