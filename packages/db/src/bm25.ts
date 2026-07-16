import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict";

const jieba = Jieba.withDict(dict);

/**
 * 抽「型号/编码」整段作为原子 token（小写）。
 * jieba 会把 `GSP-9050MBE`/`YDS-2-35` 切成 `gsp/-/9050/mbe`，公共碎片命中错行；
 * 追加整段编码作原子 token，让 BM25 能精确命中唯一型号行。
 * 匹配：用 -./ 连接的字母数字段 / 字母紧跟数字 / 数字紧跟字母。
 */
export function modelTokens(text: string): string[] {
  const re = /[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+)+|[A-Za-z]+\d[A-Za-z0-9]*|\d[A-Za-z]+[A-Za-z0-9]*/g;
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const tok = m[0].toLowerCase();
    if (tok.length >= 2 && /[a-z]/.test(tok) && /\d/.test(tok)) out.add(tok);
  }
  return [...out];
}

/** 中文分词 → 空格连接，喂给 Postgres 的 to_tsvector('simple', …) 做 BM25/关键词检索。
 * 除 jieba 分词外，追加「型号原子 token」以支持型号精确检索。 */
export function tokenizeZh(text: string): string {
  const words = jieba
    .cut(text, false)
    .map((t: string) => t.trim().toLowerCase())
    .filter(Boolean);
  return [...words, ...modelTokens(text)].join(" ");
}

/** 把分词结果拼成 to_tsquery 的 OR 查询（单引号包裹防特殊字符）。 */
export function toTsQuery(text: string): string {
  const tokens = tokenizeZh(text).split(" ").filter(Boolean);
  return tokens.map((t) => `'${t.replace(/'/g, "''")}'`).join(" | ");
}
