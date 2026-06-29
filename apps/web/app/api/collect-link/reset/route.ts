import { NextResponse } from "next/server";
import { setUserCollectToken } from "@kb/db";
import { randomToken } from "../../../../lib/auth-crypto";
import { resolveAuth } from "../../../../lib/auth";
import { collectUrl } from "../../../../lib/collect-link";

export const runtime = "nodejs";

/** 重置当前用户的收集 token（旧链接随即失效）。 */
export async function POST(req: Request) {
  const auth = await resolveAuth(req);
  if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const token = randomToken();
  await setUserCollectToken(auth.userId, token);
  return NextResponse.json({ token, url: collectUrl(token) });
}
