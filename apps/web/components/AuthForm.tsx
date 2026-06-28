"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0); // 重发倒计时秒
  const isLogin = mode === "login";

  // 登录页：刚注册完跳过来时给个提示
  useEffect(() => {
    if (isLogin && new URLSearchParams(window.location.search).get("registered") === "1") {
      setNotice("注册成功，请登录");
    }
  }, [isLogin]);

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
      if (isLogin) {
        router.push("/");
        router.refresh();
      } else {
        // 注册成功不自动登录，跳转登录页让用户用刚注册的账号登录
        router.push("/login?registered=1");
      }
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
          <div className="auth-pwd">
            <input
              type={showPwd ? "text" : "password"}
              autoComplete={isLogin ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isLogin ? undefined : 8}
            />
            <button
              type="button"
              className="auth-eye"
              onClick={() => setShowPwd((v) => !v)}
              aria-label={showPwd ? "隐藏密码" : "显示密码"}
              title={showPwd ? "隐藏密码" : "显示密码"}
              tabIndex={-1}
            >
              {showPwd ? eyeOff : eye}
            </button>
          </div>
        </label>
        {notice && <div className="auth-notice">{notice}</div>}
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

const eye = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const eyeOff = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
