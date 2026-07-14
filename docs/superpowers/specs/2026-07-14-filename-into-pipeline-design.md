# 设计：文件名接进处理管线（喂大模型 + 进向量）

- 日期：2026-07-14
- 状态：已批准（待写实现计划）
- 范围：`packages/adapters`（parser / llm）、`packages/pipeline`

## 1. 背景与目标

排查发现：**正常上传流程里，文件名从解析到问答，全程没有作为语义喂给大模型，也没进任何被 embed 的内容。** 逐阶段实况：

- **解析（默认容器路径）**：`safeMountName()`（`packages/adapters/src/parser/mount-name.ts:13`）把上传名归一成 `input.<ext>`，容器里的 Claude Code 只看到 `input.pdf`，真实文件名进不去。归一是为了防止文件名里的 `" : \``  破坏 `docker -v` 单文件挂载（历史真实 bug），不能推翻。
  - 扫描 PDF 的逐页 vision OCR（`ocrPrompt`，`pdf-parser.ts:21`）只带页码，无文件名。
  - csv/xlsx 走确定性解析（`TabularSandboxParser`），无模型。
  - 仅调试用的宿主机路径（`KB_PARSER=host` → `ClaudeCodeSandboxParser`）本来就把真实文件名写进 prompt（`claude-code-sandbox.ts:120`），正常 web 不走这条。
- **造结构**：`structure(markdown)`（`llm-client.ts:53`）只喂正文块，无标题/文件名。（本次不改，见非目标。）
- **上下文化**：`contextualize(fullDoc, chunk)`（`llm-client.ts:113`）喂正文 + 片段，无文件名。
- **检索问答**：喂 Opus 的是 chunk 的 `content`（上下文前缀 + 原文），前缀来自上下文化（无文件名）。`doc_title` 只写进 chunk metadata（`chunker.ts:165`），**既不 embed 也不进 answer 的可引用 document**，模型答题看不到文件名。

文件名（= `docs.title` = `filename`，`kb.ts:138` `processDoc` 里 `title: filename, source: filename`）目前只用于落库展示、大表格兜底前缀、metadata 反查——没有一处作为语义喂进模型或进向量。

### 目标（brainstorming 结论）
1. **上下文化时把文件名作为文档来源喂给模型**，让上下文前缀的定位更准。
2. **每个 chunk 的上下文前缀都带上 `《文件名》` 并进 embedding**，让「搜文件名相关问题」在向量 + BM25 两路都能命中。
3. **解析时把真实文件名作为语义提示告诉模型**（容器路径），帮模型判断文档主题/类型——但不碰安全归一，磁盘定位名仍是 `input.<ext>`。

### 非目标
- 不改造结构（`structure`）——它只决定在哪插标题，文件名对它意义不大。
- 不给问答阶段的 Opus 单独喂文件名（②已让文件名进 chunk content，Opus 通过可引用 document 已能看到，无需再改 `answer`）。
- **不回填存量旧文档**——只对本次改动后新入库的文档生效。旧文档如需带上文件名，另行触发重新入库（本设计不含）。
- 不给扫描 PDF 的逐页 OCR（`ocrPrompt`）加文件名——纯转写任务，加了只会诱导模型幻觉出与本页无关的内容。
- 保留文件扩展名（`.pdf`/`.docx` 本身是类型信号），不去扩展名、不换分隔符，前缀统一用 `《文件名.ext》`。

## 2. 决策记录（brainstorming 结论）

- **前缀格式**：`《<完整文件名含扩展名>》`。LLM 路径下 = `《文件名》 <LLM 上下文>`（空格分隔）；大表格兜底路径现状已是 `《文件名》· heading_path`，保持不动。
- **去重策略**：上下文化的 system 提示新增「不要复述文档标题/文件名」——文件名由②的机械前缀作为**唯一来源**注入，避免 LLM 又吐一遍造成 `《x》《x》…` 重复。
- **解析提示的传输**：走 **env 变量** `KB_ORIGINAL_FILENAME`（`SandboxDockerParser` 通过 `-e` 注入容器）。execFile 数组参无 shell 插值，任意字符安全，且完全不碰 `-v` 挂载路径。
- **定位名 vs 语义名分离**：`buildPrompt` 里磁盘定位名仍是 `input.<ext>`（agent 靠它 `ls`/读文件），真实文件名只作为**独立标注的语义提示**出现，并明确告诉模型"实际请读磁盘上的 `input.<ext>`"。宿主机调试路径下真实名 == 定位名，`originalName` 留空跳过、零重复。

## 3. 变更详情

### 3.1 `packages/adapters/src/llm/llm-client.ts` — `contextualize` 加 title

- 签名：`contextualize(fullDoc: string, chunk: string, title?: string, model?: string)`。
- **抽出纯函数** `buildContextualizeContent(fullDoc, chunk, title?)`（**导出**，与 `buildAnswerSystemPrompt` 同款可测），返回 `messages[0].content` 的两块文本数组：
  - 第 1 块（带 `cache_control: { type: "ephemeral" }`）= 可缓存前缀。`title` 存在时把标题拼进这块（与整份文档同块 → 跟着 prompt cache 命中，成本≈0）：

    ```
    文档标题/来源文件：《<title>》

    <document>
    <fullDoc>
    </document>
    ```

    `title` 为空/未传时退回原样（无标题行、无 `《》`），保持向后兼容。
  - 第 2 块 = 现有的「请阅读上述完整文档，为下面片段生成上下文说明… `<chunk>`…」，不变。
