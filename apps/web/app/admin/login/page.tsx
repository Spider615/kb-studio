"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminLoginPage() {
  const router = useRouter();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, pass }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "登录失败");
        return;
      }
      router.push("/admin");
      router.refresh();
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><span className="mark">✦</span> kb-studio</div>
        <h1 className="auth-title">管理后台登录</h1>
        <label className="auth-field">
          <span>账号</span>
          <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <div className="auth-err">{err}</div>}
        <button type="submit" className="btn primary auth-submit" disabled={busy}>
          {busy ? "请稍候…" : "登录"}
        </button>
      </form>
    </div>
  );
}
