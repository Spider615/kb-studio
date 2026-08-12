import http from "node:http";
import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import {
  StreamConverter,
  anthropicToOpenAI,
  openAIToAnthropicMessage,
  flattenSystem,
} from "./anthropic-openai-convert";

export interface ArkAnthropicProxy {
  url: string;
  close: () => Promise<void>;
}

export interface ArkAnthropicProxyOptions {
  /** 方舟 base，默认 https://ark.cn-beijing.volces.com/api/v3 */
  arkBaseUrl?: string;
  /** 方舟 key，默认读 ARK_API_KEY */
  apiKey?: string;
  /** 目标豆包模型；Agent SDK 传来的 claude-* 一律被覆盖。默认读 KB_MODEL_PARSE_ARK */
  model?: string;
  /** 心跳间隔（毫秒）。Anthropic 客户端对 ANTHROPIC_BASE_URL 连接有静默看门狗，长时间无字节会断。 */
  pingIntervalMs?: number;
}

/**
 * 进程内反向代理：对外说 **Anthropic Messages 协议**，对内转成 **OpenAI 协议**打火山方舟。
 *
 * 为什么需要它：解析层用 @anthropic-ai/claude-agent-sdk 在容器里跑 Claude Code，
 * 而这个 SDK 只支持 Anthropic Messages / Bedrock / Vertex 三种协议——没有 OpenAI 那一行，
 * 所以「把 ANTHROPIC_BASE_URL 指到方舟 /api/v3」是不通的。这里补上缺的那一层。
 *
 * 设计要点（都是踩过的坑，别随手改）：
 *  - **必须流式转发**：缓冲整包再吐会让客户端 stall；
 *  - **必须定期发 ping**：Anthropic 客户端对 base-url 连接有静默字节看门狗，
 *    模型思考期间没有任何字节会被判死；
 *  - **anthropic-beta / x-api-key 一律不转发**：那是给 Anthropic 的，方舟不认（原
 *    beta-sanitizing-proxy 是"剥掉不支持的 beta 再转给真 Claude"，这里的方向正好相反）；
 *  - **错误体尽量原样透传**：Claude Code 靠匹配上游报错文案决定重试/禁用能力。
 *
 * 与 beta-sanitizing-proxy 的分工：那个用于「仍然打真 Claude（302）」的场景，
 * 只改 header；这个用于「改打豆包」，做全量协议翻译。两者互斥，按 KB_MODEL_PARSE 选。
 */
export async function startArkAnthropicProxy(
  opts: ArkAnthropicProxyOptions = {},
): Promise<ArkAnthropicProxy> {
  const arkBase = (opts.arkBaseUrl ?? process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3")
    .replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.ARK_API_KEY ?? "";
  const targetModel =
    opts.model ?? process.env.KB_MODEL_PARSE_ARK ?? "doubao-seed-2-0-code-preview-260215";
  const pingMs = opts.pingIntervalMs ?? 15_000;
  // 火山是国内端点：这里显式用不带代理的 Agent，避免被进程级 ProxyAgent 拽去走 Clash
  const dispatcher: Dispatcher = new Agent();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d as Buffer));
    req.on("end", () => {
      void handle(Buffer.concat(chunks));
    });

    async function handle(raw: Buffer) {
      const url = req.url ?? "";
      let body: any = {};
      try {
        body = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
      } catch {
        return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "请求体不是合法 JSON" } });
      }

      // token 计数：Agent SDK 会调它来做上下文预算。方舟没有对等接口，给个够用的估算
      // （偏保守：宁可高估让 SDK 提前压缩，也别低估导致真实请求超限）。
      if (url.includes("count_tokens")) {
        return sendJson(res, 200, { input_tokens: estimateTokens(body) });
      }
      if (!url.includes("/v1/messages")) {
        return sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `不支持的路径 ${url}` } });
      }

      const oaBody = anthropicToOpenAI(body, { targetModel });
      const wantStream = !!body?.stream;

      let up;
      try {
        up = await undiciRequest(`${arkBase}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(oaBody),
          dispatcher,
          headersTimeout: 300_000,
          bodyTimeout: 600_000,
        });
      } catch (e: any) {
        return sendJson(res, 502, {
          type: "error",
          error: { type: "api_error", message: `ark-anthropic-proxy 连接方舟失败: ${e?.message ?? e}` },
        });
      }

      // 上游报错：原样把方舟的错误体透出去（外层能看到真实原因，不要包一层自己的信封）
      if (up.statusCode >= 400) {
        const text = await up.body.text();
        res.writeHead(up.statusCode, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `方舟返回 ${up.statusCode}: ${text.slice(0, 800)}` },
          }),
        );
      }

      if (!wantStream) {
        const json = (await up.body.json()) as any;
        return sendJson(res, 200, openAIToAnthropicMessage(json, targetModel));
      }

      // ---- 流式：OpenAI SSE → Anthropic SSE ----
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const conv = new StreamConverter(`msg_${Date.now().toString(36)}`, targetModel);
      writeEvents(res, conv.start());

      // 心跳：模型思考期间上游可能长时间无字节，客户端看门狗会掐断连接
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write("event: ping\ndata: {\"type\":\"ping\"}\n\n");
      }, pingMs);

      let buf = "";
      try {
        for await (const part of up.body) {
          buf += Buffer.from(part).toString("utf-8");
          // SSE 以空行分帧；最后一段可能不完整，留在 buf 里等下次
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            for (const line of frame.split("\n")) {
              const s = line.trim();
              if (!s.startsWith("data:")) continue;
              const payload = s.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                writeEvents(res, conv.chunk(JSON.parse(payload)));
              } catch {
                /* 单帧解析失败不该终止整条流，跳过即可 */
              }
            }
          }
        }
        writeEvents(res, conv.finish());
      } catch (e: any) {
        // 流中断：补一个 error 事件让客户端知道，而不是静默截断（截断会被当成正常结束）
        if (!res.writableEnded) {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: `上游流中断: ${e?.message ?? e}` },
            })}\n\n`,
          );
        }
      } finally {
        clearInterval(ping);
        if (!res.writableEnded) res.end();
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function writeEvents(res: http.ServerResponse, events: Array<{ event: string; data: unknown }>): void {
  for (const e of events) {
    if (res.writableEnded) return;
    res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  }
}

/**
 * 粗估 token 数（方舟无 count_tokens 对等接口）。
 * CJK 约 1 字 1 token，其余按 ~4 字符 1 token；整体上浮 15% 留安全边际。
 */
function estimateTokens(body: any): number {
  let text = flattenSystem(body?.system);
  for (const m of body?.messages ?? []) {
    const c = m?.content;
    if (typeof c === "string") text += c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "text") text += b.text ?? "";
        else if (b?.type === "tool_use") text += JSON.stringify(b.input ?? {});
        else if (b?.type === "tool_result") text += typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      }
    }
  }
  let cjk = 0;
  for (const ch of text) {
    const o = ch.codePointAt(0) ?? 0;
    if (o >= 0x3000 && o <= 0x9fff) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil((cjk + rest / 4) * 1.15);
}
