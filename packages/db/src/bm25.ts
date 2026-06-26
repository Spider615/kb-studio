import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict";

const jieba = Jieba.withDict(dict);

/** 中文分词 → 空格连接，喂给 Postgres 的 to_tsvector('simple', …) 做 BM25/关键词检索。 */
export function tokenizeZh(text: string): string {
  return jieba
    .cut(text, false)
    .map((t: string) => t.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

/** 把分词结果拼成 to_tsquery 的 OR 查询（单引号包裹防特殊字符）。 */
export function toTsQuery(text: string): string {
  const tokens = tokenizeZh(text).split(" ").filter(Boolean);
  return tokens.map((t) => `'${t.replace(/'/g, "''")}'`).join(" | ");
}
