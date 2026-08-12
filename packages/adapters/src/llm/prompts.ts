/**
 * 两个 LLM 后端（302/Anthropic 协议的 LlmClient、火山方舟/OpenAI 协议的 ArkLlmClient）
 * 共用的提示词与造结构纯函数。
 *
 * 提示词放这里的原因：换模型后端不应该顺带改变模型看到的文字——否则出了效果差异，
 * 分不清是模型变了还是 prompt 变了。协议差异（content block 形状、cache_control、
 * system 放顶层还是 messages 里）由各自的 client 负责组装。
 */

export const BASE_ANSWER_SYSTEM =
  "你是知识库问答助手。只依据提供的资料作答，简洁准确、不编造；不要复述资料原文。";

/** 按分组背景（Agent 用途/补充）拼出问答用的 system 提示词；无背景时原样返回基础提示词。 */
export function buildAnswerSystemPrompt(groupContext?: string | null): string {
  if (!groupContext) return BASE_ANSWER_SYSTEM;
  return [
    BASE_ANSWER_SYSTEM,
    "",
    "以下是该客户对这个知识库/Agent 的背景诉求，仅供你理解语境、把握回答口径，不要在回答中逐字复述：",
    "<客户背景>",
    groupContext,
    "</客户背景>",
  ].join("\n");
}

export const STRUCTURE_SYSTEM =
  "你在为 RAG 预处理无结构文档。唯一任务是决定在哪些位置插入标题，绝不输出或改动任何正文。";

/** 造结构的 user 提示词：喂带编号的文本块，只要 JSON 标题清单。 */
export function buildStructureUserPrompt(numbered: string): string {
  return [
    "下面是按空行切分、带编号的文本块。找出话题切换处，给出要插入的标题。",
    "要求：",
    "- 只在话题明显切换处插入 `##`(二级) 或 `###`(三级)；标题之间间隔 2~5 个块，别太碎",
    "- 标题概括其后内容的主题（5~15 字）",
    "- 已经是标题的块（以 # 开头）不要再插",
    '- 只输出 JSON 数组，每项 {"before": 块号(整数), "level": 2 或 3, "title": "标题文字"}',
    "- 不要输出正文、不要解释、不要代码围栏",
    "",
    "<blocks>",
    numbered,
    "</blocks>",
  ].join("\n");
}

export const CONTEXTUALIZE_SYSTEM =
  "你为 RAG 检索生成 chunk 的上下文描述。只输出描述本身：50~100 字、单段、不要『该片段…』之类前缀或解释。若片段缺品牌/公司/时间等归属而文档标题里有，请补进描述。";

/** 上下文化的「可缓存文档块」文本（整份文档 + 标题）。Anthropic 侧会给它挂 cache_control。 */
export function buildContextualizeDocText(fullDoc: string, title?: string): string {
  return title
    ? `文档标题/来源文件：《${title}》\n\n<document>\n${fullDoc}\n</document>`
    : `<document>\n${fullDoc}\n</document>`;
}

/** 上下文化的「指令块」文本（含归属补全要求 + 目标片段）。每次调用都变，不可缓存。 */
export function buildContextualizeInstruction(chunk: string): string {
  return [
    "请阅读上述完整文档，为下面片段生成上下文说明（来源定位 + 归属补全 + 核心对象/时间 + 指代消解）：",
    "归属补全：若片段本身没写明所属品牌/公司/时间等，而文档标题/文件名里有，就在描述中补上（例：价格表某行没写品牌，则从文件名补出该品牌）。自然融入即可，不必照抄完整文件名/扩展名。",
    "<chunk>",
    chunk,
    "</chunk>",
  ].join("\n");
}

export const REWRITE_SYSTEM =
  "你把多轮对话里的最新问题改写成一句能独立检索的查询：补全指代和省略的主语。只输出改写后的查询本身，不要解释、不要引号。";

/** 多轮检索改写的 user 提示词。 */
export function buildRewriteUserPrompt(transcript: string, question: string): string {
  return ["<对话历史>", transcript, "</对话历史>", "", `最新问题：${question}`, "", "改写后的独立查询："].join(
    "\n",
  );
}

/** 按空行把文档切成块（段落/标题/表格各自成块），供造结构编号与插回。 */
export function splitBlocks(md: string): string[] {
  return md
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/** 解析模型返回的插标题清单，做范围/去重/字段校验，丢弃非法项。 */
export function parseInserts(
  raw: string,
  blockCount: number,
): Array<{ before: number; level: number; title: string }> {
  let arr: any;
  try {
    const m = raw.match(/\[[\s\S]*\]/); // 容忍模型多输出的解释/围栏，抠出 JSON 数组
    arr = JSON.parse(m ? m[0] : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out: Array<{ before: number; level: number; title: string }> = [];
  for (const it of arr) {
    const before = Number(it?.before);
    const level = Number(it?.level) === 3 ? 3 : 2;
    const title = String(it?.title ?? "").trim();
    if (!Number.isInteger(before) || before < 0 || before >= blockCount || !title) continue;
    if (seen.has(before)) continue; // 同一位置只插一个
    seen.add(before);
    out.push({ before, level, title });
  }
  return out;
}

/** 把标题机械插回原文块：原块一字不改地输出，仅在指定块前加标题行。 */
export function applyInserts(
  blocks: string[],
  inserts: Array<{ before: number; level: number; title: string }>,
): string {
  const byPos = new Map<number, { level: number; title: string }>();
  for (const ins of inserts) {
    if (/^#{1,6}\s/.test(blocks[ins.before] ?? "")) continue; // 目标块本身是标题，跳过
    byPos.set(ins.before, { level: ins.level, title: ins.title });
  }
  const out: string[] = [];
  blocks.forEach((b, i) => {
    const h = byPos.get(i);
    if (h) out.push(`${"#".repeat(h.level)} ${h.title}`);
    out.push(b);
  });
  return out.join("\n\n");
}

/** 造结构的编号块文本（[0] 块内容 ⏎ 换行压平）。 */
export function numberBlocks(blocks: string[]): string {
  return blocks.map((b, i) => `[${i}] ${b.replace(/\n/g, " ⏎ ")}`).join("\n\n");
}
