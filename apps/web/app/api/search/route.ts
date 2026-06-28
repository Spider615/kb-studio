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
    const { answer, sources } = await llm.answer(
      query,
      top.map((t) => ({ id: t.id, content: t.content, heading_path: t.heading_path })),
    );
    return NextResponse.json({
      answer,
      sources,
      hits: top.map((t) => ({ id: t.id, score: t.score, heading_path: t.heading_path, content: t.content })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
