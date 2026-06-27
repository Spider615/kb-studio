import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";
import type { LlmClient } from "../llm/llm-client";

const execFileAsync = promisify(execFile);

interface RenderResult {
  scanned: boolean;
  page_count: number;
  avg_chars: number;
  rendered: number;
  truncated: boolean;
  pages: string[]; // 每页 PNG base64（仅扫描件填充）
}

function ocrPrompt(n: number, total: number): string {
  return [
    `这是一份扫描文档的第 ${n}/${total} 页。请逐字转写本页中的所有文字，输出为 Markdown：`,
    "- 保留标题层级（#/##/###）、列表、表格结构，按自然阅读顺序",
    "- 不要翻译、不要总结、不要添加任何解释或「这页显示…」之类的元描述",
    "- 本页若是纯图片/图表且无文字，只输出一行：（本页为图片，无文字）",
  ].join("\n");
}

export interface PdfParserOptions {
  llm: LlmClient; // vision OCR
  fallback: ParserBackend; // 非扫描件走 Claude Code
  image?: string;
  maxPages?: number; // 扫描件最多 OCR 几页（默认 50）
  scale?: number; // 渲染倍率（默认 2.0，OCR 清晰度）
  charThreshold?: number; // 平均每页字符 < 此值判为扫描件（默认 8）
  concurrency?: number; // vision 并发（默认 4）
  renderTimeoutMs?: number;
}

/**
 * PDF 解析后端：先在容器里判断是否扫描件（pdfplumber 文本覆盖率）。
 *  - 有文本层 → 委托 fallback（Claude Code 容器解析，不变）；
 *  - 扫描件（几乎无文本）→ pypdfium2 逐页渲染 PNG → 逐页 302 vision OCR（并发）→ 拼成 markdown。
 * 渲染无网络（--network none）；vision 调用在 Node 经 LlmClient 走 302。
 */
export class PdfParser implements ParserBackend {
  private llm: LlmClient;
  private fallback: ParserBackend;
  private image: string;
  private maxPages: number;
  private scale: number;
  private charThreshold: number;
  private concurrency: number;
  private renderTimeoutMs: number;
  private memory: string;

  constructor(opts: PdfParserOptions) {
    this.llm = opts.llm;
    this.fallback = opts.fallback;
    this.image = opts.image ?? process.env.KB_SANDBOX_IMAGE ?? "kb-sandbox:latest";
    this.maxPages = opts.maxPages ?? 50;
    this.scale = opts.scale ?? 2.0;
    this.charThreshold = opts.charThreshold ?? 8;
    this.concurrency = opts.concurrency ?? 4;
    this.renderTimeoutMs = opts.renderTimeoutMs ?? 120_000;
    this.memory = process.env.KB_SANDBOX_MEMORY ?? "3g"; // 与 SandboxDockerParser 同一旋钮，Docker 内存紧时可调小
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const bytes =
      input.bytes ?? (input.filePath ? new Uint8Array(await readFile(input.filePath)) : undefined);
    if (!bytes) throw new Error("PdfParser.parse: 需要 filePath 或 bytes");
    const filename = input.filename || (input.filePath ? basename(input.filePath) : "upload.pdf");

    const dir = await mkdtemp(join(tmpdir(), "kb-pdf-"));
    const hostPath = join(dir, filename);
    try {
      await writeFile(hostPath, Buffer.from(bytes));

      // 1. 容器里判扫描 + （扫描则）逐页渲染。渲染/检测失败 → 退回 Claude Code。
      let meta: RenderResult;
      try {
        meta = await this.render(hostPath, filename);
      } catch {
        return this.fallback.parse(input);
      }

      // 2. 非扫描件 → Claude Code 解析
      if (!meta.scanned || meta.pages.length === 0) {
        return this.fallback.parse(input);
      }

      // 3. 扫描件 → 逐页 vision OCR（并发）
      const pages: string[] = new Array(meta.pages.length).fill("");
      await mapLimit(meta.pages, this.concurrency, async (b64, i) => {
        pages[i] = await this.ocrPage(b64, i + 1, meta.page_count);
      });
      let markdown = pages.join("\n\n").trim();
      if (meta.truncated) {
        markdown += `\n\n<!-- 注：原文档共 ${meta.page_count} 页，仅 OCR 了前 ${meta.rendered} 页 -->`;
      }

      return {
        markdown,
        images: [],
        raw_text: markdown,
        scanned: true,
        meta: {
          backend: "pdf-vision-ocr",
          page_count: meta.page_count,
          rendered: meta.rendered,
          truncated: meta.truncated,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async ocrPage(b64: string, n: number, total: number): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (await this.llm.vision(b64, ocrPrompt(n, total))).trim();
      } catch {
        if (attempt === 1) return `（第 ${n} 页 OCR 失败）`;
      }
    }
    return "";
  }

  private async render(hostPath: string, filename: string): Promise<RenderResult> {
    const args = [
      "run", "--rm",
      "--network", "none",
      "-v", `${hostPath}:/work/${filename}:ro`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "128",
      "--memory", this.memory,
      "--cpus", "2",
      "--tmpfs", "/tmp:rw,size=256m",
      "--entrypoint", "python",
      this.image,
      "/app/apps/worker/python/pdf_render.py",
      `/work/${filename}`,
      "--max-pages", String(this.maxPages),
      "--scale", String(this.scale),
      "--char-threshold", String(this.charThreshold),
    ];
    const r = await execFileAsync("docker", args, {
      timeout: this.renderTimeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(r.stdout) as RenderResult;
  }
}

/** 受限并发遍历。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}
