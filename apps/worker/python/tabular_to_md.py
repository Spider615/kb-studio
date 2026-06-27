#!/usr/bin/env python3
"""确定性表格解析：csv/tsv/xlsx/xls → markdown 表格（逐行保真，无模型）。
用法：python tabular_to_md.py <文件路径>   → markdown 打到 stdout。
xlsx 每个非空 sheet 输出 `# {sheet名}` + 整表；csv 直接输出整表。"""
import sys
import os
import csv


def cell(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).replace("\r", " ").replace("\n", " ").replace("|", "\\|").strip()


def table_md(rows):
    """rows: list[list]。第一行表头，其余数据行。列数按最大列对齐。"""
    rows = [r for r in rows if any(cell(c) != "" for c in r)]  # 丢全空行
    if not rows:
        return ""
    ncol = max(len(r) for r in rows)
    rows = [list(r) + [None] * (ncol - len(r)) for r in rows]
    header = rows[0]
    out = []
    out.append("| " + " | ".join(cell(c) for c in header) + " |")
    out.append("| " + " | ".join(["---"] * ncol) + " |")
    for r in rows[1:]:
        out.append("| " + " | ".join(cell(c) for c in r) + " |")
    return "\n".join(out)


def parse_csv(path):
    # 按扩展名定分隔符；utf-8-sig 兼容带 BOM 的 Excel 导出 csv
    delim = "\t" if path.lower().endswith(".tsv") else ","
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f, delimiter=delim))
    return table_md(rows)


def parse_xlsx(path):
    import openpyxl

    # 双载：data_only=True 取 Excel 缓存的计算值；没有缓存(如 openpyxl 生成且未被 Excel 打开过)
    # 则回退到公式串，避免公式列变空白。真实 Excel 存的文件直接显示计算结果。
    wb_v = openpyxl.load_workbook(path, data_only=True)
    wb_f = openpyxl.load_workbook(path, data_only=False)
    parts = []
    for ws_v, ws_f in zip(wb_v.worksheets, wb_f.worksheets):
        rows = []
        for rv, rf in zip(ws_v.iter_rows(values_only=True), ws_f.iter_rows(values_only=True)):
            rows.append([v if v is not None else f for v, f in zip(rv, rf)])
        md = table_md(rows)
        if not md:
            continue
        parts.append(f"# {ws_v.title}\n\n{md}")
    return "\n\n".join(parts)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("用法: python tabular_to_md.py <文件路径>\n")
        sys.exit(2)
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv", ".tsv"):
        md = parse_csv(path)
    elif ext in (".xlsx", ".xlsm", ".xls"):
        md = parse_xlsx(path)
    else:
        sys.stderr.write(f"不支持的表格类型: {ext}\n")
        sys.exit(2)
    sys.stdout.write(md.strip() + "\n")


if __name__ == "__main__":
    main()
