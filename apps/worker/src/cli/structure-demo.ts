import "dotenv/config";
import { makeLlm } from "@kb/adapters";
import { chunkMarkdown } from "@kb/core";

// 验证「造结构 + chunker」端到端：无标题的分段文本 → LLM 插标题 → 切片。
// 注意必须是**多个自然段**（\n\n 分隔）：structure() 按空行切块，只有 1 块时会直接早退
// 不调模型（原先这里是一整段无换行文本，等于空转，造结构从未真正被验证过）。
const raw = [
  "本平台是一个面向中小商家的在线开店工具，提供商品管理、订单处理和营销活动等功能。",
  "商家注册后即可快速搭建自己的店铺，无需任何技术背景，平台提供多套模板可直接套用。",
  "关于退款，用户在购买实物商品后七日内可以申请退款，虚拟商品一经售出原则上不支持退款。",
  "退款审核通常在三个工作日内完成，审核通过后款项原路退回到原支付账户。",
  "在隐私方面，我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据。",
  "用户有权随时查询、更正或删除自己的个人信息，相关请求会在十五日内处理完毕。",
].join("\n\n");

const llm = makeLlm();

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
