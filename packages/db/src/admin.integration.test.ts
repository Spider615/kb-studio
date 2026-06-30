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
