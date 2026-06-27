import { query } from "@anthropic-ai/claude-agent-sdk";
import { startBetaSanitizingProxy, type BetaSanitizingProxy } from "./beta-sanitizing-proxy";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";

export interface ClaudeCodeSandboxParserOptions {
  model?: string;
  baseUrl?: string;
  authToken?: string;
  maxTurns?: number;
  workdirRoot?: string;
}

/**
 * 自己集成的 Claude Code 沙箱解析：
 *   把上传文件丢进一个临时 workdir → 跑一轮 Claude Code（Agent SDK）→ 它用 bash/python
 *   把文件解析成 workdir 下的 parsed.md → 读回。
 *
 * 模型调用走 ANTHROPIC_BASE_URL（默认 302 网关，见 .env）。真正的隔离靠把整个 worker
 * 放进锁死容器（后续里程碑）；SDK 侧用 allowedTools + bypassPermissions 限定工具集。
 */
export class ClaudeCodeSandboxParser implements ParserBackend {
  private model: string;
  private baseUrl?: string;
  private authToken?: string;
  private maxTurns: number;
  private workdirRoot: string;

  constructor(opts: ClaudeCodeSandboxParserOptions = {}) {
    this.model = opts.model ?? process.env.KB_MODEL_PARSE ?? "claude-haiku-4-5-20251001";
    this.baseUrl = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
    this.authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN;
    this.maxTurns = opts.maxTurns ?? 8;
    this.workdirRoot = opts.workdirRoot ?? tmpdir();
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const bytes =
      input.bytes ??
      (input.filePath ? new Uint8Array(await readFile(input.filePath)) : undefined);
    if (!bytes) throw new Error("ClaudeCodeSandboxParser.parse: 需要 filePath 或 bytes");
    const filename =
      input.filename || (input.filePath ? basename(input.filePath) : "upload.bin");

    const dir = await mkdtemp(join(this.workdirRoot, "kb-parse-"));
    let betaProxy: BetaSanitizingProxy | undefined;
    try {
      await writeFile(join(dir, filename), Buffer.from(bytes));

      // Claude Code 二进制硬编码下发一组 anthropic-beta，其中若干 302 透传不认（403「Parameter error」）。
      // 起一个进程内反代剥掉这些 beta 再转发到 302；把子进程的 ANTHROPIC_BASE_URL 指到反代。
      const upstream = this.baseUrl ?? "https://api.302.ai";
      betaProxy = await startBetaSanitizingProxy({ upstream });

      // 显式构造子进程 env，强制走 反代 + x-api-key 认证。
      // 关键：必须用 ANTHROPIC_API_KEY(x-api-key)，不能用 ANTHROPIC_AUTH_TOKEN(Bearer)——
      // 否则新版 Claude Code 会按 OAuth 处理并附带 `anthropic-beta: oauth-2025-04-20`，同样被 302 拒。
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
      env.ANTHROPIC_BASE_URL = betaProxy.url; // 指向本地剥 beta 反代
      if (this.authToken) env.ANTHROPIC_API_KEY = this.authToken; // 302 key 当 x-api-key
      env.ANTHROPIC_AUTH_TOKEN = ""; // 清掉 Bearer/OAuth，避免 oauth-2025-04-20 beta
      // 反代在 127.0.0.1：必须让子进程对本地直连，否则它会把请求经 Clash(HTTP_PROXY) 隧道出去打不到本地
      env.NO_PROXY = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
      env.no_proxy = env.NO_PROXY;

      const options: any = {
        cwd: dir,
        model: this.model,
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
        permissionMode: "bypassPermissions",
        maxTurns: this.maxTurns,
        // 解析只是「文件→markdown」，不需要扩展思考。新版 Claude Code 默认给 haiku 开
        // thinking(budget 31999)，每个 turn 狂思考几十秒 → 整次解析 2-3 分钟。关掉后大幅提速。
        thinking: { type: "disabled" },
        env,
      };

      let resultText = "";
      for await (const message of query({ prompt: buildPrompt(filename), options })) {
        const m = message as any;
        if (m?.type === "result" || (m && "result" in m && typeof m.result === "string")) {
          resultText = m.result ?? "";
        }
      }

      // 优先读 agent 写出的 parsed.md；读不到则退回它的最终文本
      let markdown = "";
      try {
        markdown = await readFile(join(dir, "parsed.md"), "utf-8");
      } catch {
        markdown = resultText;
      }
      markdown = markdown.trim();
      const scanned = /<!--\s*SCANNED/i.test(markdown);

      return {
        markdown,
        images: [],
        raw_text: markdown,
        scanned,
        meta: { model: this.model },
      };
    } finally {
      await betaProxy?.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function buildPrompt(filename: string): string {
  return [
    `当前工作目录里有一个文件 \`${filename}\`。请把它解析成干净的 Markdown：`,
    `- 用合适的工具/库（pdf→pdfplumber/pypdf；docx→python-docx；xlsx→openpyxl/pandas；csv→pandas 或 python csv；md/txt→直接读）`,
    `- 保留标题层级（#/##/###）与表格结构`,
    `- PDF 若几乎无文本（扫描件），在 Markdown 顶部写一行 \`<!-- SCANNED: needs vision OCR -->\``,
    `- 不要总结、不要改写正文`,
    `把结果写入当前目录的 \`parsed.md\`（UTF-8）。完成即可，无需多余说明。`,
  ].join("\n");
}
