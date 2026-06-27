"use client";
import { useRef, useState } from "react";

export type DocItem = {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  createdAt: string;
  pushedAt: string | null;
};

export default function DocList({
  docs,
  selectedId,
  onSelect,
  onUploaded,
}: {
  docs: DocItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUploaded: (id: string) => void;
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

  return (
    <aside className="list-col">
      <div className="upload-box">
        <input type="file" ref={fileRef} />
        <button onClick={upload} disabled={busy}>
          {busy ? "处理中…" : "上传并处理"}
        </button>
        {busy && <p className="muted">解析→切片→上下文化→向量化…</p>}
        {err && <p className="err">⚠ {err}</p>}
      </div>
      <div className="list">
        {docs.length === 0 && <p className="muted">还没有文档，先上传一个</p>}
        {docs.map((d) => (
          <div key={d.id} className={d.id === selectedId ? "list-item active" : "list-item"}>
            <button className="li-main" onClick={() => onSelect(d.id)}>
              <div className="li-title">{d.title}</div>
              <div className="li-meta">
                {d.chunkCount} chunk · {d.status}
              </div>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
