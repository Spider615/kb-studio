/** 加载动画：旋转环 + 文案，居中。 */
export default function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="loading-block">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}
