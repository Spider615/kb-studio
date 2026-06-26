import "dotenv/config";
import { LlmClient } from "@kb/adapters";
import { chunkMarkdown } from "@kb/core";

// 验证「造结构 + chunker」端到端：一段无标题流水文本 → 302 LLM 插标题 → 切片。
const raw =
  "本平台是一个面向中小商家的在线开店工具，提供商品管理、订单处理和营销活动等功能，商家注册后即可快速搭建自己的店铺，无需任何技术背景。" +
  "关于退款，用户在购买实物商品后七日内可以申请退款，虚拟商品一经售出原则上不支持退款，退款审核通常在三个工作日内完成，审核通过后款项原路退回。" +
  "在隐私方面，我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据，用户有权随时查询、更正或删除自己的个人信息，相关请求会在十五日内处理完毕。";

const llm = new LlmClient();

console.error("→ 调 302 造结构…");
const structured = await llm.structure(raw);
console.log("=== 造结构后 ===\n");
console.log(structured);

const chunks = chunkMarkdown({ docId: "doc_struct", docTitle: "造结构 demo", markdown: structured });
console.log(`\n=== 切片：${chunks.length} 块 ===`);
for (const c of chunks) {
  console.log(`  ${c.id} [${c.chunk_type}] ~${c.token_estimate}tok | ${c.metadata.heading_path.join(" > ") || "(根)"}`);
}

const headingCount = (structured.match(/^#{2,3}\s/gm) ?? []).length;
const ok = headingCount >= 2 && chunks.length >= 2 && structured.includes("退款");
console.log(`\n断言: 插入标题数=${headingCount} chunk数=${chunks.length} 原文保留=${structured.includes("退款")}`);
console.log(ok ? "✅ 造结构 + 切片 跑通" : "❌ 有问题");
process.exit(ok ? 0 : 1);
