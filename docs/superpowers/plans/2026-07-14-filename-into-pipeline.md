# 文件名接进处理管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让文件名参与上下文化（把品牌/公司/时间等归属织进每个 chunk 并进向量），并在容器解析时把真实文件名作为语义提示告诉模型。

**Architecture:** 单一机制——上下文化独占「来源 + 归属」，`contextualize` 拿到文件名、输出即完整前缀；无 LLM 时（大表/LLM 空）由纯函数 `resolveChunkPrefix` 退确定性 `《文件名》· 章节`。解析侧经 env `KB_ORIGINAL_FILENAME` 把原始名传进容器，`buildPrompt` 作独立语义提示（磁盘定位名仍是 `input.<ext>`，不碰安全归一）。

**Tech Stack:** TypeScript / Node 18 / npm workspaces；`@anthropic-ai/sdk`（302 网关）；测试 `node:test` + tsx。

## Global Constraints

- 中文注释 + 中文用户文案，代码标识符英文。
- 测试运行命令：`node --import tsx --test <文件绝对或相对路径>`（在仓库根目录跑；`.env` 已含 `DATABASE_URL`，postgres-js 懒连接，纯函数测试不触发连库）。
- 纯函数单测放 `*.test.ts`（连库的才叫 `*.integration.test.ts`）——本计划全是纯函数，不连库、不起容器。
- `contextualize` 新签名 `(fullDoc, chunk, title?, model?)`：`title` 插在 `model` 前，现有 2 参调用方（`ingest.ts`、`enrich-demo.ts`）不受影响。
- 前缀格式保留扩展名：`《<完整文件名含扩展名>》`；确定性兜底 = `《文件名》${heading ? " · " + heading.join(" · ") : ""}`。
- 每个任务 TDD：先写失败测试 → 跑挂 → 最小实现 → 跑过 → 提交。
- 分支已在 `feat/filename-into-pipeline`，直接在其上提交。

---

### Task 1: 上下文化喂文件名 + 归属补全（`buildContextualizeContent` / `contextualize`）

**Files:**
- Modify: `packages/adapters/src/llm/llm-client.ts`（新增导出 `buildContextualizeContent`；改 `contextualize` 签名与 system 提示）
- Test: `packages/adapters/src/llm/llm-client.test.ts`（扩充）

**Interfaces:**
- Produces:
  - `export function buildContextualizeContent(fullDoc: string, chunk: string, title?: string): Anthropic.TextBlockParam[]` —— 返回 `messages[0].content` 的两块文本：第 0 块（带 `cache_control`）= 可缓存文档块（含 `《title》` 当 title 存在），第 1 块 = 含「归属补全」的说明指令 + `<chunk>`。
  - `contextualize(fullDoc: string, chunk: string, title?: string, model?: string): Promise<string>`（签名变更）。

- [ ] **Step 1: 写失败测试**

在 `packages/adapters/src/llm/llm-client.test.ts` 顶部把 import 改为同时引入 `buildContextualizeContent`，并在文件末尾追加测试：

```ts
import { buildAnswerSystemPrompt, buildContextualizeContent } from "./llm-client";
```

```ts
test("buildContextualizeContent 传 title：可缓存块含《title》+cache_control，第二块含归属补全", () => {
  const content = buildContextualizeContent("整份文档正文XYZ", "某片段ABC", "2022年-精骐&捷美-产品价格表.csv");
  const first = content[0] as any;
  assert.ok(first.text.includes("《2022年-精骐&捷美-产品价格表.csv》"));
  assert.ok(first.text.includes("<document>"));
  assert.ok(first.text.includes("整份文档正文XYZ"));
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
  const second = content[1] as any;
  assert.ok(second.text.includes("<chunk>"));
  assert.ok(second.text.includes("某片段ABC"));
  assert.ok(second.text.includes("归属"));
});

test("buildContextualizeContent 不传 title：可缓存块无标题行、无《》（向后兼容）", () => {
  const content = buildContextualizeContent("正文", "片段");
  const first = content[0] as any;
  assert.ok(first.text.startsWith("<document>"));
  assert.ok(!first.text.includes("《"));
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test packages/adapters/src/llm/llm-client.test.ts`
Expected: FAIL，报 `buildContextualizeContent` 不是导出/未定义。

- [ ] **Step 3: 最小实现**

在 `packages/adapters/src/llm/llm-client.ts` 新增导出纯函数（放在 `LlmClient` 类之前或之后皆可，建议紧邻 `buildAnswerSystemPrompt`）：

