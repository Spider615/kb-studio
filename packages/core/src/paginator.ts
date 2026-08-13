import { estimateTokens } from "./tokenize";

export interface PaginateOptions {
  maxPageTokens?: number; // 单页上限，超过则次级切分，默认 8000
  minPageTokens?: number; // 低于此值与相邻页合并，默认 300
}

export interface Page {
  pageIndex: number; // 从 1 开始；目录页由 buildWiki 另行插入为 0
  title: string;
  content: string; // 逐字取自入参 markdown
  headingPath: string[];
  tokenEstimate: number;
  continued?: boolean; // 由超长内容硬切产生的续页
}

interface HeadingLine {
  line: number;
  level: number;
  text: string;
}

/** 扫出所有 ATX 标题行（跳过围栏代码块内的 # 号）。 */
function scanHeadings(lines: string[]): HeadingLine[] {
  const out: HeadingLine[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const marker = fence[1]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) out.push({ line: i, level: h[1]!.length, text: h[2]!.trim() });
  }
  return out;
}

/**
 * 选切页层级：取出现次数最多的层级；次数并列时取更浅的层级。
 * 只出现一次的层级（通常是文档标题 H1）不作为切页层级，除非它是唯一的层级。
 */
function pickSplitLevel(headings: HeadingLine[]): number | null {
  if (headings.length === 0) return null;
  const count = new Map<number, number>();
  for (const h of headings) count.set(h.level, (count.get(h.level) ?? 0) + 1);
  const multi = [...count.entries()].filter(([, n]) => n >= 2);
  const pool = multi.length > 0 ? multi : [...count.entries()];
  pool.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pool[0]![0];
}

/** 给定行号，算出它所处的标题路径（各层级最近的一个标题）。 */
function headingPathAt(headings: HeadingLine[], line: number, splitLevel: number): string[] {
  const stack: string[] = [];
  for (const h of headings) {
    if (h.line > line) break;
    if (h.level > splitLevel) continue;
    stack.length = Math.max(0, h.level - 1);
    stack[h.level - 1] = h.text;
  }
  return stack.filter((s) => s != null);
}

export function paginate(markdown: string, opts: PaginateOptions = {}): Page[] {
  const minPageTokens = opts.minPageTokens ?? 300;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings = scanHeadings(lines);
  const splitLevel = pickSplitLevel(headings);

  // 无标题：整篇一页
  if (splitLevel === null) {
    const content = markdown.trim();
    if (!content) return [];
    return [{ pageIndex: 1, title: "全文", content, headingPath: [], tokenEstimate: estimateTokens(content) }];
  }

  const cuts = headings.filter((h) => h.level === splitLevel);
  // 切页层级只有一个标题：整篇一页
  if (cuts.length === 0) {
    const content = markdown.trim();
    return [{ pageIndex: 1, title: headings[0]!.text, content, headingPath: [headings[0]!.text], tokenEstimate: estimateTokens(content) }];
  }

  const raw: Array<{ title: string; content: string; headingPath: string[] }> = [];
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]!;
    // 第一页从文首开始，把前言并进来；其余从各自标题行开始
    const from = i === 0 ? 0 : cut.line;
    const to = i + 1 < cuts.length ? cuts[i + 1]!.line : lines.length;
    const content = lines.slice(from, to).join("\n").trim();
    if (!content) continue;
    raw.push({ title: cut.text, content, headingPath: headingPathAt(headings, cut.line, splitLevel) });
  }

  const maxPageTokens = opts.maxPageTokens ?? 8000;
  const merged = mergeShort(raw, minPageTokens);
  const split = merged.flatMap((p) => splitOversized(p, maxPageTokens, headings, splitLevel));
  return numberPages(split);
}

