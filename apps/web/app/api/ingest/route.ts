import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  createProcessingDoc,
  createGroup,
  findGroupByNameAndUser,
  findUserByCollectToken,
} from "@kb/db";
import { processDoc } from "../../../lib/kb";
import { saveOriginal } from "../../../lib/files";
import { serviceSecretOk } from "../../../lib/service-auth";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * 服务端入库接口（collector 等后端按 ref 代客户入库）。
 * 鉴权走共享服务密钥（Bearer），不走 cookie；归属由 ref(收集 token) 反查员工，
 * 企业名 find-or-create 该员工名下分组。其余处理与 /api/upload 完全一致（共用 processDoc）。
 */
export async function POST(req: Request) {
  try {
    if (!serviceSecretOk(req)) return NextResponse.json({ error: "未授权" }, { status: 401 });

    const form = await req.formData();
    const file = form.get("file") as any;
    if (!file || typeof file.arrayBuffer !== "function")
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });

    const ref = String(form.get("ref") ?? "").trim();
    if (!ref) return NextResponse.json({ error: "缺少 ref" }, { status: 400 });
    const user = await findUserByCollectToken(ref);
    if (!user) return NextResponse.json({ error: "无效收集链接" }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = (typeof file.name === "string" && file.name) || "upload.bin";

    // 一企业一分组：按企业名 find-or-create 该员工名下分组；空企业名 → 未分组
    const company = String(form.get("company") ?? "").trim();
    let groupId: string | null = null;
    if (company) {
      const existing = await findGroupByNameAndUser(company, user.id);
      if (existing) {
        groupId = existing.id;
      } else {
        groupId = "grp_" + randomUUID().slice(0, 8);
        await createGroup({ id: groupId, name: company, userId: user.id });
      }
    }

    const docId = "doc_" + randomUUID().slice(0, 8);
    // 落盘原文件（供预览）；失败不致命
    let fileId: string | null = null;
    try {
      fileId = await saveOriginal(docId, filename, bytes);
    } catch (e: any) {
      console.error("[ingest] 存原文件失败:", e?.message ?? e);
    }
    // 先建处理中文档行，立即返回 docId；真正处理后台异步跑
    await createProcessingDoc(docId, filename, filename, fileId, user.id, groupId);
    void processDoc(docId, bytes, filename);
    return NextResponse.json({ docId, groupId });
  } catch (e: any) {
    console.error("[ingest] 建任务失败:", e?.message ?? e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
