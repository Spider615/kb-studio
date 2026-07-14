# 设计：文件名接进处理管线（喂大模型 + 进向量）

- 日期：2026-07-14
- 状态：已批准（待写实现计划）
- 范围：`packages/adapters`（parser / llm）、`packages/pipeline`

## 1. 背景与目标

排查发现：**正常上传流程里，文件名从解析到问答，全程没有作为语义喂给大模型，也没进任何被 embed 的内容。** 逐阶段实况：

- **解析（默认容器路径）**：`safeMountName()`（`mount-name.ts:13`）把上传名归一成 `input.<ext>`，容器里的 Claude Code 只看到 `input.pdf`，真实文件名进不去。归一是为了防止文件名里的 `" : \`` 破坏 `docker -v` 单文件挂载（历史真实 bug），不能推翻。
  - 扫描 PDF 逐页 vision OCR（`ocrPrompt`，`pdf-parser.ts:21`）只带页码，无文件名。
  - csv/xlsx 走确定性解析（`TabularSandboxParser`），无模型。
  - 仅调试用的宿主机路径（`KB_PARSER=host` → `ClaudeCodeSandboxParser`）本来就把真实文件名写进 prompt（`claude-code-sandbox.ts:120`），正常 web 不走这条。
- **上下文化**：`contextualize(fullDoc, chunk)`（`llm-client.ts:113`）喂正文 + 片段，无文件名。
- **检索问答**：喂 Opus 的是 chunk 的 `content`（上下文前缀 + 原文），前缀来自上下文化（无文件名）。`doc_title` 只写进 chunk metadata（`chunker.ts:165`），既不 embed 也不进 answer 的可引用 document。

文件名（= `docs.title` = `filename`，`kb.ts:138`）目前只用于落库展示、大表格兜底前缀、metadata 反查——没有一处作为语义喂进模型或进向量。

### 动机例子（归属只在文件名里）

`2022年-精骐&捷美-产品价格表.csv`：表格每一行都是「精骐&捷美」的产品，但**归属（品牌/公司）只写在文件名上，行内容里完全没有**。当前每行 chunk = `表头 + 该行`，既不含品牌、上下文化也看不到文件名 → RAG 检索/问答时模型不知道这些产品是谁的，用户问「精骐&捷美的某产品多少钱」根本命中不了。

关键洞察：文件名要的不是「机械贴一个标签」，而是**一起参与上下文化**——让上下文化把文件名里的归属（品牌/公司/时间）**织进**每个 chunk 的语义描述。

### 目标
1. **解析时**把真实文件名作为语义提示告诉模型（容器路径），帮它判断文档主题/类型；不碰安全归一，磁盘定位名仍是 `input.<ext>`。
2. **上下文化时**把文件名作为文档来源喂给模型，并要求它在片段缺归属时从文件名补出品牌/公司/时间——上下文化产出的前缀本身即承载来源 + 归属。
3. 上述前缀进 `content` → 进 embedding + BM25，使「搜品牌/来源相关问题」两路都能命中。

### 非目标
- 不改造结构（`structure`）——它只决定在哪插标题，文件名对它意义不大。
- 不给问答阶段的 Opus 单独喂文件名（文件名已随 chunk `content` 进入可引用 document，Opus 已能看到）。
- **不回填存量旧文档**——只对本次改动后新入库的文档生效。旧文档如需带上文件名，另行触发重新入库（本设计不含）。
- 不给扫描 PDF 逐页 OCR（`ocrPrompt`）加文件名——纯转写任务，加了只会诱导模型幻觉。
- 保留文件扩展名（`.pdf`/`.docx` 本身是类型信号），确定性兜底前缀统一 `《文件名.ext》`。

## 2. 决策记录（核心：单一机制，不叠补丁）

一版早期设计曾"LLM 织入品牌"叠加"机械前缀 `《文件名》`"两个机制、再加去重指令调停，属打补丁。本版塌成**一个机制**：

