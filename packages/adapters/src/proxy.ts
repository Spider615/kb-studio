import { ProxyAgent, setGlobalDispatcher } from "undici";

let installed = false;

/**
 * 若环境里有代理（HTTPS_PROXY / https_proxy / ALL_PROXY …），给 Node 全局 fetch 装上 undici 代理。
 * 直连 302 的海外端点需要走代理；容器里不设这些变量则直连。幂等，多次调用只装一次。
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
  setGlobalDispatcher(new ProxyAgent(url));
  installed = true;
  return url;
}
