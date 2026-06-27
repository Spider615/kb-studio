"use client";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Kind = "pdf" | "markdown" | "text" | "sheet" | "docx" | "image" | "other";

function kindOf(filename: string): Kind {
  const e = (/\.[a-z0-9]+$/i.exec(filename)?.[0] ?? "").toLowerCase();
  if (e === ".pdf") return "pdf";
  if (e === ".md" || e === ".markdown") return "markdown";
  if (e === ".txt" || e === ".json" || e === ".log") return "text";
  if (e === ".csv" || e === ".tsv" || e === ".xlsx" || e === ".xls" || e === ".xlsm") return "sheet";
  if (e === ".docx" || e === ".doc") return "docx";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(e)) return "image";
  return "other";
}

const isBinarySheet = (filename: string) => /\.(xlsx|xls|xlsm)$/i.test(filename);

export default function FilePreview({
  open,
  onClose,
  docId,
  filename,
}: {
  open: boolean;
  onClose: () => void;
  docId: string;
  filename: string;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [html, setHtml] = useState(""); // docx / 表格 渲染出的 HTML
  const kind = kindOf(filename);
  const url = `/api/docs/${docId}/file`;

  useEffect(() => {
    if (!open) return;
    setErr("");
    setText("");
    setHtml("");
    if (kind === "pdf" || kind === "image" || kind === "other") return; // 这些不需要预取

    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `加载失败 (${res.status})`);

        if (kind === "markdown" || kind === "text") {
          setText(await res.text());
        } else if (kind === "sheet") {
          const XLSX = await import("xlsx");
          const wb = isBinarySheet(filename)
            ? XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
            : XLSX.read(await res.text(), { type: "string" });
          const parts = wb.SheetNames.map((n) => {
            const table = XLSX.utils.sheet_to_html(wb.Sheets[n]!);
            return wb.SheetNames.length > 1 ? `<h4 class="sheet-name">${n}</h4>${table}` : table;
          });
          setHtml(parts.join("\n"));
        } else if (kind === "docx") {
          // mammoth 浏览器构建：docx → HTML
          // @ts-expect-error mammoth 浏览器子路径无类型声明
          const mammoth = await import("mammoth/mammoth.browser");
          const out = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() });
          setHtml(out.value || "<p>（空文档）</p>");
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [open, docId, filename, kind, url]);

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal preview" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <h3>{filename}</h3>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn" href={url} download={filename}>
              下载
            </a>
            <button type="button" className="btn ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className="preview-body">
          {loading && <p className="muted">加载中…</p>}
          {err && <p className="err">⚠ {err}</p>}
          {!loading && !err && kind === "pdf" && <iframe className="preview-frame" src={url} title={filename} />}
          {!loading && !err && kind === "image" && <img className="preview-img" src={url} alt={filename} />}
          {!loading && !err && kind === "markdown" && (
            <div className="a-body markdown" style={{ background: "transparent", border: 0, padding: 0 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          )}
          {!loading && !err && kind === "text" && <pre className="preview-text">{text}</pre>}
          {!loading && !err && (kind === "sheet" || kind === "docx") && (
            <div className="file-html" dangerouslySetInnerHTML={{ __html: html }} />
          )}
          {!loading && !err && kind === "other" && (
            <div className="empty">
              <div className="muted">此格式不支持内联预览</div>
              <a className="btn primary" href={url} download={filename}>
                下载原文件
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
