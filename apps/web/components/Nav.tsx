"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "知识库" },
  { href: "/chat", label: "对话" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="主导航">
      <div className="nav-brand">kb-studio</div>
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={active ? "nav-item active" : "nav-item"}
            aria-current={active ? "page" : undefined}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
