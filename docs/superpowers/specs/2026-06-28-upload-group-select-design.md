# 上传时选择分组 — 设计

日期：2026-06-28
状态：已确认，待实现

## 背景

分组功能已完整存在（`groups` 表、`docs.group_id` 外键、`listGroups/createGroup/setDocGroup`，前端 `DocList.tsx` 支持拖拽与「⋯ 移动到」归组）。当前上传流程是：点「↑ 上传文档」→ 选文件 → **立即** POST `/api/upload`，文档默认落「未分组」，要归组只能上传后再移动。

本需求：**在上传那一刻就能指定目标分组**，省去事后移动。与现有「上传后移动」并存，不替换。

## 交互（弹框确认式）

1. 点「↑ 上传文档」→ 系统文件选择器选文件。
2. 选完文件**不立即上传**，弹出 `UploadDialog`：
   - 显示文件名；
   - 「归入分组」下拉，默认选中 **未分组**，列出当前用户的已有分组；
   - 下拉/列表末尾「＋ 新建分组」。
3. 点「＋ 新建分组」→ 弹框内**就地展开**小表单（分组名输入 + 颜色选择，复用 `GROUP_COLORS`），保存后新组立即被选为目标分组；**不离开弹框、不丢失已选文件**。
4. 点「开始上传」→ 带 `groupId` POST `/api/upload`，文档直接落入该分组；点「取消」清空待传文件、不上传。

约束：
- **分组可选**，默认未分组。
- 仍为**单文件上传**（不引入多文件多选，YAGNI）。
- 后台异步处理（解析 → 造结构 → 入库）流程完全不变，`groupId` 只在建文档行那一刻写入。

## 前端改动

### 新增 `apps/web/components/UploadDialog.tsx`

独立组件，职责单一：选目标分组并确认上传。

Props：
```ts
{
  open: boolean;
  fileName: string;
  groups: GroupItem[];
  onClose: () => void;                          // 取消，清空待传文件
  onConfirm: (groupId: string | null) => Promise<void>;  // 开始上传
  onCreateGroup: (name: string, color: string | null) => Promise<GroupItem>; // 内联建组，返回新组
}
```

内部状态：`targetGroupId: string | null`（默认 `null`=未分组）、内联建组小表单的开合与 `name`/`color`、`busy`/`err`。
内联建组：调用 `onCreateGroup` → 拿到新 `GroupItem` → `setTargetGroupId(newGroup.id)` → 收起小表单。

### 改 `apps/web/components/DocList.tsx`

把现有 `upload()` 拆成两步：
- `onFilePicked()`：文件 input 的 `onChange` 触发，把选中的 `File` 存进组件 state（如 `pendingFile`），打开 `UploadDialog`。**不立即上传。**
- `confirmUpload(groupId)`：构建 `FormData`，`append("file", pendingFile)` + `append("groupId", groupId ?? "")`，POST `/api/upload`，沿用原有成功/失败处理（清空 input、`onUploaded(docId)`、错误展示）。

`UploadDialog` 的 `onCreateGroup` 接 `DocList` 的 `onCreateGroup` prop（透传到 `page.tsx`）。

### 改 `apps/web/app/page.tsx`

`createGroup` 改为**返回新建的 `GroupItem`**：POST `/api/groups` 的响应已含 `{ group: {...} }`，在 `await load()` 之前接住该 `group` 并 `return` 它。

`DocList` 的 `onCreateGroup` prop 类型相应改为 `(name, color) => Promise<GroupItem>`。`GroupDialog` 经由 `DocList` 调用 `onCreateGroup` 的那条 `onSubmit` 包装器仅 `await` 不读返回值，类型仍兼容（`Promise<void>` 包装器内 await 一个返回值的 Promise，OK），无需改 `GroupDialog`。

## 后端改动

### `apps/web/app/api/upload/route.ts`

- 从 `form.get("groupId")` 读取（字符串或空）。
- 归一：空串 → `null`。
- 若非空：**校验该组属于当前用户**，用新增 repo 助手 `groupBelongsToUser(groupId, userId)`；不属于 → 返回 400 `{ error: "分组不存在" }`。
- 把 `groupId`（已校验，或 null）作为新参数传给 `createProcessingDoc(...)`。

### `packages/db/src/repo.ts`

- `createProcessingDoc` 增加可选参数 `groupId: string | null = null`，写进 `db.insert(docs).values({ ..., groupId })`。放在末位以兼容现有调用。
- 新增 `groupBelongsToUser(id: string, userId: string): Promise<boolean>`，复用 `setDocGroup` 中的 EXISTS 思路（`SELECT 1 FROM groups WHERE id = ? AND user_id = ?`）。

## 边界与不变量

- 上传中途用户删除了目标分组：`docs.group_id` 外键 `onDelete: set null` 自动把文档移回未分组，不报错。
- `groupId` 仅在建文档行时写入；后台处理崩溃/取消时行为与现状一致（删行或标失败）。
- 多用户隔离：上传只能选/落入**本人**分组（服务端 `groupBelongsToUser` 校验把关，前端下拉本就只列本人分组）。

## 测试 / 验证

- `npm run typecheck --workspace @kb/web`（root typecheck 不覆盖 apps/web）+ `npm run typecheck`（db 包）。
- 手动：选文件 → 弹框默认未分组 → 选已有分组上传 → 文档出现在该组；选「＋ 新建分组」建组并上传 → 新组出现且文档在内；取消不产生文档；带非法 groupId 直接打接口应 400。

## 非目标（YAGNI）

- 多文件批量上传与逐文件分组。
- 拖拽文件到某分组段直接上传（现有拖拽仅用于移动已存在文档）。
- 上传后在弹框里改其它元数据（标题等）。
