import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";
import { runSandboxScript, type SandboxRunOptions } from "./run-sandbox-script";

const DEFAULT_SCRIPT = "/app/apps/worker/python/docx_to_md.py";

export interface DocxSandboxParserOptions extends SandboxRunOptions {
  scriptPath?: string;
  minChars?: number; // 确定性输出少于此值（图片/复杂布局为主）→ 退回 fallback，默认 20
}

/**
 * 确定性 DOCX 解析后端：把 docx 只读挂进锁死容器，跑 docx_to_md.py（python-docx 逐块转 markdown）。
 * 无模型、无网络、逐块保真——比容器化 Claude Code 更快更省、不改写。
 * 兜底：解析异常，或产出过少（多为图片/复杂排版为主的 docx，确定性拿不到内容）→ 退回 fallback（Claude Code）。
 */
export class DocxSandboxParser implements ParserBackend {
  private scriptPath: string;
  private minChars: number;

  constructor(
    private fallback: ParserBackend,
    private opts: DocxSandboxParserOptions = {},
  ) {
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT;
    this.minChars = opts.minChars ?? 20;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    try {
      const markdown = (await runSandboxScript(this.scriptPath, input, this.opts)).trim();
      if (markdown.length >= this.minChars) {
        return {
          markdown,
          images: [],
          raw_text: markdown,
          scanned: false,
          meta: { backend: "docx-sandbox" },
        };
      }
      console.warn(`[DocxSandboxParser] 确定性产出过少(${markdown.length}<${this.minChars} 字)，退回 fallback: ${input.filename ?? ""}`);
    } catch (e: any) {
      // 静默退回会掩盖「镜像未含 docx_to_md.py（改 python 脚本后需重建镜像）」等系统性失败 → 打日志留信号
      console.warn(`[DocxSandboxParser] 确定性解析失败，退回 fallback: ${input.filename ?? ""}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    return this.fallback.parse(input);
  }
}
