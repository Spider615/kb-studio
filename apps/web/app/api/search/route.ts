import { NextResponse } from "next/server";
import { retrieve } from "@kb/pipeline";
import { getDeps } from "../../../lib/kb";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const { query } = await req.json();
    if (!query) return NextResponse.json({ error: "缺少 query" }, { status: 400 });

    const { llm, embedder, reranker } = getDeps();
    const top = await retrieve(query, { embedder, reranker }, { topK: 4, poolN: 10 });
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