```ts
/** 上下文化的 user content（两块文本）：可缓存文档块（含标题）+ 含「归属补全」的说明指令。纯函数，便于单测。 */
export function buildContextualizeContent(
  fullDoc: string,
  chunk: string,
  title?: string,
): Anthropic.TextBlockParam[] {
  const docText = title
    ? `文档标题/来源文件：《${title}》\n\n<document>\n${fullDoc}\n</document>`
    : `<document>\n${fullDoc}\n</document>`;
  return [
    { type: "text", text: docText, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: [
        "请阅读上述完整文档，为下面片段生成上下文说明（来源定位 + 归属补全 + 核心对象/时间 + 指代消解）：",
        "归属补全：若片段本身没写明所属品牌/公司/时间等，而文档标题/文件名里有，就在描述中补上（例：价格表某行没写品牌，则从文件名补出该品牌）。自然融入即可，不必照抄完整文件名/扩展名。",
        "<chunk>",
        chunk,
        "</chunk>",
      ].join("\n"),
    },
  ];
}
```

把现有 `contextualize` 方法整体替换为：

```ts
  /** 上下文化：给一个 chunk 生成 50~100 字上下文前缀；整份文档 + 文件名走 prompt caching。
   *  title 存在时会喂给模型，并要求它在片段缺归属（品牌/公司/时间）时从文件名补出。 */
  async contextualize(fullDoc: string, chunk: string, title?: string, model?: string): Promise<string> {
    const res = await this.client.messages.create({
      model: model ?? this.defaultModel,
      max_tokens: 300,
      system:
        "你为 RAG 检索生成 chunk 的上下文描述。只输出描述本身：50~100 字、单段、不要『该片段…』之类前缀或解释。若片段缺品牌/公司/时间等归属而文档标题里有，请补进描述。",
      messages: [{ role: "user", content: buildContextualizeContent(fullDoc, chunk, title) }],
    });
    return firstText(res);
  }
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `node --import tsx --test packages/adapters/src/llm/llm-client.test.ts`
Expected: PASS（原 2 个 + 新 2 个测试全过）。

Run: `npm run typecheck`
Expected: 无报错。（注意：tsx 只剥类型不校验，故必须跑 typecheck 才能验证 `Anthropic.TextBlockParam` 返回类型无误；若该类型名在当前 SDK 版本不可用而报错，退回 `any[]` 即可。）

- [ ] **Step 5: 提交**

```bash
git add packages/adapters/src/llm/llm-client.ts packages/adapters/src/llm/llm-client.test.ts
git commit -m "feat(llm): contextualize 喂文件名 + 归属补全（buildContextualizeContent）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 入库单一前缀机制（`resolveChunkPrefix` + wire `ingestDoc`）

**Files:**
- Modify: `packages/pipeline/src/ingest.ts`（新增导出 `resolveChunkPrefix`；删局部 `deterministicPrefix` 闭包；改主循环传 title + 用 `resolveChunkPrefix`）
- Test: `packages/pipeline/src/ingest.test.ts`（新建）

**Interfaces:**
- Consumes: `contextualize(fullDoc, chunk, title?, model?)`（Task 1）。
- Produces: `export function resolveChunkPrefix(llmPrefix: string | null | undefined, title: string, headingPath: string[]): string` —— LLM 织入优先，空/纯空白退确定性 `《title》· heading`。

- [ ] **Step 1: 写失败测试**

新建 `packages/pipeline/src/ingest.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChunkPrefix } from "./ingest";

test("resolveChunkPrefix：LLM 织入结果优先，原样返回", () => {
  assert.equal(
    resolveChunkPrefix("精骐&捷美2022年产品价格表中，产品A", "2022年-精骐&捷美-产品价格表.csv", ["Sheet1"]),
    "精骐&捷美2022年产品价格表中，产品A",
  );
});

test("resolveChunkPrefix：LLM 空串/null → 确定性《文件名》· 章节（含文件名）", () => {
  assert.equal(resolveChunkPrefix("", "报表.csv", ["Sheet1", "华东区"]), "《报表.csv》 · Sheet1 · 华东区");
  assert.equal(resolveChunkPrefix(null, "报表.csv", ["Sheet1", "华东区"]), "《报表.csv》 · Sheet1 · 华东区");
});

test("resolveChunkPrefix：无 heading_path → 只有《文件名》", () => {
  assert.equal(resolveChunkPrefix(null, "报表.csv", []), "《报表.csv》");
});

test("resolveChunkPrefix：纯空白 LLM 结果视为空，退兜底", () => {
  assert.equal(resolveChunkPrefix("   ", "报表.csv", []), "《报表.csv》");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test packages/pipeline/src/ingest.test.ts`
