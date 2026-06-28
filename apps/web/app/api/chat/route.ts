import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatTurn, type ChatMessage } from "@kb/pipeline";
import {
  getConversation,
  getMessages,
  insertMessages,
  touchConversation,
  listDocIdsInGroup,
  listDocIdsForUser,
} from "@kb/db";
import { getDeps } from "../../../lib/kb";
import { resolveAuth } from "../../../lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const { conversationId, query } = await req.json();
    if (!conversationId || !query)
      return NextResponse.json({ error: "缺少 conversationId 或 query" }, { status: 400 });

    const conv = await getConversation(conversationId);
    if (!conv || conv.userId !== auth.userId)
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });

    const prior = await getMessages(conversationId);
    const history: ChatMessage[] = prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const { llm, embedder, reranker } = getDeps();

    // 检索隔离：先取本人全部文档 id，再按会话 scope 收窄，全程不越权
    const allowed = new Set(await listDocIdsForUser(auth.userId));
    let docIds: string[];
    if (conv.scopeGroupId) {
      docIds = (await listDocIdsInGroup(conv.scopeGroupId)).filter((id) => allowed.has(id));
    } else if (conv.scopeDocId) {
      docIds = allowed.has(conv.scopeDocId) ? [conv.scopeDocId] : [];
    } else {
      docIds = [...allowed];
    }
    if (docIds.length === 0) docIds = ["__none__"]; // 零命中而非退回全库

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

    const title = history.length === 0 ? query.slice(0, 20) : undefined;
    await touchConversation(conversationId, title);

    return NextResponse.json({ answer: r.answer, sources: r.sources, hits, title: title ?? conv.title });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
