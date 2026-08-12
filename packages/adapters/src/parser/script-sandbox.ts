import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";
import { runSandboxScript, type SandboxRunOptions } from "./run-sandbox-script";

export interface ScriptSandboxParserOptions extends SandboxRunOptions {
  /** 容器内脚本路径，如 /app/apps/worker/python/pdf_to_md.py */
  scriptPath: string;
  /** 写进 meta.backend，便于排查是哪条路径产出的 */
  backend: string;
  /** 产出少于此字数视为失败（多为图片型文档）→ 有 fallback 就退，否则抛错。默认 20 */
  minChars?: number;
  /** 可选兜底后端；不传则产出过少直接抛错（让上层重试/标 failed，而不是悄悄入库空内容） */
  fallback?: ParserBackend;
}

/**
 * 通用确定性解析后端：把文件只读挂进锁死容器，跑指定的 python 脚本转 markdown。
 * 无模型、无网络、逐块保真——比容器化 Claude Code 更快更省，且不会改写正文。
 *
 * 与 DocxSandboxParser 的关系：那个是 docx 专用（早于本类存在，含自己的兜底策略），
 * 这里把同一套「挂载→跑脚本→校验产出」抽成可复用的，供 pdf / pptx 等后续格式共用。
 *
 * ⚠️ 改动 apps/worker/python/*.py 后必须重建镜像
 * （`docker build ... -t kb-sandbox:latest`），否则容器里跑的仍是旧脚本、甚至脚本不存在。
 */
export class ScriptSandboxParser implements ParserBackend {
  private scriptPath: string;
  private backend: string;
  private minChars: number;
  private fallback?: ParserBackend;

  constructor(private opts: ScriptSandboxParserOptions) {
    this.scriptPath = opts.scriptPath;
    this.backend = opts.backend;
    this.minChars = opts.minChars ?? 20;
    this.fallback = opts.fallback;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    let markdown = "";
    let err: unknown;
    try {
      markdown = (await runSandboxScript(this.scriptPath, input, this.opts)).trim();
    } catch (e) {
      err = e;
    }

    if (!err && markdown.length >= this.minChars) {
      return {
        markdown,
        images: [],
        raw_text: markdown,
        scanned: false,
        meta: { backend: this.backend },
      };
    }

    const why = err
      ? `解析失败: ${String((err as any)?.message ?? err).slice(0, 200)}`
      : `产出过少(${markdown.length}<${this.minChars} 字)`;
    if (this.fallback) {
      // 静默退回会掩盖「镜像未含该脚本（改 python 后需重建镜像）」这类系统性失败 → 留日志
      console.warn(`[${this.backend}] ${why}，退回 fallback: ${input.filename ?? ""}`);
      return this.fallback.parse(input);
    }
    throw new Error(`[${this.backend}] ${why}（${input.filename ?? ""}）`);
  }
}
