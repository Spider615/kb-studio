import { NextRequest, NextResponse } from "next/server";

// 普通用户放行清单（登录/注册页 + 这些 API + 静态资源由 matcher 排除）。
const PUBLIC = [
  "/login",
  "/register",
  "/reset",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/send-code",
  "/api/auth/reset-password",
  "/api/ingest",
  "/api/collect-link/validate",
];

// 管理后台放行清单（登录页 + 登录接口）。
const ADMIN_PUBLIC = ["/admin/login", "/api/admin/login"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ===== 管理后台分支：与普通用户会话完全隔离 =====
  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    if (ADMIN_PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      return NextResponse.next();
    }
    // 粗门禁：只查 kb_admin cookie 在不在；HMAC 细校验在 /admin 服务端组件里做。
    if (req.cookies.has("kb_admin")) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/admin/login";
    return NextResponse.redirect(url);
  }

  // ===== 普通用户分支（原逻辑）=====
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  if (req.cookies.has("kb_session")) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // 排除 Next 静态资源与 favicon；其余全过中间件
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
