#!/usr/bin/env python3
"""扫描 PDF 检测 + 逐页渲染（无模型、无网络）。
判断 PDF 是否扫描件（几乎无文本层）；是则用 pypdfium2 逐页渲染成 PNG（base64），
输出 JSON 到 stdout：{scanned, page_count, avg_chars, rendered, truncated, pages:[base64...]}。
用法：python pdf_render.py <pdf> [--max-pages N] [--scale S] [--char-threshold C]"""
import sys
import json
import base64
import io
import re
import argparse

_CID_RE = re.compile(r"\(cid:\d+\)")


def _junk_ratio(text):
    """坏字比例：字体 cmap 损坏时文本层常映射到 私用区(PUA)/C1 控制符/替换符(U+FFFD)。
    语言无关、安全信号（不含 Latin-1 字母 00C0-00FF，免误伤法/德/西等欧语正文）。

    注意本函数只认「非法字符」。字体子集缺 ToUnicode 时，文本层会映射成
    **合法但语义错乱**的字符（如 GB→犌犅、标题→!"#$），这类逃过本检测——
    由下面 _cid_ratio / font_unmapped_ratio 两个信号负责。"""
    if not text:
        return 0.0
    junk = 0
    for ch in text:
        o = ord(ch)
        if (0x0080 <= o <= 0x009F) or (0xE000 <= o <= 0xF8FF) or o == 0xFFFD:
            junk += 1
    return junk / len(text)


def _cid_ratio(text):
    """`(cid:N)` 字面量占比：pdfminer/pdfplumber 在字形无 ToUnicode 映射时的标准输出。
    语言无关。正常 PDF 该比例恒为 0，故信号极干净。"""
    if not text:
        return 0.0
    return sum(len(m) for m in _CID_RE.findall(text)) / len(text)


def font_unmapped_ratio(path, max_pages=10):
    """无 /ToUnicode 的字体占比——比抽文本更根本的信号：不解码正文就能判文本层可信度。
    返回 (无映射字体数, 字体总数, 比例)。读不到字体资源时按「健康」处理（返回 0），
    避免因 PDF 结构异常误判成需 OCR。"""
    try:
        from pypdf import PdfReader

        reader = PdfReader(path)
        total = bad = 0
        for pg in reader.pages[:max_pages]:
            try:
                fonts = pg["/Resources"]["/Font"]
            except Exception:
                continue
            for key in fonts:
                try:
                    font = fonts[key].get_object()
                except Exception:
                    continue
                total += 1
                if "/ToUnicode" not in font:
                    bad += 1
        return bad, total, (bad / total if total else 0.0)
    except Exception:
        return 0, 0, 0.0


def text_stats(path):
    """返回 (总文本字符数, 页数, 坏字比, cid比)，用 pdfplumber 抽文本层。"""
    import pdfplumber

    total = 0
    junk_total = 0.0
    cid_total = 0.0
    with pdfplumber.open(path) as pdf:
        pages = len(pdf.pages)
        for pg in pdf.pages:
            t = (pg.extract_text() or "").strip()
            total += len(t)
            junk_total += _junk_ratio(t) * len(t)
            cid_total += _cid_ratio(t) * len(t)
    junk_ratio = (junk_total / total) if total else 0.0
    cid_ratio = (cid_total / total) if total else 0.0
    return total, pages, junk_ratio, cid_ratio


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
    # `(cid:N)` 字面量比 > 此值 → 字形无 ToUnicode 映射。取 0.05：实测坏文档 66.5%、
    # 正常文档恒为 0，两端分离极干净，阈值取在低位即可，不存在误伤风险。
    ap.add_argument("--cid-threshold", type=float, default=0.05)
    # 无 /ToUnicode 字体占比 > 此值 → 文本层不可信。取 0.5：实测坏文档 100%、正常文档 0%。
    # 用「过半」而非「全部」，兼容中英混排里只有中文子集字体坏掉的情况。
    ap.add_argument("--font-threshold", type=float, default=0.5)
    a = ap.parse_args()

    total, pages, junk_ratio, cid_ratio = text_stats(a.path)
    avg = (total / pages) if pages else 0
    unmapped_fonts, total_fonts, font_ratio = font_unmapped_ratio(a.path)
    # 需 OCR 的四种情形，任一命中即走渲染+vision：
    #   1) 几乎无文本 —— 扫描件
    #   2) 坏字比高 —— 字体 cmap 损坏，映射到 PUA/C1/U+FFFD 这类非法字符
    #   3) (cid:N) 比高 —— 字形无 ToUnicode，pdfminer 只能吐 cid 编号
    #   4) 无 ToUnicode 字体占多数 —— 同 3 的根因，但不必抽文本就能判
    # 3/4 覆盖的是「合法字符但语义错乱」这类：文本层看着有内容、实则是垃圾
    # （典型如国标 PDF 的方正字体子集，GB→犌犅、标题→!"#$），2 完全测不到。
    scanned = pages > 0 and (
        avg < a.char_threshold
        or junk_ratio > a.junk_threshold
        or cid_ratio > a.cid_threshold
        or font_ratio > a.font_threshold
    )
    result = {
        "scanned": scanned,
        "page_count": pages,
        "avg_chars": round(avg, 1),
        "junk_ratio": round(junk_ratio, 3),
        "cid_ratio": round(cid_ratio, 3),
        "font_unmapped_ratio": round(font_ratio, 3),
        "font_unmapped": unmapped_fonts,
        "font_total": total_fonts,
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
