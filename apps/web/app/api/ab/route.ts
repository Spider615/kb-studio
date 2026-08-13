import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatTurn, agentSearch, safeTruncateUtf16 } from "@kb/pipeline";
import { listDocIdsInGroup, listDocIdsForUser, insertAbRun, findGroupById } from "@kb/db";
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

    const [ra, rb] = await Promise.allSettled([runA(), runB()]);
    const a = ra.status === "fulfilled" ? ra.value : { error: String((ra.reason as any)?.message ?? ra.reason) };
    const b = rb.status === "fulfilled" ? rb.value : { error: String((rb.reason as any)?.message ?? rb.reason) };

    const runId = "ab_" + randomUUID().slice(0, 8);
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
      bAnswer: (b as any).answer ?? null,
      bTrace: (b as any).trace ?? null,
      bMs: (b as any).ms ?? null,
      bTokens: (b as any).tokens ?? null,
      bError: (b as any).error ?? null,
    });

    return NextResponse.json({ runId, a, b });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
