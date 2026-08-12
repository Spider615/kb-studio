#!/usr/bin/env python3
"""确定性 PDF 解析：pdfplumber 抽文本层 + 表格 → markdown（无模型、无网络）。
用法：python pdf_to_md.py <文件路径> [--max-pages N]  → markdown 打到 stdout。

只处理「有文本层」的 PDF；扫描件/字体 cmap 损坏的由上层 PdfParser 先用 pdf_render.py 判出来，
走 vision 逐页 OCR，不会进到这里。

设计取舍（有意为之，别当成缺陷）：
- **不推断标题层级**。PDF 没有语义标题，只能靠字号猜，而页眉/强调文字/大号正文都会误判成标题，
  一旦插错层级会直接污染 chunker 的「结构优先」切片。这里只输出干净的段落与表格，
  标题交给上层 shouldStructure()→LLM 造结构环节补（那一步本来就是为「解析后无标题」设计的）。
- **表格区域从正文里剔除**，避免同一份内容既进正文又进表格（pdfplumber 的 extract_text
  默认会把表格里的字也抽出来）。
- **按行合并成段落**：PDF 是按视觉行断行的，直接输出会把一个句子切成很多行，
  破坏下游按句切分。用「行尾无句末标点 → 与下一行同段」的启发式合并，对中英文都适用。
"""
import sys
import os
import re
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tabular_to_md import table_md  # 复用：丢空行/空列 + 跳标题横幅 + 单元格清洗

# 句末标点（中英）：行尾是这些字符时视为段落/句子结束，不与下一行合并
SENTENCE_END = "。！？…；：.!?;:"
# 这些结尾也不合并：列表项、编号行常见的收尾
BLOCK_END = "）)】」』”\"'"


def _merge_lines(lines):
    """把视觉换行合并成段落。

    两条判据缺一不可：
    1. 行尾无句末标点 —— 句子没说完，多半是排版断行；
    2. 该行接近「满行宽」—— 只有被右边距逼断的行才会顶到页宽。

    只用第 1 条会把标题吃掉：标题天然不带句号，会被接到下一段正文里
    （真实 PDF 里几乎每个标题都中招）。满行宽用非空行长度的 75 分位来估，
    避免被大量短行拉低；阈值取 75%，给字距/标点留出余量。
    """
    stripped = [l.strip() for l in lines]
    lens = sorted(len(l) for l in stripped if l)
    if not lens:
        return []
    full_width = lens[min(int(len(lens) * 0.75), len(lens) - 1)]
    min_continue = full_width * 0.75

    paras = []
    buf = ""
    for line in stripped:
        if not line:
            if buf:
                paras.append(buf)
                buf = ""
            continue
        # 列表项/编号行独立成段，不与上一行粘连
        is_bullet = bool(re.match(r"^([-*•·]|\d+[.、)]|[（(]\d+[）)])\s*", line))
        if is_bullet:
            if buf:
                paras.append(buf)
            buf = line
            continue
        if not buf:
            buf = line
            continue
        last_line = buf.split("\n")[-1]
        ended = buf[-1] in SENTENCE_END or buf[-1] in BLOCK_END
        # 上一行明显没顶到页宽 → 它是自然结束的独立行（标题/段末），不该续接
        short = len(last_line) < min_continue
        if ended or short:
            paras.append(buf)
            buf = line
        else:
            # 中文之间不加空格，含 ASCII 时补一个空格（英文单词边界）
            sep = "" if (_is_cjk(buf[-1]) and _is_cjk(line[0])) else " "
            buf = buf + sep + line
    if buf:
        paras.append(buf)
    return paras


def _is_cjk(ch):
    o = ord(ch)
    return 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0x3000 <= o <= 0x303F


def _page_markdown(page):
    """单页 → markdown 片段列表。表格单独成块，正文剔除表格区域后按段合并。"""
    out = []
    try:
        tables = page.find_tables()
    except Exception:
        tables = []
    bboxes = []
    for t in tables:
        try:
            bboxes.append(t.bbox)
        except Exception:
            pass

    # 正文：过滤掉落在表格 bbox 内的字符对象，避免与表格重复
    def _outside_tables(obj):
        if not bboxes:
            return True
        x = obj.get("x0", 0)
        top = obj.get("top", 0)
        for x0, top0, x1, top1 in bboxes:
            if x0 <= x <= x1 and top0 <= top <= top1:
                return False
        return True

    try:
        src = page.filter(_outside_tables) if bboxes else page
        text = src.extract_text() or ""
    except Exception:
        # filter 在某些畸形页上会抛错 → 退回不过滤（宁可表格内容重复，也不要丢正文）
        text = page.extract_text() or ""
    for para in _merge_lines(text.split("\n")):
        out.append(para)

    # 表格：按 markdown 表输出（复用 tabular 的清洗）
    for t in tables:
        try:
            grid = t.extract()
        except Exception:
            continue
        if not grid:
            continue
        md = table_md([[("" if c is None else str(c)) for c in row] for row in grid])
        if md:
            out.append(md)
    return out


def pdf_to_md(path, max_pages):
    import pdfplumber

    blocks = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            if i >= max_pages:
                blocks.append(f"<!-- 已截断：仅解析前 {max_pages} 页，共 {len(pdf.pages)} 页 -->")
                break
            blocks.extend(_page_markdown(page))
    return "\n\n".join(b for b in blocks if b and b.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--max-pages", type=int, default=300)
    a = ap.parse_args()
    md = pdf_to_md(a.path, a.max_pages)
    sys.stdout.write(md.strip() + "\n")


if __name__ == "__main__":
    main()
