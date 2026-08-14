import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  createGroup,
  findGroupByNameAndUser,
  findUserByCollectToken,
  updateGroup,
  upsertCollectSubmission,
} from "@kb/db";
import { isArchiveUpload, ingestSingleFile, ingestArchive } from "../../../lib/kb";
import { serviceSecretOk } from "../../../lib/service-auth";

export const runtime = "nodejs";
export const maxDuration = 600;

/** 表单字段取值：trim 后空串一律当"没填"（null），供 COALESCE 语义使用。 */
function field(form: FormData, key: string): string | null {
  const v = String(form.get(key) ?? "").trim();
  return v || null;
}

/**
 * 服务端入库接口（collector 等后端按 ref 代客户入库）。
 * 鉴权走共享服务密钥（Bearer），不走 cookie；归属由 ref(收集 token) 反查员工，
 * 企业名 find-or-create 该员工名下分组。普通文件 → 1 个 doc；压缩包 → 沙箱解压成多个 doc。
 *
 * 客户在收集器表单填的信息分三处落库，确保不丢：
 * - 企业属性（企业名/行业/Agent 用途/其他补充）→ groups（非空才覆盖，保持"最新值"语义）
 * - 整次提交的完整表单快照 → collect_submissions（collector 逐文件调 N 次，按 submissionId 合并成一行）
 * - 这份文件本身的材料分类 + 所属提交 → docs.category / docs.submission_id
 *
 * **`file` 是可选的**：collector 每次提交先不带文件调一次，只登记分组和提交记录，再逐个推文件。
 * 否则「客户只填了需求、一个文件都没传」的提交在这边完全不存在——收集器那边是 for-each-file
 * 循环推的，0 个文件就是 0 个请求，企业名/行业/诉求会静默消失。
 */
export async function POST(req: Request) {
  try {
    if (!serviceSecretOk(req)) return NextResponse.json({ error: "未授权" }, { status: 401 });

    const form = await req.formData();
    const file = form.get("file") as any;
    const hasFile = !!file && typeof file.arrayBuffer === "function";

    const ref = String(form.get("ref") ?? "").trim();
    if (!ref) return NextResponse.json({ error: "缺少 ref" }, { status: 400 });
    const user = await findUserByCollectToken(ref);
    if (!user) return NextResponse.json({ error: "无效收集链接" }, { status: 400 });

    // 一企业一分组：按企业名 find-or-create 该员工名下分组；空企业名 → 未分组
    const company = field(form, "company");
    // 客户对这个 Agent 的诉求 + 行业（收集器表单字段）；新值非空才覆盖已有分组的对应值，空值保留旧值
    const agentPurpose = field(form, "agentPurpose");
    const agentNotes = field(form, "agentNotes");
    const industry = field(form, "industry");
    // 这份文件在表单里属于哪一类材料（"产品说明书"/"批量上传"…）
    const category = field(form, "category");
    // collector 侧的提交号：同一次提交的 N 个文件请求靠它合并成一条提交记录
    const collectorId = field(form, "submissionId");
    // 表单原样快照（JSON 字符串）；解析失败不阻塞入库，只记日志
    let formSnapshot: Record<string, unknown> | null = null;
    const rawForm = field(form, "form");
    if (rawForm) {
      try {
        const parsed = JSON.parse(rawForm);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) formSnapshot = parsed;
      } catch (e: any) {
        console.warn("[ingest] form 快照不是合法 JSON，已忽略:", e?.message ?? e);
      }
    }

    let groupId: string | null = null;
    if (company) {
      const existing = await findGroupByNameAndUser(company, user.id);
      if (existing) {
        groupId = existing.id;
        const patch: { agentPurpose?: string; agentNotes?: string; industry?: string } = {};
        if (agentPurpose) patch.agentPurpose = agentPurpose;
        if (agentNotes) patch.agentNotes = agentNotes;
        if (industry) patch.industry = industry;
        if (Object.keys(patch).length > 0) await updateGroup(existing.id, patch, user.id);
      } else {
        groupId = "grp_" + randomUUID().slice(0, 8);
        await createGroup({
          id: groupId,
          name: company,
          userId: user.id,
          agentPurpose,
          agentNotes,
          industry,
        });
      }
    }

    // 提交记录：有 submissionId 才建（它是把 N 个文件请求合成一行的唯一依据）。
    // 没有它就无法去重，硬建会给一次提交留下 N 条重复记录，宁可退回旧行为并留日志。
    let submissionId: string | null = null;
    if (collectorId) {
      try {
        submissionId = await upsertCollectSubmission({
          id: "sub_" + randomUUID().slice(0, 8),
          userId: user.id,
          groupId,
          collectorId,
          company,
          industry,
          agentPurpose,
          agentNotes,
          form: formSnapshot,
        });
      } catch (e: any) {
        // 提交记录只是留档，失败不该挡住文件入库
        console.error("[ingest] 记录提交失败（不影响入库）:", e?.message ?? e);
      }
    } else if (agentPurpose || agentNotes || industry || formSnapshot) {
      console.warn("[ingest] collector 未带 submissionId，本次提交的表单快照无法留档（企业属性仍写入分组）");
    }

    // 只登记表单信息、不带文件的调用：分组与提交记录已经落好，到此为止
    if (!hasFile) {
      return NextResponse.json({ archive: false, docIds: [], count: 0, groupId, submissionId, metadataOnly: true });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = (typeof file.name === "string" && file.name) || "upload.bin";
    const origin = { category, submissionId };

    // 压缩包：解压可能耗时（docker + 大包），全部丢后台跑、立即返回，避免撑爆 collector 请求超时。
    if (isArchiveUpload(filename)) {
      void ingestArchive(bytes, filename, user.id, groupId, origin);
      return NextResponse.json({ archive: true, queued: true, groupId, submissionId });
    }

    // 普通文件：建行 + 后台处理，立即返回 docId
    const docId = await ingestSingleFile(bytes, filename, user.id, groupId, origin);
    return NextResponse.json({ archive: false, docIds: [docId], count: 1, groupId, submissionId });
  } catch (e: any) {
    console.error("[ingest] 建任务失败:", e?.message ?? e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
