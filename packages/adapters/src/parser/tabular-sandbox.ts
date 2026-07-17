import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";
import { runSandboxScript, type SandboxRunOptions } from "./run-sandbox-script";

export interface TabularSandboxParserOptions extends SandboxRunOptions {
  scriptPath?: string; // 容器内确定性解析脚本路径
}

/**
 * 确定性表格解析后端：把 csv/xlsx 只读挂进锁死容器，跑 tabular_to_md.py（openpyxl/csv 逐行转 markdown）。
 * 无模型、无网络（--network none）、逐行保真——不会像 Claude Code agent 那样抽样/漏行/改写，且 <1s。
 * 加固对齐 SandboxDockerParser：非 root、--cap-drop ALL、no-new-privileges、pids/内存/CPU 限制、/tmp tmpfs、输入只读。
 */
export class TabularSandboxParser implements ParserBackend {
  private scriptPath: string;

  constructor(private opts: TabularSandboxParserOptions = {}) {
    this.scriptPath = opts.scriptPath ?? "/app/apps/worker/python/tabular_to_md.py";
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const markdown = (await runSandboxScript(this.scriptPath, input, this.opts)).trim();
    return {
      markdown,
      images: [],
      raw_text: markdown,
      scanned: false,
      meta: { backend: "tabular-sandbox" },
    };
  }
}
