import { NextResponse } from "next/server";
import { retrieve } from "@kb/pipeline";
import { listDocIdsForUser } from "@kb/db";
import { getDeps } from "../../../lib/kb";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { query } = await req.json();
    if (!query) return NextResponse.json({ error: "缺少 query" }, { status: 400 });

    const allowed = await listDocIdsForUser(auth.userId);
    const docIds = allowed.length ? allowed : ["__none__"]; // 无文档 → 零命中

    const { llm, embedder, reranker } = getDeps();
    const top = await retrieve(query, { embedder, reranker }, { topK: 4, poolN: 10, docIds });
    // 零命中：不调 LLM（空上下文会被网关拒），直接返回友好空答案
    if (top.length === 0) {
      return NextResponse.json({ answer: "没有找到相关内容。", sources: [], hits: [] });
    }
    const { answer, sources } = await llm.answer(
      query,
      top.map((t) => ({ id: t.id, content: t.content, heading_path: t.heading_path })),
    );
    return NextResponse.json({
      answer,
      sources,
      // 邻居扩展块只作上下文喂 LLM，不计入对外展示的「命中片段」
      hits: top
        .filter((t) => t.via !== "neighbor")
        .map((t) => ({ id: t.id, score: t.score, heading_path: t.heading_path, content: t.content })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
