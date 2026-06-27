# kb-studio Web UI 重设计 — 设计文档

- **日期**：2026-06-27
- **范围**：`apps/web` 前端表现层
- **目标**：把现有 UI 从「通用后台冷灰风」重做成 **Claude 暖色风**，更简洁、操作更舒服。
- **Mockup**：`assets/2026-06-27-ui-redesign-mockup.html`（截图 `.png` 同目录）——视觉以 mockup 为准，本文档是其落地规范。

## 锁定决策（已与用户确认）

1. **改动档位**：换皮 + **布局重构**（不仅改颜色字体，也重排骨架）。
2. **风格强度**：**完整 Claude 风**——暖米白底 + 黏土橙强调色 + 衬线标题 + 浅暖侧栏。
3. **深色模式**：**只做浅色**（不实现 dark theme）。
4. **骨架**：**单一暖色侧栏**——侧栏顶部用 `知识库 / 对话` 分段切换，主操作置顶，列表居中，设置置底；右侧为干净工作区。
5. **不变项**：功能、API、数据流、后端管线**完全不动**；纯前端表现层。不引入 Tailwind / 组件库 / 任何新依赖，仍是纯 CSS。

## 非目标（Out of Scope）

- 不做深色模式。
- 不改任何 `app/api/*` 路由、`lib/kb.ts`、`@kb/*` 包。
- 不改变功能行为（上传/解析/预览/推送/检索问答的流程一字不动）。
- 不做响应式/移动端适配（保持桌面两栏，与现状一致）。
- 不新增依赖（不上 Tailwind、shadcn、icon 库；图标用文字/emoji 或内联 SVG）。

## 设计系统（Design Tokens）

全部以 CSS 变量定义在 `globals.css` `:root`，浅色单主题。

### 颜色

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#FAF9F5` | 工作区主底（暖奶白） |
| `--sidebar` | `#F0EEE6` | 侧栏底（暖米色，取代旧深藏青 `#111827`） |
| `--surface` | `#FFFFFF` | 卡片/输入/模态底 |
| `--surface-2` | `#FBFAF6` | 次级抬升底（scope bar 等） |
| `--border` | `#E8E4DA` | 暖发丝分隔线 |
| `--border-strong` | `#DCD7C9` | 按钮/输入描边 |
| `--text` | `#28261F` | 主文字（暖近黑） |
| `--text-2` | `#6F6B5E` | 次级文字 |
| `--text-3` | `#9B9686` | 弱化/占位/meta |
| `--accent` | `#C96442` | 黏土橙：主按钮/选中态/发送/溯源/品牌符号 |
| `--accent-hover` | `#B4573A` | 主按钮 hover |
| `--accent-soft` | `#F4E8E1` | 黏土浅底：选中列表项、text 徽章 |
| `--accent-text` | `#9A4A2E` | 黏土深字：徽章文字、溯源标签 |
| `--ok-bg` / `--ok-text` | `#EAF1E6` / `#506B46` | 已就绪/已推送 状态（柔绿，替换刺眼绿） |
| `--warn-bg` / `--warn-text` | `#FBF0E2` / `#956428` | 上下文前缀 callout、处理中 |
| `--err` | `#B5483A` | 错误文字、删除危险态 |

### 字体

```css
--font-sans: -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
--font-serif: Georgia, "Songti SC", "Times New Roman", serif;
```

- **衬线**：品牌字标 `kb-studio`、空状态大标题。（用户已确认保留衬线的「文艺/高级感」。）
- **无衬线**：其余所有 UI 文字、文档标题、正文、列表（中文用 PingFang 更清晰）。

### 形状与阴影

- 圆角：卡片/模态 `12px`、按钮/输入 `9–11px`、列表项/分段 `7–9px`、状态 pill `999px`、气泡 `14px`（带一个 `4px` 尖角朝向发送方）。
- 阴影：极柔暖投影 `0 1px 2px rgba(60,50,30,.04)`（卡片）、`0 12px 40px rgba(60,50,30,.10)`（模态）。
- 间距：整体加大留白；工作区内边距 `~22–28px`，卡片 `15–17px`。

## 布局架构

```
┌──────────────┬─────────────────────────────┐
│  Sidebar     │  Workspace                   │
│  (264px)     │  (flex:1)                    │
│              │                              │
│  品牌字标     │  [Header: 标题 + 状态pill +   │
│  分段切换     │           操作按钮]           │
│  主操作CTA    │  ────────────────────────    │
│  列表(flex)   │  [Scroll: chunk列表 / 对话流] │
│  ───────      │                              │
│  设置(置底)   │  [对话页底部: Composer]       │
└──────────────┴─────────────────────────────┘
```

- **整体**：`.app` flex 横向，`height:100vh`，左 `Sidebar` 固定 264px，右 `Workspace` 自适应。
- **Sidebar 是共享外壳**：在两个路由间复用，按当前 section 渲染对应列表与 CTA。
- 旧的 132px 深藏青 `Nav`（独立导航条 + 各页自带列表的「视觉双左栏」）**退役**，合并为这一个侧栏。

## 组件规范

