"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
// 注意：从 @kb/core（零依赖，仅 zod）导入，不是 @kb/pipeline —— AbPanel 是 "use client" 组件，
// @kb/pipeline 的桶导出会把 jieba/undici/fs 等服务端专属依赖一并拖进浏览器打包，构建会直接报错。
// 详见 packages/core/src/text.ts 顶部注释。
import { safeTruncateUtf16 } from "@kb/core";

export interface AbSide {
  answer?: string;
  hits?: Array<{ id: string; score: number; heading_path: string[]; content: string }>;
  trace?: Array<{ step: number; tool: string; args: unknown; resultSummary: string; ms: number }>;
  turnsUsed?: number;
  truncated?: boolean;
  ms?: number;
  tokens?: number;
  error?: string;
}

export function AbPanel({ label, side, loading }: { label: string; side: AbSide | null; loading: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--card)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
          {loading ? "运行中…" : side ? `${((side.ms ?? 0) / 1000).toFixed(1)}s · ${(side.tokens ?? 0).toLocaleString()} token${side.turnsUsed ? ` · ${side.turnsUsed} 轮` : ""}${side.truncated ? " · 已截断" : ""}` : "—"}
        </div>
      </header>

      <div style={{ padding: 14, flex: 1, overflowX: "auto" }}>
        {side?.error ? (
          <div style={{ color: "var(--danger, #b3261e)", fontSize: 14 }}>失败：{side.error}</div>
        ) : side?.answer ? (
          <ReactMarkdown>{side.answer}</ReactMarkdown>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: 14 }}>{loading ? "…" : "尚未提问"}</div>
        )}
      </div>

      {(side?.hits?.length || side?.trace?.length) && (
        <footer style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ width: "100%", padding: "8px 14px", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--muted)" }}
          >
            {side.hits ? `命中 ${side.hits.length} 个片段` : `工具轨迹 ${side.trace!.length} 步`} {open ? "▴" : "▾"}
          </button>
          {open && (
            <div style={{ padding: "0 14px 14px", fontSize: 13, maxHeight: 320, overflow: "auto" }}>
              {side.hits?.map((h, i) => (
                <div key={h.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ color: "var(--muted)" }}>#{i + 1} · {h.heading_path.join(" / ") || "—"} · {h.score?.toFixed(3)}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{safeTruncateUtf16(h.content, 300)}</div>
                </div>
              ))}
              {side.trace?.map((t) => (
                <div key={t.step} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ color: "var(--muted)" }}>
                    {t.step}. <code>{t.tool}</code>({JSON.stringify(t.args)}) · {t.ms}ms
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{t.resultSummary}</div>
                </div>
              ))}
            </div>
          )}
        </footer>
      )}
    </section>
  );
}
