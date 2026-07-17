import type {
  MiaodongAdapter,
  MiaodongCredentials,
  PushPayload,
  PushResult,
} from "@kb/core";
import { Agent, fetch as undiciFetch } from "undici";
import { splitForParagraph } from "./split";

/** 直连 dispatcher：秒懂是国内端点，必须绕开可能已被装上的全局代理（installProxyFromEnv 装的 ProxyAgent）。 */
const directDispatcher = new Agent();

/** 规范化用户填的域名为 https://<host>：去协议前缀和结尾斜杠。 */
function normalizeBase(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `https://${d}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 有界重试：瞬时错误（网络抖动 / 5xx / 408 / 429）退避重试；永久错误（其余 4xx，如内容非法）立即抛。
 * sleepFn 注入以便测试。
 */
const RETRYABLE_4XX = new Set([408, 425, 429]); // 408 请求超时、425 too early、429 限流 → 可重试
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = Number(String(e?.message ?? e).match(/HTTP (\d+)/)?.[1]);
      const permanent = status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);
      if (permanent || attempt >= retries) throw e;
      await sleepFn(300 * (attempt + 1));
    }
  }
}

/** 受限并发遍历：收集每项结果，单项失败不中断其他（保留原项顺序）。 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** POST JSON；非 2xx 抛 HTTP 错，响应非 JSON 也抛。 */
async function postJson(url: string, body: unknown, token?: string): Promise<any> {
  const res = await undiciFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    dispatcher: directDispatcher,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON: ${text.slice(0, 200)}`);
  }
}

export interface RealMiaodongOptions {
  concurrency?: number; // 段落并发上限（默认 6）
  retries?: number; // 每次请求瞬时错误的重试次数（默认 3）
}

/**
 * 秒懂推送真实实现：取 token → 建文档 → 并发建段落（每请求带有界重试）。
 * 国内端点（insight.juzibot.com），不调 installProxyFromEnv（代理只给 302 海外端点）。
 * 注：段落并发推送 → 秒懂侧段落顺序为最终一致、非严格入库顺序；chunk 为独立检索单元，顺序不影响检索。
 *     需严格保序时用 `new RealMiaodongAdapter({ concurrency: 1 })`。
 */
export class RealMiaodongAdapter implements MiaodongAdapter {
  constructor(private readonly opts: RealMiaodongOptions = {}) {}

  async push(payload: PushPayload, creds: MiaodongCredentials): Promise<PushResult> {
    const base = normalizeBase(creds.domain);
    const concurrency = Math.max(1, this.opts.concurrency ?? 6);
    const retries = Math.max(0, this.opts.retries ?? 3);
    const paragraphs = payload.chunks.flatMap((c) => splitForParagraph(c.content));
    if (paragraphs.length === 0) {
      throw new Error("没有可推送的段落（文档内容为空）");
    }

    // 1) 取 token（带重试）
    let tokenJson: any;
    try {
      tokenJson = await withRetry(
        () =>
          postJson(`${base}/openapi/get-access-token`, {
            accessKeyId: creds.accessKeyId,
            accessKeySecret: creds.accessKeySecret,
          }),
        retries,
      );
    } catch (e: any) {
      throw new Error(`秒懂取 token 失败: ${e?.message ?? e}`);
    }
    let token = tokenJson?.data?.accessToken;
    if (!token) {
      throw new Error(`秒懂取 token 失败: 响应无 accessToken（${JSON.stringify(tokenJson?.data ?? tokenJson)}）`);
    }
    // token 刷新（in-flight 去重，防并发 worker 同时刷新风暴）——大文档推送耗时超 token TTL 时用
    let refreshing: Promise<void> | null = null;
    const refreshToken = () => {
      if (!refreshing) {
        refreshing = withRetry(
          () => postJson(`${base}/openapi/get-access-token`, { accessKeyId: creds.accessKeyId, accessKeySecret: creds.accessKeySecret }),
          retries,
        )
          .then((j) => { const t = j?.data?.accessToken; if (t) token = t; })
          .finally(() => { refreshing = null; });
      }
      return refreshing;
    };

    // 2) 建文档（不传 metadata；带重试）
    let createJson: any;
    try {
      createJson = await withRetry(
        () =>
          postJson(
            `${base}/openapi/knowledge-base/doc/create`,
            { knowledgeBaseId: creds.knowledgeBaseId, name: payload.title },
            token,
          ),
        retries,
      );
    } catch (e: any) {
      throw new Error(`秒懂建文档失败: ${e?.message ?? e}`);
    }
    const remoteDocId = createJson?.data?.id;
    if (remoteDocId === undefined || remoteDocId === null) {
      throw new Error(`秒懂建文档失败: 响应无 docId（${JSON.stringify(createJson?.data ?? createJson)}）`);
    }

    // 3) 段落：>1000 字符按句切分 → 有界并发推送、每请求带重试；单段永久失败不中断其他，最后汇总
    const paraUrl = `${base}/openapi/knowledge-base/doc/paragraph/create`;
    const idErr = (pjson: any): string | null =>
      pjson?.data?.id === undefined || pjson?.data?.id === null
        ? `响应无段落 id（${JSON.stringify(pjson?.data ?? pjson)}）`
        : null;
    const results = await mapLimit(paragraphs, concurrency, async (content) => {
      const body = { knowledgeBaseId: creds.knowledgeBaseId, docId: remoteDocId, content };
      try {
        return idErr(await withRetry(() => postJson(paraUrl, body, token), retries));
      } catch (e: any) {
        // token 过期(401) → 刷新一次后重试该段（其余错误直接记为失败）
        if (/HTTP 401/.test(String(e?.message ?? e))) {
          try {
            await refreshToken();
            return idErr(await postJson(paraUrl, body, token));
          } catch (e2: any) {
            return String(e2?.message ?? e2);
          }
        }
        return String(e?.message ?? e);
      }
    });
    const failures = results.filter((r): r is string => r !== null);
    const pushed = paragraphs.length - failures.length;
    if (failures.length) {
      // 部分失败 → best-effort 删除已建的半份文档，避免留孤儿（重试整篇会累积重复文档）。
      // 若删除也失败（如 token 已过期）→ 如实告知残留 docId，别谎报已回滚
      let rolledBack = false;
      try {
        await postJson(`${base}/openapi/knowledge-base/doc/delete`, { knowledgeBaseId: creds.knowledgeBaseId, docId: remoteDocId }, token);
        rolledBack = true;
      } catch { /* 忽略删除异常，不掩盖原始推送错误 */ }
      const uniq = [...new Set(failures)];
      const rb = rolledBack ? "已回滚删除文档" : `回滚删除亦失败，可能残留孤儿文档 docId=${remoteDocId}`;
      throw new Error(
        `秒懂建段落失败（成功 ${pushed}/${paragraphs.length}，${failures.length}段/${uniq.length}类，${rb}）: ${uniq.slice(0, 3).join(" | ")}${uniq.length > 3 ? " …" : ""}`,
      );
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
