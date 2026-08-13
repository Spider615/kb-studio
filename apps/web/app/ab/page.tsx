"use client";
import { useEffect, useState } from "react";
import { AbPanel, type AbSide } from "../../components/AbPanel";
import Sidebar from "../../components/Sidebar";
import { showToast } from "../../components/Toast";

interface GroupItem { id: string; name: string }

export default function AbPage() {
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [groupId, setGroupId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [a, setA] = useState<AbSide | null>(null);
  const [b, setB] = useState<AbSide | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => r.json())
      .then((d) => setGroups(d.groups ?? d ?? []))
      .catch(() => {});
  }, []);

  async function ask() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setA(null);
    setB(null);
    setRunId(null);
    setVerdict(null);
    try {
      const res = await fetch("/api/ab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, groupId: groupId || undefined }),
      });
      const d = await res.json();
      if (d.error) {
        setA({ error: d.error });
        setB({ error: d.error });
      } else {
        setA(d.a);
        setB(d.b);
        setRunId(d.runId);
      }
    } catch (e: any) {
      setA({ error: String(e?.message ?? e) });
      setB({ error: String(e?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }

  async function rate(v: string) {
    if (!runId) return;
    // 乐观更新，但失败要能回退：fetch 对 4xx/5xx 不 reject，PATCH /api/ab/[runId] 在
    // runId 不存在或不属于当前用户时回 404——这轮评分是整个 A/B 实验唯一的产出物，
    // 静默丢失代价很高，不能让按钮停留在「已选中」这个错误状态却什么都没有落库。
    const prev = verdict;
    setVerdict(v);
    try {
      const res = await fetch(`/api/ab/${runId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: v }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setVerdict(prev);
        showToast(`评分保存失败：${d?.error ?? res.status}`, "error");
      }
    } catch (e: any) {
      setVerdict(prev);
      showToast(`评分保存失败：${e?.message ?? e}`, "error");
    }
  }

  return (
    <div className="app">
      <Sidebar>{null}</Sidebar>
      <main style={{ flex: 1, overflowY: "auto", padding: 24, maxWidth: 1400, margin: "0 auto" }}>
        <h1 style={{ fontFamily: "var(--font-serif, serif)", fontSize: 24, marginBottom: 4 }}>A/B 检索对比</h1>
        <p style={{ color: "var(--text-3)", fontSize: 14, marginBottom: 16 }}>
          同一个问题分别走单轮 RAG 与 wiki + agentic 两条链路。每次提问相互独立，不带对话历史。
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)" }}>
            <option value="">全部知识库</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="输入一个坐席会真的问的问题…"
            style={{ flex: 1, minWidth: 260, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)" }}
          />
          <button onClick={ask} disabled={loading || !query.trim()} style={{ padding: "8px 20px", borderRadius: 6, border: "none", background: "var(--accent, #C96442)", color: "#fff", cursor: loading ? "default" : "pointer" }}>
            {loading ? "运行中…" : "对比"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }} className="ab-columns">
          <AbPanel label="A · 单轮 RAG" side={a} loading={loading} />
          <AbPanel label="B · wiki + agentic" side={b} loading={loading} />
        </div>

        {runId && (
          <div style={{ marginTop: 20, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, color: "var(--text-3)" }}>这轮谁更好：</span>
            {[
              { v: "a", label: "A 好" },
              { v: "b", label: "B 好" },
              { v: "tie", label: "差不多" },
              { v: "neither", label: "都不行" },
            ].map((o) => (
              <button
                key={o.v}
                onClick={() => rate(o.v)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: verdict === o.v ? "var(--accent, #C96442)" : "transparent",
                  color: verdict === o.v ? "#fff" : "inherit",
                  cursor: "pointer",
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        <style>{`@media (max-width: 900px) { .ab-columns { flex-direction: column; } }`}</style>
      </main>
    </div>
  );
}
