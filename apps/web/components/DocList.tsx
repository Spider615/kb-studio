"use client";
import { useRef, useState } from "react";

export type DocProgress = { stage: string; done: number; total: number };

export type DocItem = {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  createdAt: string;
  pushedAt: string | null;
  progress?: DocProgress | null;
  error?: string | null;
};

export const STAGE_LABEL: Record<string, string> = {
  parsing: "解析中",
  structuring: "生成结构中",
  contextualizing: "上下文化中",
  embedding: "向量化中",
  storing: "写入中",
};

function pct(p?: DocProgress | null): number | null {
  if (!p || p.total <= 0) return null;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

/** Postgres 时间戳（如 "2026-06-27 12:45:06.29+00"）→ 本地 "YYYY-MM-DD HH:mm"。 */
export function fmtTime(s?: string | null): string {
  if (!s) return "";
  let t = s.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(t)) t += ":00"; // "+00" → "+00:00"
  else if (!/([+-]\d{2}:?\d{2}|Z)$/.test(t)) t += "Z"; // 无时区按 UTC
  const d = new Date(t);
  if (isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function DocList({
  docs,
  selectedId,
  onSelect,
  onUploaded,
  onDelete,
}: {
  docs: DocItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUploaded: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (json.error) setErr(json.error);
      else {
        if (fileRef.current) fileRef.current.value = "";
        await onUploaded(json.docId);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  function dotClass(d: DocItem) {
    if (d.status === "failed") return "dot failed";
    if (d.status === "processing") return "dot pending";
    return "dot";
  }

  function meta(d: DocItem) {
    if (d.status === "processing") {
      const label = STAGE_LABEL[d.progress?.stage ?? ""] ?? "处理中";
      const p = pct(d.progress);
      return p === null ? label : `${label} ${p}%`;
    }
    if (d.status === "failed") return "处理失败";
    if (d.status === "pushed") return `${d.chunkCount} chunk · 已推送`;
    if (d.status === "ready") return `${d.chunkCount} chunk · 已就绪`;
    return d.status;
  }

  return (
    <>
      <input type="file" ref={fileRef} hidden onChange={upload} />
      <button type="button" className="cta" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? "上传中…" : "↑ 上传文档"}
      </button>
      {err && <p className="err" style={{ padding: "8px 4px 0" }}>⚠ {err}</p>}
      <div className="list-title">文档</div>
      <div className="list">
        {docs.length === 0 && <p className="muted" style={{ padding: "4px 8px" }}>还没有文档，先上传一个</p>}
        {docs.map((d) => {
          const p = d.status === "processing" ? pct(d.progress) : null;
          return (
            <div key={d.id} className={d.id === selectedId ? "item on" : "item"}>
              <button type="button" className="item-main" onClick={() => onSelect(d.id)}>
                <span className={dotClass(d)} />
                <div className="txt">
                  <div className="t">{d.title}</div>
                  <div className="m">{meta(d)}</div>
                  {d.status === "processing" ? (
                    <div className="pbar">
                      <span style={p === null ? { width: "30%" } : { width: `${p}%` }} className={p === null ? "indet" : ""} />
                    </div>
                  ) : (
                    <div className="m time">{fmtTime(d.createdAt)}</div>
                  )}
                </div>
              </button>
              <button
                type="button"
                className="x"
                onClick={() => onDelete(d.id)}
                aria-label="删除文档"
                title="删除"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
