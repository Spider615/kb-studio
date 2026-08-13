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

test("真正的并列场景：超长章节被 splitOversized 切成续页，续页与首页共用同一个 headingPath——命中归起始页", () => {
  // 模拟 paginator.ts splitOversized 产生的续页：首页 + 续1 + 续2 三页的 headingPath 完全相同，
  // 只有 pageIndex/title 不同（真实数据里 title 会带「（续N）」，这里字段不是判据，故意不写以确认
  // headingPath 才是唯一依据）。三页长度相同的最长前缀匹配下必须取 pageIndex 最小的起始页。
  const continuedPages: Page[] = [
    { pageIndex: 3, title: "长章", content: "", headingPath: ["制度", "长章"], tokenEstimate: 0 },
    { pageIndex: 4, title: "长章（续1）", content: "", headingPath: ["制度", "长章"], tokenEstimate: 0 },
    { pageIndex: 5, title: "长章（续2）", content: "", headingPath: ["制度", "长章"], tokenEstimate: 0 },
  ];
  const out = mapChunksToPages([{ id: "c9", headingPath: ["制度", "长章", "第五条"], chunkIndex: 20 }], continuedPages);
  assert.deepEqual(out, [{ chunkId: "c9", pageIndex: 3 }]);
});
