import { execFile } from "node:child_process";
import { mkdtemp, mkdir, chmod, writeFile, rm, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { safeMountName } from "./mount-name";

const execFileAsync = promisify(execFile);

// 复合扩展名要整段保留，否则 unar 只当 .gz 解一层、解不出内层 tar（见 archive-sandbox 复合扩展名修复）
const COMPOUND_EXT = [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz"];

/** 容器内挂载名：复合压缩扩展名整段保留（input.tar.gz），其余沿用 safeMountName。 */
function archiveMountName(filename: string): string {
  const lower = filename.toLowerCase();
  for (const e of COMPOUND_EXT) if (lower.endsWith(e)) return "input" + e;
  return safeMountName(filename);
}

/** 解压出来的单个文件。 */
export interface ExtractedFile {
  filename: string; // 包内原始文件名（basename，用于 docs.title）
  bytes: Uint8Array;
}

export interface ArchiveExtractResult {
  files: ExtractedFile[];
  skipped: { name: string; reason: string }[];
  truncated: boolean; // 超过文件数/总大小上限被截断
}

export interface ArchiveExtractorOptions {
  image?: string;
  scriptPath?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutMs?: number;
}

const ARCHIVE_EXT = /\.(zip|rar|7z|tar|tgz|tar\.gz)$/i;

/**
 * 压缩包解压后端：把 zip/rar/7z 只读挂进锁死容器，跑 extract_archive.py（unar 解压 + 过滤 + 限量）。
 * 与 TabularSandboxParser 同款加固：非 root、--cap-drop ALL、no-new-privileges、pids/内存/CPU 限制、
 * --network none、输入只读；额外挂一个 rw 输出目录供容器写解压结果，宿主机读回各文件字节。
 */
export class ArchiveExtractor {
  private image: string;
  private scriptPath: string;
  private memory: string;
  private cpus: string;
  private pidsLimit: number;
  private timeoutMs: number;

  constructor(opts: ArchiveExtractorOptions = {}) {
    this.image = opts.image ?? process.env.KB_SANDBOX_IMAGE ?? "kb-sandbox:latest";
    this.scriptPath = opts.scriptPath ?? "/app/apps/worker/python/extract_archive.py";
    // 内存需大于解压暂存 tmpfs(2g)，让炸弹先撑爆 tmpfs(ENOSPC) 而非触发 OOM
    this.memory = opts.memory ?? "3g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? 256;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** 文件名是否是受支持的压缩包。 */
  static isArchive(filename: string): boolean {
    return ARCHIVE_EXT.test(filename);
  }

  async extract(input: { bytes: Uint8Array; filename: string }): Promise<ArchiveExtractResult> {
    const mountName = archiveMountName(input.filename);
    const base = await mkdtemp(join(tmpdir(), "kb-arc-"));
    const inPath = join(base, mountName);
    const outDir = join(base, "out");
    try {
      await writeFile(inPath, Buffer.from(input.bytes));
      await mkdir(outDir, { recursive: true });
      await chmod(outDir, 0o777); // 容器内非 root(uid 10001) 要能写入解压结果

      const args = [
        "run", "--rm",
        "--network", "none",
        "-v", `${inPath}:/work/${mountName}:ro`,
        "-v", `${outDir}:/out:rw`,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", String(this.pidsLimit),
        "--memory", this.memory,
        "--cpus", this.cpus,
        "--tmpfs", "/tmp:rw,size=128m",
        // 解压暂存：RAM-backed 且限 2g —— 解压炸弹只撑爆这里(ENOSPC)，碰不到宿主磁盘
        "--tmpfs", "/extract:rw,size=2g",
        "--entrypoint", "python",
        this.image,
        this.scriptPath,
        `/work/${mountName}`,
        "/out",
      ];

      let stdout = "";
      try {
        const r = await execFileAsync("docker", args, {
          timeout: this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = r.stdout;
      } catch (e: any) {
        const stderr = (e?.stderr ?? "").toString().slice(-800);
        throw new Error(`解压失败（image=${this.image}）：${e?.message ?? e}\n${stderr}`);
      }

      let manifest: any;
      try {
        manifest = JSON.parse(stdout.trim().split("\n").pop() || "{}");
      } catch {
        throw new Error(`解压输出解析失败：${stdout.slice(-400)}`);
      }
      if (manifest.error) throw new Error(String(manifest.error));

      const files: ExtractedFile[] = [];
      for (const f of manifest.files ?? []) {
        // 逐文件读取并兜底：单个坏条目不拖垮整包；lstat 不跟随软链（脚本已过滤，这里双保险）
        try {
          if (typeof f?.path !== "string" || f.path.includes("..")) continue;
          const p = join(outDir, f.path);
          const st = await lstat(p);
          if (!st.isFile()) continue; // 符号链接/目录/特殊文件一律跳过
          const bytes = new Uint8Array(await readFile(p));
          files.push({ filename: f.name ?? basename(f.path), bytes });
        } catch (e: any) {
          console.error("[archive] 读取解压文件失败，跳过:", f?.path, e?.message ?? e);
        }
      }
      return {
        files,
        skipped: manifest.skipped ?? [],
        truncated: Boolean(manifest.truncated),
      };
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
}
