"use client";

export type Conv = { id: string; title: string; updatedAt: string };

export default function ConversationList({
  items,
  selectedId,
  onSelect,
  onNew,
  onDelete,
}: {
  items: Conv[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="list-col">
      <div className="upload-box">
        <button onClick={onNew}>+ 新建对话</button>
      </div>
      <div className="list">
        {items.length === 0 && <p className="muted">还没有对话</p>}
        {items.map((c) => (
          <div key={c.id} className={c.id === selectedId ? "list-item active" : "list-item"}>
            <button className="li-main" onClick={() => onSelect(c.id)}>
              <div className="li-title">{c.title}</div>
            </button>
            <button className="li-del" onClick={() => onDelete(c.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
