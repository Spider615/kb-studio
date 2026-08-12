import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict";

const jieba = Jieba.withDict(dict);

/**
 * 自定义专有名词（品牌 / 产品线 / 客户名），逗号或空格分隔，来自 env `KB_JIEBA_WORDS`。
 *
 * 为什么需要：jieba 默认词典不认识的专有名词会被切成**单字**，关键词检索随之退化成
 * 单字匹配、召回大量噪声。实例：「润度」被切成「润」「度」，于是任何含这两个字的片段
 * （「温度」「湿度」里的「度」同样中招）都会命中，BM25 分还很高——而真正的关键词
 * 反倒淹没了。加进词典后「润度」成为一个整词，精确命中才有意义。
 *
 * ⚠️ **改这个变量后必须重建全部 chunk 的 tsv_text**（`npm run rebuild-tsv`）。
 * 否则查询用新分词（'润度'）、而索引里存的是旧分词（'润' '度'），两边对不上，
 * 结果是**一条都匹配不到**——比不加词典更糟。
 */
export function customJiebaWords(): string[] {
  return (process.env.KB_JIEBA_WORDS ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 模块加载时装入自定义词典。格式为 jieba 的「词 词频 词性」；词频取 3000
// 是为了压过默认切分（默认词典里单字的频次不低，给太小不生效）。
{
  const words = customJiebaWords();
  if (words.length) {
    jieba.loadDict(Buffer.from(words.map((w) => `${w} 3000 n`).join("\n"), "utf-8"));
  }
}

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
