import test from "node:test";
import assert from "node:assert/strict";
import { buildCitedDocsBlock, parseCitations } from "./citations";

const CHUNKS = [
  { id: "doc_1_c0001", content: "保修期为一年。", heading_path: ["售后", "保修"] },
  { id: "doc_1_c0002", content: "支持七天无理由退货。", heading_path: ["售后"] },
  { id: "doc_1_c0003", content: "运费买家承担。", heading_path: [] },
];

test("buildCitedDocsBlock 从 1 开始编号，带标题路径", () => {
  const block = buildCitedDocsBlock(CHUNKS);
  assert.match(block, /\[1\]（售后 · 保修）\n保修期为一年。/);
  assert.match(block, /\[2\]（售后）\n支持七天无理由退货。/);
  assert.match(block, /\[3\]\n运费买家承担。/); // 无 heading_path 时不带括号
});

test("解析引用并按首次出现顺序去重", () => {
  const { sources } = parseCitations("保修一年[1]，可退货[2]，另见[1]。", CHUNKS);
  assert.deepEqual(
    sources.map((s) => s.id),
    ["doc_1_c0001", "doc_1_c0002"],
  );
  assert.deepEqual(sources[0]!.heading_path, ["售后", "保修"]);
});

test("越界序号被丢弃（模型编造来源的主要形态）", () => {
  const { sources } = parseCitations("依据[9]和[0]以及[2]。", CHUNKS);
  assert.deepEqual(
    sources.map((s) => s.id),
    ["doc_1_c0002"],
  );
});

test("支持 [1][3] 与 [1,2] / [1、2] 多种并列写法", () => {
  assert.deepEqual(
    parseCitations("a[1][3]", CHUNKS).sources.map((s) => s.id),
    ["doc_1_c0001", "doc_1_c0003"],
  );
  assert.deepEqual(
    parseCitations("a[1,2]", CHUNKS).sources.map((s) => s.id),
    ["doc_1_c0001", "doc_1_c0002"],
  );
  assert.deepEqual(
    parseCitations("a[1、3]", CHUNKS).sources.map((s) => s.id),
    ["doc_1_c0001", "doc_1_c0003"],
  );
});

test("默认剥掉标记，且不在标点前留空格", () => {
  const { answer } = parseCitations("保修期为一年[1]，支持退货[2]。", CHUNKS);
  assert.equal(answer, "保修期为一年，支持退货。");
});

test("stripMarkers=false 时保留标记原文", () => {
  const { answer } = parseCitations("保修期为一年[1]。", CHUNKS, { stripMarkers: false });
  assert.equal(answer, "保修期为一年[1]。");
});

test("不误伤 markdown 链接（[文字](url) 里的方括号非纯数字）", () => {
  const { answer, sources } = parseCitations("见[文档](http://a.b)说明[1]。", CHUNKS);
  assert.equal(answer, "见[文档](http://a.b)说明。");
  assert.deepEqual(
    sources.map((s) => s.id),
    ["doc_1_c0001"],
  );
});

test("无引用时返回空 sources，正文不变", () => {
  const { answer, sources } = parseCitations("没有找到相关内容。", CHUNKS);
  assert.equal(answer, "没有找到相关内容。");
  assert.deepEqual(sources, []);
});
