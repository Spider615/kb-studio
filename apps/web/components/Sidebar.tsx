"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import CredentialsDialog from "./CredentialsDialog";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const onChat = path.startsWith("/chat");
  const [showCreds, setShowCreds] = useState(false);

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
        <button onClick={() => setShowCreds(true)}>⚙ 设置 · 秒懂凭据</button>
      </div>
      <CredentialsDialog open={showCreds} onClose={() => setShowCreds(false)} />
    </aside>
  );
}
