/** @type {import('next').NextConfig} */
const nextConfig = {
  // 编译 workspace TS 包
  transpilePackages: ["@kb/core", "@kb/adapters", "@kb/db", "@kb/pipeline"],
  // 原生/重依赖保持外部（不打包），运行时在 Node 加载
  serverExternalPackages: [
    "@anthropic-ai/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "@node-rs/jieba",
    "postgres",
    "undici",
    "drizzle-orm",
  ],
};
export default nextConfig;
