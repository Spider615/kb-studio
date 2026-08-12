import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sql, createProcessingDoc } from "@kb/db";
import { processDoc } from "../../../web/lib/kb";

/**
 * 恢复工装：把 `.uploads/` 里的上传原件重新灌回库（docs/chunks 被清空后用）。
 *
 * 走的是 web 上传接口的同一条管线（`processDoc`：解析→造结构→切片→上下文化→向量→ready），
 * 不复制管线逻辑。`saveOriginal` 存盘时用的就是 `docId + 扩展名`，所以文件名天然带着原
 * docId —— 重灌后 doc id 不变、`docs.file_id` 仍指向同一个文件，原文件预览照常可用。
 *
 * ⚠️ 原始文件名（原来的 `docs.title`）随 docs 表一起没了，磁盘上只剩 `doc_xxx.ext`。
 * 脚本在入库后用正文首个 H1 回填标题；拿不到 H1 的只能留 `doc_xxx.ext`。
 * 另外上下文化本来会从文件名补品牌/归属，这一路信息这次拿不到了。
 *
 * 用法：
 *   npm run reingest-uploads -- --user <邮箱|userId> [--dir <目录>] [--group <groupId>]
 *                               [--concurrency 2] [--dry-run] [--force]
 */

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name: string) => argv.includes(`--${name}`);

const userRef = arg("user");
const dir = path.resolve(arg("dir") ?? path.join(process.cwd(), "apps/web/.uploads"));
const groupId = arg("group") ?? null;
const concurrency = Math.max(1, Number(arg("concurrency", "2")));
const dryRun = flag("dry-run");
const force = flag("force");

if (!userRef) {
  console.error("用法: npm run reingest-uploads -- --user <邮箱|userId> [--dir <目录>] [--group <groupId>]");
  process.exit(1);
}

// ---- 1. 解析归属用户 ----
const user = (await sql`SELECT id, email FROM users WHERE id = ${userRef} OR email = ${userRef} LIMIT 1`)[0];
if (!user) {
  console.error(`✗ 找不到用户：${userRef}`);
  process.exit(1);
}

// ---- 2. 校验分组归属（传了才校验；不属于该用户会导致文档在界面上看不见）----
if (groupId) {
  const g = (await sql`SELECT id, name, user_id FROM groups WHERE id = ${groupId} LIMIT 1`)[0];
  if (!g) {
    console.error(`✗ 分组不存在：${groupId}`);
    process.exit(1);
  }
  if (g.user_id !== user.id) {
    console.error(`✗ 分组 ${g.name} 不属于 ${user.email}，入库后该用户看不到`);
    process.exit(1);
  }
}

// ---- 3. 列出原件（文件名即 docId+扩展名）----
const entries = (await readdir(dir).catch(() => [] as string[]))
  .filter((f) => /^doc_[0-9a-z]+\.[a-z0-9]+$/i.test(f))
  .sort();

if (!entries.length) {
  console.error(`✗ ${dir} 下没有 doc_*.* 原件`);
  process.exit(1);
}

// 只跳过已 ready 的（脚本可重复跑）：failed/processing 的会自动重试——批量重灌最常见的
// 失败就是方舟 TPM 瞬时限流，重跑一次通常就好。--force 则连 ready 的也重灌。
const done_ = new Set(
  (await sql`SELECT id FROM docs WHERE status = 'ready'`).map((r: any) => String(r.id)),
);
const todo = entries.filter((f) => force || !done_.has(path.parse(f).name));
const skipped = entries.length - todo.length;

console.log(`原件目录 : ${dir}`);
console.log(`归属用户 : ${user.email} (${user.id})${groupId ? ` / 分组 ${groupId}` : " / 未分组"}`);
console.log(`待重灌   : ${todo.length} 个${skipped ? `（跳过已在库的 ${skipped} 个）` : ""}`);
console.log(`并发     : ${concurrency}\n`);