### Sidebar（新增共享组件）
- **品牌行**：`✦ kb-studio`，衬线，`✦` 用 `--accent`。
- **分段切换 `知识库 / 对话`**：圆角胶囊容器（`#E6E2D6` 底），选中项 `--surface` 底 + 柔阴影；点击切换路由（`/` ↔ `/chat`）。
- **主操作 CTA**：黏土橙满宽按钮。知识库页=「↑ 上传文档」（点击触发文件选择并上传）；对话页=「＋ 新建对话」。busy 态显示处理文案。
- **列表区**：上方小节标题（`文档` / `最近对话`，11px 大写灰）。列表项 `flex:1` 可滚动。
- **列表项**：左状态圆点（绿=就绪/已推送、暖黄=处理中；对话项无圆点）+ 标题（单行省略）+ meta（`24 chunk · 已就绪`）+ hover 显现的操作（文档 `⋯` / 对话 `✕` 删除）。选中态 `--accent-soft` 底。hover `#E7E2D5`。
- **置底**：分隔线上方「⚙ 设置 · 秒懂凭据」入口（承接 PushDialog 凭据；本期点开仍走现有推送弹框逻辑，不新增页面）。

### Workspace — 通用
- **Header**：左=标题（无衬线，semibold，单行省略）+ 副标题 meta；右=状态 pill + 操作按钮组。底部 `--border` 分隔。
- **状态 pill**：`● 已就绪`（柔绿）；圆点 + 文字。
- **按钮层级**：`.btn`（描边白底，次级）/ `.btn.primary`（黏土实心，主操作如「推送到秒懂」）/ `.btn.danger`（红字描边，删除）。

### Workspace — 知识库（chunk 预览）
- **chunk 卡片**：暖白底 + 发丝描边 + 柔阴影。
  - head：类型徽章 + 标题路径（`›` 连接，灰）+ 右对齐 `~N tok`（tabular-nums）。
  - 徽章：`text/code` 用黏土浅底黏土字；`table` 用冷蓝浅底（`#E9EEF2`/`#3E6079`）区分；`image_caption` 同 text 体系。
  - **上下文前缀 callout**：暖橙左边框（`#E0A655`）+ `--warn-bg`，`＋上下文：…`（仅当 `context_prefix` 存在）。
  - body：`content_original`，`white-space:pre-wrap`，行高 1.7。
- **空状态**：居中衬线「从左侧选择一篇文档查看 chunk」。

### Workspace — 对话
- **scope bar**：`--surface-2` 底，`知识库范围` 标签 + 下拉（描边白底 pill 风）。
- **对话流 `.thread`**：纵向 gap 18px，可滚动。
  - **用户气泡**：黏土实心、白字、右对齐、右下尖角。
  - **助手气泡**：描边白卡、左对齐、左下尖角；下方接「溯源：…」（黏土标签 + 灰路径）与「▸ 命中的 N 个片段」可展开 details。
  - 发送中：助手位「思考中…」占位。
- **composer**：圆角输入框（描边白底 + 柔阴影）+ 黏土圆角发送按钮（`↑` 图标）。Enter 发送行为不变。
- **空状态**：居中衬线「新建或选择一个对话开始提问」。

### PushDialog（模态）
- 沿用现有逻辑与字段（域名 / accessKeyId / accessKeySecret / knowledgeBaseId、localStorage 记忆非密三项）。
- 视觉换新：暖白模态 + `12px` 圆角 + 柔投影；标题衬线可选；输入框统一描边；按钮用新 `.btn` / `.btn.primary`（确认推送）/ `.ghost`（取消）。遮罩 `rgba(40,35,25,.35)`。

## 受影响文件

| 文件 | 改动 |
|---|---|
| `apps/web/app/globals.css` | **重写**为 token + 组件类（浅色单主题、暖调） |
| `apps/web/components/Sidebar.tsx` | **新增**共享侧栏（分段切换 + CTA + 列表 + 设置入口） |
| `apps/web/components/Nav.tsx` | **退役/删除**（功能并入 Sidebar） |
| `apps/web/app/layout.tsx` | 调整外壳：去掉独立 Nav，改由各页/壳渲染 Sidebar（保持 `.app` 容器） |
| `apps/web/app/page.tsx` | 接入新 Sidebar（知识库 section：文档列表 + 上传 CTA） |
| `apps/web/app/chat/page.tsx` | 接入新 Sidebar（对话 section：会话列表 + 新建 CTA） |
| `apps/web/components/DocList.tsx` | 拆分：上传/列表逻辑迁入 Sidebar 的知识库态；保留为列表渲染或合并 |
| `apps/web/components/ConversationList.tsx` | 同上，迁入 Sidebar 的对话态 |
| `apps/web/components/DocDetail.tsx` | 套用新 Header / pill / 按钮 / chunk 卡片 类名 |
| `apps/web/components/ChatThread.tsx` | 套用新 scope bar / 气泡 / composer 类名 |
| `apps/web/components/PushDialog.tsx` | 套用新模态 / 输入 / 按钮 类名 |

> Sidebar 合并方案细节（是把 DocList/ConversationList 收进 Sidebar，还是 Sidebar 接收 children）留给实现计划阶段定；契约：Sidebar 负责「品牌 + 分段切换 + CTA + 列表区 + 设置」，工作区负责右侧内容。

## 验收标准

- 两个路由视觉与 mockup 一致：暖色单侧栏、黏土橙强调、衬线品牌/空状态、软化卡片与气泡。
- `知识库 / 对话` 分段切换可在两路由间跳转，选中态正确。
- 上传、删除、推送弹框、检索问答、scope 选择等所有现有交互行为不回归。
- `npm run typecheck --workspace @kb/web` 通过（注意 root typecheck 不覆盖 web）。
- 无新增依赖；无深色模式代码。

## 实现时再确认的外部事实（fidelity）

- 黏土橙/暖底确切色值可在实现时对照 Claude 官方设计系统（如 `awesome-design` 的 Claude DESIGN.md）微调，但以本文档 token 为基线。
