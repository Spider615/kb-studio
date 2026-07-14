import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChunkPrefix } from "./ingest";

test("resolveChunkPrefix：LLM 织入结果优先，原样返回", () => {
  assert.equal(
    resolveChunkPrefix("精骐&捷美2022年产品价格表中，产品A", "2022年-精骐&捷美-产品价格表.csv", ["Sheet1"]),
    "精骐&捷美2022年产品价格表中，产品A",
  );
});

test("resolveChunkPrefix：LLM 空串/null → 确定性《文件名》· 章节（含文件名）", () => {
  assert.equal(resolveChunkPrefix("", "报表.csv", ["Sheet1", "华东区"]), "《报表.csv》 · Sheet1 · 华东区");
  assert.equal(resolveChunkPrefix(null, "报表.csv", ["Sheet1", "华东区"]), "《报表.csv》 · Sheet1 · 华东区");
});

test("resolveChunkPrefix：无 heading_path → 只有《文件名》", () => {
  assert.equal(resolveChunkPrefix(null, "报表.csv", []), "《报表.csv》");
});

test("resolveChunkPrefix：纯空白 LLM 结果视为空，退兜底", () => {
  assert.equal(resolveChunkPrefix("   ", "报表.csv", []), "《报表.csv》");
});

test("resolveChunkPrefix：非空 LLM 前缀去除首尾空白", () => {
  assert.equal(resolveChunkPrefix("  精骐&捷美产品A  ", "报表.csv", []), "精骐&捷美产品A");
});