- **上下文化独占「来源 + 归属」这件事**。`contextualize` 拿到文件名，输出的前缀本身就包含来源定位与从文件名补出的归属；**它的输出即完整前缀**，不再在外面机械拼 `《文件名》`。
- **确定性前缀 `《文件名》· 章节` 只作"无 LLM 时"的兜底**：大表（行 > `maxLlmRows`，默认 400，为控成本不逐行喂 LLM）或 LLM 返回空/失败时使用。文件名要么被 LLM 织入（智能路径）、要么由兜底带上（无 LLM 路径）——**永不并存，无需去重指令**。
- **删除**：机械 `《文件名》 + LLM前缀` 拼接、「不要复述文件名」去重指令、以及"冗余可接受"的自圆其说。
- **解析提示传输**走 env 变量 `KB_ORIGINAL_FILENAME`（`SandboxDockerParser` 经 `-e` 注入容器）。execFile 数组参无 shell 插值，任意字符安全，不碰 `-v` 挂载路径。
- **定位名 vs 语义名分离**：容器里磁盘定位名仍是 `input.<ext>`（agent 靠它读文件），真实文件名只作独立标注的语义提示，并明确告诉模型"实际请读 `input.<ext>`"。

### 诚实的取舍
放弃「原文件名整串一定在每个 chunk 里」的硬保证。换来干净、无冗余、且正是所要的"语义织入"。品牌召回不丢——正文缺品牌时 LLM 补出「精骐&捷美」；正文自带归属时不硬塞、少噪声。只有「拿完整文件名当查询词精确搜」这种罕见场景弱一点，那本可走 metadata（`doc_title`）精确匹配，不值得往每个向量塞原文件名。

## 3. 变更详情

### 3.1 `packages/adapters/src/llm/llm-client.ts` — `contextualize` 加 title + 归属补全

- 签名：`contextualize(fullDoc: string, chunk: string, title?: string, model?: string)`。
- **抽出纯函数** `buildContextualizeContent(fullDoc, chunk, title?)`（**导出**，与 `buildAnswerSystemPrompt` 同款可测），返回 `messages[0].content` 的两块文本：
  - 第 1 块（带 `cache_control: { type: "ephemeral" }`）= 可缓存前缀。`title` 存在时把标题拼进这块（与整份文档同块 → 跟着 prompt cache 命中，成本≈0）：

    ```
    文档标题/来源文件：《<title>》

    <document>
    <fullDoc>
    </document>
    ```

    `title` 为空/未传时退回原样（无标题行、无 `《》`），保持向后兼容。
  - 第 2 块 = 上下文说明指令，把「归属补全」写进要点：
    > 请阅读上述完整文档，为下面片段生成上下文说明（来源定位 + **归属补全** + 核心对象/时间 + 指代消解）：
    > **归属补全**：若片段本身没写明所属品牌/公司/时间等，而文档标题/文件名里有，就在描述中补上（例：价格表某行没写品牌，则从文件名补出该品牌）。自然融入即可，不必照抄完整文件名/扩展名。
    > 其后接现有 `<chunk>…</chunk>`。
- `contextualize()` 改为调用 `buildContextualizeContent(...)` 填 `messages`，逻辑等价。
- system 提示：保留「只输出描述本身、50~100 字、单段、无『该片段…』前缀」，末尾加一句：`若片段缺品牌/公司/时间等归属而文档标题里有，请补进描述。`

### 3.2 `packages/pipeline/src/ingest.ts` — 传 title + 单一前缀机制

把「LLM 主 + 确定性兜底」收成一处，前缀恒非空。**抽出纯函数** `resolveChunkPrefix(llmPrefix, title, headingPath)`（**导出**，无 DB 依赖 → 可单测），统一决定最终前缀：

```
// pure: LLM 织入优先，空/失败退确定性《文件名》·章节
export function resolveChunkPrefix(
  llmPrefix: string | null | undefined,
  title: string,
  headingPath: string[],
): string {
  const deterministic = `《${title}》${headingPath.length ? " · " + headingPath.join(" · ") : ""}`;
  return llmPrefix && llmPrefix.trim() ? llmPrefix : deterministic;
}
```

`ingestDoc` 主循环改为：

