"use client";
import { useEffect, useRef, useState } from "react";
import { GROUP_COLORS } from "./GroupDialog";
import type { GroupItem } from "./DocList";

const UNGROUPED = ""; // select 的 value：空串 = 未分组

const fileKey = (f: File) => `${f.name}__${f.size}__${f.lastModified}`;
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 上传文档弹框：拖拽/点选多文件 + 选目标分组（可选，默认未分组）+ 内联新建分组 → 确认上传。 */
export default function UploadDialog({
  open,
  groups,
  onClose,
  onConfirm,
  onCreateGroup,
}: {
  open: boolean;
  groups: GroupItem[];
  onClose: () => void;
  onConfirm: (files: File[], groupId: string | null) => Promise<void>;
  onCreateGroup: (name: string, color: string | null) => Promise<GroupItem>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [targetId, setTargetId] = useState<string>(UNGROUPED);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string | null>(GROUP_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setDragOver(false);
    setTargetId(UNGROUPED);
    setCreating(false);
    setNewName("");
    setNewColor(GROUP_COLORS[0]);
    setBusy(false);
    setErr("");
    if (fileRef.current) fileRef.current.value = "";
  }, [open]);

  if (!open) return null;

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      return [...prev, ...incoming.filter((f) => !seen.has(fileKey(f)))];
    });
  }
  function onPick() {
    if (fileRef.current?.files?.length) addFiles(fileRef.current.files);
    if (fileRef.current) fileRef.current.value = ""; // 清空，便于再次选同名文件
  }
  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

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
    if (busy || files.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      await onConfirm(files, targetId === UNGROUPED ? null : targetId);
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

        <input type="file" ref={fileRef} hidden multiple onChange={onPick} />
        <div className="field">
          <span>文件</span>
          <div
            className={dragOver ? "dropzone over" : "dropzone"}
            onClick={() => !busy && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!busy && e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
            }}
          >
            {dragOver ? "松开以添加文件" : "拖拽文件到此，或点击选择（可多选）"}
          </div>
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={fileKey(f)}>
                  <span className="fname">{f.name}</span>
                  <span className="fsize">{fmtSize(f.size)}</span>
                  <button type="button" disabled={busy} onClick={() => removeFile(i)} aria-label={`移除 ${f.name}`}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

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
          <button type="button" className="btn primary" onClick={confirm} disabled={busy || creating || files.length === 0}>
            {busy ? "上传中…" : files.length > 1 ? `开始上传（${files.length}）` : "开始上传"}
          </button>
        </div>
      </div>
    </div>
  );
}
