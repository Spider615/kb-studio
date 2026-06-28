"use client";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import ConversationList, { type Conv } from "../../components/ConversationList";
import ChatThread from "../../components/ChatThread";

export default function ChatPage() {
  const [items, setItems] = useState<Conv[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string; docCount: number }[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const json = await res.json();
      setItems(json.conversations ?? []);
    } catch (e) {
      console.error("[kb] 加载会话列表失败:", e);
    } finally {
      setLoading(false);
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

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => r.json())
      .then((json) => setGroups((json.groups ?? []).map((g: any) => ({ id: g.id, name: g.name, docCount: g.docCount }))))
      .catch((e) => console.error("[kb] 加载分组失败:", e));
  }, []);

  const onNew = useCallback(async () => {
    // 已有空对话（未发过消息）则直接选中它，不再新建——避免堆叠空「新对话」
    const empty = items.find((c) => c.messageCount === 0);
    if (empty) {
      setSelectedId(empty.id);
      return;
    }
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
  }, [items, load]);

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
    <div className="app">
      <Sidebar>
        <ConversationList items={items} loading={loading} selectedId={selectedId} onSelect={setSelectedId} onNew={onNew} onDelete={onDelete} />
      </Sidebar>
      <ChatThread conversationId={selectedId} onTitle={onTitle} docs={docs} groups={groups} />
    </div>
  );
}
