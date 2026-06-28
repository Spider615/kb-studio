"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CredentialsDialog from "./CredentialsDialog";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const onChat = path.startsWith("/chat");
  const [showCreds, setShowCreds] = useState(false);
  const [menu, setMenu] = useState(false);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.user && setEmail(j.user.email))
      .catch(() => {});
  }, []);

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
              <button type="button" onClick={logout}>退出登录</button>
            </div>
          )}
        </div>
      </div>
      <CredentialsDialog open={showCreds} onClose={() => setShowCreds(false)} />
    </aside>
  );
}
