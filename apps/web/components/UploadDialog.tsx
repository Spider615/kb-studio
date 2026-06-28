"use client";
import { useEffect, useState } from "react";
import { GROUP_COLORS } from "./GroupDialog";
import type { GroupItem } from "./DocList";

const UNGROUPED = ""; // select 的 value：空串 = 未分组

/** 上传文档弹框：选目标分组（可选，默认未分组）+ 内联新建分组 + 确认上传。 */
export default function UploadDialog({
  open,
  fileName,
  groups,
  onClose,
  onConfirm,
  onCreateGroup,
}: {
  open: boolean;
  fileName: string;
  groups: GroupItem[];
  onClose: () => void;
  onConfirm: (groupId: string | null) => Promise<void>;
  onCreateGroup: (name: string, color: string | null) => Promise<GroupItem>;
}) {
  const [targetId, setTargetId] = useState<string>(UNGROUPED);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string | null>(GROUP_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setTargetId(UNGROUPED);
    setCreating(false);
    setNewName("");
    setNewColor(GROUP_COLORS[0]);
    setBusy(false);
    setErr("");
  }, [open]);

  if (!open) return null;

  async function createInline() {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const g = await onCreateGroup(newName.trim(), newColor);
      setTargetId(g.id); // 新组立即成为目标
      setCreating(false);
      setNewName("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await onConfirm(targetId === UNGROUPED ? null : targetId);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e)); // 失败留在框内重试
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>上传文档</h3>
        <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>文件：{fileName}</p>

        <label className="field">
          <span>归入分组</span>
          <select value={targetId} disabled={busy || creating} onChange={(e) => setTargetId(e.target.value)}>
            <option value={UNGROUPED}>未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>

        {!creating ? (
          <button
            type="button"
            className="btn ghost"
            style={{ alignSelf: "flex-start", marginBottom: 4 }}
            disabled={busy}
            onClick={() => setCreating(true)}
          >
            ＋ 新建分组
          </button>
        ) : (
          <div className="field">
            <span>新分组名</span>
            <input
              value={newName}
              autoFocus
              placeholder="如：产品手册"
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createInline()}
            />
            <div className="color-pick" style={{ marginTop: 8 }}>
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === newColor ? "swatch on" : "swatch"}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                  aria-label={`选择颜色 ${c}`}
                />
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => { setCreating(false); setNewName(""); }}>
                取消新建
              </button>
              <button type="button" className="btn primary" disabled={!newName.trim() || busy} onClick={createInline}>
                {busy ? "建组中…" : "建组并选中"}
              </button>
            </div>
          </div>
        )}

        {err && <p className="err">⚠ {err}</p>}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={confirm} disabled={busy || creating}>
            {busy ? "上传中…" : "开始上传"}
          </button>
        </div>
      </div>
    </div>
  );
}
