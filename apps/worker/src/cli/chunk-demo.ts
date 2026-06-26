import { chunkMarkdown } from "@kb/core";

// 离线验证 chunker：标题层级 + 表格 + 一个超长段落（强制触发大小兜底 + overlap）。
const longBody =
  "申请时需提供订单号、购买凭证以及退款原因说明。客服将在收到申请后的三个工作日内完成审核。".repeat(40);

const md = `# 用户服务协议

本协议是平台与用户之间的约定，适用于所有注册用户。请在使用前仔细阅读。

## 第五章 退款政策

### 5.1 时限要求

退款申请需在购买后 7 日内提交。逾期视为自动放弃。${longBody}审核通过后款项原路退回。

### 5.2 适用范围

| 商品类型 | 是否支持退款 | 时限 |
| --- | --- | --- |
| 实物商品 | 支持 | 7 日 |
| 虚拟商品 | 不支持 | — |
| 服务类 | 部分支持 | 3 日 |

虚拟商品一经售出不予退款，除非存在质量问题。

## 第六章 隐私条款

我们重视用户隐私，仅在必要范围内收集信息，绝不向第三方出售。
`;

const chunks = chunkMarkdown({ docId: "doc_demo", docTitle: "用户服务协议", markdown: md });

console.log(`共 ${chunks.length} 个 chunk\n`);
for (const c of chunks) {
  console.log(`── ${c.id}  [${c.chunk_type}]  ~${c.token_estimate} tok  | ${c.metadata.heading_path.join(" > ") || "(根)"}`);
  console.log(`   "${c.content.replace(/\n+/g, " ").slice(0, 70)}…"`);
}

// 任意 a 的 n 字窗口是否出现在 b
function shareWindow(a: string, b: string, n: number): boolean {
  for (let i = 0; i + n <= a.length; i++) if (b.includes(a.slice(i, i + n))) return true;
  return false;
}

const fiveOne = chunks.filter((c) => c.metadata.heading_path.at(-1) === "5.1 时限要求");
const splitOk = fiveOne.length >= 2; // 超长节被切成多块
const overlapOk = fiveOne.length >= 2 && shareWindow(fiveOne[0]!.content.slice(-120), fiveOne[1]!.content.slice(0, 200), 15);
const tableHolders = chunks.filter((c) => ["实物商品", "虚拟商品", "服务类"].every((r) => c.content.includes(r)));
const tableOk = tableHolders.length === 1; // 表格三行完整在同一个 chunk
const sizeOk = chunks.every((c) => c.token_estimate <= 900); // 都在 max 附近以内
const headingOk = chunks.every((c) => c.metadata.heading_path.length > 0);

console.log(
  `\n断言: split=${splitOk} overlap=${overlapOk} tableIntact=${tableOk} size=${sizeOk} heading=${headingOk}`,
);
const ok = splitOk && overlapOk && tableOk && sizeOk && headingOk;
console.log(ok ? "✅ 全部通过" : "❌ 有失败");
process.exit(ok ? 0 : 1);
