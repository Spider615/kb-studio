"use client";
import { useEffect, useState } from "react";

type Cred = { id: string; name: string; domain: string; knowledgeBaseId: string };

/** 推送弹框：勾选已存凭据（可多选）→ 提交 credentialIds。凭据在「设置·秒懂凭据」里管理。 */
export default function PushDialog({
  open,
  onClose,
  onSubmit,
  pushing,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (credentialIds: string[]) => void;
  pushing: boolean;
  error: string;
}) {
  const [creds, setCreds] = useState<Cred[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setLoading(true);
    fetch("/api/credentials")
      .then((r) => r.json())
      .then((j) => setCreds(j.credentials ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const canSubmit = selected.size > 0 && !pushing;

  return (
    <div className="overlay" onClick={pushing ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>推送到秒懂</h3>
        {loading ? (
          <p className="muted">加载凭证…</p>
        ) : creds.length === 0 ? (
          <p className="muted">还没有凭证。请到左下角「设置 · 凭证」添加后再推送。</p>
        ) : (
          <>
            <p className="muted" style={{ margin: "-8px 0 12px" }}>选择要推送到的凭证（可多选）：</p>
            <div className="cred-pick">
              {creds.map((c) => (
                <label key={c.id} className="cred-opt">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="cred-meta">
                    <span className="cred-name">{c.name}</span>
                    <span className="cred-sub">
                      {c.domain} · {c.knowledgeBaseId}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {error && <p className="err">⚠ {error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={pushing}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={() => onSubmit([...selected])}>
            {pushing ? "推送中…" : "确认推送"}
          </button>
        </div>
      </div>
    </div>
  );
}
