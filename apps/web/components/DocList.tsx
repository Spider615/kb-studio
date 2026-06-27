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

  const isReady = (d: DocItem) => d.status === "ready" || d.status === "pushed";
  function statusText(d: DocItem) {
    if (d.status === "pushed") return `${d.chunkCount} chunk · 已推送`;
    if (d.status === "ready") return `${d.chunkCount} chunk · 已就绪`;
    return d.status;
  }

  return (
    <>
      <input type="file" ref={fileRef} hidden onChange={upload} />
      <button className="cta" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? "处理中…" : "↑ 上传文档"}
      </button>
      {busy && <p className="muted" style={{ padding: "8px 4px 0" }}>解析→切片→上下文化→向量化…</p>}
      {err && <p className="err" style={{ padding: "8px 4px 0" }}>⚠ {err}</p>}
      <div className="list-title">文档</div>
      <div className="list">
        {docs.length === 0 && <p className="muted" style={{ padding: "4px 8px" }}>还没有文档，先上传一个</p>}
        {docs.map((d) => (
          <div key={d.id} className={d.id === selectedId ? "item on" : "item"}>
            <button className="item-main" onClick={() => onSelect(d.id)}>
              <span className={isReady(d) ? "dot" : "dot pending"} />
              <div className="txt">
                <div className="t">{d.title}</div>
                <div className="m">{statusText(d)}</div>
              </div>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
