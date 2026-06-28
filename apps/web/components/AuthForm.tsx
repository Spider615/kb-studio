"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0); // 重发倒计时秒
  const isLogin = mode === "login";

  // 倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode() {
    setErr(null);
    if (!EMAIL_RE.test(email)) {
      setErr("请先填写正确的邮箱");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "发送失败");
        return;
      }
      setCooldown(60);
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

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
        body: JSON.stringify(isLogin ? { email, password } : { email, password, code }),
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
          {isLogin ? (
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          ) : (
            <div className="auth-row">
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button type="button" className="btn" onClick={sendCode} disabled={busy || cooldown > 0}>
                {cooldown > 0 ? `重新发送(${cooldown}s)` : "发送验证码"}
              </button>
            </div>
          )}
        </label>
        {!isLogin && (
          <label className="auth-field">
            <span>验证码</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
        )}
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