- `contextualize()` 改为调用 `buildContextualizeContent(...)` 填 `messages`，逻辑等价。
- system 提示末尾追加：`不要复述文档标题/文件名。`

### 3.2 `packages/pipeline/src/ingest.ts` — 传 title + 机械前缀

- 上下文化调用改为 `deps.llm.contextualize(input.markdown, c.content_original, input.title)`。
- 定义 `const titleTag = \`《${input.title}》\`;`。
- LLM 路径（非大表格兜底）拼前缀：

  ```
  const prefix = await deps.llm.contextualize(input.markdown, c.content_original, input.title);
  c.context_prefix = prefix ? `${titleTag} ${prefix}` : titleTag;   // LLM 返回空也至少有 《文件名》
  ```

- 大表格兜底路径（`deterministicPrefix`）现状已含 `《title》`，不动。
- `c.content` 拼接逻辑不变（`context_prefix ? prefix + "\n" + original : original`）；因 `context_prefix` 现在恒非空，文件名必进 `content` → 进 embedding + jieba/BM25。

### 3.3 `packages/adapters/src/parser/claude-code-sandbox.ts` — buildPrompt 加语义提示

- `buildPrompt(onDiskName: string, originalName?: string)`（**导出**该纯函数供测试断言）：
  - 首行的定位名仍用 `onDiskName`（容器里 = `input.<ext>`）。
  - 若 `originalName` 存在且 `!== onDiskName`，追加一行：

    > `补充：这个文件上传时的原始文件名是 \`<originalName>\`，可帮助你判断文档主题/类型；但磁盘上的实际文件名是 \`<onDiskName>\`，请按这个读取。`

- `parse()` 内读 `process.env.KB_ORIGINAL_FILENAME`，作为 `originalName` 传入 `buildPrompt`。宿主机路径下该 env 未设 → `undefined` → 跳过提示（真实名已经是 `onDiskName`）。

### 3.4 `packages/adapters/src/parser/sandbox-docker.ts` — 注入原始文件名 env

- **抽出纯函数** `buildDockerRunArgs({ hostPath, mountName, filename, image, ... })`（**导出**），把现在内联在 `parse()` 里的 docker 参数数组构造挪进去，供纯断言测试。
- 在参数里追加：`"-e", \`KB_ORIGINAL_FILENAME=${filename}\``（`filename` = 原始上传名，非 `mountName`）。
- `parse()` 改为调用 `buildDockerRunArgs(...)`，行为等价，其余不变。

## 4. 数据流（改动后）

```
上传 → doc 行(title=filename)
  → 解析(容器): -e KB_ORIGINAL_FILENAME=真实名 → buildPrompt 定位 input.pdf + 语义提示真实名
  → (条件)造结构  [不变]
  → 入库:
       contextualize(markdown, chunk, title)  ← 标题进可缓存 <document> 块
       context_prefix = 《title》 + LLM前缀      ← 文件名机械注入
       content = 前缀 + 原文  → embed + BM25    ← 文件名进两路索引
  → 问答: Opus 通过可引用 chunk.content 即可见文件名  [无需改 answer]
```

## 5. 测试策略

全部走**纯函数 + `node:test`**（沿用 `llm-client.test.ts` 现有惯例，不 mock HTTP client、不起容器）。

- **`buildContextualizeContent`（`llm-client.test.ts` 扩充）**：
  - 传 title：第 1 块文本含 `《<title>》` 且带 `cache_control:{type:"ephemeral"}`；`<document>` 与 `fullDoc` 仍在同一块。
  - 不传 title：第 1 块无标题行、无 `《》`（向后兼容）。
  - 第 2 块含 `<chunk>` 与 `chunk` 内容。
- **`ingest.ts`（新增 `ingest.test.ts`）**：注入假 `llm`（`contextualize` 返回固定串 / 空串）+ 假 `embedder`（记录收到的 `content`），断言：
  - 每个非表格 chunk 的 `context_prefix` 以 `《<title>》` 开头；
  - LLM 返回空串时前缀严格等于 `《<title>》`（无尾随空格/换行）；LLM 返回非空 `X` 时前缀为 `《<title>》 X`；
  - 传给 `embedder.embed` 的每个 `content` 含文件名。
- **`buildPrompt`（`claude-code-sandbox` 新增测试）**：`originalName` 存在且异于 `onDiskName` 时提示含两个名字且指明按 `onDiskName` 读；`originalName` 缺省或等于 `onDiskName` 时无附加提示（输出与旧 `buildPrompt(onDiskName)` 一致）。
- **`buildDockerRunArgs`（`sandbox-docker` 新增测试）**：返回数组含 `-e` 后紧跟 `KB_ORIGINAL_FILENAME=<原始名>`，且 `-v` 挂载仍用 `mountName`（不受原始名影响）。

## 6. 风险与回滚

- **向后兼容**：`contextualize` 的 `title` 为可选参，旧调用方（demo 脚本 `enrich-demo` 等）不传也能跑。
- **前缀变长**：每个 chunk 的 embedded content 多出 `《文件名》`（通常 <30 字符），对向量/BM25 影响可忽略，且正是目标。
- **存量文档**：不受影响（旧 chunk 不含文件名前缀），检索行为对旧文档不变；新文档才带文件名。
- **回滚**：四处改动相互独立，可单独 revert 任一注入点而不破坏其余（②依赖①的 title 传参，但①可独立存在）。
