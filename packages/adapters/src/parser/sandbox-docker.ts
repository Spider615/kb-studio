import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import type { ParserBackend, ParseInput, ParseResult } from "@kb/core";
import { safeMountName } from "./mount-name";

const execFileAsync = promisify(execFile);

export interface DockerRunArgsInput {
  image: string;
  authToken?: string;
  baseUrl: string;
  model: string;
  proxy: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  tmpfsSize: string;
  hostPath: string;
  mountName: string;
  filename: string; // 原始上传名，注入 KB_ORIGINAL_FILENAME 供容器内 buildPrompt 用
}

/** 构造 docker run 参数数组（纯函数，便于单测）。原始名只经 -e 传，绝不进 -v 挂载路径（详见 safeMountName）。 */
export function buildDockerRunArgs(o: DockerRunArgsInput): string[] {
  return [
    "run", "--rm",
    "-e", `ANTHROPIC_AUTH_TOKEN=${o.authToken ?? ""}`,
    "-e", `ANTHROPIC_BASE_URL=${o.baseUrl}`,
    "-e", `KB_MODEL_PARSE=${o.model}`,
    "-e", "ANTHROPIC_API_KEY=", // 清掉，parser 内用 AUTH_TOKEN 走 x-api-key
    "-e", `KB_ORIGINAL_FILENAME=${o.filename}`, // 原始上传名，供容器内 buildPrompt 作语义提示（只走 env，不进 -v 挂载）
    "-e", `HTTPS_PROXY=${o.proxy}`, // 容器内经宿主机 Clash 出网到 302
    "-e", `HTTP_PROXY=${o.proxy}`, // 容器内经宿主机 Clash 出网到 302
    "-e", "NO_PROXY=localhost,127.0.0.1",
    "-v", `${o.hostPath}:/work/${o.mountName}:ro`, // 输入只读挂载（用安全归一 mountName，防特殊字符破坏挂载）
    // 加固：非 root + 丢能力 + 禁提权 + pids/内存/CPU 限制 + tmpfs
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(o.pidsLimit),
    "--memory", o.memory,
    "--cpus", o.cpus,
    "--tmpfs", `/tmp:rw,size=${o.tmpfsSize}`,
    o.image,
    `/work/${o.mountName}`,
  ];
}

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
    // 容器内一律用安全名挂载（原始名可能含 " : ` 破坏 docker -v 解析，详见 safeMountName）
    const mountName = safeMountName(filename);

    const dir = await mkdtemp(join(tmpdir(), "kb-sbx-"));
    const hostPath = join(dir, mountName);
    try {
      await writeFile(hostPath, Buffer.from(bytes));

      const args = buildDockerRunArgs({
        image: this.image,
        authToken: this.authToken,
        baseUrl: this.baseUrl,
        model: this.model,
        proxy: this.proxy,
        memory: this.memory,
        cpus: this.cpus,
        pidsLimit: this.pidsLimit,
        tmpfsSize: this.tmpfsSize,
        hostPath,
        mountName,
        filename,
      });

      let stdout = "";
      try {
        const r = await execFileAsync("docker", args, {
          timeout: this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = r.stdout;
      } catch (e: any) {
        const stderr = (e?.stderr ?? "").toString();
        // 容器 stderr 常混着 Claude Code/Agent SDK 的压缩源码：子进程抛未捕获异常时 V8 会把
        // 出错的那一整行 minified 源码打出来（动辄几十 KB），就是前端看到的「一坨代码」。
        // 先按行清洗——丢掉超长(疑似压缩源码)行，只在人类可读的短行里挑报错，绝不把源码抛给前端。
        const readable = stderr
          .split("\n")
          .map((l: string) => l.trimEnd())
          .filter((l: string) => l.length > 0 && l.length <= 500);
        const meaningful = readable
          .filter((l: string) =>
            /Error:|returned an error result|API Error|Traceback|ModuleNotFoundError|got status|429|rate.?limit|timed out|maxTurns|max turns|exited with code|Failed to spawn/i.test(l),
          )
          .slice(0, 6)
          .join("\n")
          .trim();
        const timedOut = e?.killed && e?.signal === "SIGTERM";
        // OOM-kill：容器被内存限制杀掉，退出码 137 / SIGKILL，stderr 往往为空——这正是
        // 之前"容器解析失败：（空）"的来源。这里显式识别并给出可执行建议。
        const oom = e?.code === 137 || e?.signal === "SIGKILL";
        // 子进程 spawn 失败/秒退：SDK 会 dump 自己的源码，上面多半抓不到干净信息。
        // 用原始 stderr 里的 SDK 签名识别这种情况，给出「重试即可」的可执行提示。
        const spawnFailed =
          /Failed to spawn|process exited with code|ProcessTransport|Claude Code process/i.test(stderr);
        // detail 兜底链：保证永不为空、且永不含压缩源码，把退出码/信号/e.message 带出来。
        const detail =
          meaningful ||
          (timedOut ? `解析超时（>${this.timeoutMs}ms）` : "") ||
          (oom
            ? `容器被 OOM 杀掉（退出码 137）——Docker 可用内存不足，装不下 --memory ${this.memory}。请调高 Docker Desktop 内存或关掉部分容器；也可设环境变量 KB_SANDBOX_MEMORY 调小单容器上限`
            : "") ||
          (spawnFailed
            ? "容器内解析子进程异常退出（多为上游网关瞬时抖动/限流导致 claude 子进程秒退），重试通常即可恢复"
            : "") ||
          readable.slice(-6).join("\n").trim() ||
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
