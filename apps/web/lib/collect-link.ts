/** 把 collect token 拼成发给客户的收集链接（指向 collector 表单 /form?ref=）。 */
export function collectUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_COLLECTOR_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/form?ref=${token}`;
}
