"use client";
import { useCallback, useEffect, useState } from "react";

type Token = { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string };

export default function TokensDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null); // 新建后一次性明文
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/tokens");
    if (res.ok) setTokens((await res.json()).tokens ?? []);
  }, []);

  useEffect(() => {
    if (open) {
      setSecret(null);
      setName("");
      load();
    }
  }, [open, load]);

  if (!open) return null;

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        setSecret(json.secret);
        setName("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("吊销这个 Token？使用它的程序会立即失效。")) return;
    await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>API Tokens</h3>
        <p className="muted" style={{ margin: "-8px 0 12px" }}>
          给外部程序用：请求头带 <code>Authorization: Bearer kbs_…</code>
        </p>

        {secret && (
          <div className="token-reveal">
            <div className="token-reveal-h">新 Token（仅显示这一次，请立即复制）</div>
            <code>{secret}</code>
            <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(secret)}>复制</button>
          </div>
        )}

        <div className="token-create">
          <input placeholder="Token 名称，如「脚本导入」" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn primary" onClick={create} disabled={busy || !name.trim()}>新建</button>
        </div>

        <div className="token-list">
          {tokens.length === 0 && <div className="token-empty">还没有 Token</div>}
          {tokens.map((t) => (
            <div key={t.id} className="token-row">
              <div>
                <div className="token-name">{t.name}</div>
                <div className="token-meta">{t.prefix}… · {t.lastUsedAt ? "用过" : "未用过"}</div>
              </div>
              <button type="button" className="btn danger" onClick={() => revoke(t.id)}>吊销</button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
