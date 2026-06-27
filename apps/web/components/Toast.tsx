"use client";
import { useEffect, useState } from "react";

type ToastType = "success" | "error";
type ToastItem = { id: number; message: string; type: ToastType };
type Listener = (t: ToastItem) => void;

let seq = 0;
const listeners = new Set<Listener>();

/** 在页面上方弹出一个提示，几秒后自动消失。可在任意客户端组件里调用。 */
export function showToast(message: string, type: ToastType = "success") {
  const item: ToastItem = { id: ++seq, message, type };
  listeners.forEach((l) => l(item));
}

/** 全局挂载一次（layout 里），负责渲染所有 toast。 */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const on: Listener = (t) => {
      setItems((arr) => [...arr, t]);
      setTimeout(() => setItems((arr) => arr.filter((x) => x.id !== t.id)), 3000);
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="toaster">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <span className="toast-icon">{t.type === "success" ? "✓" : "⚠"}</span>
          {t.message}
        </div>
      ))}
    </div>
  );
}
