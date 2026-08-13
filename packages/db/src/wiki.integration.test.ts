// 集成测试：需 DATABASE_URL 指向起着的 pg（本机 brew pg 或 npm run db:up）。会自建并清理测试数据。
// 跑法：npx tsx --test packages/db/src/wiki.integration.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, sql as pg } from "./client";
import { chunks } from "./schema";
import type { ChunkMetadata } from "@kb/core";
import {
  upsertDoc,
  insertWikiPages,
  listWikiPages,
  getWikiPage,
  getWikiOutline,
  listWikiDocs,
  setWikiStatus,
  deleteDoc,
  assignChunkPages,
  pageIdsForChunkIds,
} from "./repo";

const docId = "doc_test_" + randomUUID().slice(0, 8);
// 第二篇文档：专门用来验证 assignChunkPages 不会跨文档误改（docId 约束是否真的生效）。
const pageDocId = "doc_test_" + randomUUID().slice(0, 8);
const otherDocId = "doc_test_" + randomUUID().slice(0, 8);
// insertWikiPages 事务原子性测试专用。
const atomicDocId = "doc_test_" + randomUUID().slice(0, 8);
// insertWikiPages 混合 docId 校验测试专用（两篇各自独立的文档）。
const mixedDocIdA = "doc_test_" + randomUUID().slice(0, 8);
const mixedDocIdB = "doc_test_" + randomUUID().slice(0, 8);

// 兜底清理：即便某条用例中途失败，也不落测试数据到库里（deleteDoc 对不存在的 id 是空操作，级联删 chunks/wiki_pages）。
after(async () => {
  await deleteDoc(docId);
  await deleteDoc(pageDocId);
  await deleteDoc(otherDocId);
  await deleteDoc(atomicDocId);
  await deleteDoc(mixedDocIdA);
  await deleteDoc(mixedDocIdB);
  await pg.end();
});

/** 造一条满足 chunks 表 notNull 约束的最小 chunk 行；metadata 形状照抄 @kb/core 的 ChunkMetadata。 */
function makeChunkRow(id: string, forDocId: string, idx: number) {
  const metadata: ChunkMetadata = {
    doc_id: forDocId,
    doc_title: "测试文档",
    heading_path: [],
    page_num: null,
    chunk_index: idx,
    chunk_type: "text",
    image_url: null,
    image_id: null,
    prev_chunk_id: null,
    next_chunk_id: null,
  };
  return {
    id,
    docId: forDocId,
    content: `内容 ${idx}`,
    contentOriginal: `内容 ${idx}`,
    chunkIndex: idx,
    metadata,
  };
}

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

test("assignChunkPages 批量回填 + pageIdsForChunkIds 往返；不误改其他文档、NULL 不入结果", async () => {
  await upsertDoc({ id: pageDocId, title: "分页测试文档", source: "test", status: "ready" } as any);
  await upsertDoc({ id: otherDocId, title: "另一篇文档", source: "test", status: "ready" } as any);

  await insertWikiPages([
    { id: `page_${pageDocId}_0`, docId: pageDocId, pageIndex: 0, title: "目录", content: "目录", headingPath: [], tokenEstimate: 1 },
    { id: `page_${pageDocId}_1`, docId: pageDocId, pageIndex: 1, title: "甲章", content: "甲章正文", headingPath: ["甲章"], tokenEstimate: 1 },
  ]);
  const pageId1 = `page_${pageDocId}_1`;

  const chunkId1 = `chunk_${pageDocId}_0`;
  const chunkId2 = `chunk_${pageDocId}_1`;
  const unassignedChunkId = `chunk_${pageDocId}_2`; // 故意不进 mapping，page_id 应保持 NULL
  const otherChunkId = `chunk_${otherDocId}_0`; // 属于另一篇文档

  await db.insert(chunks).values([
    makeChunkRow(chunkId1, pageDocId, 0),
    makeChunkRow(chunkId2, pageDocId, 1),
    makeChunkRow(unassignedChunkId, pageDocId, 2),
    makeChunkRow(otherChunkId, otherDocId, 0),
  ]);

  // 空数组应短路，不抛错、不产生任何 UPDATE
  await assignChunkPages(pageDocId, []);

  // mapping 里混入 otherChunkId（同一个 pageId、会被分进同一条 UPDATE），验证 assignChunkPages
  // 内部 `eq(chunks.docId, docId)` 约束真的挡住了跨文档误改，而不只是表面上看起来对。
  await assignChunkPages(pageDocId, [
    { chunkId: chunkId1, pageId: pageId1 },
    { chunkId: chunkId2, pageId: pageId1 },
    { chunkId: otherChunkId, pageId: pageId1 },
  ]);

  // 直接查库确认，不只信函数返回值
  const rows = await db
    .select({ id: chunks.id, pageId: chunks.pageId })
    .from(chunks)
    .where(inArray(chunks.id, [chunkId1, chunkId2, unassignedChunkId, otherChunkId]));
  const pageIdById = new Map(rows.map((r) => [r.id, r.pageId]));
  assert.equal(pageIdById.get(chunkId1), pageId1);
  assert.equal(pageIdById.get(chunkId2), pageId1);
  assert.equal(pageIdById.get(unassignedChunkId), null);
  assert.equal(pageIdById.get(otherChunkId), null); // 未被误改——docId 约束生效

  const map = await pageIdsForChunkIds([chunkId1, chunkId2, unassignedChunkId, otherChunkId]);
  assert.equal(map.get(chunkId1), pageId1);
  assert.equal(map.get(chunkId2), pageId1);
  assert.equal(map.has(unassignedChunkId), false); // page_id 为 NULL 的不入结果 Map
  assert.equal(map.has(otherChunkId), false);

  const emptyMap = await pageIdsForChunkIds([]);
  assert.equal(emptyMap.size, 0);
});

