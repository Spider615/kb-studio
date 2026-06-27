import type {
  MiaodongAdapter,
  MiaodongCredentials,
  PushPayload,
  PushResult,
} from "@kb/core";
import { splitForParagraph } from "./split";

/** 规范化用户填的域名为 https://<host>：去协议前缀和结尾斜杠。 */
function normalizeBase(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `https://${d}`;
}

/** POST JSON；非 2xx 抛 HTTP 错，响应非 JSON 也抛。 */
async function postJson(url: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * 秒懂推送真实实现：取 token → 建文档 → 顺序建段落。
 * 国内端点（insight.juzibot.com），不调 installProxyFromEnv（代理只给 302 海外端点）。
 */
export class RealMiaodongAdapter implements MiaodongAdapter {
  async push(payload: PushPayload, creds: MiaodongCredentials): Promise<PushResult> {
    const base = normalizeBase(creds.domain);

    // 1) 取 token
    let tokenJson: any;
    try {
      tokenJson = await postJson(`${base}/openapi/get-access-token`, {
        accessKeyId: creds.accessKeyId,
        accessKeySecret: creds.accessKeySecret,
      });
    } catch (e: any) {
      throw new Error(`秒懂取 token 失败: ${e?.message ?? e}`);
    }
    const token = tokenJson?.data?.accessToken;
    if (!token) {
      throw new Error(`秒懂取 token 失败: 响应无 accessToken（${JSON.stringify(tokenJson?.data ?? tokenJson)}）`);
    }

    // 2) 建文档（不传 metadata）
    let createJson: any;
    try {
      createJson = await postJson(
        `${base}/openapi/knowledge-base/doc/create`,
        { knowledgeBaseId: creds.knowledgeBaseId, name: payload.title },
        token,
      );
    } catch (e: any) {
      throw new Error(`秒懂建文档失败: ${e?.message ?? e}`);
    }
    const remoteDocId = createJson?.data?.id;
    if (remoteDocId === undefined || remoteDocId === null) {
      throw new Error(`秒懂建文档失败: 响应无 docId（${JSON.stringify(createJson?.data ?? createJson)}）`);
    }

    // 3) 段落：上下文化 content，>1000 字符按句切分，顺序推送（保序）
    const paragraphs = payload.chunks.flatMap((c) => splitForParagraph(c.content));
    let pushed = 0;
    for (const content of paragraphs) {
      try {
        await postJson(
          `${base}/openapi/knowledge-base/doc/paragraph/create`,
          { knowledgeBaseId: creds.knowledgeBaseId, docId: remoteDocId, content },
          token,
        );
      } catch (e: any) {
        throw new Error(
          `秒懂建段落失败（已成功 ${pushed}/${paragraphs.length}）: ${e?.message ?? e}`,
        );
      }
      pushed++;
    }

    return {
      ok: true,
      pushed,
      target: "miaodong",
      remoteDocId: String(remoteDocId),
      knowledgeBaseId: creds.knowledgeBaseId,
    };
  }
}
