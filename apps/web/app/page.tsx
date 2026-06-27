"use client";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import DocList, { type DocItem } from "../components/DocList";
import DocDetail from "../components/DocDetail";

export default function KbPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/docs");
      const json = await res.json();
      setDocs(json.docs ?? []);
    } catch (e) {
      console.error("[kb] 加载文档列表失败:", e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 有处理中的文档时每 1.5s 轮询刷新进度
  useEffect(() => {
    if (!docs.some((d) => d.status === "processing")) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [docs, load]);

  const onUploaded = useCallback(
    async (id: string) => {
      await load();
      setSelectedId(id);
    },
    [load],
  );

  // 统一删除：列表项与详情都走这里（含处理中→停止处理）
  const removeDoc = useCallback(
    async (id: string) => {
      if (!confirm("删除这篇文档？正在处理的会停止处理。")) return;
      try {
        const res = await fetch(`/api/docs/${id}`, { method: "DELETE" });
        const json = await res.json();
        if (json.ok) {
          setSelectedId((s) => (s === id ? null : s));
          await load();
        }
      } catch (e) {
        console.error("[kb] 删除文档失败:", e);
      }
    },
    [load],
  );

  const selectedDoc = docs.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar>
        <DocList
          docs={docs}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onUploaded={onUploaded}
          onDelete={removeDoc}
        />
      </Sidebar>
      <DocDetail docId={selectedId} doc={selectedDoc} onDelete={removeDoc} onChanged={load} />
    </div>
  );
}
