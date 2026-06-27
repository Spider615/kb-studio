"use client";
import { useEffect, useState, type FormEvent } from "react";
import { LS_KEY } from "./PushDialog";

export default function CredentialsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [domain, setDomain] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      setDomain(s.domain || "");
      setAccessKeyId(s.accessKeyId || "");
      setKnowledgeBaseId(s.knowledgeBaseId || "");
    } catch {}
  }, [open]);

  if (!open) return null;

  function save(e: FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ domain, accessKeyId, knowledgeBaseId }));
      setSaved(true);
    } catch {}
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>秒懂凭据</h3>
        <p className="muted" style={{ margin: "-8px 0 14px" }}>
          这里只记非密三项；accessKeySecret 在每次推送时单独填写、不保存。
        </p>
        <form onSubmit={save}>
          <label className="field">
            <span>域名</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="insight.juzibot.com" />
          </label>
          <label className="field">
            <span>accessKeyId</span>
            <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
          </label>
          <label className="field">
            <span>knowledgeBaseId</span>
            <input value={knowledgeBaseId} onChange={(e) => setKnowledgeBaseId(e.target.value)} />
          </label>
          <div className="modal-actions">
            {saved && <span className="ok" style={{ marginRight: "auto" }}>✅ 已保存</span>}
            <button type="button" className="btn ghost" onClick={onClose}>
              关闭
            </button>
            <button type="submit" className="btn primary">
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
