import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let installed = false;

/**
 * 直连白名单：这些 host 不走代理。
 *
 * 火山方舟是国内端点，实测直连 73~85ms；若被塞进 Clash 隧道会出海再回国，既慢又可能
 * 因出口 IP 变成境外而触发 API Key 的 IP 限制。国内服务一律加到这里。
 *
 * ⚠️ 形式很讲究：undici 对**不以 `.` 或 `*` 开头**的条目只做**精确匹配**
 * （见 undici/lib/dispatcher/env-http-proxy-agent.js 的 #shouldProxy）。
 * 也就是说裸写 `volces.com` 匹配不到 `ark.cn-beijing.volces.com`，子域必须写成 `.volces.com`。
 * 这里两种都列：裸域走精确匹配，带点的覆盖所有子域。
 */
const DIRECT_HOSTS = [
  "volces.com",
  ".volces.com", // 方舟 ark.cn-beijing.volces.com / 知识库 api-knowledgebase.mlp.…
  "volcengineapi.com",
  ".volcengineapi.com",
  "localhost",
  "127.0.0.1",
];

function noProxyList(): string {
  const inherited = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const extra = (process.env.KB_NO_PROXY_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...inherited, ...DIRECT_HOSTS, ...extra])].join(",");
}

/**
 * 若环境里有代理（HTTPS_PROXY / https_proxy / ALL_PROXY …），给 Node 全局 fetch 装上 undici 代理，
 * 但对 DIRECT_HOSTS 里的国内端点直连。幂等，多次调用只装一次。
 *
 * 为什么必须按 host 分流：setGlobalDispatcher 是**进程级**的，一旦装上 ProxyAgent，同进程里
 * 所有 fetch 都会被塞进代理，组件自己躲不开。而本项目正好是混合的——302 海外端点必须走
 * Clash，火山国内端点必须不走。EnvHttpProxyAgent 原生支持 noProxy，故用它而非裸 ProxyAgent。
 */
export function installProxyFromEnv(): string | null {
  if (installed) return null;
  const url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
  if (!url) return null;
  setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url, noProxy: noProxyList() }));
  installed = true;
  return url;
}

/** 供单测/诊断：某 host 是否会绕过代理直连（复刻 undici 的匹配规则）。 */
export function willBypassProxy(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return noProxyList()
    .split(",")
    .filter(Boolean)
    .some((entry) =>
      /^[.*]/.test(entry) ? h.endsWith(entry.replace(/^\*/, "")) : h === entry,
    );
}
