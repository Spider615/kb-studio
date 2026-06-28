import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";
import { safeMountName } from "./mount-name";

const execFileAsync = promisify(execFile);

export interface TabularSandboxParserOptions {
  image?: string; // 默认 kb-sandbox:latest
  scriptPath?: string; // 容器内确定性解析脚本路径
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutMs?: number;
}

/**
 * 确定性表格解析后端：把 csv/xlsx 只读挂进锁死容器，跑 tabular_to_md.py（openpyxl/csv 逐行转 markdown）。
 * 无模型、无网络（--network none）、逐行保真——不会像 Claude Code agent 那样抽样/漏行/改写，且 <1s。
 * 加固对齐 SandboxDockerParser：非 root、--cap-drop ALL、no-new-privileges、pids/内存/CPU 限制、/tmp tmpfs、输入只读。
 */
export class TabularSandboxParser implements ParserBackend {
  private image: string;
  private scriptPath: string;
  private memory: string;
  private cpus: string;
  private pidsLimit: number;
  private timeoutMs: number;

  constructor(opts: TabularSandboxParserOptions = {}) {
    this.image = opts.image ?? process.env.KB_SANDBOX_IMAGE ?? "kb-sandbox:latest";
    this.scriptPath = opts.scriptPath ?? "/app/apps/worker/python/tabular_to_md.py";
    this.memory = opts.memory ?? "2g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? 128;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const bytes =
      input.bytes ?? (input.filePath ? new Uint8Array(await readFile(input.filePath)) : undefined);
    if (!bytes) throw new Error("TabularSandboxParser.parse: 需要 filePath 或 bytes");
    const filename = input.filename || (input.filePath ? basename(input.filePath) : "upload.bin");
    const mountName = safeMountName(filename); // 原始名可能含 " : ` 破坏 docker -v 解析

    const dir = await mkdtemp(join(tmpdir(), "kb-tab-"));
    const hostPath = join(dir, mountName);
    try {
      await writeFile(hostPath, Buffer.from(bytes));
      const args = [
        "run", "--rm",
        "--network", "none", // 确定性解析不需要网络
        "-v", `${hostPath}:/work/${mountName}:ro`,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", String(this.pidsLimit),
        "--memory", this.memory,
        "--cpus", this.cpus,
        "--tmpfs", "/tmp:rw,size=128m",
        "--entrypoint", "python",
        this.image,
        this.scriptPath,
        `/work/${mountName}`,
      ];

      let stdout = "";
      try {
        const r = await execFileAsync("docker", args, {
          timeout: this.timeoutMs,
          maxBuffer: 128 * 1024 * 1024,
        });
        stdout = r.stdout;
      } catch (e: any) {
        const stderr = (e?.stderr ?? "").toString().slice(-800);
        throw new Error(`表格解析失败（image=${this.image}）：${e?.message ?? e}\n${stderr}`);
      }

      const markdown = stdout.trim();
      return {
        markdown,
        images: [],
        raw_text: markdown,
        scanned: false,
        meta: { backend: "tabular-sandbox", image: this.image },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
