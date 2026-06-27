import http from "node:http";
import { request as undiciRequest, ProxyAgent, Agent, type Dispatcher } from "undici";

/**
 * 302 网关不支持（会 403「Parameter error」）的 anthropic-beta 值。
 * 新版 Claude Code 二进制（claude-cli ≥2.1 / agent-sdk ≥0.3）会硬编码下发一组 beta，
 * 其中下面这些 302 的 /v1/messages 透传不认；302 对 anthropic-beta 严格校验，遇到任一未知值整条 403。
 * 这里只剥离 denylist，保留 302 已支持的（claude-code-20250219 / interleaved-thinking-2025-05-14 /
 * context-management-2025-06-27）。302 以后支持了就从这里删；Claude Code 再加新 beta 被拒就往这里加。
 */
export const UNSUPPORTED_ANTHROPIC_BETAS = new Set([
  "thinking-token-count-2026-05-13",
  "prompt-caching-scope-2026-01-05",
  "advisor-tool-2026-03-01",
]);

function sanitizeBeta(value: string | string[] | undefined): string | undefined {
  if (value == null) return undefined;
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !UNSUPPORTED_ANTHROPIC_BETAS.has(s))
    .join(",");
}

export interface BetaSanitizingProxy {
  url: string;
  close: () => Promise<void>;
}

/**
 * 进程内反向代理：监听 127.0.0.1 临时端口，把进来的请求里 anthropic-beta 头中 302 不支持的 beta 剥掉，
 * 再经 Clash(HTTPS_PROXY) 转发到真实 upstream（默认 https://api.302.ai）。
 * 解析时把 Claude Code 子进程的 ANTHROPIC_BASE_URL 指到这里，绕过二进制硬编码的不兼容 beta。
 * 注意：子进程必须设 NO_PROXY=127.0.0.1，否则它会把对本地代理的请求经 Clash 隧道出去。
 */
export async function startBetaSanitizingProxy(opts: {
  upstream: string;
  proxyUrl?: string;
}): Promise<BetaSanitizingProxy> {
  const upstream = opts.upstream.replace(/\/$/, "");
  const proxyUrl =
    opts.proxyUrl ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    "";
  const dispatcher: Dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v == null) continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "content-length" || lower === "connection") continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      const beta = sanitizeBeta(req.headers["anthropic-beta"]);
      if (beta) headers["anthropic-beta"] = beta;
      else delete headers["anthropic-beta"];

      try {
        const up = await undiciRequest(upstream + (req.url ?? ""), {
          method: (req.method as Dispatcher.HttpMethod) ?? "POST",
          headers,
          body: body.length ? body : undefined,
          dispatcher,
        });
        res.writeHead(up.statusCode, up.headers as http.OutgoingHttpHeaders);
        for await (const c of up.body) res.write(c);
        res.end();
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: `beta-sanitizing-proxy upstream error: ${e?.message ?? e}` } }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
