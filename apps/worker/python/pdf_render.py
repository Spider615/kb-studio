#!/usr/bin/env python3
"""扫描 PDF 检测 + 逐页渲染（无模型、无网络）。
判断 PDF 是否扫描件（几乎无文本层）；是则用 pypdfium2 逐页渲染成 PNG（base64），
输出 JSON 到 stdout：{scanned, page_count, avg_chars, rendered, truncated, pages:[base64...]}。
用法：python pdf_render.py <pdf> [--max-pages N] [--scale S] [--char-threshold C]"""
import sys
import json
import base64
import io
import argparse


def _junk_ratio(text):
    """坏字比例：字体 cmap 损坏时文本层常映射到 私用区(PUA)/C1 控制符/替换符(U+FFFD)。
    语言无关、安全信号（不含 Latin-1 字母 00C0-00FF，免误伤法/德/西等欧语正文）。"""
    if not text:
        return 0.0
    junk = 0
    for ch in text:
        o = ord(ch)
        if (0x0080 <= o <= 0x009F) or (0xE000 <= o <= 0xF8FF) or o == 0xFFFD:
            junk += 1
    return junk / len(text)


def text_stats(path):
    """返回 (总文本字符数, 页数, 坏字比)，用 pdfplumber 抽文本层。"""
    import pdfplumber

    total = 0
    junk_total = 0.0
    with pdfplumber.open(path) as pdf:
        pages = len(pdf.pages)
        for pg in pdf.pages:
            t = (pg.extract_text() or "").strip()
            total += len(t)
            junk_total += _junk_ratio(t) * len(t)
    junk_ratio = (junk_total / total) if total else 0.0
    return total, pages, junk_ratio


def render_pages(path, max_pages, scale):
    """逐页渲染成 PNG base64，返回 (base64列表, 总页数, 是否截断)。"""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(path)
    n = len(pdf)
    m = min(n, max_pages)
    out = []
    for i in range(m):
        bmp = pdf[i].render(scale=scale)
        pil = bmp.to_pil()
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        out.append(base64.b64encode(buf.getvalue()).decode())
    return out, n, (n > max_pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--max-pages", type=int, default=50)
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--char-threshold", type=int, default=8)  # 平均每页字符数 < 此值 → 判为扫描件
    # 坏字比 > 此值 → 判为整字体 cmap 损坏/需 OCR。取 0.4：仅坏字占主导才触发，避免误伤含少量
    # 符号/勾选框字体(Wingdings/Symbol 常映射到 F000-F0FF 私用区)的正常文档。
    ap.add_argument("--junk-threshold", type=float, default=0.4)
    a = ap.parse_args()

    total, pages, junk_ratio = text_stats(a.path)
    avg = (total / pages) if pages else 0
    # 需 OCR：几乎无文本(扫描件) 或 文本层坏字比过高(字体 cmap 损坏)——两种都走渲染+vision
    scanned = pages > 0 and (avg < a.char_threshold or junk_ratio > a.junk_threshold)
    result = {
        "scanned": scanned,
        "page_count": pages,
        "avg_chars": round(avg, 1),
        "junk_ratio": round(junk_ratio, 3),
        "rendered": 0,
        "truncated": False,
        "pages": [],
    }
    if scanned:
        imgs, n, truncated = render_pages(a.path, a.max_pages, a.scale)
        result["rendered"] = len(imgs)
        result["truncated"] = truncated
        result["pages"] = imgs
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
