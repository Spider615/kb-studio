import "dotenv/config";
import zlib from "node:zlib";
import { makeLlm } from "@kb/adapters";

/**
 * 火山方舟对话层自检：只打 LLM，不碰 302 向量 / reranker / 数据库。
 *
 * 存在的意义：其余 demo（enrich / ingest / answer / chat）都要先过 302 的 embedding 和 pgvector，
 * 任一环境没配好就跑不到模型这一步，无法判断「方舟这条链路本身通不通」。迁移后回归、
 * 或换模型 ID 后想快速确认，跑这个最省事：`npm run ark-check`。
 *
 * 重点在第 3 项：引用标记。Anthropic 的 citations 是协议级保证，豆包只能靠指令遵循，
 * 准确率是本次迁移唯一无法靠文档预判的东西，必须实测。
 */

const llm = makeLlm();
const model = process.env.KB_MODEL_CONTEXT ?? "(默认)";
const answerModel = process.env.KB_MODEL_ANSWER ?? "(默认)";
console.log(`后端=${process.env.KB_LLM ?? "ark"} 对话模型=${model} 问答模型=${answerModel}\n`);

let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "✅" : "❌"} ${name}：${detail}`);
  if (!ok) failed++;
}

// ---- 1. 上下文化（含「从文件名补出归属」这条要求）----
const DOC = `# 2024 年产品价格表

## 空调系列

型号 KF-35，制冷量 3500W，零售价 2999 元。
型号 KF-50，制冷量 5000W，零售价 4299 元。

## 冰箱系列

型号 BCD-210，容积 210L，零售价 1899 元。`;

const prefix = await llm.contextualize(DOC, "型号 KF-50，制冷量 5000W，零售价 4299 元。", "美的-2024年产品价格表.xlsx");
check(
  "上下文化",
  prefix.length >= 10 && prefix.length <= 200,
  `${prefix.length} 字 | ${prefix.slice(0, 80)}${prefix.length > 80 ? "…" : ""}`,
);
check("  └ 归属补全（品牌应从文件名补出）", /美的/.test(prefix), /美的/.test(prefix) ? "含「美的」" : `未补出品牌：${prefix}`);

// ---- 2. 多轮检索改写（指代消解）----
const rewritten = await llm.rewriteQuery("用户：KF-50 多少钱？\n助手：4299 元。", "那它的制冷量呢？");
check(
  "检索改写",
  rewritten.length > 0 && /KF-50|KF50/i.test(rewritten),
  rewritten || "(空)",
);

// ---- 3. 引用溯源（本次迁移的核心未知项）----
const CHUNKS = [
  { id: "doc_x_c0001", content: "空调 KF-35 的制冷量为 3500W，零售价 2999 元。", heading_path: ["空调系列"] },
  { id: "doc_x_c0002", content: "空调 KF-50 的制冷量为 5000W，零售价 4299 元。", heading_path: ["空调系列"] },
  { id: "doc_x_c0003", content: "冰箱 BCD-210 的容积为 210L，零售价 1899 元。", heading_path: ["冰箱系列"] },
  { id: "doc_x_c0004", content: "全线产品整机保修三年，压缩机保修十年。", heading_path: ["售后"] },
];

const cases: Array<{ q: string; want: string[] }> = [
  { q: "KF-50 多少钱？", want: ["doc_x_c0002"] },
  { q: "冰箱容积多大？保修多久？", want: ["doc_x_c0003", "doc_x_c0004"] },
];

for (const c of cases) {
  const { answer, sources } = await llm.answer(c.q, CHUNKS);
  const got = sources.map((s) => s.id);
  const hit = c.want.every((w) => got.includes(w));
  check(
    `引用溯源「${c.q}」`,
    hit && got.length > 0,
    `期望含 ${c.want.join(",")} | 实得 ${got.join(",") || "(无引用)"}`,
  );
  console.log(`     答：${answer.replace(/\n/g, " ").slice(0, 100)}`);
  // 标记必须已被剥掉：残留 [1] 会直接显示在前端
  check("  └ 标记已从正文剥离", !/\[\s*\d+\s*\]/.test(answer), /\[\s*\d+\s*\]/.test(answer) ? `残留：${answer.slice(0, 60)}` : "无残留");
}

// ---- 4. 幻觉防线：问资料里没有的东西，不该编造引用 ----
{
  const { answer, sources } = await llm.answer("洗衣机什么价格？", CHUNKS);
  console.log(`\n  越界提问答：${answer.replace(/\n/g, " ").slice(0, 100)}`);
  console.log(`  引用：${sources.map((s) => s.id).join(",") || "(无)"}（资料无洗衣机，理想为空或极少）`);
}

// ---- 5. vision（扫描件 OCR 走这条）----
{
  const png = makeTestPng();
  const desc = await llm.vision(png, "描述这张图，20 字内");
  check("vision 图片输入", desc.length > 0, desc.slice(0, 60));
}

console.log(`\n${failed === 0 ? "✅ 方舟对话层全部通过" : `❌ ${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);

/** 生成一张 64x64 蓝底白横条 PNG（base64），不依赖任何图像库。 */
function makeTestPng(): string {
  const w = 64;
  const h = 64;
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const px = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const o = 1 + x * 3;
      if (y >= 26 && y < 38) {
        px[o] = 255;
        px[o + 1] = 255;
        px[o + 2] = 255;
      } else {
        px[o] = 0x1e;
        px[o + 1] = 0x4d;
        px[o + 2] = 0xd8;
      }
    }
    rows.push(px);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdrData),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
