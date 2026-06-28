"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLogin = mode === "login";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!isLogin && password.length < 8) {
      setErr("密码至少 8 位");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${isLogin ? "login" : "register"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "操作失败");
        return;
      }
      router.push("/");
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
        <div className="auth-brand">
          <span className="mark">✦</span> kb-studio
        </div>
        <h1 className="auth-title">{isLogin ? "登录" : "注册"}</h1>
        <label className="auth-field">
          <span>邮箱</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isLogin ? undefined : 8}
          />
        </label>
        {err && <div className="auth-err">{err}</div>}
        <button type="submit" className="btn primary auth-submit" disabled={busy}>
          {busy ? "请稍候…" : isLogin ? "登录" : "注册"}
        </button>
        <div className="auth-alt">
          {isLogin ? (
            <>还没有账号？<Link href="/register">去注册</Link></>
          ) : (
            <>已有账号？<Link href="/login">去登录</Link></>
          )}
        </div>
      </form>
    </div>
  );
}
