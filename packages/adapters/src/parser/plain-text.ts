import { readFile } from "node:fs/promises";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";

/**
 * 纯文本 / Markdown 直读：txt·md·markdown 本来就是目标格式，不需要任何解析。
 *
 * 之前这类文件走容器化 Claude Code——起一个容器 + 若干轮模型调用，只为把文本原样抄一遍，
 * 既慢又可能被模型"顺手优化"改写正文。直接读字节最快也最保真，且没有任何执行风险
 * （纯读取，不解释内容）。
 *
 * 编码：按 UTF-8 解码；带 BOM 的去掉 BOM。非 UTF-8（GBK 等）会出现替换符，
 * 由上层按产出质量决定是否重传——不在这里猜编码，猜错比报错更难排查。
 */
export class PlainTextParser implements ParserBackend {
  async parse(input: ParseInput): Promise<ParseResult> {
    const bytes =
      input.bytes ?? (input.filePath ? new Uint8Array(await readFile(input.filePath)) : undefined);
    if (!bytes) throw new Error("PlainTextParser.parse: 需要 filePath 或 bytes");

    let text = Buffer.from(bytes).toString("utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
    const markdown = text.replace(/\r\n?/g, "\n").trim();
    if (!markdown) throw new Error(`PlainTextParser: 文件为空（${input.filename ?? ""}）`);

    return {
      markdown,
      images: [],
      raw_text: markdown,
      scanned: false,
      meta: { backend: "plain-text" },
    };
  }
}
