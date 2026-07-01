"use client";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import DocList, { type DocItem, type GroupItem } from "../components/DocList";
import DocDetail from "../components/DocDetail";

export default function KbPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [dRes, gRes] = await Promise.all([fetch("/api/docs"), fetch("/api/groups")]);
      if (dRes.status === 401 || gRes.status === 401) {
        window.location.href = "/login";
        return;
      }
      const dJson = await dRes.json();
      const gJson = await gRes.json();
      setDocs(dJson.docs ?? []);
      setGroups(gJson.groups ?? []);
    } catch (e) {
      console.error("[kb] 加载文档/分组失败:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  // 归组：乐观更新 + PATCH，失败回滚（重新拉取）
  const moveDoc = useCallback(
    async (docId: string, groupId: string | null) => {
      const before = docs;
      setDocs((arr) => arr.map((d) => (d.id === docId ? { ...d, groupId } : d)));
      setGroups((arr) =>
        arr.map((g) => {
          const had = before.find((d) => d.id === docId)?.groupId ?? null;
          if (g.id === had && had !== groupId) return { ...g, docCount: Math.max(0, g.docCount - 1) };
          if (g.id === groupId && had !== groupId) return { ...g, docCount: g.docCount + 1 };
          return g;
        }),
      );
      try {
        const res = await fetch(`/api/docs/${docId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groupId }),
        });
        if (!res.ok) throw new Error(String(res.status));
      } catch (e) {
        console.error("[kb] 归组失败，回滚:", e);
        await load();
      }
    },
    [docs, load],
  );

  const createGroup = useCallback(
    async (
      name: string,
      color: string | null,
      agentPurpose: string | null = null,
      agentNotes: string | null = null,
    ): Promise<GroupItem> => {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color, agentPurpose, agentNotes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "建组失败");
      await load();
      return json.group as GroupItem;
    },
    [load],
  );

  const updateGroup = useCallback(
    async (
      id: string,
      name: string,
      color: string | null,
      agentPurpose: string | null,
      agentNotes: string | null,
    ) => {
      const res = await fetch(`/api/groups/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color, agentPurpose, agentNotes }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "保存失败");
      await load();
    },
    [load],
  );

  const deleteGroup = useCallback(
    async (id: string) => {
      if (!confirm("删除这个分组？组内文档会移回「未分组」，不会删除文档。")) return;
      try {
        const res = await fetch(`/api/groups/${id}`, { method: "DELETE" });
        const json = await res.json();
        if (json.ok) await load();
        else console.error("[kb] 删除分组失败:", json.error);
      } catch (e) {
        console.error("[kb] 删除分组失败:", e);
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
          groups={groups}
          loading={loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onUploaded={onUploaded}
          onRefresh={load}
          onDelete={removeDoc}
          onMoveDoc={moveDoc}
          onCreateGroup={createGroup}
          onUpdateGroup={updateGroup}
          onDeleteGroup={deleteGroup}
        />
      </Sidebar>
      <DocDetail docId={selectedId} doc={selectedDoc} groups={groups} onDelete={removeDoc} onChanged={load} onMoveDoc={moveDoc} />
    </div>
  );
}