```
let llmPrefix: string | null = null;
if (!(c.metadata.is_table_row && !llmForRows)) {                          // 大表跳过 LLM
  llmPrefix = await deps.llm.contextualize(input.markdown, c.content_original, input.title);
}
c.context_prefix = resolveChunkPrefix(llmPrefix, input.title, c.metadata.heading_path);
c.content = `${c.context_prefix}\n${c.content_original}`;                 // 前缀恒非空，无裸原文分支
```

- 相对现状的行为变化：① 给 `contextualize` 传 `input.title`；② 原 `prefix || null`（空则丢上下文）→ 走 `resolveChunkPrefix` 退确定性前缀（顺带修了"LLM 返回空 → chunk 丢失全部上下文"的旧行为）。
- 大表与 LLM 路径共用 `resolveChunkPrefix`：大表 `llmPrefix=null` → 得确定性前缀；LLM 路径用其结果或退兜底。
- 现有局部闭包 `deterministicPrefix(c)` 被 `resolveChunkPrefix` 取代删除。
- **不再有**机械 `《文件名》 + prefix` 拼接。

**表格行（动机例子）覆盖**：
- 小表（行 ≤ 400）：每行走 LLM 上下文化 + 归属补全 → 每行前缀带上从文件名推断的品牌（「精骐&捷美2022年产品价格表中，产品A…」）。最佳形态。
- 大表（行 > 400）：行级回退 `《文件名》· sheet/章节`（无 LLM）。品牌不由模型语义重述，但文件名整串（含"精骐&捷美"）仍在每行前缀 → 向量 + BM25 命中不受影响，Opus 也能从前缀读出归属。`maxLlmRows` 可按需调高换取全行 LLM 归属。

### 3.3 `packages/adapters/src/parser/claude-code-sandbox.ts` — buildPrompt 加语义提示

- `buildPrompt(onDiskName: string, originalName?: string)`（**导出**该纯函数供测试断言）：
  - 首行定位名仍用 `onDiskName`（容器里 = `input.<ext>`）。
  - 若 `originalName` 存在且 `!== onDiskName`，追加一行：
    > `补充：这个文件上传时的原始文件名是 \`<originalName>\`，可帮助你判断文档主题/类型；但磁盘上的实际文件名是 \`<onDiskName>\`，请按这个读取。`
- `parse()` 内读 `process.env.KB_ORIGINAL_FILENAME` 作 `originalName` 传入。宿主机路径下该 env 未设 → `undefined` → 跳过提示（真实名已是 `onDiskName`）。

### 3.4 `packages/adapters/src/parser/sandbox-docker.ts` — 注入原始文件名 env

- **抽出纯函数** `buildDockerRunArgs({ hostPath, mountName, filename, image, ... })`（**导出**），把内联在 `parse()` 的 docker 参数数组构造挪进去，供纯断言测试。
- 参数里追加：`"-e", \`KB_ORIGINAL_FILENAME=${filename}\``（`filename` = 原始上传名，非 `mountName`）。
- `parse()` 改为调用 `buildDockerRunArgs(...)`，行为等价，其余不变。

### 3.5 全文件类型覆盖（不是只管表格）

「上下文化喂文件名 + 归属补全」是**所有文件类型的默认路径**，与类型无关；**只有表格**有"按行切 + 大表回退"的特殊分支。非表格 chunk（`is_table_row` 未置）在 `ingest.ts` 里**永远**走 LLM 上下文化，无行数上限（现有行为，本次仅多传 `title`）。因此大表是整个设计里**唯一**会从"LLM 织入"退化为"确定性前缀"的情况：

| 文件类型 | 每 chunk 的归属注入（①②） | 解析告知真名（③） |
|---|---|---|
| pdf / docx / pptx / md / txt | 每块 LLM，品牌**织入句子** ✓ 最佳 | ✓ 容器收到真实文件名 |
| 扫描 pdf | 每块 LLM ✓（OCR 阶段不加、ingest 阶段补） | OCR 纯转写不加，ingest 补 ✓ |
| csv/xlsx 小表（行 ≤ `maxLlmRows`） | 每行 LLM，品牌**织入句子** ✓ 最佳 | 无模型（不需要） |
| csv/xlsx 大表（行 > `maxLlmRows`） | 确定性兜底 `《文件名》· 章节`，品牌以原文件名形式在每行 ✓（召回不丢，形态糙） | 无模型 |

