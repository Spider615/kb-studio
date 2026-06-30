import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminCountUsers, adminListUsers, adminSystemStats } from "@kb/db";
import { ADMIN_COOKIE, verifyAdminCookie } from "../../lib/admin-auth";
import AdminLogout from "./AdminLogout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 总是实时查库，不缓存

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  processing: "处理中",
  ready: "待确认",
  pushed: "已推送",
  failed: "失败",
};

function fmt(d: Date | null): string {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-card">
      <div className="admin-card-v">{value}</div>
      <div className="admin-card-l">{label}</div>
    </div>
  );
}

export default async function AdminDashboard() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!verifyAdminCookie(token)) redirect("/admin/login");

  const [count, usersList, stats] = await Promise.all([
    adminCountUsers(),
    adminListUsers(),
    adminSystemStats(),
  ]);

  return (
    <div className="admin">
      <header className="admin-head">
        <div className="brand"><span className="mark">✦</span> kb-studio 管理后台</div>
        <AdminLogout />
      </header>

      <div className="admin-body">
        <section className="admin-cards">
          <StatCard label="注册用户" value={count} />
          <StatCard label="文档总数" value={stats.totalDocs} />
          <StatCard label="Chunk 总数" value={stats.totalChunks} />
          <StatCard label="已推送秒懂文档" value={stats.pushedDocCount} />
          <StatCard label="近 7 天注册" value={stats.registrations7d} />
          <StatCard label="近 30 天注册" value={stats.registrations30d} />
        </section>

        <section className="admin-statusbar">
          <span className="admin-statusbar-title">文档状态分布</span>
          {Object.keys(stats.docsByStatus).length === 0 ? (
            <span className="admin-muted">暂无文档</span>
          ) : (
            Object.entries(stats.docsByStatus).map(([s, n]) => (
              <span className="pill ok" key={s}>{STATUS_LABEL[s] ?? s}: {n}</span>
            ))
          )}
        </section>

        <section className="admin-table-wrap">
          <h2 className="admin-h2">用户列表（{count}）</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th><th>昵称</th><th>注册时间</th>
                <th>文档</th><th>对话</th><th>凭据</th><th>最近登录</th>
              </tr>
            </thead>
            <tbody>
              {usersList.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.displayName ?? "—"}</td>
                  <td>{fmt(u.createdAt)}</td>
                  <td>{u.docCount}</td>
                  <td>{u.conversationCount}</td>
                  <td>{u.credentialCount}</td>
                  <td>{fmt(u.lastLoginAt)}</td>
                </tr>
              ))}
              {usersList.length === 0 && (
                <tr><td colSpan={7} className="admin-muted">还没有用户注册</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