test("insertWikiPages 删+插要在同一事务里：插入失败时旧页保持完好", async () => {
  await upsertDoc({ id: atomicDocId, title: "事务测试文档", source: "test", status: "ready" } as any);
  await insertWikiPages([
    { id: `page_${atomicDocId}_0`, docId: atomicDocId, pageIndex: 0, title: "目录", content: "目录", headingPath: [], tokenEstimate: 1 },
    { id: `page_${atomicDocId}_1`, docId: atomicDocId, pageIndex: 1, title: "甲章", content: "甲章正文", headingPath: ["甲章"], tokenEstimate: 1 },
  ]);
  assert.equal((await listWikiPages(atomicDocId)).length, 2);

  // 故意构造一批会触发 (doc_id, page_index) 唯一索引冲突的页：两行 pageIndex 都是 0
  await assert.rejects(() =>
    insertWikiPages([
      { id: `page_${atomicDocId}_new0`, docId: atomicDocId, pageIndex: 0, title: "新目录", content: "x", headingPath: [], tokenEstimate: 1 },
      { id: `page_${atomicDocId}_new0b`, docId: atomicDocId, pageIndex: 0, title: "重复索引", content: "y", headingPath: [], tokenEstimate: 1 },
    ]),
  );

  // 没有事务时：旧页已被前半句 delete 清空、insert 又失败，这里会读到 0 行。
  // 有事务时：delete+insert 一起回滚，原有 2 个页应该完好无损。
  const after2 = await listWikiPages(atomicDocId);
  assert.equal(after2.length, 2);
  assert.equal(after2[0]!.title, "目录");
  assert.equal(after2[1]!.title, "甲章");
});

test("insertWikiPages 混合 docId 直接抛错，两篇文档原有页都不受影响", async () => {
  await upsertDoc({ id: mixedDocIdA, title: "混合测试A", source: "test", status: "ready" } as any);
  await upsertDoc({ id: mixedDocIdB, title: "混合测试B", source: "test", status: "ready" } as any);

  await insertWikiPages([
    { id: `page_${mixedDocIdA}_0`, docId: mixedDocIdA, pageIndex: 0, title: "A的目录", content: "a", headingPath: [], tokenEstimate: 1 },
  ]);
  await insertWikiPages([
    { id: `page_${mixedDocIdB}_0`, docId: mixedDocIdB, pageIndex: 0, title: "B的目录", content: "b", headingPath: [], tokenEstimate: 1 },
  ]);

  // pageIndex 特意不冲突（都是 1），只有 docId 混了——若没有校验，这一步会「悄悄成功」：
  // 删掉 A 的旧页、插入 A 的新页和 B 的新页，B 的旧页则被晾在一边不受影响，
  // 而 A 的目录页凭空消失，违反「整篇覆盖式写入」的语义且毫无提示。
  await assert.rejects(() =>
    insertWikiPages([
      { id: `page_${mixedDocIdA}_1`, docId: mixedDocIdA, pageIndex: 1, title: "A的甲章", content: "aa", headingPath: [], tokenEstimate: 1 },
      { id: `page_${mixedDocIdB}_1`, docId: mixedDocIdB, pageIndex: 1, title: "B的甲章", content: "bb", headingPath: [], tokenEstimate: 1 },
    ]),
  );

  const pagesA = await listWikiPages(mixedDocIdA);
  assert.equal(pagesA.length, 1);
  assert.equal(pagesA[0]!.title, "A的目录");

  const pagesB = await listWikiPages(mixedDocIdB);
  assert.equal(pagesB.length, 1);
  assert.equal(pagesB[0]!.title, "B的目录");
});
