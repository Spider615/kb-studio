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

  const onUploaded = useCallback(
    async (id: string) => {
      await load();
      setSelectedId(id);
    },
    [load],
  );

  const onDeleted = useCallback(
    async (id: string) => {
      setSelectedId((s) => (s === id ? null : s));
      await load();
    },
    [load],
  );

  return (
    <div className="app">
      <Sidebar>
        <DocList docs={docs} selectedId={selectedId} onSelect={setSelectedId} onUploaded={onUploaded} />
      </Sidebar>
      <DocDetail docId={selectedId} onDeleted={onDeleted} />
    </div>
  );
}
