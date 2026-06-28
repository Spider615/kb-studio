// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。自清理。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql as pg } from "./client";
import {
  upsertEmailVerification,
  getEmailVerification,
  incEmailVerificationAttempts,
  deleteEmailVerification,
} from "./repo";

const email = "verify_test_" + randomUUID().slice(0, 8) + "@test.local";

after(async () => {
  await deleteEmailVerification(email);
  await pg.end();
});

test("upsert → get 往返，attempts 初始 0", async () => {
  const exp = new Date(Date.now() + 600_000);
  const sent = new Date();
  await upsertEmailVerification({ email, codeHash: "H1", expiresAt: exp, lastSentAt: sent });
  const row = await getEmailVerification(email);
  assert.equal(row?.codeHash, "H1");
  assert.equal(row?.attempts, 0);
  assert.ok(row!.expiresAt.getTime() > Date.now());
});

test("upsert 覆盖旧码并重置 attempts", async () => {
  await incEmailVerificationAttempts(email);
  await incEmailVerificationAttempts(email);
  let row = await getEmailVerification(email);
  assert.equal(row?.attempts, 2);
  // 重发：覆盖
  await upsertEmailVerification({ email, codeHash: "H2", expiresAt: new Date(Date.now() + 600_000), lastSentAt: new Date() });
  row = await getEmailVerification(email);
  assert.equal(row?.codeHash, "H2");
  assert.equal(row?.attempts, 0); // 重置
});

test("incAttempts 累加", async () => {
  await incEmailVerificationAttempts(email);
  const row = await getEmailVerification(email);
  assert.equal(row?.attempts, 1);
});

test("delete 后 get 为 null", async () => {
  await deleteEmailVerification(email);
  assert.equal(await getEmailVerification(email), null);
});
