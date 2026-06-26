"use client";
import { useState } from "react";

type Chunk = {
  id: string;
  chunk_type: string;
  token_estimate: number;
  context_prefix: string | null;
  content_original: string;
  heading_path: string[];
};
type DocResult = { docId: string; count: number; chunks: Chunk[] };
type Hit = { id: string; score: number; heading_path: string[]; content: string };
type SearchResult = { answer: string; sources: { heading_path: string[] }[]; hits: Hit[] };

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<DocResult | null>(null);
  const [pushed, setPushed] = useState(false);
  const [err, setErr] = useState("");

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setErr("");
    setDoc(null);
    setPushed(false);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (json.error) setErr(json.error);
      else setDoc(json);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  async function confirm() {
    if (!doc) return;
    setBusy(true);
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId: doc.docId }),
      });
      const json = await res.json();
      if (json.ok) setPushed(true);
      else setErr(json.error ?? "推送失败");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setResult(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      setResult(await res.json());
    } catch (e: any) {
      setResult({ answer: "错误: " + String(e?.message ?? e), sources: [], hits: [] });
    }
    setSearching(false);
  }

  return (
    <main className="wrap">
      <h1>kb-studio · 知识库处理台</h1>
      <p className="sub">
        上传文件 → Claude Code 沙箱解析 → 切片 + 上下文化 + 向量化 → 预览确认 → 推送秒懂（stub）
      </p>

      <section className="card">
        <h2>1 · 上传 &amp; 处理</h2>
        <div className="row">
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button onClick={upload} disabled={!file || busy}>
            {busy && !doc ? "处理中…" : "上传并处理"}
          </button>
        </div>
        {busy && !doc && (
          <p className="muted">解析 → 切片 → 逐 chunk 上下文化(302) → bge-m3 向量化 → 入库，稍候…</p>
        )}
        {err && <p className="err">⚠ {err}</p>}
      </section>

      {doc && (
        <section className="card">
          <h2>2 · 预览 chunk（{doc.count} 个）</h2>
          <div className="chunks">
            {doc.chunks.map((c) => (
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
          {pushed ? (
            <p className="ok">✅ 已推送到秒懂（stub，待接真接口）</p>
          ) : (
            <button onClick={confirm} disabled={busy}>
              确认并推送秒懂
            </button>
          )}
        </section>
      )}

      <section className="card">
        <h2>3 · 检索测试台</h2>
        <div className="row">
          <input
            className="grow"
            value={query}
            placeholder="问点什么，比如：退款多久能到账？"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button onClick={search} disabled={searching}>
            {searching ? "检索中…" : "提问"}
          </button>
        </div>
        {result && (
          <div className="result">
            <div className="answer">{result.answer}</div>
            {result.sources.length > 0 && (
              <div className="sources">
                溯源：{result.sources.map((s) => s.heading_path.join(" › ")).join("  |  ")}
              </div>
            )}
            <details>
              <summary>命中的 {result.hits.length} 个片段</summary>
              {result.hits.map((h) => (
                <div className="hit" key={h.id}>
                  <span className="score">{h.score.toFixed(3)}</span>
                  <span className="path">{h.heading_path.join(" › ")}</span>
                  <div className="hit-body">{h.content.slice(0, 120)}…</div>
                </div>
              ))}
            </details>
          </div>
        )}
      </section>
    </main>
  );
}
