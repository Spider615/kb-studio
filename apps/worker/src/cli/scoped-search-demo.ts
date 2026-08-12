import "dotenv/config";
import { makeLlm, OpenAICompatEmbedder } from "@kb/adapters";
import { clearAll } from "@kb/db";
import { ingestDoc, retrieve } from "@kb/pipeline";

// 范围检索验证：入两篇文档，按 docId 过滤检索 → 命中只来自指定文档。
const docX = `# 退款政策\n\n退款申请需在购买后 7 日内提交，审核通常三个工作日内完成，原路退回。`;
const docY = `# 配送说明\n\n标准快递 48 小时内发出，偏远地区可能延迟，支持顺丰到付。`;

const llm = makeLlm();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});

await clearAll();
console.error("→ 入库两篇…");
await ingestDoc({ docId: "doc_x", title: "退款政策", source: "scoped-demo", markdown: docX }, { llm, embedder });
await ingestDoc({ docId: "doc_y", title: "配送说明", source: "scoped-demo", markdown: docY }, { llm, embedder });

const q = "多久能处理好？"; // 两篇都可能沾边
const onlyX = await retrieve(q, { embedder }, { topK: 5, docIds: ["doc_x"] });
const onlyY = await retrieve(q, { embedder }, { topK: 5, docIds: ["doc_y"] });
const all = await retrieve(q, { embedder }, { topK: 5 });

const xOk = onlyX.length > 0 && onlyX.every((h) => h.id.startsWith("doc_x_"));
const yOk = onlyY.length > 0 && onlyY.every((h) => h.id.startsWith("doc_y_"));
console.log(`docId=doc_x → ${onlyX.map((h) => h.id).join(",")}  [仅 doc_x: ${xOk}]`);
console.log(`docId=doc_y → ${onlyY.map((h) => h.id).join(",")}  [仅 doc_y: ${yOk}]`);
console.log(`无过滤   → ${all.map((h) => h.id).join(",")}`);
process.exit(xOk && yOk ? 0 : 1);
