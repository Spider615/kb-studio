"use client";
import { useEffect, useState } from "react";

export const GROUP_COLORS = ["#C96442", "#C8A24A", "#7A9A6B", "#6B8B9A", "#9A6B8B"];

/** 建组 / 改名弹框。mode=create 时提交建组；mode=edit 时提交改名+改色。 */
export default function GroupDialog({
  open,
  mode,
  initialName,
  initialColor,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  initialName?: string;
  initialColor?: string | null;
  onClose: () => void;
  onSubmit: (name: string, color: string | null) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(GROUP_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setColor(initialColor ?? GROUP_COLORS[0]);
    setErr("");
  }, [open, initialName, initialColor]);

  if (!open) return null;

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onSubmit(name.trim(), color);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "create" ? "新建分组" : "编辑分组"}</h3>
        <label className="field">
          <span>分组名</span>
          <input
            value={name}
            autoFocus
            placeholder="如：产品手册"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <div className="field">
          <span>颜色</span>
          <div className="color-pick">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={c === color ? "swatch on" : "swatch"}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`选择颜色 ${c}`}
              />
            ))}
          </div>
        </div>
        {err && <p className="err">⚠ {err}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
