import { estimateTokens } from "./tokenize";
import type { Chunk, ChunkType } from "./contracts";

export interface ChunkOptions {
  targetTokens?: number; // 目标 chunk 大小，默认 700
  maxTokens?: number; // 超过则二次切，默认 800
  overlapTokens?: number; // 相邻 chunk 重叠，默认 80
}

export interface ChunkDocInput {
  docId: string;
  docTitle: string;
  markdown: string;
}

type BlockKind = "heading" | "table" | "code" | "para";
interface Block {
  kind: BlockKind;
  text: string;
  level?: number;
  headingText?: string;
}

/** 把 markdown 切成块：代码块、表格整块保留，标题单独成块，其余按空行分段。 */
function toBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    const text = para.join("\n").trim();
    if (text) blocks.push({ kind: "para", text });
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flushPara();
      const marker = fence[1]!;
      const buf = [line];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) buf.push(lines[i++] ?? "");
      if (i < lines.length) buf.push(lines[i++] ?? "");
      blocks.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      flushPara();
      blocks.push({ kind: "heading", text: line.trim(), level: h[1]!.length, headingText: h[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) buf.push(lines[i++] ?? "");
      blocks.push({ kind: "table", text: buf.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

/** 超长段落按句子边界切到接近 target。 */
function splitBySentence(text: string, target: number): string[] {
  const parts = text.split(/(?<=[。！？!?\n])/).filter((s) => s.trim());
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && estimateTokens(cur + p) > target) {
      out.push(cur.trim());
      cur = p;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text.trim()];
}

/** 取文本末尾约 overlapTokens 个 token 作为重叠。 */
function tail(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const sents = text.split(/(?<=[。！？!?\n])/).filter((s) => s.trim());
  let acc = "";
  for (let k = sents.length - 1; k >= 0; k--) {
    const cand = (sents[k] ?? "") + acc;
    if (acc && estimateTokens(cand) > overlapTokens) break;
    acc = cand;
  }
  return acc.trim();
}

/**
 * 结构优先 → 大小兜底 → 重叠保护 → 元数据。
 * 在 markdown 上：按标题分节、表格/代码整块、超 max 的段落按句切、相邻文本块带 overlap。
 */
export function chunkMarkdown(input: ChunkDocInput, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 700;
  const max = opts.maxTokens ?? 800;
  const overlap = opts.overlapTokens ?? 80;

  const chunks: Chunk[] = [];
  const stack: { level: number; text: string }[] = [];
  let parts: { text: string; type: ChunkType }[] = [];
  let tokens = 0;
  let hasBody = false; // 是否已积累正文（纯标题/overlap 不算）

  const typeOf = (): ChunkType => {
    const set = new Set(parts.filter((p) => p.text.trim()).map((p) => p.type));
    return set.size === 1 ? [...set][0]! : "text";
  };

  const emit = (carryOverlap: boolean) => {
    const original = parts.map((p) => p.text).join("\n\n").trim();
    if (!original) {
      parts = [];
      tokens = 0;
      hasBody = false;
      return;
    }
    const idx = chunks.length;
    const type = typeOf();
    chunks.push({
      id: `${input.docId}_c${String(idx).padStart(4, "0")}`,
      doc_id: input.docId,
      content: original,
      content_original: original,
      context_prefix: null,
      chunk_index: idx,
      chunk_type: type,
      token_estimate: estimateTokens(original),
      metadata: {
        doc_id: input.docId,
        doc_title: input.docTitle,
        heading_path: stack.map((s) => s.text),
        page_num: null,
        chunk_index: idx,
        chunk_type: type,
        image_url: null,
        image_id: null,
        prev_chunk_id: null,
        next_chunk_id: null,
      },
    });
    const carry = carryOverlap && type === "text" ? tail(original, overlap) : "";
    parts = carry ? [{ text: carry, type: "text" }] : [];
    tokens = carry ? estimateTokens(carry) : 0;
    hasBody = false;
  };

  const pushBody = (text: string, type: ChunkType) => {
    const t = estimateTokens(text);
    if (hasBody && tokens + t > target) emit(true);
    parts.push({ text, type });
    tokens += t;
    hasBody = true;
  };

  for (const b of toBlocks(input.markdown)) {
    if (b.kind === "heading") {
      if (hasBody) emit(false); // 跨标题不带 overlap
      while (stack.length && stack[stack.length - 1]!.level >= (b.level ?? 1)) stack.pop();
      stack.push({ level: b.level ?? 1, text: b.headingText ?? b.text });
      parts.push({ text: b.text, type: "text" }); // 标题进 chunk，但不算 body
      tokens += estimateTokens(b.text);
      continue;
    }
    if (b.kind === "table" || b.kind === "code") {
      const t = estimateTokens(b.text);
      const type: ChunkType = b.kind === "table" ? "table" : "code";
      if (t > max) {
        if (parts.length) emit(false);
        parts.push({ text: b.text, type });
        tokens += t;
        hasBody = true;
        emit(false); // 大表/大代码整块自成一 chunk
      } else pushBody(b.text, type);
      continue;
    }
    // 段落
    const t = estimateTokens(b.text);
    if (t > max) for (const piece of splitBySentence(b.text, target)) pushBody(piece, "text");
    else pushBody(b.text, "text");
  }
  if (hasBody) emit(false);

  for (let i = 0; i < chunks.length; i++) {
    chunks[i]!.metadata.prev_chunk_id = i > 0 ? chunks[i - 1]!.id : null;
    chunks[i]!.metadata.next_chunk_id = i < chunks.length - 1 ? chunks[i + 1]!.id : null;
  }
  return chunks;
}
