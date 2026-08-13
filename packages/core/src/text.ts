/** 按 UTF-16 code unit 截断，若切点恰好落在代理对中间（末字符是孤立的高位代理，
 *  0xD800-0xDBFF 且缺配对的低位代理），回退一位，避免产出裸代理经 UTF-8 序列化后变成 U+FFFD 乱码。
 *
 *  放在 @kb/core 而非 packages/pipeline（原实现所在处）：这个函数零依赖、纯字符串运算，
 *  @kb/core 只依赖 zod、不引入任何 Node-only 模块（fs/jieba/undici 等），是唯一可以安全被
 *  "use client" 组件（如 AbPanel）直接 bundle 进浏览器的位置——pipeline/db/adapters 的
 *  index 桶导出会把 jieba/undici(node: scheme)/fs 等服务端依赖一并拖进客户端打包，
 *  webpack 直接报 Module not found。`packages/pipeline/src/agent-tools.ts` 的同名导出
 *  改为从这里 re-export，服务端调用方（agent-search.ts / /api/ab route.ts 等）行为不变。 */
export function safeTruncateUtf16(s: string, len: number): string {
  const cut = s.slice(0, len);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) return cut.slice(0, -1);
  return cut;
}
