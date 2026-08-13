// 给已入库的文档补跑 wiki 化：npm run wiki-demo -- <docId>
// 默认走 makeLlm()（豆包，KB_LLM=claude 退回 302）。豆包没有 answerRaw，目录页会走
// buildWiki 内的确定性兜底（只有「序号. 标题」，没有一句话说明）；想验证真实 LLM 生成的
// 目录说明，跑之前设 KB_LLM=claude。
import "dotenv/config";
import { buildWiki } from "@kb/pipeline";
import { getDoc, getDocWithChunks, listWikiPages, setWikiStatus } from "@kb/db";
import { makeLlm } from "@kb/adapters";

const docId = process.argv[2];
if (!docId) {
  console.error("用法：npm run wiki-demo -- <docId>");
  process.exit(1);
}

const doc = await getDoc(docId);
if (!doc) {
  console.error(`找不到文档 ${docId}`);
  process.exit(1);
}

// 现状踩坑：ingestDoc 落库时只传 title/source/status，从未把解析出的 markdown 写回
// docs.raw_text / docs.structured_md（这两列在 schema 里存在，但写入路径缺失，可能是
// 更早期遗留的空实现）——所以存量文档这两列几乎必为空。退回用 chunks 按 chunk_index
// 拼回原文：content_original 本就含标题行（chunker 没有剥掉标题），拼接后 buildWiki
// 仍能正常分页；唯一代价是相邻文本 chunk 间 ~80 token 的 overlap 会在拼接处轻微重复
// （chunker 的 overlap 设计如此），对 wiki 页内容质量影响可忽略。
let markdown = doc.structuredMd ?? doc.rawText ?? "";
if (!markdown.trim()) {
  console.warn("[wiki-demo] docs.structured_md / raw_text 为空（存量文档的已知缺口），改从 chunks 按序拼回原文…");
  const withChunks = await getDocWithChunks(docId);
  markdown = (withChunks?.chunks ?? []).map((c) => c.contentOriginal).join("\n\n");
}
if (!markdown.trim()) {
  console.error("文档没有可用正文（structured_md / raw_text 为空，且该文档也没有 chunk）");
  process.exit(1);
}

await setWikiStatus(docId, "pending");
const llm = makeLlm();
const { pageCount } = await buildWiki(
  docId,
  markdown,
  { llm },
  { onProgress: (p) => console.log(`  ${p.stage} ${p.done}/${p.total}`) },
);
console.log(`\n✅ 生成 ${pageCount} 页（另加 1 页目录）`);

for (const p of await listWikiPages(docId)) {
  console.log(`  ${p.pageIndex}. ${p.title}（${p.tokenEstimate} token）`);
}
process.exit(0);
