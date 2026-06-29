#!/usr/bin/env python3
"""沙箱内解压压缩包：zip/rar/7z/tar → 释放包内文件，过滤垃圾/不支持类型，限量防 zip 炸弹。
用法：python extract_archive.py <压缩包路径> <输出目录>
- 先解压到容器内 size 受限的 tmpfs STAGING（/extract），炸弹只会撑爆 tmpfs（ENOSPC）而非宿主磁盘。
- 用 unar 解压（支持 zip/rar/rar5/7z/tar/tar.gz...，自动猜编码，能解中文名）。
- 跳过符号链接（防解压出 `x -> /etc/passwd` 之类被宿主机 readFile 跟随读到任意文件）。
- 只保留可入库的文件类型；跳过目录、空文件、系统垃圾、嵌套压缩包。
- 上限 MAX_FILES 个文件、MAX_TOTAL_BYTES 总大小，超出则截断并在 manifest 标记。
- 通过筛选的文件才从 STAGING 拷到 <输出目录>（宿主机 bind mount），宿主机只拿到有界、干净的集合。
- stdout 输出 JSON：{"files":[{"path","name","size"}], "skipped":[{"name","reason"}], "truncated":bool}
  path 为相对输出目录的路径，宿主机据此读取每个文件字节。"""
import sys
import os
import json
import shutil
import subprocess

# 容器内 tmpfs 暂存目录（由适配器以 --tmpfs 挂载并限制大小）
STAGING = "/extract"

# 可入库类型（与 kb-studio getParser 能处理的对齐）
SUPPORTED = {
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".xlsm",
    ".csv", ".tsv", ".txt", ".md", ".markdown", ".json",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
}
# 嵌套压缩包不递归（避免炸弹/复杂度），直接跳过
ARCHIVE_EXT = {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz"}
MAX_FILES = 300
MAX_TOTAL_BYTES = 1024 * 1024 * 1024  # 1 GB 解压后总量


def is_junk(name: str, rel: str) -> bool:
    base = os.path.basename(name)
    if base in (".DS_Store", "Thumbs.db", "desktop.ini"):
        return True
    if base.startswith("._"):  # macOS AppleDouble
        return True
    parts = rel.replace("\\", "/").split("/")
    if "__MACOSX" in parts:
        return True
    return False


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "用法: extract_archive.py <archive> <outdir>"}), flush=True)
        sys.exit(2)
    archive, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(STAGING, exist_ok=True)

    # unar 解压到 tmpfs 暂存：-q 安静 -f 覆盖 -o 输出目录。
    # 不用 -D（flatten 在 tmpfs 上对 tar.gz 会报错）；外层目录无所谓，下面 os.walk 递归找文件。
    proc = subprocess.run(
        ["unar", "-q", "-f", "-o", STAGING, archive],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(json.dumps({"error": f"unar 解压失败(code={proc.returncode}): {proc.stderr[-500:]}"}), flush=True)
        sys.exit(1)

    files, skipped, total = [], [], 0
    truncated = False
    # followlinks=False：不跟随目录符号链接走出 STAGING
    for root, _dirs, names in os.walk(STAGING, followlinks=False):
        for n in sorted(names):
            full = os.path.join(root, n)
            rel = os.path.relpath(full, STAGING)
            # 符号链接一律跳过（防 `x -> /etc/passwd` 被宿主机 readFile 跟随读取任意文件）
            if os.path.islink(full):
                skipped.append({"name": rel, "reason": "符号链接(已忽略)"})
                continue
            if not os.path.isfile(full):
                continue
            if is_junk(n, rel):
                continue
            ext = os.path.splitext(n)[1].lower()
            if ext in ARCHIVE_EXT:
                skipped.append({"name": rel, "reason": "嵌套压缩包(不递归)"})
                continue
            if ext not in SUPPORTED:
                skipped.append({"name": rel, "reason": f"不支持的类型 {ext or '无扩展名'}"})
                continue
            size = os.path.getsize(full)
            if size == 0:
                skipped.append({"name": rel, "reason": "空文件"})
                continue
            if len(files) >= MAX_FILES or total + size > MAX_TOTAL_BYTES:
                truncated = True
                continue
            # 通过筛选：拷到宿主机 bind mount（只复制干净、有界的文件）
            dest = os.path.join(outdir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(full, dest)  # copyfile 不跟随软链（已排除）、不保留权限位
            total += size
            files.append({"path": rel, "name": n, "size": size})

    print(json.dumps({"files": files, "skipped": skipped, "truncated": truncated}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
