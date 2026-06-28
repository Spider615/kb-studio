import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCode, checkCode, inCooldown, RESEND_COOLDOWN_MS } from "./verify-code";

const fakeHash = (s: string) => "H(" + s + ")"; // 确定性假哈希，便于断言

test("generateCode 是 6 位数字", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateCode();
    assert.match(c, /^\d{6}$/);
  }
});

test("checkCode：行不存在按过期处理", () => {
  assert.equal(checkCode(null, "123456", Date.now(), fakeHash), "expired");
});

test("checkCode：已过期返回 expired", () => {
  const row = { codeHash: fakeHash("123456"), expiresAt: new Date(1000), attempts: 0 };
  assert.equal(checkCode(row, "123456", 2000, fakeHash), "expired");
});

test("checkCode：码不匹配返回 wrong", () => {
  const row = { codeHash: fakeHash("123456"), expiresAt: new Date(9999999999999), attempts: 0 };
  assert.equal(checkCode(row, "000000", 1000, fakeHash), "wrong");
});

test("checkCode：码匹配且未过期返回 ok", () => {
  const row = { codeHash: fakeHash("123456"), expiresAt: new Date(9999999999999), attempts: 0 };
  assert.equal(checkCode(row, "123456", 1000, fakeHash), "ok");
});

test("inCooldown：冷却窗口内为 true，窗口外为 false", () => {
  const now = 1_000_000;
  assert.equal(inCooldown(new Date(now - RESEND_COOLDOWN_MS + 1), now), true);
  assert.equal(inCooldown(new Date(now - RESEND_COOLDOWN_MS - 1), now), false);
});