/** 过短页与后一页合并（末页则并入前一页），避免产生大量碎页。 */
function mergeShort(
  pages: Array<{ title: string; content: string; headingPath: string[] }>,
  minPageTokens: number,
): Array<{ title: string; content: string; headingPath: string[] }> {
  if (minPageTokens <= 0 || pages.length <= 1) return pages;
  const out: typeof pages = [];
  for (const p of pages) {
    const prev = out[out.length - 1];
    if (prev && estimateTokens(prev.content) < minPageTokens) {
      prev.content = `${prev.content}\n\n${p.content}`;
      continue; // 合并后沿用前一页的标题与路径
    }
    out.push({ ...p });
  }
  // 末页仍过短则并入前一页
  if (out.length > 1 && estimateTokens(out[out.length - 1]!.content) < minPageTokens) {
    const last = out.pop()!;
    out[out.length - 1]!.content += `\n\n${last.content}`;
  }
  return out;
}

function numberPages(pages: Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }>): Page[] {
  return pages.map((p, i) => ({
    pageIndex: i + 1,
    title: p.title,
    content: p.content,
    headingPath: p.headingPath,
    tokenEstimate: estimateTokens(p.content),
    ...(p.continued ? { continued: true } : {}),
  }));
}

/** 一段 markdown 里连续的表格行区间（含表头两行）。找不到表格返回 null。 */
function findTableBlock(lines: string[]): { start: number; end: number } | null {
  const isRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i] ?? "")) continue;
    let j = i;
    while (j < lines.length && isRow(lines[j] ?? "")) j++;
    if (j - i >= 3) return { start: i, end: j }; // 表头 + 分隔行 + 至少一行数据
    i = j;
  }
  return null;
}

/**
 * 超长页切分，按优先级：
 * 1) 页内有次级标题 → 按次级标题切
 * 2) 页主体是表格 → 按数据行切，每页重复表头两行
 * 3) 其余 → 按空行分段硬切
 * 续页标题追加「（续）」并标 continued。
 */
function splitOversized(
  page: { title: string; content: string; headingPath: string[]; continued?: boolean },
  maxPageTokens: number,
  headings: HeadingLine[],
  splitLevel: number,
): Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }> {
  if (estimateTokens(page.content) <= maxPageTokens) return [page];
  const lines = page.content.split("\n");

  // 1) 次级标题
  const subPattern = new RegExp(`^#{${splitLevel + 1}}\\s+\\S`);
  const subCuts = lines.map((l, i) => (subPattern.test(l) ? i : -1)).filter((i) => i >= 0);
  let parts: string[];
  if (subCuts.length >= 2) {
    parts = [];
    const bounds = [0, ...subCuts.slice(1), lines.length];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const seg = lines.slice(bounds[i]!, bounds[i + 1]!).join("\n").trim();
      if (seg) parts.push(seg);
    }
  } else {
    const table = findTableBlock(lines);
    if (table) {
      // 2) 表格按行切，每页重复表头两行
      const head = lines.slice(0, table.start).join("\n");
      const header = lines.slice(table.start, table.start + 2).join("\n");
      const dataRows = lines.slice(table.start + 2, table.end);
      const tail = lines.slice(table.end).join("\n").trim();
      const budget = Math.max(1, maxPageTokens - estimateTokens(`${head}\n${header}`));
      parts = [];
      let buf: string[] = [];
      for (const row of dataRows) {
        buf.push(row);
        if (estimateTokens(buf.join("\n")) >= budget) {
          parts.push([head, header, ...buf].filter(Boolean).join("\n").trim());
          buf = [];
        }
      }
      if (buf.length) parts.push([head, header, ...buf].filter(Boolean).join("\n").trim());
      if (tail) parts.push(tail);
    } else {
      // 3) 按空行分段硬切
      parts = [];
      let buf: string[] = [];
      for (const para of page.content.split(/\n\s*\n/)) {
        buf.push(para);
        if (estimateTokens(buf.join("\n\n")) >= maxPageTokens) {
          parts.push(buf.join("\n\n").trim());
          buf = [];
        }
      }
      if (buf.length) parts.push(buf.join("\n\n").trim());
    }
  }

  if (parts.length <= 1) return [page];
  return parts.map((content, i) => ({
    title: i === 0 ? page.title : `${page.title}（续${i}）`,
    content,
    headingPath: page.headingPath,
    ...(i > 0 ? { continued: true } : {}),
  }));
}
