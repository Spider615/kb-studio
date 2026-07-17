import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLexGuard, expandNeighbors } from "./retrieve";
import type { SearchHit } from "@kb/db";

const hit = (id: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  id,
  content: id,
  score: 0,
  heading_path: [],
  prev_chunk_id: null,
  next_chunk_id: null,
  ...extra,
});

test("lexguard：把 BM25 精确命中并入 core，替换末尾最弱项，保持 topK，注入项标 via", () => {
  const core = [hit("a"), hit("b"), hit("c")]; // topK=3, cap=⌊3/3⌋=1
  const kw = [hit("z"), hit("a")]; // z 是精确命中但不在 core；a 已在
  const out = applyLexGuard(core, kw, 3, 2);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((h) => h.id), ["a", "b", "z"]); // 末尾 c 被 z 顶掉，a 不重复注入
  assert.equal(out[2]!.via, "lexguard");
});

test("lexguard：注入名额有上限，不霸榜（保住多数精排）", () => {
  const core = [hit("a"), hit("b"), hit("c"), hit("d"), hit("e"), hit("f")]; // topK=6, cap=⌊6/3⌋=2
  const kw = [hit("u"), hit("v"), hit("w"), hit("x"), hit("y")]; // 5 个精确命中
  const out = applyLexGuard(core, kw, 6, 5);
  assert.equal(out.length, 6);
  assert.equal(out.filter((h) => h.via === "lexguard").length, 2); // 最多顶 2 个，保住 4 个精排
  assert.deepEqual(out.slice(0, 4).map((h) => h.id), ["a", "b", "c", "d"]);
});

test("lexguard：命中已在 core → 不变；lexGuardN=0 → 关闭", () => {
  const core = [hit("a"), hit("b")];
  assert.deepEqual(applyLexGuard(core, [hit("a")], 2, 2).map((h) => h.id), ["a", "b"]);
  assert.deepEqual(applyLexGuard(core, [hit("z")], 2, 0).map((h) => h.id), ["a", "b"]);
});

test("邻居扩展 ±1：带回命中 chunk 的 prev/next，命中在前邻居在后，去重", () => {
  const core = [hit("c2", { prev_chunk_id: "c1", next_chunk_id: "c3" })];
  const store: Record<string, SearchHit> = {
    c1: hit("c1", { next_chunk_id: "c2" }),
    c3: hit("c3", { prev_chunk_id: "c2", next_chunk_id: "c4" }),
    c4: hit("c4"),
  };
  const fetch = async (ids: string[]) => ids.map((id) => store[id]).filter(Boolean) as SearchHit[];
  return expandNeighbors(core, 1, fetch).then((out) => {
    assert.deepEqual(out.map((h) => h.id), ["c2", "c1", "c3"]); // 只扩 1 跳，不含 c4
    assert.equal(out[0]!.via, undefined); // 主命中无 via
    assert.equal(out[1]!.via, "neighbor"); // 邻居标 via
    assert.equal(out[2]!.via, "neighbor");
  });
});

test("邻居扩展 ±2：沿链多跳；n=0 关闭", async () => {
  const core = [hit("c2", { prev_chunk_id: "c1", next_chunk_id: "c3" })];
  const store: Record<string, SearchHit> = {
    c1: hit("c1", { next_chunk_id: "c2" }),
    c3: hit("c3", { prev_chunk_id: "c2", next_chunk_id: "c4" }),
    c4: hit("c4", { prev_chunk_id: "c3" }),
  };
  const fetch = async (ids: string[]) => ids.map((id) => store[id]).filter(Boolean) as SearchHit[];
  const out = await expandNeighbors(core, 2, fetch);
  assert.deepEqual(new Set(out.map((h) => h.id)), new Set(["c2", "c1", "c3", "c4"]));
  const off = await expandNeighbors(core, 0, fetch);
  assert.deepEqual(off.map((h) => h.id), ["c2"]);
});
