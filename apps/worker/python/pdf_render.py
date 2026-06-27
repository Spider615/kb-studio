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


def text_stats(path):
    """返回 (总文本字符数, 页数)，用 pdfplumber 抽文本层。"""
    import pdfplumber

    total = 0
    with pdfplumber.open(path) as pdf:
        pages = len(pdf.pages)
        for pg in pdf.pages:
            total += len((pg.extract_text() or "").strip())
    return total, pages


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
    a = ap.parse_args()

    total, pages = text_stats(a.path)
    avg = (total / pages) if pages else 0
    scanned = pages > 0 and avg < a.char_threshold
    result = {
        "scanned": scanned,
        "page_count": pages,
        "avg_chars": round(avg, 1),
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
