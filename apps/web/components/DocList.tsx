"use client";
import { useState } from "react";
import Loading from "./Loading";
import GroupDialog from "./GroupDialog";
import UploadDialog from "./UploadDialog";
import PushDialog from "./PushDialog";
import { showToast } from "./Toast";

export type DocProgress = { stage: string; done: number; total: number };

export type DocItem = {
  id: string;
  title: string;
  source: string;
  status: string;
  chunkCount: number;
  createdAt: string;
  pushedAt: string | null;
  progress?: DocProgress | null;
  error?: string | null;
  groupId?: string | null;
  /** 客户交这份材料时选的分类（收集器来源，手动上传为空） */
  category?: string | null;
  /** 来自哪次收集器提交（手动上传为空） */
  submissionId?: string | null;
};

export type GroupItem = {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  docCount: number;
  agentPurpose: string | null;
  agentNotes: string | null;
  industry: string | null;
};

export const STAGE_LABEL: Record<string, string> = {
  parsing: "解析中",
  structuring: "生成结构中",
  contextualizing: "上下文化中",
  embedding: "向量化中",
  storing: "写入中",
};

function pct(p?: DocProgress | null): number | null {
  if (!p || p.total <= 0) return null;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

/** Postgres 时间戳 → 本地 "YYYY-MM-DD HH:mm"。 */
export function fmtTime(s?: string | null): string {
  if (!s) return "";
  let t = s.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(t)) t += ":00";
  else if (!/([+-]\d{2}:?\d{2}|Z)$/.test(t)) t += "Z";
  const d = new Date(t);
  if (isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const UNGROUPED = "__ungrouped__";

export default function DocList({
  docs,
  groups,
  loading,
  selectedId,
  onSelect,
  onUploaded,
  onRefresh,
  onDelete,
  onMoveDoc,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
}: {
  docs: DocItem[];
  groups: GroupItem[];
  loading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUploaded: (id: string) => void;
  onRefresh?: () => Promise<void> | void;
  onDelete: (id: string) => void;
  onMoveDoc: (docId: string, groupId: string | null) => void;
  // agentPurpose/agentNotes/industry 设为可选参数：UploadDialog 内联建组不填这几项，仍可直接把 onCreateGroup 传给它
  onCreateGroup: (
    name: string,
    color: string | null,
    agentPurpose?: string | null,
    agentNotes?: string | null,
    industry?: string | null,
  ) => Promise<GroupItem>;
  onUpdateGroup: (
    id: string,
    name: string,
    color: string | null,
    agentPurpose: string | null,
    agentNotes: string | null,
    industry: string | null,
  ) => Promise<void>;
  onDeleteGroup: (id: string) => void;
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem("kb.collapsedGroups") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null); // 文档项「移动到」菜单
  const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null); // 分组段 ⋯ 菜单
  const [dialog, setDialog] = useState<{
    mode: "create" | "edit";
    id?: string;
    name?: string;
    color?: string | null;
    agentPurpose?: string | null;
    agentNotes?: string | null;
    industry?: string | null;
  } | null>(null);
  const [pushGroupId, setPushGroupId] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushErr, setPushErr] = useState("");

  function persistCollapsed(next: Set<string>) {
    setCollapsed(new Set(next));
    try {
      localStorage.setItem("kb.collapsedGroups", JSON.stringify([...next]));
    } catch {}
  }
  function toggleCollapse(id: string) {
    const n = new Set(collapsed);
    n.has(id) ? n.delete(id) : n.add(id);
    persistCollapsed(n);
  }

  // 多文件：逐个发到单文件接口（同批共用 groupId），并发提交后汇总成败。
  // 压缩包(.zip/.rar/...)由后端后台解压成多个 doc：响应无 docId，只表示已入队。
  // 注：真正的解析并发由服务端全局闸统一限流，前端全量并发提交不会压垮机器。
  async function confirmUpload(files: File[], groupId: string | null) {
    type UpRes =
      | { ok: true; docId: string }
      | { ok: true; archive: true; name: string }
      | { ok: false; name: string; msg: string };
    const results = await Promise.all(
      files.map(async (file): Promise<UpRes> => {
        const fd = new FormData();
        fd.append("file", file);
        if (groupId) fd.append("groupId", groupId);
        try {
          const res = await fetch("/api/upload", { method: "POST", body: fd });
          const json = await res.json();
          if (json.error) return { ok: false, name: file.name, msg: String(json.error) };
          if (json.archive || json.queued) return { ok: true, archive: true, name: file.name };
          return { ok: true, docId: String(json.docId) };
        } catch (e: any) {
          return { ok: false, name: file.name, msg: String(e?.message ?? e) };
        }
      }),
    );
    const okDocs: string[] = [];
    let archives = 0;
    const failed: { name: string; msg: string }[] = [];
    for (const r of results) {
      if (r.ok && "docId" in r) okDocs.push(r.docId);
      else if (r.ok) archives++;
      else failed.push({ name: r.name, msg: r.msg });
    }
    if (okDocs.length === 0 && archives === 0)
      throw new Error(failed.map((f) => `${f.name}：${f.msg}`).join("；")); // 全失败：留框重试

    // 有单文件 → 刷新并选中第一个；压缩包解压出的 doc 稍后才出现，补几次延迟刷新让其自动冒出
    if (okDocs.length > 0) await onUploaded(okDocs[0]);
    else await onRefresh?.();
    if (archives > 0) for (const d of [2000, 5000, 9000]) setTimeout(() => onRefresh?.(), d);

    const parts: string[] = [];
    if (okDocs.length) parts.push(`成功 ${okDocs.length} 个`);
    if (archives) parts.push(`压缩包 ${archives} 个（后台解压入库中）`);
    if (failed.length) parts.push(`失败 ${failed.length} 个（${failed.map((f) => f.name).join("、")}）`);
    showToast(`上传：${parts.join("，")}`, failed.length ? "error" : "success");
  }

  async function doGroupPush(credentialIds: string[]) {
    if (!pushGroupId || pushing) return;
    setPushing(true);
    setPushErr("");
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupId: pushGroupId, credentialIds }),
      });
      const json = await res.json();
      const perDoc = json.perDoc ?? [];
      const okCount = perDoc.filter((d: any) => d.ok).length;
      const failCount = perDoc.filter((d: any) => !d.ok).length;
      if (json.ok) {
        showToast(`整组推送完成：成功 ${okCount} 篇${failCount ? `，跳过/失败 ${failCount} 篇` : ""}`, "success");
        setPushGroupId(null);
      } else {
        setPushErr(`推送失败：${failCount} 篇未成功（组内可能没有就绪文档）`);
      }
    } catch (e: any) {
      setPushErr(String(e?.message ?? e));
    } finally {
      setPushing(false);
    }
  }

  function dotClass(d: DocItem) {
    if (d.status === "failed") return "dot failed";
    if (d.status === "processing") return "dot pending";
    return "dot";
  }
  function meta(d: DocItem) {
    if (d.status === "processing") {
      const label = STAGE_LABEL[d.progress?.stage ?? ""] ?? "处理中";
      const p = pct(d.progress);
      return p === null ? label : `${label} ${p}%`;
    }
    if (d.status === "failed") return "处理失败";
    if (d.status === "pushed") return `${d.chunkCount} chunk · 已推送`;
    if (d.status === "ready") return `${d.chunkCount} chunk · 已就绪`;
    return d.status;
  }

  // 分段：每个分组 + 末尾「未分组」
  const sections: Array<{ key: string; gid: string | null; name: string; color: string | null; deletable: boolean }> = [
    ...groups.map((g) => ({ key: g.id, gid: g.id, name: g.name, color: g.color, deletable: true })),
    { key: UNGROUPED, gid: null, name: "未分组", color: null, deletable: false },
  ];
  const docsOf = (gid: string | null) => docs.filter((d) => (d.groupId ?? null) === gid);

  function renderDoc(d: DocItem) {
    const p = d.status === "processing" ? pct(d.progress) : null;
    return (
      <div
        key={d.id}
        className={`item${d.id === selectedId ? " on" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", d.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <button type="button" className="item-main" onClick={() => onSelect(d.id)}>
          <span className={dotClass(d)} />
          <div className="txt">
            <div className="t">{d.title}</div>
            <div className="m">{meta(d)}</div>
            {d.status === "processing" ? (
              <div className="pbar">
                <span style={p === null ? { width: "30%" } : { width: `${p}%` }} className={p === null ? "indet" : ""} />
              </div>
            ) : (
              <div className="m time">{fmtTime(d.createdAt)}</div>
            )}
          </div>
        </button>
        <div className="item-actions">
          <button
            type="button"
            className="mv"
            onClick={() => setMenuFor((v) => (v === d.id ? null : d.id))}
            aria-label="移动到分组"
            title="移动到分组"
          >
            ⋯
          </button>
          <button type="button" className="x" onClick={() => onDelete(d.id)} aria-label="删除文档" title="删除">
            ✕
          </button>
        </div>
        {menuFor === d.id && (
          <div className="move-menu" onMouseLeave={() => setMenuFor(null)}>
            <div className="mm-title">移动到</div>
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                disabled={(d.groupId ?? null) === g.id}
                onClick={() => {
                  onMoveDoc(d.id, g.id);
                  setMenuFor(null);
                }}
              >
                {g.name}
              </button>
            ))}
            <button
              type="button"
              disabled={(d.groupId ?? null) === null}
              onClick={() => {
                onMoveDoc(d.id, null);
                setMenuFor(null);
              }}
            >
              未分组
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button type="button" className="cta" onClick={() => setUploadOpen(true)}>
        ↑ 上传文档
      </button>
      <button type="button" className="cta ghost" onClick={() => setDialog({ mode: "create" })}>
        ＋ 新建分组
      </button>
      <div className="list-title">文档</div>
      <div className="list">
        {loading && docs.length === 0 && <Loading />}
        {!loading && docs.length === 0 && groups.length === 0 && (
          <p className="muted" style={{ padding: "4px 8px" }}>还没有文档，先上传一个</p>
        )}
        {sections.map((s) => {
          const items = docsOf(s.gid);
          // 未分组段为空时不显示（除非正拖拽到它上面）
          if (s.gid === null && items.length === 0 && dragOver !== UNGROUPED) return null;
          const ungrouped = s.gid === null;
          const isCollapsed = !ungrouped && collapsed.has(s.key);
          return (
            <div
              key={s.key}
              className={`group-seg${dragOver === s.key ? " drag-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(s.key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOver((v) => (v === s.key ? null : v));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                setDragOver(null);
                if (!id) return;
                const cur = docs.find((d) => d.id === id)?.groupId ?? null;
                if (cur !== s.gid) onMoveDoc(id, s.gid);
              }}
            >
              <div className={`group-head${ungrouped ? " ungrouped" : ""}`}>
                {!ungrouped && (
                  <button type="button" className="caret" onClick={() => toggleCollapse(s.key)} aria-label="折叠/展开">
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                )}
                {!ungrouped && <span className="g-dot" style={{ background: s.color ?? "var(--text-3)" }} />}
                <span className="g-name" onClick={ungrouped ? undefined : () => toggleCollapse(s.key)}>{s.name}</span>
                <span className="g-count">{items.length}</span>
                {s.deletable && (
                  <button
                    type="button"
                    className="g-menu-btn"
                    onClick={() => setGroupMenuFor((v) => (v === s.key ? null : s.key))}
                    aria-label="分组菜单"
                  >
                    ⋯
                  </button>
                )}
                {groupMenuFor === s.key && s.gid && (
                  <div className="move-menu group-menu" onMouseLeave={() => setGroupMenuFor(null)}>
                    <button
                      type="button"
                      onClick={() => {
                        const g = groups.find((x) => x.id === s.gid);
                        setDialog({
                          mode: "edit",
                          id: s.gid!,
                          name: s.name,
                          color: s.color,
                          agentPurpose: g?.agentPurpose ?? null,
                          agentNotes: g?.agentNotes ?? null,
                          industry: g?.industry ?? null,
                        });
                        setGroupMenuFor(null);
                      }}
                    >
                      编辑（改名 / 改色 / Agent 用途）
                    </button>
                    <button type="button" onClick={() => { setPushGroupId(s.gid); setGroupMenuFor(null); }}>
                      推送整组到秒懂
                    </button>
                    <button type="button" className="danger" onClick={() => { onDeleteGroup(s.gid!); setGroupMenuFor(null); }}>
                      删除分组
                    </button>
                  </div>
                )}
              </div>
              {(ungrouped || !isCollapsed) && <div className="group-body">{items.map(renderDoc)}</div>}
            </div>
          );
        })}
      </div>

      <UploadDialog
        open={uploadOpen}
        groups={groups}
        onClose={() => setUploadOpen(false)}
        onConfirm={confirmUpload}
        onCreateGroup={onCreateGroup}
      />
      <GroupDialog
        open={!!dialog}
        mode={dialog?.mode ?? "create"}
        initialName={dialog?.name}
        initialColor={dialog?.color}
        initialAgentPurpose={dialog?.agentPurpose}
        initialAgentNotes={dialog?.agentNotes}
        initialIndustry={dialog?.industry}
        onClose={() => setDialog(null)}
        onSubmit={async (name, color, agentPurpose, agentNotes, industry) => {
          if (dialog?.mode === "edit" && dialog.id)
            await onUpdateGroup(dialog.id, name, color, agentPurpose, agentNotes, industry);
          else await onCreateGroup(name, color, agentPurpose, agentNotes, industry);
        }}
      />
      <PushDialog
        open={!!pushGroupId}
        onClose={() => {
          if (!pushing) {
            setPushGroupId(null);
            setPushErr("");
          }
        }}
        onSubmit={doGroupPush}
        pushing={pushing}
        error={pushErr}
      />
    </>
  );
}
