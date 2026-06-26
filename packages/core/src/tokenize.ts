/**
 * 粗略 token 估算，仅用于切片体积控制——不是 Claude 计费口径。
 * CJK 字符按 ~1 token/字；其余按 chars/4。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ＀-￯]/g) ?? []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}
