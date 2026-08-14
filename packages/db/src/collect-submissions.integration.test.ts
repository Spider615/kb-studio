// 集成测试：需 DATABASE_URL 指向起着的 pg。会自建并清理测试数据。
// 覆盖「收集链接填的信息全部落库」这条链路：提交记录合并 + 文档带材料分类/提交号。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, groups, users, collectSubmissions } from "./schema";
import { eq } from "drizzle-orm";
import {
  createUser,
  createGroup,
  findGroupById,
  updateGroup,
  upsertCollectSubmission,
  findCollectSubmission,
  listCollectSubmissions,
  createProcessingDoc,
  listDocs,
} from "./repo";

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
    await db.delete(collectSubmissions).where(eq(collectSubmissions.userId, id));
    await db.delete(groups).where(eq(groups.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await pg.end();
});

function sub(userId: string, collectorId: string, over: Record<string, any> = {}) {
  return {
    id: "sub_test_" + randomUUID().slice(0, 8),
    userId,
    groupId: null,
    collectorId,
    company: "测试企业",
    industry: "电商零售",
    agentPurpose: "售后客服",
    agentNotes: "语气亲切",
    form: { company: "测试企业", industry: "电商零售", categories: { "a.pdf": "产品说明书" } },
    ...over,
  };
}

test("upsertCollectSubmission 首次插入：结构化字段 + 表单快照都存下来", async () => {
  const userId = await makeUser();
  const id = await upsertCollectSubmission(sub(userId, "1"));
  const row = await findCollectSubmission(id, userId);
  assert.equal(row?.company, "测试企业");
  assert.equal(row?.industry, "电商零售");
  assert.equal(row?.agentPurpose, "售后客服");
  assert.equal(row?.agentNotes, "语气亲切");
  // 表单原样快照：以后表单加字段也是往这里塞，不用改表
  assert.deepEqual((row?.form as any)?.categories, { "a.pdf": "产品说明书" });
});

test("同一次提交的多个文件请求合并成一行（幂等）", async () => {
  const userId = await makeUser();
  const first = await upsertCollectSubmission(sub(userId, "7"));
  const second = await upsertCollectSubmission(sub(userId, "7"));
  assert.equal(second, first, "第二个文件的请求应命中同一行，而不是新建");
  const all = await listCollectSubmissions(userId);
  assert.equal(all.length, 1);
});

test("后到的请求不会用空值把先到的信息冲掉", async () => {
  const userId = await makeUser();
  const id = await upsertCollectSubmission(sub(userId, "9"));
  await upsertCollectSubmission(
    sub(userId, "9", { industry: null, agentPurpose: null, agentNotes: null, form: null }),
  );
  const row = await findCollectSubmission(id, userId);
  assert.equal(row?.industry, "电商零售");
  assert.equal(row?.agentPurpose, "售后客服");
  assert.equal(row?.agentNotes, "语气亲切");
  assert.ok(row?.form, "form 快照不应被 null 覆盖");
});

test("不同员工用同一个 collector 提交号互不干扰", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const idA = await upsertCollectSubmission(sub(a, "42", { company: "甲公司" }));
  const idB = await upsertCollectSubmission(sub(b, "42", { company: "乙公司" }));
  assert.notEqual(idA, idB);
  assert.equal((await findCollectSubmission(idA, a))?.company, "甲公司");
  // 非本人的提交查不到
  assert.equal(await findCollectSubmission(idA, b), null);
});

test("文档带上材料分类与提交号，列表能读回", async () => {
  const userId = await makeUser();
  const submissionId = await upsertCollectSubmission(sub(userId, "13"));
  const docId = "doc_test_" + randomUUID().slice(0, 8);
  await createProcessingDoc(docId, "说明书.pdf", "说明书.pdf", null, userId, null, {
    category: "产品说明书",
    submissionId,
  });
  const row = (await listDocs(userId)).find((d) => d.id === docId);
  assert.equal(row?.category, "产品说明书");
  assert.equal(row?.submissionId, submissionId);
});

test("手动上传的文档 category/submissionId 为 null（不传 origin）", async () => {
  const userId = await makeUser();
  const docId = "doc_test_" + randomUUID().slice(0, 8);
  await createProcessingDoc(docId, "手传.pdf", "手传.pdf", null, userId, null);
  const row = (await listDocs(userId)).find((d) => d.id === docId);
  assert.equal(row?.category, null);
  assert.equal(row?.submissionId, null);
});

test("行业写在分组上，沿用非空才覆盖的局部更新语义", async () => {
  const userId = await makeUser();
  const gid = "grp_test_" + randomUUID().slice(0, 8);
  await createGroup({ id: gid, name: "行业测试组", userId, industry: "教育培训" });
  assert.equal((await findGroupById(gid))?.industry, "教育培训");
  // 只改用途不该动行业
  await updateGroup(gid, { agentPurpose: "新用途" }, userId);
  assert.equal((await findGroupById(gid))?.industry, "教育培训");
  await updateGroup(gid, { industry: "电商零售" }, userId);
  assert.equal((await findGroupById(gid))?.industry, "电商零售");
});
