"use client";
import { useEffect, useState } from "react";
import PushDialog, { LS_KEY, type MiaodongCreds } from "./PushDialog";

type Chunk = {
  id: string;
  chunk_type: string;
  token_estimate: number;
  context_prefix: string | null;
  content_original: string;
  heading_path: string[];
};

export default function DocDetail({
  docId,
  onDeleted,
}: {
  docId: string | null;
  onDeleted: (id: string) => void;
}) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [err, setErr] = useState("");
  const [pushing, setPushing] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [pushErr, setPushErr] = useState("");

  useEffect(() => {
    if (!docId) {
      setChunks([]);
      setTitle("");
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setErr("");
    setPushed(false);
    setShowDialog(false);
    setPushErr("");
    setChunks([]);
    setTitle("");
    fetch(`/api/docs/${docId}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else {
          setChunks(json.chunks);
          setTitle(json.doc.title);
          setPushed(json.doc.status === "pushed");
        }
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [docId]);

  async function del() {
    if (!docId || !confirm("删除这篇文档及其所有 chunk？")) return;
    try {
      const res = await fetch(`/api/docs/${docId}`, { method: "DELETE" });
      const json = await res.json();
      if (json.ok) onDeleted(docId);
      else setErr(json.error ?? "删除失败");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function doPush(creds: MiaodongCreds) {
    if (!docId || pushing) return;
    setPushing(true);
    setPushErr("");
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId, credentials: creds }),
      });
      const json = await res.json();
      if (json.ok) {
        // 记非密三项，secret 不存
        try {
          localStorage.setItem(
            LS_KEY,
            JSON.stringify({
              domain: creds.domain,
              accessKeyId: creds.accessKeyId,
              knowledgeBaseId: creds.knowledgeBaseId,
            }),
          );
        } catch {}
        setPushed(true);
        setShowDialog(false);
      } else {
        setPushErr(json.error ?? "推送失败");
      }
    } catch (e: any) {
      setPushErr(String(e?.message ?? e));
    } finally {
      setPushing(false);
    }
  }

  function openDialog() {
    setPushErr("");
    setShowDialog(true);
  }

  if (!docId)
    return (
      <section className="detail-col">
        <p className="muted">从左侧选择一篇文档查看 chunk</p>
      </section>
    );

  return (
    <section className="detail-col">
      <div className="detail-head">
        <h2>
          {title}（{chunks.length} chunk）
        </h2>
        <div className="row">
          {pushed ? <span className="ok">✅ 已推送</span> : <button onClick={openDialog}>确认推送秒懂</button>}
          <button className="danger" onClick={del}>
            删除
          </button>
        </div>
      </div>
      {err && <p className="err">⚠ {err}</p>}
      {loading ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="chunks">
          {chunks.map((c) => (
            <div className="chunk" key={c.id}>
              <div className="chunk-head">
                <span className="badge">{c.chunk_type}</span>
                <span className="path">{c.heading_path.join(" › ") || "(根)"}</span>
                <span className="tok">~{c.token_estimate} tok</span>
              </div>
              {c.context_prefix && <div className="prefix">＋上下文：{c.context_prefix}</div>}
              <div className="body">{c.content_original}</div>
            </div>
          ))}
        </div>
      )}
      <PushDialog
        open={showDialog}
        onClose={() => {
          if (!pushing) {
            setShowDialog(false);
            setPushErr("");
          }
        }}
        onSubmit={doPush}
        pushing={pushing}
        error={pushErr}
      />
    </section>
  );
}
