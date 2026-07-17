#!/usr/bin/env python3
"""确定性 DOCX 解析：python-docx → markdown（无模型、逐块保真）。
用法：python docx_to_md.py <文件路径>  → markdown 打到 stdout。
按文档正文顺序遍历段落与表格：标题样式→#/##/…，列表→-，表格→markdown 表（复用 tabular 的空列/横幅清洗）。
标题层级从样式名解析（英文 Heading N / 中文 标题 N / Title），其他 locale 退化为普通段落，仍保真文本。

已知限制（同 prior Claude Code 路径，非本次回归）：
- 内容控件(w:sdt)、文本框/形状(txbxContent)、单元格内嵌套表内的正文不抽取（只遍历 body 顶层 CT_P/CT_Tbl）；
- 列表检测只看样式名，靠段落 numPr 实现的列表检测不到、有序列表丢序号；
- 内嵌图片不抽取（走 kb-studio 的图片/vision 步骤，与旧路径一致）。
产出过少时上层 DocxSandboxParser 会退回 Claude Code 兜底。"""
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tabular_to_md import table_md  # 复用：丢空列 + 跳标题横幅 + 单元格清洗


def _iter_blocks(doc):
    """按文档正文顺序产出 Paragraph / Table（python-docx 不直接支持有序遍历）。"""
    from docx.document import Document as _Doc
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    parent = doc.element.body
    for child in parent.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, doc)
        elif isinstance(child, CT_Tbl):
            yield Table(child, doc)


def _heading_level(style_name):
    """从样式名解析标题层级（1–6）；非标题返回 0。通用：英文/中文样式名。"""
    if not style_name:
        return 0
    s = style_name.strip().lower()
    if s in ("title", "标题"):
        return 1
    m = re.search(r"(?:heading|标题)\s*([1-9])", s)
    if m:
        return min(int(m.group(1)), 6)
    return 0


def _is_list(style_name):
    s = (style_name or "").lower()
    return "list" in s or "列表" in s or s.startswith("bullet")


def docx_to_md(path):
    import docx

    doc = docx.Document(path)
    out = []
    for block in _iter_blocks(doc):
        if block.__class__.__name__ == "Table":
            grid = [[c.text for c in row.cells] for row in block.rows]
            md = table_md(grid)  # 复用：丢空列/跳横幅/清洗
            if md:
                out.append(md)
            continue
        # Paragraph
        text = (block.text or "").strip()
        if not text:
            continue
        style = getattr(getattr(block, "style", None), "name", "") or ""
        lvl = _heading_level(style)
        if lvl:
            out.append("#" * lvl + " " + text)
        elif _is_list(style):
            out.append("- " + text)
        else:
            out.append(text)
    return "\n\n".join(out)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("用法: python docx_to_md.py <文件路径>\n")
        sys.exit(2)
    md = docx_to_md(sys.argv[1])
    sys.stdout.write(md.strip() + "\n")


if __name__ == "__main__":
    main()
