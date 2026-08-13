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
  // 统一重编号（防递归编号撞车）
  return numberPages(renumberPages(split));
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
      // 合并后取体量更大那页的标题和路径
      const prevTokens = estimateTokens(prev.content);
      const pTokens = estimateTokens(p.content);
      if (pTokens > prevTokens) {
        prev.title = p.title;
        prev.headingPath = p.headingPath;
      }
      prev.content = `${prev.content}\n\n${p.content}`;
      continue;
    }
    out.push({ ...p });
  }
  // 末页仍过短则并入前一页
  if (out.length > 1 && estimateTokens(out[out.length - 1]!.content) < minPageTokens) {
    const last = out.pop()!;
    const prevTokens = estimateTokens(out[out.length - 1]!.content);
    const lastTokens = estimateTokens(last.content);
    if (lastTokens > prevTokens) {
      out[out.length - 1]!.title = last.title;
      out[out.length - 1]!.headingPath = last.headingPath;
    }
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
 * 2) 页主体是表格 → 按数据行切，每页重复表头两行（表头过大时仅首页重复）
 * 3) 其余 → 按空行分段硬切、或按句子边界兜底
 * 结果仍超预算则递归处理。续页标题追加「（续）」并标 continued。
 */
function splitOversized(
  page: { title: string; content: string; headingPath: string[]; continued?: boolean },
  maxPageTokens: number,
  headings: HeadingLine[],
  splitLevel: number,
  depth: number = 0,
): Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }> {
  if (estimateTokens(page.content) <= maxPageTokens) return [page];
  // 防止无限递归：达到一定深度后直接返回
  if (depth > 10) return [page];

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
      const headTokens = estimateTokens(head);
      const headerTokens = estimateTokens(header);
      parts = [];

      // 判据：剩余预算是否低于合理下限（预算 30% 或绝对下限 100）
      const minBudget = Math.max(100, Math.floor(maxPageTokens * 0.3));
      const remainingBudget = maxPageTokens - headerTokens - headTokens;
      const headTooLarge = head && remainingBudget < minBudget;

      if (headTooLarge) {
        // head 单独成第一页，后续子页不重复 head
        parts.push(head);
        const budget = Math.max(1, maxPageTokens - headerTokens);
        let buf: string[] = [];
        for (const row of dataRows) {
          buf.push(row);
          if (estimateTokens(buf.join("\n")) >= budget) {
            parts.push([header, ...buf].filter(Boolean).join("\n").trim());
            buf = [];
          }
        }
        if (buf.length) parts.push([header, ...buf].filter(Boolean).join("\n").trim());
        if (tail) parts.push(tail);
      } else {
        // head 合理，每页都重复
        const budget = Math.max(1, remainingBudget);
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
      }
    } else {
      // 3) 按空行分段硬切
      parts = [];
      let buf: string[] = [];
      const paras = page.content.split(/\n\s*\n/);
      for (const para of paras) {
        buf.push(para);
        if (estimateTokens(buf.join("\n\n")) >= maxPageTokens) {
          parts.push(buf.join("\n\n").trim());
          buf = [];
        }
      }
      if (buf.length) parts.push(buf.join("\n\n").trim());

      // 无空行可切的超长段落用预算硬切兜底
      if (parts.length === 1 && estimateTokens(parts[0]!) > maxPageTokens) {
        const longPart = parts[0]!;
        parts = splitByBudget(longPart, maxPageTokens);
      }
    }
  }

  if (parts.length <= 1) return [page];

  // 递归处理仍超预算的子页，但不编号（由上层 renumberPages 统一处理）
  const result: Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    const content = parts[i]!;
    const isContinued = i > 0; // 只有第 2、3... 部分标 continued，第 1 部分保持原值
    const subPage = {
      title: page.title, // 暂不编号
      content,
      headingPath: page.headingPath,
      ...(isContinued ? { continued: true } : { continued: page.continued }),
    };
    if (estimateTokens(content) > maxPageTokens) {
      const subs = splitOversized(subPage, maxPageTokens, headings, splitLevel, depth + 1);
      result.push(...subs);
    } else {
      result.push(subPage);
    }
  }
  return result;
}

/**
 * 按 estimateTokens 同口径逐字符累加权重，达到预算即切。
 * CJK 字符 1 个 = 1 token；其余字符 = 0.25 token。
 * 使用 for...of 码点迭代，天然不会切坏 emoji 等代理对。
 */
function splitByBudget(text: string, budgetTokens: number): string[] {
  const out: string[] = [];
  let buf = "";
  let acc = 0;
  const cjkPattern = /[㐀-鿿豈-﫿぀-ヿ＀-￯]/; // 与 tokenize.ts 同口径

  for (const ch of text) {
    const w = cjkPattern.test(ch) ? 1 : 0.25;
    if (acc + w > budgetTokens && buf) {
      out.push(buf);
      buf = "";
      acc = 0;
    }
    buf += ch;
    acc += w;
  }

  if (buf) out.push(buf);
  return out.length > 0 ? out : [text];
}

/**
 * 统一重编号：把相同标题的页按出现顺序分别标 (无后缀)、（续1）、（续2）…。
 * 这样无论递归多少层，最终结果里同名标题的页全局唯一。
 * 注意：必须避开原文中真实存在的标题（非 continued 的页），否则会撞车。
 */
function renumberPages(
  pages: Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }>,
): Array<{ title: string; content: string; headingPath: string[]; continued?: boolean }> {
  // 第一遍：收集所有原文真实标题（非 continued 的页）
  const taken = new Set<string>();
  for (const p of pages) {
    if (!p.continued) {
      taken.add(p.title);
    }
  }

  // 第二遍：处理需要编号的页（continued 的页），避开已占用标题
  const titleCounters = new Map<string, number>(); // 记录每个基础标题已用过的续号
  return pages.map((p) => {
    if (!p.continued) {
      // 原文真实标题，保持原样
      return p;
    }

    // 需要编号：从 1 开始试探候选标题，跳过任何已占用的
    let counter = titleCounters.get(p.title) ?? 0;
    let candidate: string;
    do {
      counter++;
      candidate = `${p.title}（续${counter}）`;
    } while (taken.has(candidate));

    titleCounters.set(p.title, counter);
    taken.add(candidate); // 标记这个候选已占用，防止后续重复
    return {
      ...p,
      title: candidate,
    };
  });
}