Expected: FAIL，报 `resolveChunkPrefix` 未导出/未定义。

- [ ] **Step 3: 最小实现 + 接线**

在 `packages/pipeline/src/ingest.ts`，`ingestDoc` 函数外（模块级）新增导出：

```ts
/** 决定 chunk 最终上下文前缀：LLM 织入优先，空/纯空白退确定性《文件名》· 章节（仍带文件名）。纯函数，便于单测。 */
export function resolveChunkPrefix(
  llmPrefix: string | null | undefined,
  title: string,
  headingPath: string[],
): string {
  const deterministic = `《${title}》${headingPath.length ? " · " + headingPath.join(" · ") : ""}`;
  return llmPrefix && llmPrefix.trim() ? llmPrefix : deterministic;
}
```

删除 `ingestDoc` 内的局部闭包（现有代码）：

```ts
  const deterministicPrefix = (c: (typeof chunks)[number]) => {
    const hp = c.metadata.heading_path;
    return `《${input.title}》${hp.length ? " · " + hp.join(" · ") : ""}`;
  };
```

把主循环 `mapWithConcurrency(chunks, concurrency, async (c) => {...})` 的循环体替换为：

```ts
    if (opts.signal?.aborted) throw abortError();
    let llmPrefix: string | null = null;
    if (!(c.metadata.is_table_row && !llmForRows)) {
      // 非大表：走 LLM 上下文化（喂文件名，织入归属）
      llmPrefix = await deps.llm.contextualize(input.markdown, c.content_original, input.title);
    }
    c.context_prefix = resolveChunkPrefix(llmPrefix, input.title, c.metadata.heading_path);
    c.content = `${c.context_prefix}\n${c.content_original}`;
    done += 1;
    if (done === total || done % step === 0) await report("contextualizing", done);
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `node --import tsx --test packages/pipeline/src/ingest.test.ts`
Expected: PASS（4 个测试全过）。

Run: `npm run typecheck`
Expected: 无报错（确认删闭包 / 改循环体没留悬空引用；`c.context_prefix` 赋 string 兼容 `string | null`）。

- [ ] **Step 5: 提交**

```bash
git add packages/pipeline/src/ingest.ts packages/pipeline/src/ingest.test.ts
git commit -m "feat(pipeline): 单一前缀机制 resolveChunkPrefix——LLM 织入优先，空退《文件名》兜底

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 容器解析告知真实文件名（`buildPrompt` 语义提示）

**Files:**
- Modify: `packages/adapters/src/parser/claude-code-sandbox.ts`（导出 `buildPrompt`；加 `originalName` 参；`parse()` 读 env 传入）
- Test: `packages/adapters/src/parser/claude-code-sandbox.test.ts`（新建）

**Interfaces:**
- Produces: `export function buildPrompt(onDiskName: string, originalName?: string): string` —— `originalName` 存在且异于 `onDiskName` 时，在首行末尾追加双名提示并指明按 `onDiskName` 读取。

- [ ] **Step 1: 写失败测试**

新建 `packages/adapters/src/parser/claude-code-sandbox.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./claude-code-sandbox";

test("buildPrompt：originalName 异于磁盘名 → 双名提示 + 指明按磁盘名读", () => {
  const p = buildPrompt("input.pdf", "2022年-精骐&捷美-产品价格表.csv");
  assert.ok(p.includes("input.pdf"));
  assert.ok(p.includes("2022年-精骐&捷美-产品价格表.csv"));
  assert.ok(p.includes("原始文件名"));
  assert.ok(p.includes("按这个读取"));
});

test("buildPrompt：无 originalName → 无补充提示（与旧行为一致）", () => {
  const p = buildPrompt("2022年-精骐&捷美-产品价格表.csv");
  assert.ok(p.includes("2022年-精骐&捷美-产品价格表.csv"));
  assert.ok(!p.includes("原始文件名"));
});

test("buildPrompt：originalName 等于磁盘名 → 跳过提示", () => {
  const p = buildPrompt("a.pdf", "a.pdf");
  assert.ok(!p.includes("原始文件名"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test packages/adapters/src/parser/claude-code-sandbox.test.ts`
Expected: FAIL，报 `buildPrompt` 未导出。

