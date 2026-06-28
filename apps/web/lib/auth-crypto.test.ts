import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  SESSION_COOKIE,
} from "./auth-crypto";

test("hashPassword 产出可被 verifyPassword 校验", async () => {
  const hash = await hashPassword("correct horse");
  assert.notEqual(hash, "correct horse"); // 不是明文
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
});

test("randomToken 每次不同且足够长", () => {
  const a = randomToken();
  const b = randomToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40); // 32 字节 base64url ≈ 43 字符
});

test("sha256 确定且非原文", () => {
  assert.equal(sha256("x"), sha256("x"));
  assert.notEqual(sha256("x"), "x");
  assert.equal(sha256("x").length, 64); // hex
});

test("SESSION_COOKIE 常量为 kb_session", () => {
  assert.equal(SESSION_COOKIE, "kb_session");
});
