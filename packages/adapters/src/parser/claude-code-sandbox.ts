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
    this.maxTurns = opts.maxTurns ?? 12;
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
      for await (const message of query({
        // KB_ORIGINAL_FILENAME 是跨容器进程边界传原始名的必要通道（parse-one.ts 是独立进程）；
        // 每容器单文件单次解析，故直读 env 安全。
        prompt: buildPrompt(filename, process.env.KB_ORIGINAL_FILENAME),
        options,
      })) {
        const m = message as any;
        if (m?.type === "result" || (m && "result" in m && typeof m.result === "string")) {
          resultText = m.result ?? "";
        }
      }

      // 读 agent 写出的 parsed.md（= 真正的解析产物）。读不到/为空说明 agent 只在对话里
      // 声称"已保存"却没真正落盘（小模型偶发，尤其并发/复杂文件时）——这时绝不能把 agent
      // 的对话收尾文本当正文入库（否则知识库里只会存进一句"已将 xx 解析为 parsed.md"）。
      // 直接抛错：交给上层 processDoc 重试，持续失败就明确标 failed，而不是悄悄存一坨垃圾。
      let markdown = "";
      try {
        markdown = (await readFile(join(dir, "parsed.md"), "utf-8")).trim();
      } catch {
        throw new Error(
          `解析未产出 parsed.md（agent 未真正落盘）。agent 收尾文本: ${(resultText || "").slice(0, 160)}`,
        );
      }
      if (!markdown) throw new Error("解析产出的 parsed.md 为空");
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

export function buildPrompt(onDiskName: string, originalName?: string): string {
  const hint =
    originalName && originalName !== onDiskName
      ? `（补充：该文件上传时的原始文件名是 \`${originalName}\`，可帮助你判断文档主题/类型；但磁盘上的实际文件名是 \`${onDiskName}\`，请按这个读取。）`
      : "";
  return [
    `当前工作目录里有一个文件 \`${onDiskName}\`。请把它解析成干净的 Markdown：${hint}`,
    `- 用合适的工具/库（pdf→pdfplumber/pypdf；docx→python-docx；pptx→python-pptx(逐页幻灯片提取标题/正文/表格)；xlsx→openpyxl/pandas；csv→pandas 或 python csv；md/txt→直接读）`,
    `- 保留标题层级（#/##/###）与表格结构`,
    `- PDF 若几乎无文本（扫描件），在 Markdown 顶部写一行 \`<!-- SCANNED: needs vision OCR -->\``,
    `- 不要总结、不要改写正文`,
    `- 必须把完整结果写入当前工作目录的 \`parsed.md\`（UTF-8）——这是唯一交付物，绝不能只在回复里粘贴内容；写完务必用 \`ls -l parsed.md\` 确认文件已生成且非空，再结束。`,
  ].join("\n");
}
