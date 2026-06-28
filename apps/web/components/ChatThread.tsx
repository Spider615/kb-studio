"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Loading from "./Loading";

type Src = { id: string; heading_path: string[] };
type Hit = { id: string; score: number; heading_path: string[]; content: string };
type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Src[] | null;
  hits: Hit[] | null;
};

export default function ChatThread({
  conversationId,
  onTitle,
  docs,
  groups,
}: {
  conversationId: string | null;
  onTitle: (id: string, title: string) => void;
  docs: { id: string; title: string }[];
  groups: { id: string; name: string; docCount: number }[];
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [err, setErr] = useState("");
  const [scope, setScope] = useState(""); // "" | g:<groupId> | d:<docId>
  const rawScopeRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversationId) {
      setMsgs([]);
      return;
    }
    const ctrl = new AbortController();
    setErr("");
    setMsgs([]);
    setLoadingMsgs(true);
    fetch(`/api/conversations/${conversationId}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else {
          setMsgs(json.messages ?? []);
          const conv = json.conversation;
          const init = conv?.scopeGroupId ? `g:${conv.scopeGroupId}` : conv?.scopeDocId ? `d:${conv.scopeDocId}` : "";
          rawScopeRef.current = init;
          setScope(normalizeScope(init));
        }
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoadingMsgs(false);
      });
    return () => ctrl.abort();
  }, [conversationId]);

  useEffect(() => {
    setScope(normalizeScope(rawScopeRef.current));
  }, [docs, groups]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, sending]);

  function normalizeScope(s: string): string {
    if (s.startsWith("g:")) return groups.some((g) => `g:${g.id}` === s) ? s : "";
    if (s.startsWith("d:")) return docs.some((d) => `d:${d.id}` === s) ? s : "";
    return "";
  }

  async function changeScope(v: string) {
    const prev = scope;
    setScope(v);
    if (!conversationId) return;
    const body = v.startsWith("g:")
      ? { scopeGroupId: v.slice(2), scopeDocId: null }
      : v.startsWith("d:")
        ? { scopeDocId: v.slice(2), scopeGroupId: null }
        : { scopeDocId: null, scopeGroupId: null };
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setScope(prev);
        setErr(`保存知识库范围失败 (${res.status})`);
      } else {
        rawScopeRef.current = v;
      }
    } catch (e: any) {
      setScope(prev);
      setErr(String(e?.message ?? e));
    }
  }

  async function send() {
    if (!conversationId || !input.trim() || sending) return;
    const q = input.trim();
    const tmpId = "tmp_" + crypto.randomUUID();
    setInput("");
    setSending(true);
    setErr("");
    setMsgs((m) => [...m, { id: tmpId, role: "user", content: q, sources: null, hits: null }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, query: q }),
      });
      const json = await res.json();
      if (json.error) {
        setErr(json.error);
        setMsgs((m) => m.filter((x) => x.id !== tmpId));
        setInput(q);
      } else {
        setMsgs((m) => [
          ...m,
          { id: "a_" + crypto.randomUUID(), role: "assistant", content: json.answer, sources: json.sources, hits: json.hits },
        ]);
        if (json.title) onTitle(conversationId, json.title);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setMsgs((m) => m.filter((x) => x.id !== tmpId));
      setInput(q);
    } finally {
      setSending(false);
    }
  }

  if (!conversationId)
    return (
      <section className="work">
        <div className="empty">
          <div className="big">开始一段对话</div>
          <div>新建或选择左侧的对话，向知识库提问</div>
        </div>
      </section>
    );

  return (
    <section className="work">
      <div className="scope">
        <label htmlFor="scope-select">知识库范围</label>
        <select id="scope-select" value={scope} onChange={(e) => changeScope(e.target.value)}>
          <option value="">全部知识库</option>
          {groups.length > 0 && (
            <optgroup label="分组">
              {groups.map((g) => (
                <option key={g.id} value={`g:${g.id}`}>
                  {g.name}（{g.docCount}）
                </option>
              ))}
            </optgroup>
          )}
          {docs.length > 0 && (
            <optgroup label="单篇">
              {docs.map((d) => (
                <option key={d.id} value={`d:${d.id}`}>
                  {d.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <div className="thread">
        {loadingMsgs && msgs.length === 0 && <Loading />}
        {msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="bub user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="bub asst">
              <div className="a-body markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
              {m.sources && m.sources.length > 0 && (
                <div className="src">
                  <span className="label">溯源：</span>
                  {m.sources.map((s) => s.heading_path.join(" › ")).join("  |  ")}
                </div>
              )}
              {m.hits && m.hits.length > 0 && (
                <details className="det">
                  <summary>命中的 {m.hits.length} 个片段</summary>
                  {m.hits.map((h) => (
                    <div className="hit" key={h.id}>
                      <span className="score">{h.score.toFixed(3)}</span>
                      <span className="path">{h.heading_path.join(" › ")}</span>
                      <div className="hit-body">{h.content.slice(0, 120)}…</div>
                    </div>
                  ))}
                </details>
              )}
            </div>
          ),
        )}
        {sending && (
          <div className="bub asst">
            <div className="a-body muted">思考中…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {err && <p className="err" style={{ padding: "0 24px" }}>⚠ {err}</p>}
      <div className="composer">
        <input
          value={input}
          placeholder="问点什么…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button type="button" className="send" onClick={send} disabled={sending} aria-label="发送">
          {sending ? "…" : "↑"}
        </button>
      </div>
    </section>
  );
}
