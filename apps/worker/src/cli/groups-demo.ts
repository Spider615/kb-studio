import "dotenv/config";
import { randomUUID } from "node:crypto";
import { LlmClient, OpenAICompatEmbedder } from "@kb/adapters";
import {
  clearAll,
  createGroup,
  setDocGroup,
  listDocIdsInGroup,
  listGroups,
  deleteGroup,
  listDocs,
} from "@kb/db";
import { ingestDoc, retrieve } from "@kb/pipeline";

// 分组验证：入两篇文档，各归一组 → 按「组内 docId 列表」过滤检索，命中只来自该组；
// 再验证 listGroups 的 docCount、删组后文档回未分组。
const docA = `# 退款政策\n\n退款申请需在购买后 7 日内提交，审核通常三个工作日内完成，原路退回。`;
const docB = `# 配送说明\n\n标准快递 48 小时内发出，偏远地区可能延迟，支持顺丰到付。`;

const llm = new LlmClient();
const embedder = new OpenAICompatEmbedder({
  baseUrl: process.env.EMBED_BASE_URL!,
  apiKey: process.env.EMBED_API_KEY,
  model: process.env.EMBED_MODEL,
  dimensions: Number(process.env.EMBED_DIM ?? 1024),
});

await clearAll();
const gA = "grp_" + randomUUID().slice(0, 8);
const gB = "grp_" + randomUUID().slice(0, 8);
await createGroup({ id: gA, name: "售后组", color: "#C96442" });
await createGroup({ id: gB, name: "物流组" });

console.error("→ 入库两篇 + 归组…");
await ingestDoc({ docId: "doc_a", title: "退款政策", source: "groups-demo", markdown: docA }, { llm, embedder });
await ingestDoc({ docId: "doc_b", title: "配送说明", source: "groups-demo", markdown: docB }, { llm, embedder });
await setDocGroup("doc_a", gA, "demo");
await setDocGroup("doc_b", gB, "demo");

// 1) 组内 docId 列表正确
const idsA = await listDocIdsInGroup(gA);
const idsAOk = idsA.length === 1 && idsA[0] === "doc_a";

// 2) 按组过滤检索：命中只来自该组
const q = "多久能处理好？"; // 两篇都可能沾边
const inA = await retrieve(q, { embedder }, { topK: 5, docIds: await listDocIdsInGroup(gA) });
const inB = await retrieve(q, { embedder }, { topK: 5, docIds: await listDocIdsInGroup(gB) });
const aScopeOk = inA.length > 0 && inA.every((h) => h.id.startsWith("doc_a_"));
const bScopeOk = inB.length > 0 && inB.every((h) => h.id.startsWith("doc_b_"));

// 3) listGroups docCount
const gs = await listGroups();
const countOk = gs.find((g) => g.id === gA)?.docCount === 1 && gs.find((g) => g.id === gB)?.docCount === 1;

// 4) 删组 → 文档回未分组（group_id 置 null，文档仍在）
await deleteGroup(gA);
const docsAfter = await listDocs("demo");
const docA2 = docsAfter.find((d) => d.id === "doc_a");
const setNullOk = !!docA2 && docA2.groupId === null;

console.log(`组内 docId 列表        [${idsAOk}]  ${idsA.join(",")}`);
console.log(`组A 范围检索仅 doc_a   [${aScopeOk}]  ${inA.map((h) => h.id).join(",")}`);
console.log(`组B 范围检索仅 doc_b   [${bScopeOk}]  ${inB.map((h) => h.id).join(",")}`);
console.log(`listGroups docCount=1  [${countOk}]`);
console.log(`删组后 doc_a 回未分组  [${setNullOk}]`);
process.exit(idsAOk && aScopeOk && bScopeOk && countOk && setNullOk ? 0 : 1);
