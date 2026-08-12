"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const MIN_PWD = 8;

/**
 * 已登录改密码：验当前密码 → 设新密码。
 * 成功后服务端会踢掉全部会话（含当前），所以这里直接跳登录页。
 */
export default function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次打开清空，避免上次输入残留
  useEffect(() => {
    if (open) {
      setOldPassword("");
      setNewPassword("");
      setConfirm("");
      setShowPwd(false);
      setErr("");
    }
  }, [open]);

  if (!open) return null;

  const canSubmit =
    !saving && oldPassword.length > 0 && newPassword.length >= MIN_PWD && confirm.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    if (newPassword.length < MIN_PWD) {
      setErr(`新密码至少 ${MIN_PWD} 位`);
      return;
    }
    if (newPassword !== confirm) {
      setErr("两次输入的新密码不一致");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "修改失败");
        return;
      }
      // 全部会话已失效，回登录页用新密码重登
      router.push("/login?reset=1");
      router.refresh();
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>修改密码</h3>
        <p className="muted" style={{ margin: "-8px 0 12px" }}>
          修改成功后所有设备都会退出登录，需要用新密码重新登录。
        </p>
        <form onSubmit={submit}>
          <label className="field">
            <span>当前密码</span>
            <input
              type={showPwd ? "text" : "password"}
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </label>
          <label className="field">
            <span>新密码（至少 {MIN_PWD} 位）</span>
            <input
              type={showPwd ? "text" : "password"}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label className="field">
            <span>确认新密码</span>
            <input
              type={showPwd ? "text" : "password"}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <label className="cred-showpwd">
            <input type="checkbox" checked={showPwd} onChange={(e) => setShowPwd(e.target.checked)} />
            <span>显示密码</span>
          </label>
          {err && <p className="err">⚠ {err}</p>}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={!canSubmit}>
              {saving ? "修改中…" : "确认修改"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
