import "dotenv/config";
import { basename } from "node:path";
import { ClaudeCodeSandboxParser } from "@kb/adapters";

// 里程碑 ① 的最小闭环：拿一个文件 → 自己集成的 Claude Code 沙箱解析 → 打印 Markdown。
// 模型走 302（见 .env 的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）。
// 用法：npm run parse-one -- <文件路径>
const file = process.argv[2];
if (!file) {
  console.error("用法: npm run parse-one -- <文件路径>");
  process.exit(1);
}

const parser = new ClaudeCodeSandboxParser();
const res = await parser.parse({ filePath: file, filename: basename(file) });

console.error(`--- 解析完成 (model=${res.meta.model}, scanned=${res.scanned}) ---`);
console.log(res.markdown);
