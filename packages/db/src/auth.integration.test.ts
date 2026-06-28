// 集成测试：需 DATABASE_URL 指向起着的 pg（npm run db:up）。会自建并清理测试用户。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { db, sql as pg } from "./client";
import { docs, users } from "./schema";
import { eq } from "drizzle-orm";
import {
  createUser,
  findUserByEmail,
  findUserById,
  createSession,
  findSessionById,
  deleteSession,
  createApiToken,
  findApiTokenByHash,
  listApiTokens,
  deleteApiToken,
  listDocIdsForUser,
} from "./repo";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const createdUsers: string[] = [];
async function makeUser() {
  const id = "usr_test_" + randomUUID().slice(0, 8);
  const email = id + "@test.local";
  await createUser({ id, email, passwordHash: "x", displayName: id });
  createdUsers.push(id);
  return { id, email };
}

after(async () => {
  for (const id of createdUsers) await db.delete(users).where(eq(users.id, id));
  await pg.end();
});

test("createUser + findUserByEmail/ById 往返", async () => {
  const u = await makeUser();
  const byEmail = await findUserByEmail(u.email);
  assert.equal(byEmail?.id, u.id);
  const byId = await findUserById(u.id);
  assert.equal(byId?.email, u.email);
});

test("会话 create/find/过期/删除", async () => {
  const u = await makeUser();
  const raw = randomUUID();
  const sid = sha(raw);
  await createSession({ id: sid, userId: u.id, expiresAt: new Date(Date.now() + 60_000) });
  const found = await findSessionById(sid);
  assert.equal(found?.userId, u.id);
  assert.ok(found!.expiresAt.getTime() > Date.now());
  await deleteSession(sid);
  assert.equal(await findSessionById(sid), null);
});

test("API token create/find-by-hash/list/revoke", async () => {
  const u = await makeUser();
  const raw = "kbs_" + randomUUID();
  const id = "tok_" + randomUUID().slice(0, 8);
  await createApiToken({ id, userId: u.id, name: "脚本", tokenHash: sha(raw), prefix: raw.slice(0, 12) });
  const hit = await findApiTokenByHash(sha(raw));
  assert.equal(hit?.userId, u.id);
  const list = await listApiTokens(u.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "脚本");
  await deleteApiToken(id, u.id);
  assert.equal(await findApiTokenByHash(sha(raw)), null);
});

test("隔离：listDocIdsForUser 只返回本人文档", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const da = "doc_test_" + randomUUID().slice(0, 8);
  const dbid = "doc_test_" + randomUUID().slice(0, 8);
  await db.insert(docs).values({ id: da, title: "A", source: "A", userId: a.id, status: "ready" });
  await db.insert(docs).values({ id: dbid, title: "B", source: "B", userId: b.id, status: "ready" });
  const idsA = await listDocIdsForUser(a.id);
  assert.ok(idsA.includes(da));
  assert.ok(!idsA.includes(dbid));
  await db.delete(docs).where(eq(docs.id, da));
  await db.delete(docs).where(eq(docs.id, dbid));
});
