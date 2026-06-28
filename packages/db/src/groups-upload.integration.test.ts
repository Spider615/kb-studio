// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。会自建并清理测试数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, groups, users } from "./schema";
import { eq } from "drizzle-orm";
import { createUser, createGroup, createProcessingDoc, groupBelongsToUser } from "./repo";

const createdUsers: string[] = [];
async function makeUser() {
  const id = "usr_test_" + randomUUID().slice(0, 8);
  await createUser({ id, email: id + "@test.local", passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return id;
}

after(async () => {
  // 无 user 外键，逐表显式删：docs → groups → users
  for (const id of createdUsers) {
    await db.delete(docs).where(eq(docs.userId, id));
    await db.delete(groups).where(eq(groups.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await pg.end();
});

test("createProcessingDoc 写入 groupId", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组", color: null, userId });
  const docId = "doc_test_" + randomUUID().slice(0, 8);
  await createProcessingDoc(docId, "f.pdf", "f.pdf", null, userId, gid);
  const row = await db.select({ groupId: docs.groupId }).from(docs).where(eq(docs.id, docId));
  assert.equal(row[0]?.groupId, gid);
});

test("createProcessingDoc 不传 groupId 默认 null", async () => {
  const userId = await makeUser();
  const docId = "doc_test_" + randomUUID().slice(0, 8);
  await createProcessingDoc(docId, "f.pdf", "f.pdf", null, userId);
  const row = await db.select({ groupId: docs.groupId }).from(docs).where(eq(docs.id, docId));
  assert.equal(row[0]?.groupId, null);
});

test("groupBelongsToUser：本人组 true，他人组 false，不存在 false", async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "u1 的组", color: null, userId: u1 });
  assert.equal(await groupBelongsToUser(gid, u1), true);
  assert.equal(await groupBelongsToUser(gid, u2), false);
  assert.equal(await groupBelongsToUser("grp_nope_xyz", u1), false);
});
