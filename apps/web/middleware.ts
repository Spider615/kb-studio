import { NextRequest, NextResponse } from "next/server";

// 放行：登录/注册页 + 这俩 API + 静态资源（由 matcher 排除）。
const PUBLIC = ["/login", "/register", "/api/auth/login", "/api/auth/register", "/api/auth/send-code"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (req.cookies.has("kb_session")) return NextResponse.next();

  // 无会话：API → 401 JSON；页面 → 跳登录
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
