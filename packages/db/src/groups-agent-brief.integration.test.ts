// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。会自建并清理测试数据。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, groups, users } from "./schema";
import { eq } from "drizzle-orm";
import { createUser, createGroup, updateGroup, findGroupById } from "./repo";

const createdUsers: string[] = [];
async function makeUser() {
  const id = "usr_test_" + randomUUID().slice(0, 8);
  await createUser({ id, email: id + "@test.local", passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return id;
}

after(async () => {
  for (const id of createdUsers) {
    await db.delete(docs).where(eq(docs.userId, id));
    await db.delete(groups).where(eq(groups.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await pg.end();
});

test("createGroup 带 agentPurpose/agentNotes 写入", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组", userId, agentPurpose: "售后客服", agentNotes: "语气亲切" });
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, "售后客服");
  assert.equal(g?.agentNotes, "语气亲切");
});

test("createGroup 不带 agentPurpose/agentNotes 默认 null", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组2", userId });
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, null);
  assert.equal(g?.agentNotes, null);
});

test("updateGroup 只传 agentPurpose 不影响 agentNotes（局部更新）", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组3", userId, agentPurpose: "旧用途", agentNotes: "补充A" });
  await updateGroup(gid, { agentPurpose: "新用途" }, userId);
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, "新用途");
  assert.equal(g?.agentNotes, "补充A");
});

test("updateGroup 传 null 清空字段", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "测试组4", userId, agentPurpose: "旧用途" });
  await updateGroup(gid, { agentPurpose: null }, userId);
  const g = await findGroupById(gid);
  assert.equal(g?.agentPurpose, null);
});

test("findGroupById 查不到返回 null", async () => {
  const g = await findGroupById("grp_nope_" + randomUUID().slice(0, 8));
  assert.equal(g, null);
});
