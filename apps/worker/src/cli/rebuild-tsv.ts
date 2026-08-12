import "dotenv/config";
import { rebuildTsvText } from "@kb/db";
import { customJiebaWords, tokenizeZh } from "../../../../packages/db/src/bm25";

/**
 * 用当前分词规则重建全部 chunk 的 BM25 索引（tsv_text）。
 * 改 KB_JIEBA_WORDS 之后必须跑，否则查询用新分词、索引是旧分词，关键词检索会全线失灵。
 * 用法：npm run rebuild-tsv
 */
const words = customJiebaWords();
console.log(`自定义词典（KB_JIEBA_WORDS）：${words.length ? words.join("、") : "(未配置)"}`);
if (words.length) {
  const sample = words[0]!;
  console.log(`分词自检：「${sample}产品」→ ${tokenizeZh(sample + "产品").split(" ").join(" / ")}`);
}

const t = Date.now();
const n = await rebuildTsvText((done, total) => {
  process.stderr.write(`\r重建中 ${done}/${total}`);
});
process.stderr.write("\n");
console.log(`✅ 重建完成：${n} 条 chunk，用时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
process.exit(0);
