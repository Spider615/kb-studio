import { execFile } from "node:child_process";
import { mkdtemp, mkdir, chmod, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { safeMountName } from "./mount-name";

const execFileAsync = promisify(execFile);

// LibreOffice 能可靠转 PDF 且前端缺预览的 office 格式：演示文稿（pptx/ppt/odp）。
// docx/xlsx 前端已有更轻的 mammoth/SheetJS 预览，不走这里。
const CONVERTIBLE = /\.(pptx?|odp)$/i;

export interface OfficePdfConverterOptions {
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutMs?: number;
}

/**
 * 在锁死的 kb-sandbox 容器里用 LibreOffice headless 把 office 文件转成 PDF（供前端内联预览）。
 * 与其它沙箱后端同款加固：--network none、--cap-drop ALL、no-new-privileges、pids/内存/CPU 限制、
 * 输入只读挂载 + 一个 rw 输出目录；LibreOffice 用户配置放容器内 tmpfs(/tmp) 避免污染/并发锁冲突。
 */
export class OfficePdfConverter {
  private image: string;
  private memory: string;
  private cpus: string;
  private pidsLimit: number;
  private timeoutMs: number;

  constructor(opts: OfficePdfConverterOptions = {}) {
    this.image = opts.image ?? process.env.KB_SANDBOX_IMAGE ?? "kb-sandbox:latest";
    this.memory = opts.memory ?? "2g";
    this.cpus = opts.cpus ?? "2";
    this.pidsLimit = opts.pidsLimit ?? 512; // soffice 会起多个子进程/线程，给足余量
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** 该格式是否需要/支持走 LibreOffice 转 PDF 预览。 */
  static canConvert(filename: string): boolean {
    return CONVERTIBLE.test(filename);
  }

  async toPdf(input: { bytes: Uint8Array; filename: string }): Promise<Uint8Array> {
    const mountName = safeMountName(input.filename); // 归一成 input.<ext>，避免特殊字符破坏 -v 挂载
    const base = await mkdtemp(join(tmpdir(), "kb-office-"));
    const inPath = join(base, mountName);
    const outDir = join(base, "out");
    try {
      await writeFile(inPath, Buffer.from(input.bytes));
      await mkdir(outDir, { recursive: true });
      await chmod(outDir, 0o777); // 容器内非 root(uid 10001) 要能写解压/转换结果

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
        "--tmpfs", "/tmp:rw,size=512m",
        "--entrypoint", "soffice",
        this.image,
        "--headless", "--norestore",
        "-env:UserInstallation=file:///tmp/louser", // 配置放 tmpfs：免污染 HOME、避免并发 profile 锁
        "--convert-to", "pdf",
        "--outdir", "/out",
        `/work/${mountName}`,
      ];

      try {
        await execFileAsync("docker", args, { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      } catch (e: any) {
        const stderr = (e?.stderr ?? "").toString().slice(-600).trim();
        throw new Error(`LibreOffice 转 PDF 失败（image=${this.image}）：${e?.message ?? e}${stderr ? "\n" + stderr : ""}`);
      }

      // soffice 按输入 basename 命名输出（input.pptx → input.pdf）；稳妥起见取 out 里第一个 .pdf
      const files = await readdir(outDir);
      const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
      if (!pdf) throw new Error("LibreOffice 未产出 PDF（格式不受支持或文件损坏）");
      return new Uint8Array(await readFile(join(outDir, pdf)));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
}
