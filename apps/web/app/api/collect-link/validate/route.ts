import { NextResponse } from "next/server";
import { findUserByCollectToken } from "@kb/db";
import { serviceSecretOk } from "../../../../lib/service-auth";

export const runtime = "nodejs";

/**
 * 校验收集 token 是否有效（collector 渲染表单前调用，决定是否显示「链接已失效」）。
 * 服务密钥鉴权；valid=true 时附带归属员工名，便于表单展示「XX 的材料收集」。
 */
export async function GET(req: Request) {
  if (!serviceSecretOk(req)) return NextResponse.json({ error: "未授权" }, { status: 401 });

  const ref = (new URL(req.url).searchParams.get("ref") ?? "").trim();
  if (!ref) return NextResponse.json({ valid: false });

  const user = await findUserByCollectToken(ref);
  if (!user) return NextResponse.json({ valid: false });
  return NextResponse.json({ valid: true, displayName: user.displayName ?? null });
}
