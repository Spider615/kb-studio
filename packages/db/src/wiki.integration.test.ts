// 集成测试：需 DATABASE_URL 指向起着的 pg（本机 brew pg 或 npm run db:up）。会自建并清理测试数据。
// 跑法：npx tsx --test packages/db/src/wiki.integration.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql as pg } from "./client";
import { upsertDoc, insertWikiPages, listWikiPages, getWikiPage, getWikiOutline, listWikiDocs, setWikiStatus, deleteDoc } from "./repo";

const docId = "doc_test_" + randomUUID().slice(0, 8);

// 兜底清理：即便某条用例中途失败，也不落测试数据到库里（deleteDoc 对不存在的 id 是空操作）。
after(async () => {
  await deleteDoc(docId);
  await pg.end();
});

test("wiki 页写入、按序读出、目录页单独取", async () => {
  await upsertDoc({ id: docId, title: "测试文档", source: "test", status: "ready" } as any);
  await insertWikiPages([
    { id: `page_${docId}_0`, docId, pageIndex: 0, title: "目录", content: "1. 甲章\n2. 乙章", headingPath: [], tokenEstimate: 10 },
    { id: `page_${docId}_1`, docId, pageIndex: 1, title: "甲章", content: "甲章正文", headingPath: ["甲章"], tokenEstimate: 5 },
    { id: `page_${docId}_2`, docId, pageIndex: 2, title: "乙章", content: "乙章正文", headingPath: ["乙章"], tokenEstimate: 5 },
  ]);

  const pages = await listWikiPages(docId);
  assert.equal(pages.length, 3);
  assert.equal(pages[0]!.pageIndex, 0);
  assert.equal(pages[2]!.title, "乙章");

  const outline = await getWikiOutline(docId);
  assert.equal(outline?.title, "目录");

  const p2 = await getWikiPage(docId, 2);
  assert.equal(p2?.content, "乙章正文");

  const missing = await getWikiPage(docId, 99);
  assert.equal(missing, null);
});

test("listWikiDocs 只列 wiki_status=ready 的文档，pageCount 不含目录页", async () => {
  await setWikiStatus(docId, "ready");
  const docs = await listWikiDocs([docId]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.pageCount, 2); // 3 行减去目录页

  await setWikiStatus(docId, "failed", "分页失败");
  assert.equal((await listWikiDocs([docId])).length, 0);
});

test("删除文档级联清理 wiki 页", async () => {
  await deleteDoc(docId);
  assert.equal((await listWikiPages(docId)).length, 0);
});
