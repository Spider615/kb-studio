"use client";
import { useEffect, useState, type FormEvent } from "react";

type Cred = { id: string; name: string; domain: string; accessKeyId: string; knowledgeBaseId: string };
type FullCred = Cred & { accessKeySecret: string };
type View = "list" | "detail" | "edit";

/** 凭证管理：列表 / 查看(只读) / 新增 / 编辑（落服务数据库）。 */
export default function CredentialsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [creds, setCreds] = useState<Cred[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<View>("list");
  const [current, setCurrent] = useState<FullCred | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  // 表单（新增 / 编辑 共用）
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

  function loadList() {
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
    setView("list");
    setCurrent(null);
    resetForm();
    loadList();
  }, [open]);

  if (!open) return null;

  async function openDetail(id: string) {
    setErr("");
    try {
      const r = await fetch(`/api/credentials/${id}`);
      const j = await r.json();
      if (j.error) return setErr(j.error);
      setCurrent(j.credential);
      setShowSecret(false);
      setView("detail");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  function startEdit() {
    if (!current) return;
    setName(current.name);
    setDomain(current.domain);
    setAccessKeyId(current.accessKeyId);
    setAccessKeySecret(current.accessKeySecret);
    setKnowledgeBaseId(current.knowledgeBaseId);
    setErr("");
    setView("edit");
  }

  function backToList() {
    setView("list");
    setCurrent(null);
    resetForm();
    setErr("");
  }

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
        loadList();
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (saving || !current) return;
    setSaving(true);
    setErr("");
    try {
      const res = await fetch(`/api/credentials/${current.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, domain, accessKeyId, accessKeySecret, knowledgeBaseId }),
      });
      const j = await res.json();
      if (j.error) setErr(j.error);
      else {
        loadList();
        // 回到详情并刷新当前值
        setCurrent({ id: current.id, name, domain, accessKeyId, accessKeySecret, knowledgeBaseId });
        setView("detail");
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function del(id: string) {
    if (!confirm("删除这个凭证？")) return;
    try {
      await fetch(`/api/credentials/${id}`, { method: "DELETE" });
      backToList();
      loadList();
    } catch (e) {
      console.error("[kb] 删除凭证失败:", e);
    }
  }

  const canAdd = Boolean(name && domain && accessKeyId && accessKeySecret && knowledgeBaseId) && !saving;
  const canSaveEdit = Boolean(name && domain && accessKeyId && knowledgeBaseId) && !saving;

  // ===== 查看（只读） =====
  if (view === "detail" && current) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{current.name}</h3>
          <div className="cred-view">
            <div className="cred-field">
              <span className="cred-label">凭证名称</span>
              <span className="cred-val">{current.name}</span>
            </div>
            <div className="cred-field">
              <span className="cred-label">域名</span>
              <span className="cred-val">{current.domain}</span>
            </div>
            <div className="cred-field">
              <span className="cred-label">accessKeyId</span>
              <span className="cred-val">{current.accessKeyId}</span>
            </div>
            <div className="cred-field">
              <span className="cred-label">accessKeySecret</span>
              <span className="cred-val">
                {showSecret ? current.accessKeySecret : "•".repeat(Math.min(20, current.accessKeySecret.length || 12))}
                <button type="button" className="link-btn" onClick={() => setShowSecret((s) => !s)}>
                  {showSecret ? "隐藏" : "显示"}
                </button>
              </span>
            </div>
            <div className="cred-field">
              <span className="cred-label">knowledgeBaseId</span>
              <span className="cred-val">{current.knowledgeBaseId}</span>
            </div>
          </div>
          {err && <p className="err">⚠ {err}</p>}
          <div className="modal-actions">
            <button type="button" className="btn danger" style={{ marginRight: "auto" }} onClick={() => del(current.id)}>
              删除
            </button>
            <button type="button" className="btn ghost" onClick={backToList}>
              返回
            </button>
            <button type="button" className="btn primary" onClick={startEdit}>
              编辑
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== 编辑 =====
  if (view === "edit" && current) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>编辑凭证</h3>
          <form onSubmit={saveEdit} className="cred-form" style={{ borderTop: 0, paddingTop: 0, marginTop: 0 }}>
            <label className="field">
              <span>凭证名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>域名</span>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} />
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
              <button type="button" className="btn ghost" onClick={() => setView("detail")}>
                取消
              </button>
              <button type="submit" className="btn primary" disabled={!canSaveEdit}>
                {saving ? "保存中…" : "保存修改"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ===== 列表 + 新增 =====
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>凭证</h3>
        <p className="muted" style={{ margin: "-8px 0 12px" }}>
          可保存多个命名凭证，点条目可查看/编辑；推送时按名称勾选（单选或多选）。
        </p>
        {loading ? (
          <p className="muted">加载中…</p>
        ) : creds.length === 0 ? (
          <p className="muted">还没有凭证，在下面添加一个 ↓</p>
        ) : (
          <div className="cred-list">
            {creds.map((c) => (
              <div className="cred-row" key={c.id}>
                <button type="button" className="cred-open" onClick={() => openDetail(c.id)}>
                  <span className="cred-name">{c.name}</span>
                  <span className="cred-sub">
                    {c.domain} · {c.knowledgeBaseId}
                  </span>
                </button>
                <button type="button" className="x" onClick={() => del(c.id)} aria-label="删除凭证" title="删除">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={add} className="cred-form">
          <div className="cred-form-title">新增凭证</div>
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
              {saving ? "保存中…" : "保存凭证"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
