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
  await deleteEmailVerification(email, "register");
  await deleteEmailVerification(email, "reset");
  await pg.end();
});

test("upsert → get 往返，attempts 初始 0", async () => {
  const exp = new Date(Date.now() + 600_000);
  const sent = new Date();
  await upsertEmailVerification({ email, purpose: "register", codeHash: "H1", expiresAt: exp, lastSentAt: sent });
  const row = await getEmailVerification(email, "register");
  assert.equal(row?.codeHash, "H1");
  assert.equal(row?.attempts, 0);
  assert.ok(row!.expiresAt.getTime() > Date.now());
});

test("upsert 覆盖旧码并重置 attempts", async () => {
  await incEmailVerificationAttempts(email, "register");
  await incEmailVerificationAttempts(email, "register");
  let row = await getEmailVerification(email, "register");
  assert.equal(row?.attempts, 2);
  // 重发：覆盖
  await upsertEmailVerification({
    email,
    purpose: "register",
    codeHash: "H2",
    expiresAt: new Date(Date.now() + 600_000),
    lastSentAt: new Date(),
  });
  row = await getEmailVerification(email, "register");
  assert.equal(row?.codeHash, "H2");
  assert.equal(row?.attempts, 0); // 重置
});

test("incAttempts 累加并返回新次数", async () => {
  const n = await incEmailVerificationAttempts(email, "register");
  assert.equal(n, 1); // 返回自增后的值
  const row = await getEmailVerification(email, "register");
  assert.equal(row?.attempts, 1);
});

test("同邮箱的 register / reset 两码互不干扰", async () => {
  const exp = new Date(Date.now() + 600_000);
  await upsertEmailVerification({ email, purpose: "register", codeHash: "REG", expiresAt: exp, lastSentAt: new Date() });
  await upsertEmailVerification({ email, purpose: "reset", codeHash: "RST", expiresAt: exp, lastSentAt: new Date() });

  // 后写的 reset 没有顶掉 register
  assert.equal((await getEmailVerification(email, "register"))?.codeHash, "REG");
  assert.equal((await getEmailVerification(email, "reset"))?.codeHash, "RST");

  // 试错次数各记各的
  await incEmailVerificationAttempts(email, "reset");
  assert.equal((await getEmailVerification(email, "reset"))?.attempts, 1);
  assert.equal((await getEmailVerification(email, "register"))?.attempts, 0);

  // 消费其中一个，另一个还在
  await deleteEmailVerification(email, "reset");
  assert.equal(await getEmailVerification(email, "reset"), null);
  assert.equal((await getEmailVerification(email, "register"))?.codeHash, "REG");
});

test("delete 后 get 为 null", async () => {
  await deleteEmailVerification(email, "register");
  assert.equal(await getEmailVerification(email, "register"), null);
});