- 例：`精骐&捷美-公司介绍.pdf`（正文只说"本公司"）→ pdf 路径每块补成「精骐&捷美公司介绍中，…」；`捷美-售后政策.docx` 同理。
- **成本非对称（诚实提醒）**：非表格文件无大表那种 400 上限，每 chunk 都调一次 Haiku（现有行为，靠 prompt caching 摊薄整份文档）。超大 PDF 本就偏贵，本次不加剧也不优化。

## 4. 数据流（改动后）

```
上传 → doc 行(title=filename)
  → 解析(容器): -e KB_ORIGINAL_FILENAME=真实名 → buildPrompt 定位 input.pdf + 语义提示真实名
  → (条件)造结构  [不变]
  → 入库:
       prefix = contextualize(markdown, chunk, title)   ← 文件名喂 LLM + 织入归属
                 或 《title》· 章节（无 LLM/空时兜底）    ← 单一机制，二选一
       content = prefix + 原文  → embed + BM25           ← 品牌/来源进两路索引
  → 问答: Opus 通过可引用 chunk.content 即可见来源/品牌  [无需改 answer]
```

## 5. 测试策略

全部走**纯函数 + `node:test`**（沿用 `llm-client.test.ts` 惯例，不 mock HTTP、不起容器）。

- **`buildContextualizeContent`（`llm-client.test.ts` 扩充）**：
  - 传 title：第 1 块含 `《<title>》` 且带 `cache_control:{type:"ephemeral"}`；`<document>` 与 `fullDoc` 仍在同一块。
  - 不传 title：第 1 块无标题行、无 `《》`（向后兼容）。
  - 第 2 块含 `<chunk>`、`chunk` 内容，以及「归属补全」关键词（如 `归属`/`品牌`）。
- **`resolveChunkPrefix`（`ingest.ts` 导出，新增 `ingest.test.ts`）**——纯函数，无 DB 依赖（不测整个 `ingestDoc`，那需真库、属 `*.integration.test.ts`）：
  - `llmPrefix="精骐&捷美…"` → 原样返回该串（LLM 织入优先）；
  - `llmPrefix=""` 或 `null` → 返回 `《<title>》· a · b`（确定性兜底，含文件名 + heading_path）；
  - `headingPath=[]` → 返回 `《<title>》`（无 ` · ` 尾巴）；
  - `llmPrefix="   "`（纯空白）→ 视为空，退确定性兜底。
- **`buildPrompt`（`claude-code-sandbox` 新增测试）**：`originalName` 异于 `onDiskName` 时提示含两个名字且指明按 `onDiskName` 读；缺省或等于时无附加提示（输出与旧 `buildPrompt(onDiskName)` 一致）。
- **`buildDockerRunArgs`（`sandbox-docker` 新增测试）**：数组含 `-e` 紧跟 `KB_ORIGINAL_FILENAME=<原始名>`，且 `-v` 挂载仍用 `mountName`（不受原始名影响）。

## 6. 风险与回滚

- **向后兼容**：`contextualize` 的 `title` 为可选参，旧调用方（`enrich-demo` 等）不传照跑。
- **行为改进（非纯新增）**：非表格 chunk 在 LLM 返回空时，前缀从"无"变成确定性 `《文件名》· 章节`——修了旧的"空则丢上下文"，方向正确。
- **前缀语义**：文件名/品牌是否进 chunk 现依赖 LLM 织入（智能路径）或确定性兜底（无 LLM）；放弃了"原文件名整串必在每个 chunk"的硬保证（见 §2 取舍）。
- **存量文档**：不受影响；新文档才带文件名。
- **回滚**：解析侧（③④）与入库侧（①②）两组相互独立，可整组回滚而不破坏另一组。
