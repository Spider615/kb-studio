"use client";
import { useCallback, useEffect, useState } from "react";
import ConversationList, { type Conv } from "../../components/ConversationList";
import ChatThread from "../../components/ChatThread";

export default function ChatPage() {
  const [items, setItems] = useState<Conv[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const json = await res.json();
      setItems(json.conversations ?? []);
    } catch (e) {
      console.error("[kb] 加载会话列表失败:", e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((json) => setDocs((json.docs ?? []).map((d: { id: string; title: string }) => ({ id: d.id, title: d.title }))))
      .catch((e) => console.error("[kb] 加载文档列表失败:", e));
  }, []);

  const onNew = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      const json = await res.json();
      if (json.id) {
        await load();
        setSelectedId(json.id);
      }
    } catch (e) {
      console.error("[kb] 新建对话失败:", e);
    }
  }, [load]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm("删除这个对话？")) return;
      try {
        await fetch(`/api/conversations/${id}`, { method: "DELETE" });
        setSelectedId((s) => (s === id ? null : s));
        await load();
      } catch (e) {
        console.error("[kb] 删除对话失败:", e);
      }
    },
    [load],
  );

  const onTitle = useCallback((id: string, title: string) => {
    setItems((arr) => arr.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  return (
    <div className="pane-2">
      <ConversationList items={items} selectedId={selectedId} onSelect={setSelectedId} onNew={onNew} onDelete={onDelete} />
      <ChatThread conversationId={selectedId} onTitle={onTitle} docs={docs} />
    </div>
  );
}
