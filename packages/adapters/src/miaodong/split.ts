/** 段落接口字数上限（秒懂：content ≤ 1000 字符）。 */
export const PARAGRAPH_MAX = 1000;

/** 按码点计字数（中文/emoji 更稳）。 */
function countChars(s: string): number {
  return Array.from(s).length;
}

/** 按句末标点切句并保留标点：。！？；.!? 及换行（、不算句界）。 */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^。！？；\n.!?]*[。！？；\n.!?]+|[^。！？；\n.!?]+$/g);
  return parts ?? [text];
}

/** 把单个超长串按码点硬切成 ≤max 的块。 */
function hardSplit(s: string, max: number): string[] {
  const chars = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) {
    out.push(chars.slice(i, i + max).join(""));
  }
  return out;
}

/**
 * 把一段正文切成多个 ≤max 字符的段落文本：
 * 先按句切，贪心打包；单句仍超 max 则硬切。
 * 保序；每段首尾空白会去除、纯空白段落丢弃（适合作为知识库段落）。
 */
export function splitForParagraph(text: string, max = PARAGRAPH_MAX): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (countChars(trimmed) <= max) return [trimmed];

  const out: string[] = [];
  let buf = "";
  for (const s of splitSentences(trimmed)) {
    if (countChars(s) > max) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(...hardSplit(s, max));
      continue;
    }
    if (buf && countChars(buf) + countChars(s) > max) {
      out.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}
