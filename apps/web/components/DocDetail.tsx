"use client";
import { useCallback, useEffect, useState } from "react";
import PushDialog from "./PushDialog";
import FilePreview from "./FilePreview";
import Loading from "./Loading";
import { STAGE_LABEL, fmtTime, type DocItem, type DocProgress } from "./DocList";

type Chunk = {
  id: string;
  chunk_type: string;
  token_estimate: number;
  context_prefix: string | null;
  content_original: string;
  heading_path: string[];
};

type PushTarget = { credentialId: string; credentialName: string; knowledgeBaseId: string; domain: string };

function pct(p?: DocProgress | null): number | null {
  if (!p || p.total <= 0) return null;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

export default function DocDetail({
  docId,
  doc,
  onDelete,
  onChanged,
}: {
  docId: string | null;
  doc: DocItem | null;
  onDelete: (id: string) => void;
  onChanged: () => void;
}) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [pushTargets, setPushTargets] = useState<PushTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [pushing, setPushing] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [pushErr, setPushErr] = useState("");
  const [hasFile, setHasFile] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const status = doc?.status;
  const title = doc?.title ?? "";
  const isProcessing = status === "processing";
  const isFailed = status === "failed";

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
      if (!docId) return;
      setLoading(true);
      setErr("");
      try {
        const r = await fetch(`/api/docs/${docId}`, { signal });
        const json = await r.json();
        if (json.error) setErr(json.error);
        else {
          setChunks(json.chunks);
          setPushTargets(json.doc.pushTargets ?? []);
          setHasFile(!!json.doc.hasFile);
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") setErr(String(e?.message ?? e));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [docId],
  );

  // 仅就绪/已推送时拉 chunk + pushTargets；处理中/失败只看 doc 摘要
  useEffect(() => {
    if (!docId || isProcessing || isFailed) {
      setChunks([]);
      setPushTargets([]);
      return;
    }
    const ctrl = new AbortController();
    setShowDialog(false);
    setPushErr("");
    loadDetail(ctrl.signal);
    return () => ctrl.abort();
  }, [docId, status, isProcessing, isFailed, loadDetail]);

  async function doPush(credentialIds: string[]) {
    if (!docId || pushing) return;
    setPushing(true);
    setPushErr("");
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId, credentialIds }),
      });
      const json = await res.json();
      if (json.ok) {
        await loadDetail();
        onChanged();
        const failed = (json.results ?? []).filter((r: any) => !r.ok);
        if (failed.length)
          setPushErr("部分失败：" + failed.map((r: any) => `${r.credentialName}：${r.error || "未知错误"}`).join("；"));
        else setShowDialog(false);
      } else {
        // 全部失败：优先展示每个凭证的具体原因
        const detail = (json.results ?? [])
          .filter((r: any) => !r.ok)
          .map((r: any) => `${r.credentialName}：${r.error || "未知错误"}`)
          .join("；");
        setPushErr(detail || json.error || "推送失败");
      }
    } catch (e: any) {
      setPushErr(String(e?.message ?? e));
    } finally {
      setPushing(false);
    }
  }

  if (!docId)
    return (
      <section className="work">
        <div className="empty">
          <div className="big">从左侧选择一篇文档</div>
          <div>查看它的 chunk 切片与上下文</div>
        </div>
      </section>
    );

  const p = pct(doc?.progress);

  return (
    <section className="work">
      <div className="head">
        <div className="h-main">
          <h1>{title || "（未命名）"}</h1>
          <div className="h-sub">
            {isProcessing
              ? STAGE_LABEL[doc?.progress?.stage ?? ""] ?? "处理中…"
              : isFailed
                ? "处理失败"
                : loading
                  ? "加载中…"
                  : `${chunks.length} chunk · 已处理${doc?.createdAt ? " · 创建于 " + fmtTime(doc.createdAt) : ""}`}
          </div>
        </div>
        {pushTargets.length > 0 && (
          <span className="pill ok">
            <span className="d" />
            已推送：{pushTargets.map((t) => t.credentialName).join("、")}
          </span>
        )}
        {!isProcessing && !isFailed && hasFile && (
          <button type="button" className="btn" onClick={() => setShowPreview(true)}>
            预览原文件
          </button>
        )}
        {!isProcessing && !isFailed && (
          <button type="button" className="btn primary" onClick={() => setShowDialog(true)}>
            推送到秒懂
          </button>
        )}
        <button type="button" className="btn danger" onClick={() => onDelete(docId)}>
          删除
        </button>
      </div>

      {isProcessing ? (
        <div className="empty">
          <div className="big">{STAGE_LABEL[doc?.progress?.stage ?? ""] ?? "处理中…"}</div>
          <div className="pbar wide">
            <span style={p === null ? { width: "30%" } : { width: `${p}%` }} className={p === null ? "indet" : ""} />
          </div>
          <div className="muted">{p === null ? "正在处理，请稍候…" : `${p}%`}</div>
        </div>
      ) : isFailed ? (
        <div className="empty">
          <div className="big">处理失败</div>
          <div className="err">{doc?.error || "未知错误"}</div>
          <div className="muted">可在左侧删除后重新上传</div>
        </div>
      ) : (
        <div className="scroll">
          {err && <p className="err">⚠ {err}</p>}
          {loading ? (
            <Loading />
          ) : (
            <div className="chunks">
              {chunks.map((c, i) => (
                <div className="chunk" key={c.id}>
                  <div className="chunk-head">
                    <span className={c.chunk_type === "table" ? "badge table" : "badge"}>{c.chunk_type}</span>
                    <span className="path">#{i + 1}</span>
                    <span className="tok">~{c.token_estimate} tok</span>
                  </div>
                  {c.context_prefix && <div className="prefix">{c.context_prefix}</div>}
                  <div className="body">{c.content_original}</div>
                </div>
              ))}
            </div>
          )}
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
      <FilePreview open={showPreview} onClose={() => setShowPreview(false)} docId={docId} filename={title} />
    </section>
  );
}