if (dryRun) {
  todo.forEach((f) => console.log(`  [dry-run] ${f}`));
  process.exit(0);
}

// ---- 4. 逐个重灌（限并发；processDoc 内部还有全局解析闸）----
const ok: string[] = [];
const failed: { file: string; err: string }[] = [];
let done = 0;

// 「Sheet1」「工作表1」这类占位名不是标题，回填了反而更难认，保留 doc_xxx.ext
const GENERIC_HEADING = /^(sheet\s*\d*|工作表\s*\d*|表\s*\d*|根|untitled)$/i;

/**
 * 首个 chunk 的 heading_path[0] → 标题。
 * 原文件名随 docs 表一起丢了，而 `ingestDoc` 只写 chunks、不回存整篇 markdown
 * （docs.raw_text/structured_md 都是 NULL），所以可读标题只能从 chunk 的标题路径取：
 * pdf/docx/md 拿到的是正文首个 H1（通常就是真标题）；xlsx/csv 拿到的是 sheet 名，
 * 叫 Sheet1 的那种按占位名跳过。
 */
async function deriveTitle(docId: string): Promise<string | null> {
  const row = (await sql`
    SELECT metadata->'heading_path'->>0 AS h
    FROM chunks WHERE doc_id = ${docId}
    ORDER BY chunk_index LIMIT 1
  `)[0];
  const t = String(row?.h ?? "").trim().replace(/\s+/g, " ");
  if (!t || GENERIC_HEADING.test(t)) return null;
  return t.slice(0, 80);
}

async function reingest(file: string): Promise<void> {
  const docId = path.parse(file).name;
  const bytes = new Uint8Array(await readFile(path.join(dir, file)));

  // 旧行（failed/processing，或 --force 下的 ready）先清掉，否则建行撞主键
  await sql`DELETE FROM chunks WHERE doc_id = ${docId}`;
  await sql`DELETE FROM docs WHERE id = ${docId}`;
  // title/source 先占位成存储名，入库后再用 H1 回填
  await createProcessingDoc(docId, file, file, file, user.id, groupId);
  await processDoc(docId, bytes, file);

  // processDoc 内部吞掉异常并把行标 failed，这里查状态判定结果
  const row = (await sql`SELECT status, error FROM docs WHERE id = ${docId}`)[0];
  const n = ++done;
  if (!row || row.status !== "ready") {
    const err = String(row?.error ?? "行已不存在");
    failed.push({ file, err });
    console.log(`[${n}/${todo.length}] ✗ ${file} — ${err.slice(0, 120)}`);
    return;
  }

  const title = await deriveTitle(docId);
  if (title) await sql`UPDATE docs SET title = ${title} WHERE id = ${docId}`;
  const cnt = (await sql`SELECT count(*)::int AS n FROM chunks WHERE doc_id = ${docId}`)[0];
  ok.push(file);
  console.log(`[${n}/${todo.length}] ✓ ${file} → 《${title ?? file}》 ${cnt?.n ?? 0} chunk`);
}

let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (cursor < todo.length) {
      const file = todo[cursor++]!;
      try {
        await reingest(file);
      } catch (e: any) {
        failed.push({ file, err: String(e?.message ?? e) });
        console.log(`[${++done}/${todo.length}] ✗ ${file} — ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  }),
);

// ---- 5. 汇总 ----
const total = (await sql`SELECT (SELECT count(*)::int FROM docs) d, (SELECT count(*)::int FROM chunks) c`)[0];
console.log(`\n成功 ${ok.length} / 失败 ${failed.length}`);
if (failed.length) failed.forEach((f) => console.log(`  ✗ ${f.file}: ${f.err.slice(0, 160)}`));
console.log(`库内现有：${total?.d ?? "?"} 篇文档 / ${total?.c ?? "?"} 个 chunk`);
process.exit(failed.length ? 1 : 0);
