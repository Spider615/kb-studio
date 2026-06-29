import { NextResponse } from "next/server";
import { findUserById, setUserCollectToken } from "@kb/db";
import { randomToken } from "../../../lib/auth-crypto";
import { resolveAuth } from "../../../lib/auth";
import { collectUrl } from "../../../lib/collect-link";

export const runtime = "nodejs";

/** 取当前用户的专属收集链接；首次访问懒生成 token。 */
export async function GET(req: Request) {
  const auth = await resolveAuth(req);
  if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const user = await findUserById(auth.userId);
  if (!user) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  let token = user.collectToken;
  if (!token) {
    token = randomToken();
    await setUserCollectToken(user.id, token);
  }
  return NextResponse.json({ token, url: collectUrl(token) });
}
