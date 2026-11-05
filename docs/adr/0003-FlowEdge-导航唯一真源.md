# ADR 0003：以 `FlowEdge` 作为导航唯一真源

- **状态：** 已接受
- **日期：** 2026-11-05
- **决策者：** 架构组
- **相关：** SRS-M3STUDIO-001 V4.1 §5.2、§5.5、FR-FLOW-007/010/012、DC-001/DC-039/DC-040

## 背景

M3E 把导航写在 `Item.action`、`Item.actions[slot]` 和 `Frame.swipe[dir]` 上；`prd-diy` 则把关联独立存储。合并后若同时保留两套真源，会出现：

- 重新生成屏幕后 action 丢失，关联断裂。
- 改一条边需要改屏幕内容，违反“关联不改屏幕”。
- 孤儿边无法在不触碰屏幕的情况下标记。
- AI 输出可能夹带 action，绕过关联权限。

## 决策

1. `flow.json` 中的 `FlowEdge` 是导航唯一真源；M3E 的 `action/actions/frame.swipe` 只做导入/导出投影。
2. `FlowEdge` 字段固定为：`edge_id/source_screen_id/source_item_id/source_slot/target_kind/target_screen_id/url/trigger/direction/transition/note/status/expires_at/created_at/created_by`。
3. `target_kind ∈ screen/back/link/menu/toggle`；`trigger ∈ click/swipe/auto`。
4. `swipe` 作为 `trigger`，方向写入 `direction ∈ left/right/up/down`；缺 `direction` 拒绝（DC-040）。
5. `orphan` **动态计算**，不写入 `flow.json`；`flow.json` 的 hash 不因孤儿状态变化（DC-039）。
6. 孤儿原因：`source_missing/target_missing/item_missing/slot_missing`。
7. 导入时默认 `status:"confirmed"`；AI 产出的边默认 `candidate`，确认后落库。
8. 导出时 `trigger:"swipe"` 投影到 `frame.swipe[direction]`；点击边投影到 `item.action` 或 `item.actions[slot]`；孤儿边与 candidate 边不导出。

## 备选方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 以 `Item.action` 为真源 | 不采用 | 屏重生成会丢边；改边会改屏幕；违反隔离 |
| 双写 `action` 与 `FlowEdge` | 不采用 | 双真源必然漂移，冲突处理复杂 |
| `swipe` 作为 `target_kind` | 不采用 | 目标类型与触发方式混在一起，且与 M3E 手势模型不对齐 |
| 持久化 `orphan` | 不采用 | 任何屏/Item 变化都要回写 flow，破坏隔离与 hash 稳定性 |
| `FlowEdge` 真源 + 投影 + 动态 orphan | **采用** | 满足隔离、可回滚、可导出，且与 M3E 手势对齐 |

## 后果

**正面**

- 改边、删边、标记孤儿都不触碰任何屏幕版本。
- 屏幕回滚后边仍按 `Item id` 存活；Item 消失时读取即标记孤儿。
- 导出可重复：边按稳定顺序投影。

**负面 / 代价**

- 读取 flow 时需要屏幕索引来计算孤儿，API 需返回计算后的 `orphan`。
- 同一屏同方向多条 swipe 边需要冲突策略（当前保留首条并告警 `EDGE_CONFLICT`）。
- `source_slot` 需要与 kind 的热区 slot 约定一致，否则标记 `slot_missing`。

## 约束

- 边不内嵌 groups/items/label/尺寸快照。
- `link` 只允许 `http/https`；`back` 走返回栈。
- 删除有边的屏幕必须先处理边（409 `EDGES_EXIST`）。
- 同一屏同一 slot 的多条边由 UI 阻止；导入冲突保留首条并告警。

## 验证

- `tests/m3-schema.test.mjs`：trigger/direction/expires_at、orphan 禁止持久化。
- `tests/m3-import-export.test.mjs`：swipe direction、动态 orphan、candidate 不导出、方向冲突。
- `tests/preview-export.test.mjs`：既有预览路由与孤儿边行为回归。
