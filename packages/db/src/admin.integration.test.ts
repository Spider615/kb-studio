// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up 或本机 brew pg）。会自建并清理测试数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, conversations, miaodongCredentials, users } from "./schema";
import { eq } from "drizzle-orm";
import {
  createUser,
  findUserById,
  touchUserLastLogin,
  adminCountUsers,
  adminListUsers,
  adminSystemStats,
} from "./repo";

const createdUsers: string[] = [];
const createdDocs: string[] = [];
const createdConvs: string[] = [];
const createdCreds: string[] = [];

async function makeUser() {
  const id = "usr_admtest_" + randomUUID().slice(0, 8);
  const email = id + "@test.local";
  await createUser({ id, email, passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return { id, email };
}

after(async () => {
  for (const id of createdCreds) await db.delete(miaodongCredentials).where(eq(miaodongCredentials.id, id));
  for (const id of createdConvs) await db.delete(conversations).where(eq(conversations.id, id));
  for (const id of createdDocs) await db.delete(docs).where(eq(docs.id, id));
  for (const id of createdUsers) await db.delete(users).where(eq(users.id, id));
  await pg.end();
});

test("touchUserLastLogin 写入 lastLoginAt", async () => {
  const u = await makeUser();
  const before = await findUserById(u.id);
  assert.equal(before?.lastLoginAt, null);
  await touchUserLastLogin(u.id);
  const afterRow = await findUserById(u.id);
  assert.ok(afterRow?.lastLoginAt instanceof Date);
});

test("adminCountUsers 包含新建用户", async () => {
  const before = await adminCountUsers();
  await makeUser();
  const now = await adminCountUsers();
  assert.ok(now >= before + 1, "新建用户后总数应增加");
});

test("adminListUsers：计数 + lastLoginAt 正确", async () => {
  const u = await makeUser();
  // 该用户造：2 文档（其一已推送）/ 1 对话 / 1 凭据
  const d1 = "doc_admtest_" + randomUUID().slice(0, 8);
  const d2 = "doc_admtest_" + randomUUID().slice(0, 8);
  await db.insert(docs).values({ id: d1, title: "A", source: "A", userId: u.id, status: "ready" });
  await db.insert(docs).values({ id: d2, title: "B", source: "B", userId: u.id, status: "pushed", pushedAt: new Date() });
  createdDocs.push(d1, d2);
  const c1 = "conv_admtest_" + randomUUID().slice(0, 8);
  await db.insert(conversations).values({ id: c1, title: "t", userId: u.id });
  createdConvs.push(c1);
  const cr1 = "cred_admtest_" + randomUUID().slice(0, 8);
  await db.insert(miaodongCredentials).values({
    id: cr1, name: "n", domain: "d", accessKeyId: "k", accessKeySecret: "s",
    knowledgeBaseId: "kbid", userId: u.id,
  });
  createdCreds.push(cr1);
  await touchUserLastLogin(u.id);

  const rows = await adminListUsers();
  const row = rows.find((r) => r.id === u.id);
  assert.ok(row, "应包含该用户");
  assert.equal(row!.docCount, 2);
  assert.equal(row!.conversationCount, 1);
  assert.equal(row!.credentialCount, 1);
  assert.equal(row!.email, u.email);
  assert.ok(row!.lastLoginAt instanceof Date);
});

test("adminSystemStats：各项 >=0 且自洽", async () => {
  await makeUser();
  const s = await adminSystemStats();
  assert.ok(s.totalUsers >= 1);
  assert.ok(s.totalDocs >= 0);
  assert.equal(typeof s.docsByStatus, "object");
  assert.ok(s.totalChunks >= 0);
  assert.ok(s.pushedDocCount >= 0);
  assert.ok(s.registrations30d >= s.registrations7d, "30 天窗口应 >= 7 天窗口");
});
