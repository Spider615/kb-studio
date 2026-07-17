import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import type { ParseInput } from "@kb/core";
import { safeMountName } from "./mount-name";

const execFileAsync = promisify(execFile);

export interface SandboxRunOptions {
  image?: string; // 默认 kb-sandbox:latest
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutMs?: number;
  tmpfsMb?: number;
}

/**
 * 在锁死容器里跑一个确定性 python 解析脚本，把只读挂载的输入文件转成 markdown（stdout）。
 * 无模型、无网络（--network none）；加固：非 root、--cap-drop ALL、no-new-privileges、pids/内存/CPU 限制、/tmp tmpfs、输入只读。
 * 供 TabularSandboxParser / DocxSandboxParser 等确定性后端共用。
 */
export async function runSandboxScript(
  scriptPath: string,
  input: ParseInput,
  opts: SandboxRunOptions = {},
): Promise<string> {
  const image = opts.image ?? process.env.KB_SANDBOX_IMAGE ?? "kb-sandbox:latest";
  const bytes =
    input.bytes ?? (input.filePath ? new Uint8Array(await readFile(input.filePath)) : undefined);
  if (!bytes) throw new Error("runSandboxScript: 需要 filePath 或 bytes");
  const filename = input.filename || (input.filePath ? basename(input.filePath) : "upload.bin");
  const mountName = safeMountName(filename); // 原始名可能含 " : ` 破坏 docker -v 解析

  const dir = await mkdtemp(join(tmpdir(), "kb-sbx-"));
  const hostPath = join(dir, mountName);
  try {
    await writeFile(hostPath, Buffer.from(bytes));
    const args = [
      "run", "--rm",
      "--network", "none",
      "-v", `${hostPath}:/work/${mountName}:ro`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(opts.pidsLimit ?? 128),
      "--memory", opts.memory ?? "2g",
      "--cpus", opts.cpus ?? "2",
      "--tmpfs", `/tmp:rw,size=${opts.tmpfsMb ?? 128}m`,
      "--entrypoint", "python",
      image,
      scriptPath,
      `/work/${mountName}`,
    ];
    try {
      const r = await execFileAsync("docker", args, {
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 128 * 1024 * 1024,
      });
      return r.stdout;
    } catch (e: any) {
      const stderr = (e?.stderr ?? "").toString().slice(-800);
      throw new Error(`确定性解析失败（image=${image}, script=${scriptPath}）：${e?.message ?? e}\n${stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
