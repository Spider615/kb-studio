import { randomUUID } from "node:crypto";
import {
  LlmClient,
  OpenAICompatEmbedder,
  Reranker302,
  SandboxDockerParser,
  TabularSandboxParser,
  DocxSandboxParser,
  PdfParser,
  ClaudeCodeSandboxParser,
  ArchiveExtractor,
} from "@kb/adapters";
import type { ParserBackend } from "@kb/core";
import { ingestDoc } from "@kb/pipeline";
import { createProcessingDoc, setDocProgress, failDoc, clearDocProgress, getDocStatus } from "@kb/db";
import { startJob, endJob } from "./jobs";
import { saveOriginal } from "./files";

/**
 * 解析后端按文件类型分流：
 * - csv/xlsx → TabularSandboxParser（容器内确定性解析，逐行保真、无模型、最快）
 * - pdf → PdfParser（判扫描件：有文本层走 Claude Code，扫描件走 vision 逐页 OCR）
 * - 其余 → SandboxDockerParser（容器化 Claude Code，处理 docx/复杂布局）
 * 设 KB_PARSER=host 则强制退回宿主机进程内 Claude Code（调试用）。
 */
export function getParser(filename?: string): ParserBackend {
  if ((process.env.KB_PARSER ?? "docker").toLowerCase() === "host") {
    return new ClaudeCodeSandboxParser();
  }
  const ext = (filename ?? "").toLowerCase();
  if (/\.(csv|tsv|xlsx?|xlsm)$/.test(ext)) return new TabularSandboxParser();
  if (ext.endsWith(".docx")) {
    // 确定性 python-docx 优先，图文/复杂布局或产出过少 → 退回 Claude Code
    return new DocxSandboxParser(new SandboxDockerParser());
  }
  if (ext.endsWith(".pdf")) {
    return new PdfParser({ llm: new LlmClient(), fallback: new SandboxDockerParser() });
  }
  return new SandboxDockerParser();
}

/**
 * 是否对解析结果做 LLM 造结构：仅当「无标题 + 有一定篇幅」时触发；
 * 已有标题、太短、或表格类（调用方会先排除）都跳过。设 KB_AUTO_STRUCTURE=off 全局关闭。
 */
