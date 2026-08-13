import { test } from "node:test";
import assert from "node:assert/strict";
import { safeTruncateUtf16 } from "./text";

test("正常截断：切点落在普通字符之间，原样截断", () => {
  assert.equal(safeTruncateUtf16("hello world", 5), "hello");
});

test("输入短于上限：原样返回，不补齐不报错", () => {
  const s = "短句子";
  assert.equal(safeTruncateUtf16(s, 100), s);
});

test("截断长度为 0：返回空字符串", () => {
  assert.equal(safeTruncateUtf16("abc", 0), "");
});

test("切点恰好落在代理对中间：回退一位，不留下孤立高位代理", () => {
  // "AB" + 😀（代理对 😀）+ "CD"：字符索引 0=A 1=B 2=\uD83D 3=\uDE00 4=C 5=D。
  // len=3 时裸 slice(0,3) 会切在代理对正中间，末字符是孤立的高位代理 \uD83D。
  const s = "AB\u{1F600}CD";
  const cut = safeTruncateUtf16(s, 3);
  assert.equal(cut, "AB", "应整体舍弃被切坏的 emoji，而不是留下半个代理对");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), "不应含孤立的高位代理");
});

test("切点落在代理对之后：emoji 完整保留，不误伤", () => {
  const s = "AB\u{1F600}CD";
  const cut = safeTruncateUtf16(s, 4);
  assert.equal(cut, "AB\u{1F600}", "切点在代理对结束处，emoji 应完整保留");
});
