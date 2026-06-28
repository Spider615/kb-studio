import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatTurn, type ChatMessage } from "@kb/pipeline";
import { getConversation, getMessages, insertMessages, touchConversation, listDocIdsInGroup } from "@kb/db";
import { getDeps } from "../../../lib/kb";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const { conversationId, query } = await req.json();
    if (!conversationId || !query)
      return NextResponse.json({ error: "缺少 conversationId 或 query" }, { status: 400 });

    const conv = await getConversation(conversationId);
    if (!conv) return NextResponse.json({ error: "会话不存在" }, { status: 400 });

    // 取本次之前的历史（决定是否首轮 + 是否改写）
    const prior = await getMessages(conversationId);
    const history: ChatMessage[] = prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const { llm, embedder, reranker } = getDeps();
    // 检索范围：优先分组（展开成组内全部 docId），否则单篇，否则全库
    let docIds: string[] | undefined;
    if (conv.scopeGroupId) {
      docIds = await listDocIdsInGroup(conv.scopeGroupId);
      // 空分组：限定到一个不存在的 id → 零命中，而不是退回全库（否则「限定到该组」会变成搜全库）
      if (docIds.length === 0) docIds = ["__empty_group__"];
    } else if (conv.scopeDocId) {
      docIds = [conv.scopeDocId];
    }
    const r = await chatTurn(history, query, { llm, embedder, reranker }, { topK: 4, poolN: 10, docIds });

    const hits = r.hits.map((h) => ({
      id: h.id,
      score: h.score,
      heading_path: h.heading_path,
      content: h.content,
    }));

    await insertMessages([
      { id: "msg_" + randomUUID().slice(0, 8), conversationId, role: "user", content: query },
      {
        id: "msg_" + randomUUID().slice(0, 8),
        conversationId,
        role: "assistant",
        content: r.answer,
        sources: r.sources,
        hits,
      },
    ]);

    // 首轮把 title 设为问题前 20 字
    const title = history.length === 0 ? query.slice(0, 20) : undefined;
    await touchConversation(conversationId, title);

    return NextResponse.json({ answer: r.answer, sources: r.sources, hits, title: title ?? conv.title });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
