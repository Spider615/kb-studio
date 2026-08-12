"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type AuthMode = "login" | "register" | "reset";

/**
 * 三种模式共用一张表单。差异全部收在这张配置表里——早先用 isLogin 三元判断，
 * 加第三种模式后会到处失效。
 * needsCode 决定是否显示「发送验证码 + 验证码输入框」。
 */
const CONFIG: Record<
  AuthMode,
  {
    title: string;
    api: string; // /api/auth/<api>
    needsCode: boolean;
    codePurpose?: "register" | "reset";
    pwdLabel: string;
    pwdAutoComplete: "current-password" | "new-password";
    minPwd?: number;
    submitLabel: string;
    doneRedirect: string;
  }
> = {
  login: {
    title: "登录",
    api: "login",
    needsCode: false,
    pwdLabel: "密码",
    pwdAutoComplete: "current-password",
    submitLabel: "登录",
    doneRedirect: "/",
  },
  register: {
    title: "注册",
    api: "register",
    needsCode: true,
    codePurpose: "register",
    pwdLabel: "密码",
    pwdAutoComplete: "new-password",
    minPwd: 8,
    submitLabel: "注册",
    // 注册成功不自动登录，跳登录页让用户用刚注册的账号登录
    doneRedirect: "/login?registered=1",
  },
  reset: {
    title: "重置密码",
    api: "reset-password",
    needsCode: true,
    codePurpose: "reset",
    pwdLabel: "新密码",
    pwdAutoComplete: "new-password",
    minPwd: 8,
    submitLabel: "重置密码",
    // 重置会踢掉全部会话，必须重新登录
    doneRedirect: "/login?reset=1",
  },
};

/** 登录页顶部提示：由上一步跳转时带的 query 决定。 */
const LOGIN_NOTICES: Record<string, string> = {
  registered: "注册成功，请登录",
  reset: "密码已重置，请用新密码登录",
};

export default function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const cfg = CONFIG[mode];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0); // 重发倒计时秒

  // 登录页：从注册/重置跳过来时给个提示
  useEffect(() => {
    if (mode !== "login") return;
    const q = new URLSearchParams(window.location.search);
    for (const [key, text] of Object.entries(LOGIN_NOTICES)) {
      if (q.get(key) === "1") {
        setNotice(text);
        return;
      }
    }
  }, [mode]);

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
        body: JSON.stringify({ email, purpose: cfg.codePurpose }),
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
    if (cfg.minPwd && password.length < cfg.minPwd) {
      setErr(`密码至少 ${cfg.minPwd} 位`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${cfg.api}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg.needsCode ? { email, password, code } : { email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json?.error ?? "操作失败");
        return;
      }
      router.push(cfg.doneRedirect);
      if (mode === "login") router.refresh();
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
        <h1 className="auth-title">{cfg.title}</h1>
        {mode === "reset" && (
          <p className="auth-hint">输入注册邮箱收取验证码，设置新密码后所有设备需重新登录。</p>
        )}
        <label className="auth-field">
          <span>邮箱</span>
          {cfg.needsCode ? (
            <div className="auth-row">
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button type="button" className="btn" onClick={sendCode} disabled={busy || cooldown > 0}>
                {cooldown > 0 ? `重新发送(${cooldown}s)` : "发送验证码"}
              </button>
            </div>
          ) : (
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </label>
        {cfg.needsCode && (
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
          <span>{cfg.pwdLabel}</span>
          <div className="auth-pwd">
            <input
              type={showPwd ? "text" : "password"}
              autoComplete={cfg.pwdAutoComplete}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={cfg.minPwd}
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
          {busy ? "请稍候…" : cfg.submitLabel}
        </button>
        <div className="auth-alt">
          {mode === "login" && (
            <>
              还没有账号？<Link href="/register">去注册</Link>
              <span className="auth-sep">·</span>
              <Link href="/reset">忘记密码？</Link>
            </>
          )}
          {mode === "register" && <>已有账号？<Link href="/login">去登录</Link></>}
          {mode === "reset" && <>想起来了？<Link href="/login">去登录</Link></>}
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
