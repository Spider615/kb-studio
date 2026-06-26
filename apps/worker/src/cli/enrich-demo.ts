import "dotenv/config";
import { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import { chunkMarkdown } from "@kb/core";

// 验证 ③ 的两步计算：上下文化（302，prompt caching）+ bge-m3 向量化。不依赖 DB。
const md = `# 用户服务协议

## 第五章 退款政策

退款申请需在购买后 7 日内提交，逾期视为自动放弃。虚拟商品一经售出原则上不支持退款。审核通常在三个工作日内完成，通过后款项原路退回。

## 第六章 隐私条款

我们仅收集为提供服务所必需的信息，不向第三方出售用户数据，用户可随时查询、更正或删除个人信息。
`;

const chunks = chunkMarkdown({ docId: "doc_e", docTitle: "用户服务协议", markdown: md });
const target = chunks.find((c) => c.metadata.heading_path.some((h) => h.includes("退款"))) ?? chunks[0]!;
console.log(`目标 chunk: ${target.id} | ${target.metadata.heading_path.join(" > ")}`);
console.log(`原文: "${target.content_original.replace(/\n+/g, " ").slice(0, 50)}…"\n`);

const llm = new LlmClient();
console.error("→ 上下文化（整份文档作可缓存前缀）…");
const prefix = await llm.contextualize(md, target.content_original);
console.log(`上下文前缀（${prefix.length} 字）: ${prefix}\n`);

const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});
const enriched = prefix ? `${prefix}\n${target.content_original}` : target.content_original;
console.error("→ embed bge-m3…");
const [vec] = await embedder.embed([enriched]);

console.log(`embedding 维度=${vec!.length}，前 3 维=[${vec!.slice(0, 3).map((x) => x.toFixed(4)).join(", ")}]`);
const ok = prefix.length >= 8 && vec!.length === 1024;
console.log("\n" + (ok ? "✅ 上下文化 + 向量化 跑通" : "❌ 有问题"));
process.exit(ok ? 0 : 1);
