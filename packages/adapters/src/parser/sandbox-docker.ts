import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";

const execFileAsync = promisify(execFile);

export interface SandboxDockerParserOptions {
  image?: string; // 默认 kb-sandbox:latest
  proxy?: string; // 容器内访问 302 的代理（默认宿主机 Clash）
  authToken?: string; // 302 key（注入容器，parser 内转成 x-api-key）
  baseUrl?: string; // 302 网关 base
  model?: string; // KB_MODEL_PARSE
  memory?: string; // 默认 3g
  cpus?: string; // 默认 2
  pidsLimit?: number; // 默认 256
  tmpfsSize?: string; // 默认 512m
  timeoutMs?: number; // 默认 300000（关掉 thinking 后解析约 30-60s，留足余量）
}

/**
 * 容器化解析后端：把上传文件写到宿主机临时目录，只读挂进锁死容器（kb-sandbox），
 * 容器里跑 parse-one.ts（同一套 ClaudeCodeSandboxParser，含剥-beta 反代）→ stdout 取回 markdown。
 *
 * 加固对齐 scripts/parse-in-sandbox.sh：非 root（镜像内 app 用户）、--cap-drop ALL、no-new-privileges、
 * pids/内存/CPU 限制、/tmp tmpfs、输入只读挂载。模型调用经 HTTPS_PROXY(宿主机 Clash) 走 302。
 */
export class SandboxDockerParser implements ParserBackend {
  private image: string;
  private proxy: string;
  private authToken?: string;
  private baseUrl: string;
  private model: string;
  private memory: string;
  private cpus: string;
  private pidsLimit: number;
  private tmpfsSize: string;
  private timeoutMs: number;

  constructor(opts: SandboxDockerParserOptions = {}) {
    this.image = opts.image ?? process.env.KB_SANDBOX_IMAGE ?? "kb-sandbox:latest";
    this.proxy = opts.proxy ?? process.env.SANDBOX_PROXY ?? "http://host.docker.internal:7897";
    this.authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN;
    this.baseUrl = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.302.ai";
    this.model = opts.model ?? process.env.KB_MODEL_PARSE ?? "claude-haiku-4-5-20251001";
    this.memory = opts.memory ?? process.env.KB_SANDBOX_MEMORY ?? "3g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? 256;
    this.tmpfsSize = opts.tmpfsSize ?? "512m";
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const bytes =
      input.bytes ??
      (input.filePath ? new Uint8Array(await (await import("node:fs/promises")).readFile(input.filePath)) : undefined);
    if (!bytes) throw new Error("SandboxDockerParser.parse: 需要 filePath 或 bytes");
    const filename = input.filename || (input.filePath ? basename(input.filePath) : "upload.bin");

    const dir = await mkdtemp(join(tmpdir(), "kb-sbx-"));
    const hostPath = join(dir, filename);
    try {
      await writeFile(hostPath, Buffer.from(bytes));

      const args = [
        "run", "--rm",
        // 把 302 配置显式注入容器（不依赖宿主机 .env 路径）
        "-e", `ANTHROPIC_AUTH_TOKEN=${this.authToken ?? ""}`,
        "-e", `ANTHROPIC_BASE_URL=${this.baseUrl}`,
        "-e", `KB_MODEL_PARSE=${this.model}`,
        "-e", "ANTHROPIC_API_KEY=", // 清掉，parser 内用 AUTH_TOKEN 走 x-api-key
        // 容器内经宿主机 Clash 出网到 302；本地(剥-beta 反代)直连不走代理
        "-e", `HTTPS_PROXY=${this.proxy}`,
        "-e", `HTTP_PROXY=${this.proxy}`,
        "-e", "NO_PROXY=localhost,127.0.0.1",
        // 输入只读挂载
        "-v", `${hostPath}:/work/${filename}:ro`,
        // 加固
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", String(this.pidsLimit),
        "--memory", this.memory,
        "--cpus", this.cpus,
        "--tmpfs", `/tmp:rw,size=${this.tmpfsSize}`,
        this.image,
        `/work/${filename}`,
      ];

      let stdout = "";
      try {
        const r = await execFileAsync("docker", args, {
          timeout: this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = r.stdout;
      } catch (e: any) {
        const stderr = (e?.stderr ?? "").toString();
        // 从容器 stderr 里挑出真正有意义的报错行（parse-one 抛出的 Error / 上游 API Error），
        // 避免把 SDK 压缩源码原样抛给前端。
        const meaningful = stderr
          .split("\n")
          .filter((l: string) =>
            /^Error:|returned an error result|API Error|Traceback|ModuleNotFoundError|got status|429|rate.?limit|timed out|maxTurns|max turns/i.test(l),
          )
          .slice(0, 6)
          .join("\n")
          .trim();
        const timedOut = e?.killed && e?.signal === "SIGTERM";
        // OOM-kill：容器被内存限制杀掉，退出码 137 / SIGKILL，stderr 往往为空——这正是
        // 之前"容器解析失败：（空）"的来源。这里显式识别并给出可执行建议。
        const oom = e?.code === 137 || e?.signal === "SIGKILL";
        // detail 兜底链：保证永不为空，且把退出码/信号/e.message 带出来，OOM 单独提示。
        const detail =
          meaningful ||
          (timedOut ? `解析超时（>${this.timeoutMs}ms）` : "") ||
          (oom
            ? `容器被 OOM 杀掉（退出码 137）——Docker 可用内存不足，装不下 --memory ${this.memory}。请调高 Docker Desktop 内存或关掉部分容器；也可设环境变量 KB_SANDBOX_MEMORY 调小单容器上限`
            : "") ||
          stderr.slice(-600).trim() ||
          `docker 退出码=${e?.code ?? "?"}${e?.signal ? ` 信号=${e.signal}` : ""}：${String(e?.message ?? "").slice(0, 300)}`;
        throw new Error(`容器解析失败（image=${this.image}）：${detail}`);
      }

      const markdown = stdout.trim();
      const scanned = /<!--\s*SCANNED/i.test(markdown);
      return {
        markdown,
        images: [],
        raw_text: markdown,
        scanned,
        meta: { backend: "sandbox-docker", image: this.image, model: this.model },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
