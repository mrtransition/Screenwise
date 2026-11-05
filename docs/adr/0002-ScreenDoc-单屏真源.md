# ADR 0002：以 `ScreenDoc` 作为单屏设计真源

- **状态：** 已接受
- **日期：** 2026-11-05
- **决策者：** 架构组
- **相关：** SRS-M3STUDIO-001 V4.1 §5.1、§5.2、§5.3、§5.6、C-016/C-018/C-019、DC-036/DC-037

## 背景

旧 `prd-diy` 的单屏文档是任意 `node-tree`，节点可嵌套 HTML、样式和任意属性。合并后采用 M3 语义部件模型，需要回答：

- 单屏文档的边界是什么？
- 版本快照存什么？
- 屏幕坐标放在哪里？
- 自由组和图层字段如何表达？
- 旧 `node-tree` 文档怎么办？

## 决策

1. 单屏设计文档统一为 `ScreenDoc`：`{ schema, format:"m3", frame, groups, meta }`。
2. `frame.id = screen_id`；`ScreenDoc` 内 `frame.x = frame.y = 0`。屏幕在画布上的位置只存 `canvas.json`。
3. 组模型为 `Group`：`axis ∈ x/y/free`；自由组内 `Item.pos` 为屏幕本地绝对坐标；非自由组禁止 `Item.pos`（DC-036）。
4. 图层字段：`Group.name/locked/hidden`、`Item.name/locked/hidden`；`hidden` 默认不进入导出（DC-037）。
5. 版本快照存完整 `ScreenDoc`，不是 diff 链；同时携带 `theme_snapshot` 与 `prompt_digest`。
6. 旧 `node-tree` 文档只读兼容：读取时标记 `format:"node-tree"`，通过旧格式只读渲染器呈现，显式转换后才生成 `ScreenDoc`，原版本不覆盖。
7. `ScreenDoc` 严格禁止持久化 `action/actions/frame.swipe`；导航只存 `FlowEdge`。

## 备选方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 继续使用 `node-tree`，M3 部件只是节点类型 | 不采用 | 无法约束 36 种 kind 的属性、尺寸与热区，AI 输出不可控 |
| 项目级只存一份大 Doc | 不采用 | 违反单屏隔离，A 屏保存会触碰 B 屏 |
| 单屏存 M3E `Doc`（含所有 frames） | 不采用 | 版本粒度过大，且会把项目级主题复制到每屏 |
| `ScreenDoc` + 独立 `ProjectDesign` + 独立 `flow.json` | **采用** | 隔离、版本、导出与 M3E 互操作都可满足 |

## 后果

**正面**

- 单屏版本可以逐字节比较与回滚。
- AI 上下文只读目标 `ScreenDoc`，天然满足上下文隔离。
- M3E 导入/导出有明确投影：`frame ↔ ScreenDoc`，`action ↔ FlowEdge`。

**负面 / 代价**

- 需要维护 schema 版本与迁移器。
- 自由组坐标、图层字段、隐藏导出规则增加编辑器与导出的复杂度。
- 旧文档需要两套渲染路径（M3 + node-tree 只读）。

## 约束

- `SCREEN_SCHEMA = "m3studio/screen@1"`；`format` 仅允许 `m3` 或只读标记 `node-tree`。
- `ScreenDoc` 内 Item id 屏内唯一，Group id 屏内唯一。
- 保存必须携带 `base_version`（DC-032）；版本前进时拒绝覆盖。
- `measurements.json` 只是缓存，不得作为版本或导出的唯一依据（DC-033）。

## 验证

- `tests/m3-schema.test.mjs`：ScreenDoc、自由组、图层、Item.pos、版本快照。
- `tests/m3-import-export.test.mjs`：M3E ↔ ScreenDoc 往返、自由组坐标守恒、隐藏导出。
- `scripts/m3-spike.mjs`：可运行的导入 → 导出 → 再导入守恒检查。
