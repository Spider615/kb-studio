import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";

const FILES_BETA = "files-api-2025-04-14";
const CODE_EXEC_TOOL = { type: "code_execution_20260120", name: "code_execution" };

export interface ClaudeSandboxParserOptions {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
}

/**
 * 在 Claude 的 code-execution 沙箱里解析文件：
 *   上传文件 → Claude 用 Python（pdfplumber / python-docx / openpyxl / pandas …）
 *   解析成 Markdown 写到 /mnt/session/outputs/parsed.md → 取回。
 *
 * ⚠️ 与 Anthropic SDK 的交互按官方文档 wire shape 写成，但用松类型（client as any），
 *    需用真实 ANTHROPIC_API_KEY + 当前版本 SDK 跑通验证（block 结构可能随版本微调）。
 */
export class ClaudeSandboxParser implements ParserBackend {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(opts: ClaudeSandboxParserOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-haiku-4-5";
    this.maxTokens = opts.maxTokens ?? 8000;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const bytes =
      input.bytes ??
      (input.filePath ? new Uint8Array(await readFile(input.filePath)) : undefined);
    if (!bytes) throw new Error("ClaudeSandboxParser.parse: 需要 filePath 或 bytes");
    const filename =
      input.filename || (input.filePath ? basename(input.filePath) : "upload.bin");

    const client: any = this.client;

    // 1) 上传文件到 Files API
    const uploaded = await client.beta.files.upload({
      file: await toFile(Buffer.from(bytes), filename, input.mime ? { type: input.mime } : undefined),
      betas: [FILES_BETA],
    });

    // 2) 进沙箱解析
    const response = await client.beta.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      betas: [FILES_BETA],
      tools: [CODE_EXEC_TOOL],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildParsePrompt(filename) },
            { type: "container_upload", file_id: uploaded.id },
          ],
        },
      ],
    });

    // 3) 取回 parsed.md（优先沙箱产物文件；取不到则退回正文文本）
    const fromFile = await downloadParsedMarkdown(client, response);
    const markdown = (fromFile ?? collectText(response)).trim();
    const scanned = /<!--\s*SCANNED/i.test(markdown);

    return {
      markdown,
      images: [],
      raw_text: markdown,
      scanned,
      meta: { file_id: uploaded.id },
    };
  }
}

function buildParsePrompt(filename: string): string {
  return [
    `容器里挂载了一个上传的文件，文件名约为 \`${filename}\`。请先用 bash 定位它（如 \`ls -R /mnt\` 或当前目录）。`,
    `然后用合适的 Python 库把它解析成干净的 Markdown：`,
    `- pdf → pdfplumber 抽文本；若几乎无文本（扫描件），在 Markdown 顶部写一行 \`<!-- SCANNED: needs vision OCR -->\``,
    `- docx → python-docx，把 Heading 样式映射成 #/##/###`,
    `- xlsx → openpyxl/pandas，每个 sheet 一个 \`##\` 标题，表格转 Markdown 表`,
    `- csv → pandas 转 Markdown 表`,
    `- md/txt → 直接读`,
    `保留标题层级与表格结构；不要总结、不要改写正文。`,
    `把结果写入 \`/mnt/session/outputs/parsed.md\`（UTF-8）。完成后只回复 \`DONE\`。`,
  ].join("\n");
}

function collectText(response: any): string {
  return (response?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

async function downloadParsedMarkdown(client: any, response: any): Promise<string | null> {
  const fileIds: string[] = [];
  for (const block of response?.content ?? []) {
    if (block?.type !== "bash_code_execution_tool_result") continue;
    for (const it of block.content?.content ?? []) {
      if (it?.type === "bash_code_execution_output" && it.file_id) fileIds.push(it.file_id);
    }
  }
  if (fileIds.length === 0) return null;

  // 优先 parsed.md，其次任意 .md，再退回第一个产物
  let chosen = fileIds[0];
  let foundMd = false;
  for (const id of fileIds) {
    try {
      const meta = await client.beta.files.retrieveMetadata(id, { betas: [FILES_BETA] });
      const name: string = meta?.filename ?? "";
      if (name.endsWith("parsed.md")) {
        chosen = id;
        foundMd = true;
        break;
      }
      if (!foundMd && name.endsWith(".md")) {
        chosen = id;
        foundMd = true;
      }
    } catch {
      /* 忽略单个文件的元数据失败 */
    }
  }

  try {
    const dl = await client.beta.files.download(chosen, { betas: [FILES_BETA] });
    const buf = Buffer.from(await dl.arrayBuffer());
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}