export function shouldStructure(markdown: string): boolean {
  if ((process.env.KB_AUTO_STRUCTURE ?? "on").toLowerCase() === "off") return false;
  const headings = (markdown.match(/^#{1,6}\s/gm) || []).length;
  // 表格为主的文档（如无标题的表格类 docx）造结构价值低、只会插几个 H2 → 跳过，省一次 LLM
  const lines = markdown.split("\n").filter((l) => l.trim());
  const tableLines = lines.filter((l) => /^\s*\|/.test(l)).length;
  if (lines.length && tableLines / lines.length > 0.6) return false;
  const blocks = markdown.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
  return headings === 0 && blocks >= 4;
}

/** 构造 302 网关的一套依赖（LLM / embedder / reranker）。 */
export function getDeps() {
  const llm = new LlmClient();
  const embedder = new OpenAICompatEmbedder({
    baseUrl: process.env.EMBED_BASE_URL ?? "https://api.302.ai/v1",
    apiKey: process.env.EMBED_API_KEY,
    model: process.env.EMBED_MODEL ?? "BAAI/bge-m3",
    dimensions: Number(process.env.EMBED_DIM ?? 1024),
  });
  const reranker = new Reranker302();
  return { llm, embedder, reranker };
}

// 全局解析并发闸：UI 多选上传 / collector / 压缩包解压 三个入口共用同一上限，
// 避免一次性起几十个解析容器（每个 --cpus 2 --memory 3g）把机器/Docker 压垮或 OOM。
// 默认 3，可用 KB_PARSE_CONCURRENCY 调整。槽位在 release 时直接交接给等待者（不减计数），
// 防止交接瞬间被新请求插队导致超额。
const PARSE_CONCURRENCY = Math.max(1, Number(process.env.KB_PARSE_CONCURRENCY ?? 3));
let activeParses = 0;
const parseWaiters: Array<() => void> = [];
async function acquireParseSlot(): Promise<void> {
  if (activeParses < PARSE_CONCURRENCY) {
    activeParses++;
    return;
  }
  await new Promise<void>((resolve) => parseWaiters.push(resolve)); // 槽位由 release 交接，醒来即持有
}
function releaseParseSlot(): void {
  const next = parseWaiters.shift();
  if (next) next(); // 直接交接，不动计数
  else activeParses = Math.max(0, activeParses - 1);
}

/**
 * 后台处理一篇已建行的文档：解析 →（条件）造结构 → 入库（chunk→上下文化→embed→存）。
 * 经 startJob/endJob 注册到任务表，可被 abortJob 中止（删处理中文档时）。
 * 文档行须已由 createProcessingDoc 建好；ingestDoc 末尾把 status 置 ready。
 * /api/upload（cookie 上传）与 /api/ingest（服务端按 ref 入库）共用此函数。
 */
export async function processDoc(docId: string, bytes: Uint8Array, filename: string): Promise<void> {
  const signal = startJob(docId);
  try {
    // isTabular：纯表格文件（跳过造结构、开概览）；tableChunks：启用表格多行打包（也含 docx 内嵌表，只作用于表块）
    const isTabular = /\.(csv|tsv|xlsx?|xlsm)$/i.test(filename);
    const tableChunks = isTabular || /\.docx$/i.test(filename);
    const { llm, embedder } = getDeps();

    // 1. 解析（带重试：容器内 claude 子进程偶发 spawn 失败 / 302 网关瞬时抖动会让单次解析挂掉，
    //    没有重试时一次抖动 = 整篇文档永久 failed、需人工重传。OOM/超时不重试：重试既修不好又很贵。
    //    重试次数可用 KB_PARSE_RETRIES 调，默认 2（即最多 3 次尝试）。）
    await setDocProgress(docId, { stage: "parsing", done: 0, total: 0 });
    const parser = getParser(filename);
    const maxParseRetries = Number(process.env.KB_PARSE_RETRIES ?? 2);
    let markdown = "";
    for (let attempt = 0; ; attempt++) {
      // 全局并发闸只圈住真正吃资源的 parse（起容器那段）；退避 sleep 期间不占槽，让别的文档先跑
      let attemptErr: any = null;
      await acquireParseSlot();
      try {
        markdown = (await parser.parse({ bytes, filename })).markdown;
      } catch (e: any) {
        attemptErr = e;
      } finally {
        releaseParseSlot();
      }
      if (!attemptErr) break;
      if (signal.aborted) return;
      const msg = String(attemptErr?.message ?? attemptErr);
      const permanent = /OOM|退出码 137|解析超时|timed out/i.test(msg);
      if (permanent || attempt >= maxParseRetries) throw attemptErr;
      const waitMs = 2000 * (attempt + 1);
      console.warn(
        `[processDoc] 解析失败(第${attempt + 1}/${maxParseRetries + 1}次)，${waitMs}ms 后重试 ${filename}: ${msg}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      if (signal.aborted) return;
    }
    if (signal.aborted) return;

    // 2. 造结构（条件，失败不致命）；纯表格跳过，docx/其他无标题文档仍可造结构
    if (!isTabular && shouldStructure(markdown)) {
      await setDocProgress(docId, { stage: "structuring", done: 0, total: 0 });
      try {
        markdown = await llm.structure(markdown);
      } catch (e: any) {
        console.error("[processDoc] structure 失败，按原文入库:", e?.message ?? e);
      }
    }
    if (signal.aborted) return;

    // 3. 入库（chunk → 上下文化(进度) → embed → 存）；ingestDoc 末尾把 status 置 ready
    await ingestDoc(
      { docId, title: filename, source: filename, markdown },
      { llm, embedder },
      {
        tableRowChunks: tableChunks,
        tableOverviewChunk: isTabular, // 概览只给纯数据表；docx 内嵌表多为排版/键值表，概览是噪声
        signal,
        onProgress: (p) => setDocProgress(docId, p),
      },
    );

    if (signal.aborted) return;
    await clearDocProgress(docId);
  } catch (e: any) {
    if (e?.name === "AbortError" || signal.aborted) return; // 被取消：行已删，静默
    // 行可能已被用户删除（删处理中文档）；还在才标失败
    const st = await getDocStatus(docId).catch(() => null);
    if (st) await failDoc(docId, String(e?.message ?? e)).catch(() => {});
    console.error("[processDoc] 处理失败:", e?.message ?? e);
  } finally {
    endJob(docId);
  }
}

/** 限并发跑一批任务（压缩包扇出时避免一次起几十个解析容器拖垮机器）。 */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx]);
      } catch {
        /* processDoc 内部已兜底标 failed，这里不让单个失败拖垮整批 */
      }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

/** 上传文件名是否是受支持的压缩包（路由据此决定走单文件还是后台解压扇出）。 */
export function isArchiveUpload(filename: string): boolean {
  return ArchiveExtractor.isArchive(filename);
}

/** 单个普通文件：建 processing 行 + 后台处理，返回 docId（路由可立即响应）。 */
export async function ingestSingleFile(
  bytes: Uint8Array,
  filename: string,
  userId: string,
  groupId: string | null,
): Promise<string> {
  const docId = await createDocRow(bytes, filename, userId, groupId);
  void processDoc(docId, bytes, filename);
  return docId;
}

/**
 * 压缩包：沙箱解压 → 每个包内文件一个 doc（同 user/group）→ 限并发后台处理。
 * 整个过程（含解压）都在后台跑，绝不抛给调用方——路由应 `void ingestArchive(...)` 后立即返回，
 * 避免同步等解压撑爆 collector 的请求超时。每个文件建行独立 try/catch：单个失败只丢它一个，
 * 不会留下永远 processing 的僵尸行（其余文件照常被 runPool 处理）。
 */
export async function ingestArchive(
  bytes: Uint8Array,
  filename: string,
  userId: string,
  groupId: string | null,
): Promise<void> {
  let extracted;
  try {
    extracted = await new ArchiveExtractor().extract({ bytes, filename });
  } catch (e: any) {
    console.error(`[ingest] 压缩包解压失败 ${filename}:`, e?.message ?? e);
    return;
  }
  const { files, skipped, truncated } = extracted;
  if (skipped.length || truncated)
    console.log(`[ingest] ${filename}: 解压 ${files.length} 个文件，跳过 ${skipped.length} 个${truncated ? "，已截断" : ""}`);
  if (!files.length) {
    console.warn(`[ingest] 压缩包内没有可入库的文件: ${filename}`);
    return;
  }

  const created: { docId: string; bytes: Uint8Array; title: string }[] = [];
  for (const f of files) {
    try {
      const docId = await createDocRow(f.bytes, f.filename, userId, groupId);
      created.push({ docId, bytes: f.bytes, title: f.filename });
    } catch (e: any) {
      // 单个建行失败只丢这个文件，不影响其余（也不留僵尸行）
      console.error(`[ingest] 建文档行失败，跳过 ${f.filename}:`, e?.message ?? e);
    }
  }
  // 限并发处理（最多 3 个同时解析）
  await runPool(created, 3, (d) => processDoc(d.docId, d.bytes, d.title));
}

/** 建一行 processing 文档（落原文件供预览 + createProcessingDoc）。返回 docId。 */
async function createDocRow(
  bytes: Uint8Array,
  filename: string,
  userId: string,
  groupId: string | null,
): Promise<string> {
  const docId = "doc_" + randomUUID().slice(0, 8);
  let fileId: string | null = null;
  try {
    fileId = await saveOriginal(docId, filename, bytes);
  } catch (e: any) {
    console.error("[ingest] 存原文件失败:", e?.message ?? e);
  }
  await createProcessingDoc(docId, filename, filename, fileId, userId, groupId);
  return docId;
}
