"use client";
import { useEffect, useState, type FormEvent } from "react";

type Cred = { id: string; name: string; domain: string; accessKeyId: string; knowledgeBaseId: string };

/** 凭据管理：列出/新增/删除命名凭据（落服务数据库）。 */
export default function CredentialsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [creds, setCreds] = useState<Cred[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");

  function resetForm() {
    setName("");
    setDomain("");
    setAccessKeyId("");
    setAccessKeySecret("");
    setKnowledgeBaseId("");
  }

  function load() {
    setLoading(true);
    fetch("/api/credentials")
      .then((r) => r.json())
      .then((j) => setCreds(j.credentials ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!open) return;
    setErr("");
    resetForm();
    load();
  }, [open]);

  if (!open) return null;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, domain, accessKeyId, accessKeySecret, knowledgeBaseId }),
      });
      const j = await res.json();
      if (j.error) setErr(j.error);
      else {
        resetForm();
        load();
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function del(id: string) {
    if (!confirm("删除这个凭据？")) return;
    try {
      await fetch(`/api/credentials/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      console.error("[kb] 删除凭据失败:", e);
    }
  }

  const canAdd = Boolean(name && domain && accessKeyId && accessKeySecret && knowledgeBaseId) && !saving;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>秒懂凭据</h3>
        <p className="muted" style={{ margin: "-8px 0 12px" }}>
          可保存多个命名凭据，推送时按名称勾选（单选或多选）。
        </p>
        {loading ? (
          <p className="muted">加载中…</p>
        ) : creds.length === 0 ? (
          <p className="muted">还没有凭据，在下面添加一个 ↓</p>
        ) : (
          <div className="cred-list">
            {creds.map((c) => (
              <div className="cred-row" key={c.id}>
                <div className="cred-meta">
                  <span className="cred-name">{c.name}</span>
                  <span className="cred-sub">
                    {c.domain} · {c.knowledgeBaseId}
                  </span>
                </div>
                <button type="button" className="x" onClick={() => del(c.id)} aria-label="删除凭据" title="删除">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={add} className="cred-form">
          <div className="cred-form-title">新增凭据</div>
          <label className="field">
            <span>凭证名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：生产环境 / 客服库" />
          </label>
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
          {err && <p className="err">⚠ {err}</p>}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              关闭
            </button>
            <button type="submit" className="btn primary" disabled={!canAdd}>
              {saving ? "保存中…" : "保存凭据"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
