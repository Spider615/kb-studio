"use client";
import Loading from "./Loading";

export type Conv = { id: string; title: string; updatedAt: string; messageCount: number };

export default function ConversationList({
  items,
  loading,
  selectedId,
  onSelect,
  onNew,
  onDelete,
}: {
  items: Conv[];
  loading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <button type="button" className="cta" onClick={onNew}>
        ＋ 新建对话
      </button>
      <div className="list-title">最近对话</div>
      <div className="list">
        {loading && items.length === 0 && <Loading />}
        {!loading && items.length === 0 && <p className="muted" style={{ padding: "4px 8px" }}>还没有对话</p>}
        {items.map((c) => (
          <div key={c.id} className={c.id === selectedId ? "item on" : "item"}>
            <button type="button" className="item-main" onClick={() => onSelect(c.id)}>
              <div className="txt">
                <div className="t">{c.title}</div>
              </div>
            </button>
            <button type="button" className="x" onClick={() => onDelete(c.id)} aria-label="删除对话">
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