- [ ] **Step 3: 最小实现**

在 `packages/adapters/src/parser/claude-code-sandbox.ts`，把函数签名 `function buildPrompt(filename: string)` 改为 **导出** 并加参、改用 `onDiskName`：

```ts
export function buildPrompt(onDiskName: string, originalName?: string): string {
  const hint =
    originalName && originalName !== onDiskName
      ? `（补充：该文件上传时的原始文件名是 \`${originalName}\`，可帮助你判断文档主题/类型；但磁盘上的实际文件名是 \`${onDiskName}\`，请按这个读取。）`
      : "";
  return [
    `当前工作目录里有一个文件 \`${onDiskName}\`。请把它解析成干净的 Markdown：${hint}`,
    `- 用合适的工具/库（pdf→pdfplumber/pypdf；docx→python-docx；pptx→python-pptx(逐页幻灯片提取标题/正文/表格)；xlsx→openpyxl/pandas；csv→pandas 或 python csv；md/txt→直接读）`,
    `- 保留标题层级（#/##/###）与表格结构`,
    `- PDF 若几乎无文本（扫描件），在 Markdown 顶部写一行 \`<!-- SCANNED: needs vision OCR -->\``,
    `- 不要总结、不要改写正文`,
    `- 必须把完整结果写入当前工作目录的 \`parsed.md\`（UTF-8）——这是唯一交付物，绝不能只在回复里粘贴内容；写完务必用 \`ls -l parsed.md\` 确认文件已生成且非空，再结束。`,
  ].join("\n");
}
```

在 `parse()` 方法里，把调用 `buildPrompt(filename)` 改为读 env 传入原始名（`filename` 在容器内 = `input.<ext>` 即磁盘定位名）：

```ts
      for await (const message of query({
        prompt: buildPrompt(filename, process.env.KB_ORIGINAL_FILENAME),
        options,
      })) {
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `node --import tsx --test packages/adapters/src/parser/claude-code-sandbox.test.ts`
Expected: PASS（3 个测试全过）。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add packages/adapters/src/parser/claude-code-sandbox.ts packages/adapters/src/parser/claude-code-sandbox.test.ts
git commit -m "feat(parser): buildPrompt 加原始文件名语义提示（定位名仍 input.<ext>）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 容器注入原始文件名 env（`buildDockerRunArgs` + `KB_ORIGINAL_FILENAME`）

**Files:**
- Modify: `packages/adapters/src/parser/sandbox-docker.ts`（抽出并导出 `buildDockerRunArgs`；加 `-e KB_ORIGINAL_FILENAME`；`parse()` 改用之）
- Test: `packages/adapters/src/parser/sandbox-docker.test.ts`（新建）

**Interfaces:**
- Produces: `export function buildDockerRunArgs(opts: DockerRunArgsInput): string[]`，其中
  `interface DockerRunArgsInput { image: string; authToken?: string; baseUrl: string; model: string; proxy: string; memory: string; cpus: string; pidsLimit: number; tmpfsSize: string; hostPath: string; mountName: string; filename: string }`。

- [ ] **Step 1: 写失败测试**

新建 `packages/adapters/src/parser/sandbox-docker.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDockerRunArgs } from "./sandbox-docker";

const base = {
  image: "kb-sandbox:latest",
  authToken: "k",
  baseUrl: "https://api.302.ai",
  model: "claude-haiku-4-5-20251001",
  proxy: "http://host.docker.internal:7897",
  memory: "3g",
  cpus: "2",
  pidsLimit: 256,
  tmpfsSize: "512m",
  hostPath: "/tmp/kb-sbx-xxx/input.csv",
  mountName: "input.csv",
  filename: "2022年-精骐&捷美-产品价格表.csv",
};

test("buildDockerRunArgs：注入 KB_ORIGINAL_FILENAME=原始名，前一项为 -e", () => {
  const args = buildDockerRunArgs(base);
  const i = args.indexOf("KB_ORIGINAL_FILENAME=2022年-精骐&捷美-产品价格表.csv");
  assert.ok(i > 0, "应包含 KB_ORIGINAL_FILENAME=原始名");
  assert.equal(args[i - 1], "-e");
});

test("buildDockerRunArgs：-v 挂载仍用安全 mountName，不受原始名影响", () => {
  const args = buildDockerRunArgs(base);
  assert.ok(args.includes("/tmp/kb-sbx-xxx/input.csv:/work/input.csv:ro"));
  assert.equal(args[args.length - 1], "/work/input.csv"); // 末位是容器内文件路径
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test packages/adapters/src/parser/sandbox-docker.test.ts`
Expected: FAIL，报 `buildDockerRunArgs` 未导出。

- [ ] **Step 3: 最小实现 + 接线**

在 `packages/adapters/src/parser/sandbox-docker.ts` 顶部（`SandboxDockerParser` 类之外）新增导出：

```ts
export interface DockerRunArgsInput {
  image: string;
  authToken?: string;
  baseUrl: string;
  model: string;
  proxy: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  tmpfsSize: string;
  hostPath: string;
  mountName: string;
  filename: string; // 原始上传名，注入 KB_ORIGINAL_FILENAME 供容器内 buildPrompt 用
}

/** 构造 docker run 参数数组（纯函数，便于单测）。原始名只经 -e 传，绝不进 -v 挂载路径（详见 safeMountName）。 */
export function buildDockerRunArgs(o: DockerRunArgsInput): string[] {
  return [
    "run", "--rm",
    "-e", `ANTHROPIC_AUTH_TOKEN=${o.authToken ?? ""}`,
    "-e", `ANTHROPIC_BASE_URL=${o.baseUrl}`,
    "-e", `KB_MODEL_PARSE=${o.model}`,
    "-e", "ANTHROPIC_API_KEY=",
    "-e", `KB_ORIGINAL_FILENAME=${o.filename}`,
    "-e", `HTTPS_PROXY=${o.proxy}`,
    "-e", `HTTP_PROXY=${o.proxy}`,
    "-e", "NO_PROXY=localhost,127.0.0.1",
    "-v", `${o.hostPath}:/work/${o.mountName}:ro`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(o.pidsLimit),
    "--memory", o.memory,
    "--cpus", o.cpus,
    "--tmpfs", `/tmp:rw,size=${o.tmpfsSize}`,
    o.image,
    `/work/${o.mountName}`,
  ];
}
```

在 `parse()` 里把内联的 `const args = [ ... ]`（现有 `"run", "--rm", ... , \`/work/${mountName}\`` 整段）替换为调用：

```ts
      const args = buildDockerRunArgs({
        image: this.image,
        authToken: this.authToken,
        baseUrl: this.baseUrl,
        model: this.model,
        proxy: this.proxy,
        memory: this.memory,
        cpus: this.cpus,
        pidsLimit: this.pidsLimit,
        tmpfsSize: this.tmpfsSize,
        hostPath,
        mountName,
        filename,
      });
```

（`filename`、`mountName`、`hostPath` 都是 `parse()` 里已有的局部变量。）

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `node --import tsx --test packages/adapters/src/parser/sandbox-docker.test.ts`
Expected: PASS（2 个测试全过）。

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add packages/adapters/src/parser/sandbox-docker.ts packages/adapters/src/parser/sandbox-docker.test.ts
git commit -m "feat(parser): 容器注入 KB_ORIGINAL_FILENAME（抽出 buildDockerRunArgs）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 全量校验

**Files:** 无改动，仅验证。

- [ ] **Step 1: 全仓类型检查**

Run: `npm run typecheck`
Expected: 无报错。

- [ ] **Step 2: 跑全部新增/受影响单测**

Run:
```bash
node --import tsx --test \
  packages/adapters/src/llm/llm-client.test.ts \
  packages/pipeline/src/ingest.test.ts \
  packages/adapters/src/parser/claude-code-sandbox.test.ts \
  packages/adapters/src/parser/sandbox-docker.test.ts
```
Expected: 全 PASS，`# fail 0`。

- [ ] **Step 3: 端到端冒烟（可选，需 DB + 302 + Docker）**

若环境具备（`.env` 配好、pgvector 起着、Docker 有 `kb-sandbox:latest`），上传一份「归属只在文件名」的文件（如把某无品牌产品表命名为 `精骐&捷美-测试表.csv`）走 web，检查该文档任一 chunk 的 `context_prefix` 是否带上「精骐&捷美」。无环境则跳过，靠单测 + typecheck 保证。

---

## 附：受影响但无需改动的调用方（确认用，勿改）

- `apps/worker/src/cli/enrich-demo.ts:24` `llm.contextualize(md, target.content_original)` —— 2 参调用，`title` 可选，兼容。
- `packages/pipeline/src/ingest.ts` 对 `contextualize` 的调用在 Task 2 内改为传 `input.title`。
- `apps/web/lib/kb.ts` 的 `processDoc` 已传 `title: filename`，无需改。
