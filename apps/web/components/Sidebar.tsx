"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CredentialsDialog from "./CredentialsDialog";
import ChangePasswordDialog from "./ChangePasswordDialog";
import { showToast } from "./Toast";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const onChat = path.startsWith("/chat");
  const [showCreds, setShowCreds] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [menu, setMenu] = useState(false);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.user && setEmail(j.user.email))
      .catch(() => {});
  }, []);

  /** 复制文本到剪贴板（clipboard 不可用时退回提示）。 */
  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** 取当前用户的专属收集链接并复制。 */
  async function copyCollectLink() {
    setMenu(false);
    try {
      const r = await fetch("/api/collect-link");
      const j = await r.json();
      if (!r.ok || !j?.url) throw new Error(j?.error || "获取失败");
      const ok = await copyText(j.url);
      showToast(ok ? "收集链接已复制" : `收集链接：${j.url}`, ok ? "success" : "error");
    } catch (e: any) {
      showToast(`获取收集链接失败：${e?.message ?? e}`, "error");
    }
  }

  /** 重置收集 token（旧链接失效）并复制新链接。 */
  async function resetCollectLink() {
    setMenu(false);
    if (!confirm("重置后旧的收集链接将立即失效，需要把新链接重新发给客户。确定重置？")) return;
    try {
      const r = await fetch("/api/collect-link/reset", { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j?.url) throw new Error(j?.error || "重置失败");
      const ok = await copyText(j.url);
      showToast(ok ? "已重置，新链接已复制（旧链接失效）" : `新链接：${j.url}`, ok ? "success" : "error");
    } catch (e: any) {
      showToast(`重置收集链接失败：${e?.message ?? e}`, "error");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="side" aria-label="主导航">
      <div className="brand">
        <span className="mark">✦</span> kb-studio
      </div>
      <nav className="seg">
        <Link href="/" className={onChat ? "" : "on"} aria-current={onChat ? undefined : "page"}>
          知识库
        </Link>
        <Link href="/chat" className={onChat ? "on" : ""} aria-current={onChat ? "page" : undefined}>
          对话
        </Link>
      </nav>
      {children}
      <div className="side-foot">
        <button type="button" onClick={() => setShowCreds(true)}>⚙ 设置 · 凭证</button>
        <div className="user-box">
          <button type="button" className="user-btn" onClick={() => setMenu((v) => !v)}>
            <span className="user-avatar">{(email[0] ?? "·").toUpperCase()}</span>
            <span className="user-email">{email || "…"}</span>
          </button>
          {menu && (
            <div className="user-menu" onMouseLeave={() => setMenu(false)}>
              <button type="button" onClick={copyCollectLink}>复制收集链接</button>
              <button type="button" onClick={resetCollectLink}>重置收集链接</button>
              <button
                type="button"
                onClick={() => {
                  setMenu(false);
                  setShowPwd(true);
                }}
              >
                修改密码
              </button>
              <button type="button" onClick={logout}>退出登录</button>
            </div>
          )}
        </div>
      </div>
      <CredentialsDialog open={showCreds} onClose={() => setShowCreds(false)} />
      <ChangePasswordDialog open={showPwd} onClose={() => setShowPwd(false)} />
    </aside>
  );
}
