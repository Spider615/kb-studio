import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createGroup, findGroupByNameAndUser, findUserByCollectToken, updateGroup } from "@kb/db";
import { isArchiveUpload, ingestSingleFile, ingestArchive } from "../../../lib/kb";
import { serviceSecretOk } from "../../../lib/service-auth";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * 服务端入库接口（collector 等后端按 ref 代客户入库）。
 * 鉴权走共享服务密钥（Bearer），不走 cookie；归属由 ref(收集 token) 反查员工，
 * 企业名 find-or-create 该员工名下分组。普通文件 → 1 个 doc；压缩包 → 沙箱解压成多个 doc。
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
    // 客户对这个 Agent 的诉求（收集器表单新增字段）；新值非空才覆盖已有分组的对应值，空值保留旧值
    const agentPurpose = String(form.get("agentPurpose") ?? "").trim();
    const agentNotes = String(form.get("agentNotes") ?? "").trim();
    let groupId: string | null = null;
    if (company) {
      const existing = await findGroupByNameAndUser(company, user.id);
      if (existing) {
        groupId = existing.id;
        const patch: { agentPurpose?: string; agentNotes?: string } = {};
        if (agentPurpose) patch.agentPurpose = agentPurpose;
        if (agentNotes) patch.agentNotes = agentNotes;
        if (Object.keys(patch).length > 0) await updateGroup(existing.id, patch, user.id);
      } else {
        groupId = "grp_" + randomUUID().slice(0, 8);
        await createGroup({
          id: groupId,
          name: company,
          userId: user.id,
          agentPurpose: agentPurpose || null,
          agentNotes: agentNotes || null,
        });
      }
    }

    // 压缩包：解压可能耗时（docker + 大包），全部丢后台跑、立即返回，避免撑爆 collector 请求超时。
    if (isArchiveUpload(filename)) {
      void ingestArchive(bytes, filename, user.id, groupId);
      return NextResponse.json({ archive: true, queued: true, groupId });
    }

    // 普通文件：建行 + 后台处理，立即返回 docId
    const docId = await ingestSingleFile(bytes, filename, user.id, groupId);
    return NextResponse.json({ archive: false, docIds: [docId], count: 1, groupId });
  } catch (e: any) {
    console.error("[ingest] 建任务失败:", e?.message ?? e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
