import "dotenv/config";
import { makeLlm, OpenAICompatEmbedder, Reranker302 } from "@kb/adapters";
import { clearAll } from "@kb/db";
import { ingestDoc, chatTurn, type ChatMessage } from "@kb/pipeline";

// 多轮对话全链路：入库 → (改写→混合检索+rerank→带历史 Opus 作答) ×2 轮。
const md = `# 用户服务协议

## 退款政策

退款申请需在购买后 7 日内提交，逾期视为自动放弃。退款审核通常在三个工作日内完成，通过后款项原路退回到原支付账户。

## 隐私保护

我们仅收集为提供服务所必需的信息，不会向任何第三方出售用户数据。
`;

const llm = makeLlm();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});
const reranker = new Reranker302();

await clearAll();
console.error("→ 入库…");
await ingestDoc({ docId: "doc_a", title: "用户服务协议", source: "chat-demo", markdown: md }, { llm, embedder });

const history: ChatMessage[] = [];
async function ask(q: string) {
  const r = await chatTurn(history, q, { llm, embedder, reranker }, { topK: 3, poolN: 8 });
  history.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
  console.log(`\nQ: ${q}\n改写: ${r.standaloneQuery}\nA: ${r.answer}\n溯源: ${r.sources.map((s) => s.heading_path.join(" > ")).join(" | ") || "(无)"}`);
  return r;
}

const r1 = await ask("退款申请有时间限制吗？");
const r2 = await ask("那审核一般要几个工作日？"); // 追问：靠历史把"那"消解成退款审核
process.exit(r2.standaloneQuery.includes("退款") && r2.answer.includes("工作日") ? 0 : 1);
