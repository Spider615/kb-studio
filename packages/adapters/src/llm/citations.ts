import type { AnswerChunk, AnswerSource } from "@kb/core";

/**
 * 非 Anthropic 模型的引用溯源：序号标记法。
 *
 * 背景：Anthropic Messages API 有协议级 citations（传 `{type:"document", citations:{enabled:true}}`，
 * 返回 `block.citations[].start_block_index`），API 保证 cited_text 逐字来自原文、模型编不出来。
 * 火山方舟的 /chat/completions **没有这个能力**（无 document content block、无 annotations），
 * Responses API 的 doc_citation 只对托管在火山知识库里的文档生效，与自建 pgvector 检索不兼容。
 * 所以这里退回到「让模型在答案里标来源、本地解析回映射」。
 *
 * 为什么用**序号** `[1]` 而不是可读 chunk id `[doc_42_c0007]`：
 * 后者要模型逐字复述一个 15+ 字符的标识符，写错一个字符就丢一条引用；序号只有 1~2 位，
 * 指令遵循率高一个量级，且越界立刻能判伪。映射由 Node 侧按位置还原，不依赖模型记住 id。
 *
 * 校验策略（有意保守）：只做**序号范围校验 + 去重**，不做答案与 chunk 的内容匹配。
 * 理由：候选集本身已经过混合检索 + rerank 筛选，「引用了范围内但不太相关的 chunk」危害有限；
 * 而中文短答案做 n-gram / 相似度匹配误杀率高，会把正确引用也丢掉。真正的幻觉风险是
 * 「编造一个不存在的来源」，那个由范围校验拦死。
 *
 * 与 Anthropic 版本相比**丢失的保证**：无法确认模型引用的那句话真的出自该 chunk。
 * 这是协议能力差异，不是实现取舍——调用方不应假设 sources 具备逐字溯源强度。
 */

/** 附加到 user 消息末尾的标注指令。与 buildCitedDocsBlock 的序号约定配套。 */
export const CITATION_INSTRUCTION = [
  "",
  "作答要求：",
  "- 只依据上面【资料】作答，资料里没有的不要编。",
  "- 每处结论后面用方括号标出依据的资料序号，例如：产品保修期为一年[2]。",
  "- 一处结论有多个依据就并列写，例如 [1][3]。",
  "- 只能引用上面出现过的序号，不要编造序号。",
].join("\n");

/** 把 TopK chunk 拼成带序号的【资料】块。序号从 1 开始，与 parseCitations 的映射一致。 */
export function buildCitedDocsBlock(chunks: AnswerChunk[]): string {
  const parts = chunks.map((c, i) => {
    const path = c.heading_path?.length ? `（${c.heading_path.join(" · ")}）` : "";
    return `[${i + 1}]${path}\n${c.content}`;
  });
  return ["【资料】", ...parts].join("\n\n");
}

/** 匹配答案里的引用标记：[1] / [1][2] / [1,2] / [1、2] / [1 2]。只认纯数字，不会误伤 markdown 链接 [文字](url)。 */
const CITE_RE = /\[\s*(\d+(?:\s*[,，、\s]\s*\d+)*)\s*\]/g;

export interface ParsedCitations {
  /** 剥掉引用标记后的答案正文 */
  answer: string;
  /** 按答案中首次出现顺序去重后的来源 */
  sources: AnswerSource[];
}

/**
 * 从模型答案里解析引用标记，映射回 chunk 并校验。
 * stripMarkers=true（默认）会把标记从正文剥掉，保持 answer 外观与 Anthropic 版本一致
 * （那边引用是结构化返回的、不在正文里），前端无需改动。
 */
export function parseCitations(
  raw: string,
  chunks: AnswerChunk[],
  opts: { stripMarkers?: boolean } = {},
): ParsedCitations {
  const stripMarkers = opts.stripMarkers ?? true;
  const sources: AnswerSource[] = [];
  const seen = new Set<string>();

  for (const m of raw.matchAll(CITE_RE)) {
    for (const numStr of m[1]!.split(/[,，、\s]+/)) {
      const n = Number(numStr);
      // 范围校验：1..N 之外一律视为模型编造，丢弃
      if (!Number.isInteger(n) || n < 1 || n > chunks.length) continue;
      const ch = chunks[n - 1]!;
      if (seen.has(ch.id)) continue;
      seen.add(ch.id);
      sources.push({ id: ch.id, heading_path: ch.heading_path });
    }
  }

  let answer = raw;
  if (stripMarkers) {
    answer = answer
      .replace(CITE_RE, "")
      // 标记常紧跟在标点前后，剥掉后会留下多余空格；收拾一下但不动换行结构
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([，。；：、！？）】」』])/g, "$1");
  }

  return { answer: answer.trim(), sources };
}
