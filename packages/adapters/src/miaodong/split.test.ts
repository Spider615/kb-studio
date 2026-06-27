import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForParagraph } from "./split";

test("短文本原样返回单段", () => {
  assert.deepEqual(splitForParagraph("你好世界"), ["你好世界"]);
});

test("空白返回空数组", () => {
  assert.deepEqual(splitForParagraph("   \n  "), []);
});

test("多句长文：每段 ≤1000 字符且保序拼回原文", () => {
  const long = "句子。".repeat(500); // 1500 字符（3*500），句界为「。」
  const parts = splitForParagraph(long, 1000);
  assert.ok(parts.length >= 2, "应切成多段");
  for (const p of parts) assert.ok(Array.from(p).length <= 1000);
  assert.equal(parts.join(""), long); // 无空白丢失，按序拼回
});

test("单句超长：硬切成定长块且拼回原文", () => {
  const s = "a".repeat(2500); // 无句界，整体一句
  const parts = splitForParagraph(s, 1000);
  assert.equal(parts.length, 3); // 1000+1000+500
  assert.ok(parts.every((p) => Array.from(p).length <= 1000));
  assert.equal(parts.join(""), s);
});
