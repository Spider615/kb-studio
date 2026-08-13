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
  /** 两栏语料范围（必修 3，目前只有 B 栏会带）：scopeTotal = A 栏可查询的文档总数 M，
   *  scopeVisible = 本栏 list_docs 实际可见的文档数 N。scopeVisible 为 null 表示范围查询本身失败，
   *  不代表「可见 0 篇」，两者必须分开判断，不能把 null 当 0 用。 */
  scopeTotal?: number;
  scopeVisible?: number | null;
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
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
          {loading ? "运行中…" : side ? `${((side.ms ?? 0) / 1000).toFixed(1)}s · ${(side.tokens ?? 0).toLocaleString()} token${side.turnsUsed ? ` · ${side.turnsUsed} 轮` : ""}${side.truncated ? " · 已截断" : ""}` : "—"}
        </div>
        {/* 必修 3：两栏语料范围不一致时给明显提示——用 !== undefined 严格判断，不能写
            `side?.scopeTotal &&` 这种真值判断，scopeTotal 合法取值里就有 0（本次会话零文档）。 */}
        {!loading && side?.scopeTotal !== undefined && side?.scopeVisible !== undefined && side?.scopeVisible !== null && (
          <div
            style={{
              fontSize: 12,
              marginTop: 6,
              ...(side.scopeVisible < side.scopeTotal
                ? { background: "var(--warn-bg)", color: "var(--warn-text)", borderRadius: 4, padding: "3px 8px" }
                : { color: "var(--text-3)" }),
            }}
          >
            可见 {side.scopeVisible}/{side.scopeTotal} 篇
            {side.scopeVisible < side.scopeTotal ? "（本栏仅覆盖已 wiki 化的文档，本轮对比范围不对等）" : ""}
          </div>
        )}
      </header>

      <div style={{ padding: 14, flex: 1, overflowX: "auto" }}>
        {side?.error ? (
          <div style={{ color: "var(--danger, #b3261e)", fontSize: 14 }}>失败：{side.error}</div>
        ) : side?.answer ? (
          <ReactMarkdown>{side.answer}</ReactMarkdown>
        ) : (
          <div style={{ color: "var(--text-3)", fontSize: 14 }}>{loading ? "…" : "尚未提问"}</div>
        )}
      </div>

      {!!(side?.hits?.length || side?.trace?.length) && (
        <footer style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ width: "100%", padding: "8px 14px", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--text-3)" }}
          >
            {side.hits ? `命中 ${side.hits.length} 个片段` : `工具轨迹 ${side.trace!.length} 步`} {open ? "▴" : "▾"}
          </button>
          {open && (
            <div style={{ padding: "0 14px 14px", fontSize: 13, maxHeight: 320, overflow: "auto" }}>
              {side.hits?.map((h, i) => (
                <div key={h.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ color: "var(--text-3)" }}>#{i + 1} · {h.heading_path.join(" / ") || "—"} · {h.score?.toFixed(3)}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{safeTruncateUtf16(h.content, 300)}</div>
                </div>
              ))}
              {side.trace?.map((t) => (
                <div key={t.step} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ color: "var(--text-3)" }}>
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
