"use client";
import { useEffect, useState, type FormEvent } from "react";

/** 非密三项记忆在 localStorage 这个 key 下（secret 不存）。 */
export const LS_KEY = "kb.miaodong.creds";

export type MiaodongCreds = {
  domain: string;
  accessKeyId: string;
  accessKeySecret: string;
  knowledgeBaseId: string;
};

export default function PushDialog({
  open,
  onClose,
  onSubmit,
  pushing,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (creds: MiaodongCreds) => void;
  pushing: boolean;
  error: string;
}) {
  const [domain, setDomain] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");

  useEffect(() => {
    if (!open) return;
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      setDomain(saved.domain || "");
      setAccessKeyId(saved.accessKeyId || "");
      setKnowledgeBaseId(saved.knowledgeBaseId || "");
    } catch {}
    setAccessKeySecret("");
  }, [open]);

  if (!open) return null;

  const canSubmit = Boolean(domain && accessKeyId && accessKeySecret && knowledgeBaseId) && !pushing;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit({ domain, accessKeyId, accessKeySecret, knowledgeBaseId });
  }

  return (
    <div className="overlay" onClick={pushing ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>推送到秒懂</h3>
        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>域名</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="insight.juzibot.com" />
          </label>
          <label className="field">
            <span>accessKeyId</span>
            <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
          </label>
          <label className="field">
            <span>accessKeySecret</span>
            <input type="password" value={accessKeySecret} onChange={(e) => setAccessKeySecret(e.target.value)} />
          </label>
          <label className="field">
            <span>knowledgeBaseId</span>
            <input value={knowledgeBaseId} onChange={(e) => setKnowledgeBaseId(e.target.value)} />
          </label>
          {error && <p className="err">⚠ {error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={pushing}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={!canSubmit}>
              {pushing ? "推送中…" : "确认推送"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
