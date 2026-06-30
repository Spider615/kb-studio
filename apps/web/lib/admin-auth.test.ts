import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdminCredentials,
  signAdminCookie,
  verifyAdminCookie,
  ADMIN_TTL_MS,
} from "./admin-auth";

test("checkAdminCredentials：默认 admin/admin 通过，其它拒绝", () => {
  assert.equal(checkAdminCredentials("admin", "admin"), true);
  assert.equal(checkAdminCredentials("admin", "wrong"), false);
  assert.equal(checkAdminCredentials("root", "admin"), false);
  assert.equal(checkAdminCredentials("", ""), false);
});

test("sign/verify 往返通过", () => {
  const now = 1_700_000_000_000;
  assert.equal(verifyAdminCookie(signAdminCookie(now), now), true);
});

test("篡改签名被拒", () => {
  const now = 1_700_000_000_000;
  const c = signAdminCookie(now);
  const tampered = c.slice(0, -1) + (c.endsWith("a") ? "b" : "a");
  assert.equal(verifyAdminCookie(tampered, now), false);
});

test("过期被拒", () => {
  const now = 1_700_000_000_000;
  const c = signAdminCookie(now);
  assert.equal(verifyAdminCookie(c, now + ADMIN_TTL_MS + 1), false);
});

test("空 / 畸形值被拒", () => {
  assert.equal(verifyAdminCookie(undefined), false);
  assert.equal(verifyAdminCookie(""), false);
  assert.equal(verifyAdminCookie("nodot"), false);
});
