"use client";
import { useEffect, useRef, useState } from "react";

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
}: {
  conversationId: string | null;
  onTitle: (id: string, title: string) => void;
  docs: { id: string; title: string }[];
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [scopeDocId, setScopeDocId] = useState("");
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
    fetch(`/api/conversations/${conversationId}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setErr(json.error);
        else {
          setMsgs(json.messages ?? []);
          const s = json.conversation?.scopeDocId ?? "";
          rawScopeRef.current = s;
          setScopeDocId(s && docs.some((d) => d.id === s) ? s : "");
        }
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      });
    return () => ctrl.abort();
  }, [conversationId]);

  // docs 列表晚于会话到达时，再用最新 docs 校验一次 scope（不重拉会话，避免重复请求与错误范围闪烁）
  useEffect(() => {
    const s = rawScopeRef.current;
    setScopeDocId(s && docs.some((d) => d.id === s) ? s : "");
  }, [docs]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, sending]);

  async function changeScope(v: string) {
    const prev = scopeDocId;
    setScopeDocId(v);
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeDocId: v || null }),
      });
      if (!res.ok) {
        setScopeDocId(prev);
        setErr(`保存知识库范围失败 (${res.status})`);
      } else {
        rawScopeRef.current = v;
      }
    } catch (e: any) {
      setScopeDocId(prev);
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
      <section className="detail-col">
        <p className="muted">新建或选择一个对话开始提问</p>
      </section>
    );

  return (
    <section className="detail-col chat">
      <div className="scope-bar">
        <label className="scope-label" htmlFor="scope-select">知识库范围</label>
        <select id="scope-select" className="scope-select" value={scopeDocId} onChange={(e) => changeScope(e.target.value)}>
          <option value="">全部知识库</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </div>
      <div className="thread">
        {msgs.map((m) => (
          <div key={m.id} className={m.role === "user" ? "bubble user" : "bubble asst"}>
            <div className="bubble-body">{m.content}</div>
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="sources">溯源：{m.sources.map((s) => s.heading_path.join(" › ")).join("  |  ")}</div>
            )}
            {m.role === "assistant" && m.hits && m.hits.length > 0 && (
              <details>
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
        ))}
        {sending && (
          <div className="bubble asst">
            <div className="bubble-body muted">思考中…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {err && <p className="err">⚠ {err}</p>}
      <div className="composer">
        <input
          className="grow"
          value={input}
          placeholder="问点什么…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={sending}>
          {sending ? "…" : "发送"}
        </button>
      </div>
    </section>
  );
}
