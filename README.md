# kb-studio

把各类文件（word / pdf / excel / csv / md …）做 **解析 → 造结构 → 切片 → 图片图→文 → 上下文化（Contextual Retrieval）→ 向量化** 入本地 RAG（pgvector + BM25 + RRF + Reranker + Citations 检索），Web 端预览 chunk 列表、人工确认后推送到「秒懂」知识库（秒懂为可插拔推送终点，接口待接）。

设计与里程碑见 [CLAUDE.md](./CLAUDE.md)。

## 快速开始

```bash
npm install
cp .env.example .env          # 填 ANTHROPIC_API_KEY 等

# 起本地 Postgres + pgvector（里程碑 ③ 起需要）
npm run db:up

# 类型检查
npm run typecheck

# 里程碑 ① 最小闭环：在 Claude 沙箱里解析一个文件
npm run parse-one -- ./some.pdf
```

## 技术栈

TypeScript / Node · Next.js（里程碑 ④）· Postgres + pgvector + pg-boss · 解析跑在 Claude code-execution 沙箱 · Embedding 默认 BGE-M3（OpenAI 兼容端点）· Claude：haiku-4-5 跑解析/造结构/上下文化/vision，opus-4-8 跑检索回答 + Citations。
