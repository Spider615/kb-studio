"use client";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workbookToHtml } from "../lib/sheet-preview";

type Kind = "pdf" | "markdown" | "text" | "sheet" | "docx" | "slides" | "image" | "other";

function kindOf(filename: string): Kind {
  const e = (/\.[a-z0-9]+$/i.exec(filename)?.[0] ?? "").toLowerCase();
  if (e === ".pdf") return "pdf";
  if (e === ".md" || e === ".markdown") return "markdown";
  if (e === ".txt" || e === ".json" || e === ".log") return "text";
  if (e === ".csv" || e === ".tsv" || e === ".xlsx" || e === ".xls" || e === ".xlsm") return "sheet";
  if (e === ".docx" || e === ".doc") return "docx";
  if (e === ".pptx" || e === ".ppt" || e === ".odp") return "slides"; // 服务端 LibreOffice 转 PDF 再预览
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
  const [pdfUrl, setPdfUrl] = useState(""); // slides：LibreOffice 转出的 PDF 的 blob URL
  const kind = kindOf(filename);
  const url = `/api/docs/${docId}/file`;

  // blob URL 随 pdfUrl 变化/卸载时回收，避免内存泄漏
  useEffect(() => () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  }, [pdfUrl]);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setText("");
    setHtml("");
    setPdfUrl("");
    if (kind === "pdf" || kind === "image" || kind === "other") return; // 这些不需要预取

    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        // slides(pptx/ppt/odp)：走服务端 LibreOffice 转 PDF 的专用端点（首次会现转，稍慢）
        if (kind === "slides") {
          const res = await fetch(`/api/docs/${docId}/preview-pdf`, { signal: ctrl.signal });
          if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `转换失败 (${res.status})`);
          const blob = await res.blob();
          setPdfUrl(URL.createObjectURL(blob));
          return;
        }

        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `加载失败 (${res.status})`);

        if (kind === "markdown" || kind === "text") {
          setText(await res.text());
        } else if (kind === "sheet") {
          const XLSX = await import("xlsx");
          const wb = isBinarySheet(filename)
            ? XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
            : XLSX.read(await res.text(), { type: "string" });
          setHtml(workbookToHtml(XLSX, wb));
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
          <div className="preview-actions">
            <a className="btn" href={url} download={filename}>
              下载
            </a>
            <button type="button" className="btn ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className="preview-body">
          {loading && <p className="muted">{kind === "slides" ? "正在转换为 PDF 预览（首次较慢）…" : "加载中…"}</p>}
          {err && <p className="err">⚠ {err}</p>}
          {!loading && !err && kind === "pdf" && <iframe className="preview-frame" src={url} title={filename} />}
          {!loading && !err && kind === "slides" && pdfUrl && (
            <iframe className="preview-frame" src={pdfUrl} title={filename} />
          )}
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
