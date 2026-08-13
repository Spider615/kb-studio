import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatTurn, agentSearch, safeTruncateUtf16 } from "@kb/pipeline";
import { listDocIdsInGroup, listDocIdsForUser, insertAbRun, findGroupById, listWikiDocs } from "@kb/db";
import { LlmClient } from "@kb/adapters";
import { getDeps } from "../../../lib/kb";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { query, groupId } = await req.json();
    if (!query || typeof query !== "string") return NextResponse.json({ error: "缺少 query" }, { status: 400 });

    // 两栏共用同一个 LLM 后端 + 同一个模型，否则模型与链路两个变量同时变，A/B 失效。
    // getDeps() 默认返回豆包（ArkLlmClient，不支持 runTools），这里显式构造 302/Claude 客户端。
    // /chat 生产链路仍走 getDeps() 的默认后端，不受影响。
    //
    // ⚠️ 必须显式指定模型：KB_MODEL_ANSWER 是两个后端共用的变量，真实 .env 里它是
    // doubao-seed-2-0-pro-260215。若不显式覆盖，answer() 会把豆包模型名发到 302 的
    // Anthropic /v1/messages 端点，必然报错。runTools 同理（它读 KB_MODEL_AGENT）。
    const AB_MODEL = process.env.KB_MODEL_AB ?? "claude-opus-4-8";
    const { embedder, reranker } = getDeps();
    const llm = new LlmClient({ answerModel: AB_MODEL });

    // 检索隔离：与 /api/chat 同一信任边界
    const allowed = new Set(await listDocIdsForUser(auth.userId));
    let docIds: string[];
    if (groupId) docIds = (await listDocIdsInGroup(groupId)).filter((id) => allowed.has(id));
    else docIds = [...allowed];
    // 两栏语料范围（必修 3）：先在替换 __none__ 哨兵之前记下真实文档数，作为下方 N/M 的分母 M——
    // A 栏在 docIds 全集上检索，这个数就是 A 栏实际能查到的文档总数。
    const scopeTotal = docIds.length;
    if (docIds.length === 0) docIds = ["__none__"];

    // 客户背景（分组 Agent 用途/补充）：拼装逻辑与 /api/chat 一致，两栏共用同一份文本——
    // 只给 A 栏补背景会变成「A 有背景、B 没有」，等于给对比多引入一个变量。
    // 归属校验不能省：findGroupById 本身不做 userId 过滤。
    let groupContext: string | null = null;
    if (groupId) {
      const group = await findGroupById(groupId);
      if (group?.userId === auth.userId) {
        const parts: string[] = [];
        if (group.agentPurpose) parts.push(`用途：${safeTruncateUtf16(group.agentPurpose, 300)}`);
        if (group.agentNotes) parts.push(`补充：${safeTruncateUtf16(group.agentNotes, 300)}`);
        if (parts.length > 0) groupContext = parts.join("\n");
      }
    }

    const runA = async () => {
      const t0 = Date.now();
      // 参数与 /api/chat 完全一致，保证 A 栏是现状；groupContext 是第 5 个参数，chatTurn 本身未改动
      const r = await chatTurn([], query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docIds }, groupContext);
      return {
        answer: r.answer,
        hits: r.hits.map((h) => ({ id: h.id, score: h.score, heading_path: h.heading_path, content: h.content })),
        ms: Date.now() - t0,
        tokens: (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
      };
    };

    const runB = async () => {
      const t0 = Date.now();
      // 与 A 栏同模型（见上方 AB_MODEL 注释）+ 同一份 groupContext（见上方注释）
      const r = await agentSearch(query, { llm: llm as any, embedder, docIds }, { maxTurns: 12, model: AB_MODEL, groupContext });
      return {
        answer: r.answer,
        trace: r.trace,
        turnsUsed: r.turnsUsed,
        truncated: r.truncated,
        ms: Date.now() - t0,
        tokens: r.tokens.input + r.tokens.output,
      };
    };

    // 两栏语料范围（必修 3）：B 栏 list_docs 实际可见的文档数（wiki_status=ready 且已生成页）。
    // 与 runA/runB 一起并发，不额外拖慢响应；这条查询很快，失败也不该拖垮两次真实 LLM 调用的结果，
    // 所以单独兜底成 null（前端遇 null 就不显示这行提示，不强行画出一个假的 0/M）。
    const scopeVisibleB = async () => (await listWikiDocs(docIds)).length;

    const [ra, rb, rScope] = await Promise.allSettled([runA(), runB(), scopeVisibleB()]);
    const a = ra.status === "fulfilled" ? ra.value : { error: String((ra.reason as any)?.message ?? ra.reason) };
    const bResult = rb.status === "fulfilled" ? rb.value : { error: String((rb.reason as any)?.message ?? rb.reason) };
    const scopeVisible = rScope.status === "fulfilled" ? rScope.value : null;
    // scopeVisible 只挂在 b 上：这是「B 栏能看到几篇文档」的事实，与 B 栏本轮是否成功作答无关——
    // 即便 agentSearch 报错，这条范围提示依然是有效信息（说明失败会不会正是范围太窄导致的）。
    const b = { ...bResult, scopeTotal, scopeVisible };

    const runId = "ab_" + randomUUID().slice(0, 8);
    // insertAbRun 失败不能连累两栏结果：两次真实 LLM 调用（B 栏常见几十秒）已经跑完，
    // 落库只是记录动作，它挂了不该让用户连答案都拿不到（顺带 6）。
    let persisted = true;
    try {
      await insertAbRun({
        id: runId,
        userId: auth.userId,
        groupId: groupId ?? null,
        query,
        aAnswer: (a as any).answer ?? null,
        aHits: (a as any).hits ?? null,
        aMs: (a as any).ms ?? null,
        aTokens: (a as any).tokens ?? null,
        aError: (a as any).error ?? null,
        bAnswer: (bResult as any).answer ?? null,
        bTrace: (bResult as any).trace ?? null,
        bMs: (bResult as any).ms ?? null,
        bTokens: (bResult as any).tokens ?? null,
        bError: (bResult as any).error ?? null,
        aScopeCount: scopeTotal,
        bScopeCount: scopeVisible,
      });
    } catch (e: any) {
      persisted = false;
      console.warn(`/api/ab: insertAbRun 失败，结果仍返回但未落库（runId=${runId}）：${e?.message ?? e}`);
    }

    // 未落库时 runId 传 null：前端凭 runId 是否存在决定要不要显示评分区，没有对应的库内行，
    // 评分按钮点了也只会拿到 404，不如干脆不给这个入口。
    return NextResponse.json({ runId: persisted ? runId : null, a, b, persisted });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
