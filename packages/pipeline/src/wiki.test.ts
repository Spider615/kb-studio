import { test } from "node:test";
import assert from "node:assert/strict";
import { mapChunksToPages } from "./wiki";
import type { Page } from "@kb/core";

const pages: Page[] = [
  { pageIndex: 1, title: "甲章", content: "", headingPath: ["制度", "甲章"], tokenEstimate: 0 },
  { pageIndex: 2, title: "乙章", content: "", headingPath: ["制度", "乙章"], tokenEstimate: 0 },
];

test("按 heading_path 最长前缀匹配归属页", () => {
  const out = mapChunksToPages(
    [
      { id: "c1", headingPath: ["制度", "甲章", "第一条"], chunkIndex: 0 },
      { id: "c2", headingPath: ["制度", "乙章"], chunkIndex: 1 },
    ],
    pages,
  );
  assert.deepEqual(out, [
    { chunkId: "c1", pageIndex: 1 },
    { chunkId: "c2", pageIndex: 2 },
  ]);
});

test("无命中的 chunk（前言）归第一页", () => {
  const out = mapChunksToPages([{ id: "c0", headingPath: ["制度"], chunkIndex: 0 }], pages);
  assert.deepEqual(out, [{ chunkId: "c0", pageIndex: 1 }]);
});

test("跨页 chunk 归起始页：按 chunk_index 顺序，命中多页时取序号更小的页", () => {
  // c3 的路径同时能匹配甲章（前缀）——取最长前缀，若并列则取 pageIndex 更小者
  const out = mapChunksToPages([{ id: "c3", headingPath: ["制度", "甲章"], chunkIndex: 5 }], pages);
  assert.deepEqual(out, [{ chunkId: "c3", pageIndex: 1 }]);
});
