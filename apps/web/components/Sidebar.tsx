"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Sidebar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const onChat = path.startsWith("/chat");

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
        {/* Task 8 接入 CredentialsDialog；本任务先放不弹窗的占位按钮 */}
        <button type="button">⚙ 设置 · 秒懂凭据</button>
      </div>
    </aside>
  );
}
