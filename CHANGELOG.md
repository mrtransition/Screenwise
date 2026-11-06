# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- **设计面板图层列表同一控件出现两条**：单控件组此前只在「组名 = 控件名」时才折叠，AI 生成或重命名后组名与控件名不同（如「登录表单」/「登录」），界面就显示成组行 + 控件行两条。现在单控件组一律折叠（组只是布局容器），组上的锁定/隐藏状态合并到该控件行；空组与多控件组仍保留组行。
- **锁定后无法解锁**：解锁也会被「已锁定的图层不可编辑」拦截，单控件组折叠后只剩一行、没有其它入口，锁定即永久卡死。现在放行「仅解锁」操作；父组锁定的继承锁仍需先解父组，子项不能绕过。

## [1.2.0] - 2026-11-06

M1 / M2 / M3 三个阶段一并对齐 SRS-M3STUDIO-001 V4.1 §11：存储 v2 与迁移、编辑器岛与手工搭屏、AI 生成与 Prompt 交付全部落地。旧 `node-tree` 屏仍可只读打开，`/tokens` 继续作为 `/design` 的兼容投影，升级不破坏既有项目数据（迁移器提供 `--dry-run` 与 `--restore`）。

#### M3 生成与 Prompt 交付

补齐 M3 的 AI 整屏生成、版本对比与 Prompt 交付链路，并修复新建 M3 屏生成后预览/导出空白的问题。

#### 新增

- **Prompt 生成**（API-020 / FR-PROMPT-*）：`GET /api/projects/:pid/prompt?lang=&screen_id=`，支持中 / 英 / 日 / 韩四种语言；单屏模式只嵌入目标屏正文，其它屏仅保留标题（C-021）。
- **Prompt 编辑与重置**：`ProjectDesign.promptEdit` 优先于自动生成内容，清空后恢复自动生成；`promptOptions` 按固定顺序追加。
- **Prompt 包导出**：`GET /api/projects/:pid/export/prompt` 下载确定性 ZIP（无第三方依赖），包含 `prompt.md` / `design.json` / `agent.md` / `README.md`；`POST /api/projects/:pid/export` 支持 `{format:'prompt'}` 返回文件 map、文件名、ZIP base64 与 digest。
- **Prompt UI**：顶栏新增「Prompt」弹层，可切换语言与范围、编辑 / 保存 / 重置、复制 Markdown、下载 `.md` / `.zip`。
- **M3 版本对比**：按 Item 返回 `added` / `removed` / `changed`，并附带 `node_id` / `tag` / 文案 / 样式 / 属性明细。
- **测试**：`tests/m3-regression.test.mjs`（4 例）、`tests/prompt.test.mjs`（6 例）。

#### 修复

- **新建 M3 屏整屏生成空白**：生成结果按目标屏幕格式转换，M3 屏写入 `groups` 结构而不是 legacy `node-tree`；预览、导出与版本内容保持一致。
- M3 生成上下文缺少热区、`assertContextIsolation` 遇到无 `root` 的 ScreenDoc 抛错。
- 应用 pending 时重新校验 M3 文档与 frame id，避免非法内容落库。
- 预览只包含 `confirmed` 边，候选边不会再变成可点击行为。
- 关联边统一校验 `target_kind ∈ screen/back/link/menu/toggle`，链接仅允许 `http/https`。
- 画布保存与测量缓存补写权限校验；整屏保存的热区保护只拦截仍被已确认边引用的 Item。
- 版本快照不再重复保存完整 Prompt 正文，只保留 `prompt_digest`。
- **multipart 导入的中文文件名乱码**：`parseMultipart` 按 latin1 切分请求体后，`filename` / `name` 没有按 UTF-8 回解，上传「项目.json」会显示成「é¡¹ç®.json」。现优先读取 RFC 5987 的 `filename*`，否则对 latin1 结果按 UTF-8 重解，不是合法 UTF-8 时保留原值。

#### 变更

- `README` 更新测试数量（220）与 M3 / Prompt 能力表。
- 修正 `README` 中残留的旧测试数量（219 / 217）与 M2 用例数（39 → 52）。

#### M2 编辑器集成

按 `SRS-M3STUDIO-001 V4.1 §11` 完成 M2。11 个验收场景（AC-302/303/304/306/307/308/309/318/319/321/322/323）全部通过，详见 `docs/M2-验收报告.md`。

#### 新增

- **保存整屏 ScreenDoc**（API-018）：`POST /api/projects/:pid/screens/:sid/doc`。校验顺序为 权限 → 锁定 → pending → 只读旧屏 → `base_version` → schema → 热区保护；任一步失败不产生版本。
- **Tidy**（API-024）：`POST .../tidy` 只预览不落库。栏位吸附只对栏类族生效，内容流左对齐 16dp、组间距 16dp，圆角按项目形状归一；自由组与锁定组不参与；同一输入二次执行零变更。
- **编辑器会话逻辑** `apps/web/src/editor-state.js`：快捷键表（V/H/空格/方向键/Delete/P/T + Ctrl 组合）、50 步撤销栈、4dp 吸附拖拽、图层锁定/隐藏/重命名/排序、部件面板检索。
- **设计面板**：侧栏新增「设计」页签，支持检索并添加 36 种部件、图层操作、Tidy、撤销/重做、保存；旧 node-tree 屏提示「转换为 M3（预览）」并展示损失报告。
- **部件目录接口**（API-028）：`GET /api/schema/kinds` 返回 36 种 kind 的 label/family/slot/尺寸/默认变体。
- **保存冲突处理**：409 时弹出「刷新到最新 / 另存为副本 / 稍后处理」，草稿不丢。
- **编辑器岛**：`apps/web/src/island.html` + `island.js` 通过 `postMessage` 承载单屏编辑；`island-host.js` 负责 origin/source 校验、信封校验、10s 超时与挂载复用。岛内不访问接口、不落库。
- **测试**：`tests/m2-editor.test.mjs`（28 例）、`tests/m2-editor-ui.test.mjs`（16 例）、`tests/m2-island.test.mjs`（6 例）；合计 201 例。

#### 修复

- 复制屏幕改为直接以「复制自 X」作为 v1，不再多出空屏基线版本（AC-309）。
- Tidy 不再把普通内容吸到 `(0,0)`：贴顶判定要求栏类族。
- `writeJsonAtomic` 写入失败时清理临时文件，不再残留 `.tmp-*`。
- 设计面板事件未绑定时搜索与按钮无响应；部件面板空态改为展示常用部件。
- **修复 `ready → load → ready` 消息回环**：宿主只在首次 `ready` 下发 `load`，岛对重复 `load` 不回 `ready`，外部回灌改用 `echo:true`。此前该回环会在 1 秒内产生上万条消息，拖垮渲染进程。
- 新增 `BRIDGE_SAVE_FAILED`，保存失败不再冒充协议错误，进入 `error` 且保留草稿与版本。
- 岛内屏按容器自适应缩放，`#canvasWrap` 占位取缩放后真实尺寸，窄面板不再裁切。
- `#islandMount` 不再随 `renderTab` 重建，切换屏幕时正确释放旧岛。
- 部件未显式指定 `size` 时，前后端布局都把默认宽夹到「屏宽 − 组横向偏移」，375 屏不再溢出。
- **新建屏幕默认改为 M3**（此前默认 `node-tree`，新建出来就是只读旧屏，M3 设计功能不可用）；前端显式传 `format`，`format:'node-tree'` 仍可指定。
- 新增 `nodeCountOf` / `anchorsOfDoc`，替换 6 处直接读 `doc.root` 的代码：M3 屏进入生成与建边链路不再 500。
- 热区集合在两种格式下统一为 `{hotspot_id,item_id,slot,text,...}`，自然语言建边可按文案匹配。
- 整屏替换的热区对比改为比较 `hotspot_id`，不再误报「丢失热区」。
- 宿主面板改动（加部件/图层/Tidy）会回灌编辑器岛；岛用 `externalDirty` 标记非撤销栈来源的改动，保存不再丢内容。
- 徽标状态存入 `state.islandBadge`，重渲染不再闪回「加载中」。
- 「属性」页签补「＋ 新建屏幕」入口。

#### 变更

- `README` 更新测试数量（190）与 M2 能力表。

#### M1 数据与存储

按 `SRS-M3STUDIO-001 V4.1 §11` 完成 M1。M1 退出条件中的 13 个验收场景（AC-301/315/316/601/603/604/605/607/608/609/610/611/612/613）全部通过，详见 `docs/M1-验收报告.md`。

#### 新增

- **存储 v2**：`project.design` 为权威主题、`design_tokens` 降为投影；屏幕坐标只存 `canvas.json`；`meta.json` 不再持有坐标；`flow.json` 不持久化 `orphan`。
- **迁移器** `apps/server/src/store/migrate.js` + 命令 `npm run migrate:v2`：`--dry-run` 只读扫描、默认备份后原地迁移、失败自动恢复、幂等跳过、`--restore <dir>` 回滚。
- **导入/导出** `apps/server/src/project/io.js`：M3E Doc、旧项目包、`.m3studio` 备份；`POST /api/projects/import` 与 `POST /api/projects/:pid/import`；先校验后写入。
- **大文件导入**：JSON / multipart / `file_path` 三条通道，统一 50MB 上限，超限 413 `IMPORT_TOO_LARGE`。
- **旧格式兼容**：`domain/legacy.js` 把 node-tree 转为 ScreenDoc 并输出损失报告；`web/src/screen-render.js` 提供独立只读渲染器（剥离 `script`/`on*`/`javascript:`）；M3 渲染器拒绝 node-tree 输入。
- **36 Kind Registry**：`domain/m3/registry.js` 落地默认尺寸、可热区、slot、尺寸约束与 Tidy 族。
- **测试**：`tests/m3-migration.test.mjs`（12 例），并入 `npm test`；合计 151 例。

#### 修复

- `service.createEdge` 缺少 `parseAnchor` 导入，导致所有建边接口 500，连带 AC-004/006、DC-001、预览路由、孤儿边、候选边与导出共 10 个用例失败。
- `importIntoProject` 缺少补偿事务，中途失败会留下半个项目；现改为失败时删除新建屏、回滚 `flow.json` 与 `screen_titles`。

#### 变更

- `README` 更新存储目录、M1 能力表与测试数量（151）。

## [1.1.0] - 2026-11-05

与 `m3e-canvas` 的产品级合并完成 M0（规格、ADR、数据模型与编辑器岛桥接契约）。**不改变 v1.0.0 运行时行为**，P0 实现验收从 M1 开始。

### 新增

- **合并版 SRS**：`docs/需求规格说明书-合并版-M3E.md`（SRS-M3STUDIO-001 V4.1），冻结 `ScreenDoc`、`ProjectDesign`、`FlowEdge`、自由组坐标与 36 Kind Registry。
- **可行性评估**：`docs/可行性评估-M3E合并.md`，含方案对比、工作量、风险矩阵、Go/No-Go 与 Kill Criteria。
- **ADR 0001–0006**：宿主+编辑器岛、ScreenDoc 单屏真源、FlowEdge 导航真源、项目级主题与版本快照、编辑器桥接协议、自由组坐标模型。
- **M0 领域模块**：`apps/server/src/domain/m3/` 的常量、schema 校验、M3E 导入导出与编辑器岛协议状态机。
- **M0 验证**：`npm run spike:m3`（往返守恒与确定性）、`npm run trace:m0`（追溯矩阵）、`docs/M0-验收报告.md`。
- **测试**：新增 `tests/m3-schema.test.mjs`、`tests/m3-import-export.test.mjs`、`tests/m3-editor-bridge.test.mjs` 共 42 例；`npm test` 合计 139 例。

### 变更

- `package.json` 新增 `spike:m3`、`trace:m0`，`npm test` 纳入 3 个 M0 测试文件。
- `README.md` 增补 M0 文档索引与命令说明，测试数量更新为 139。

### 修复

- SRS §12.5 Registry 与 `KINDS` 逐项对齐（36 种），移除不存在的 kind，补入 M3E 实际 kind。
- 清理 SRS 旧编号悬空引用；追溯矩阵当前悬空引用为 0。

## [1.0.0] - 2026-11-03

首个正式版。在 MVP 基线上补齐空间编辑，并把确定性路由、内置生成器维护与版本来源标记纳入正式验收。

### 新增

- **空间编辑（文本）**：在画布 iframe 内双击标题、正文、按钮文字即可就地编辑。
  - 失焦或回车提交一次，Esc 取消；连续输入不逐键落库。
  - 提交复用 `POST /api/projects/:pid/screens/:sid/manual-patch`，生成可回滚的 `manual_direct` 版本。
  - 仅纯文本叶子节点注入 `data-editable`，容器节点不出现编辑入口。
  - 版本摘要为语义摘要，例如「手工修改文案：「提交」→「保存」」。
- **编辑保护**：锁定屏返回 423 `SCREEN_LOCKED`；存在待确认 AI 版本时返回 409 `PENDING_EXISTS`；只读成员返回 403 `NO_PERMISSION`。
- **测试**：新增 `tests/space-edit.test.mjs`（6 例），覆盖 AC-201 / AC-202 / DC-010 / DC-014 / NFR-018、pending 拦截与客户端编辑契约。
- **发布文档**：新增本 CHANGELOG；README 与 SRS 升级到 v1.0.0 / V3.0。

### 变更

- 版本号从 `0.1.0` 升至 `1.0.0`，描述改为正式版。
- `npm test` 扩展到 10 个测试文件、97 个用例。
- SRS 将已完成的进阶条目从「规划」转为「已实现」：空间编辑（文本）、确定性路由、内置生成器维护、版本来源标记。
- 错误码文档补充 `PENDING_EXISTS`，并明确空间编辑复用统一人工写入口。

### 修复

- `manualPatch` 在存在 pending 时不再直接覆盖，改为 409 拒绝，避免待确认结果立即过期。
- 人工 patch 的版本摘要改为基于前后文档的语义摘要，不再只记录通用操作描述。
- 审计记录补充 `edit_scope`，便于区分人工编辑来源与范围。

### 已知限制

- 空间编辑仅支持文本叶子节点；图标、图片、容器与布局调整尚未开放。
- 三方合并与冲突治理仍为规划；pending 期间通过拒绝人工编辑来避免冲突。
- 独立轻量分类器尚未实现，路由为「显式指令 → 本地规则 → 大模型兜底」。

## [0.1.0] - 2026-11-03

MVP 实现基线。

### 新增

- 单项目多屏幕无限画布：创建、复制、重命名、排序、删除、拖拽定位。
- 单屏 AI 生成（整屏 / 区域 / 组件）与局部 patch 修改。
- 待确认 → 接受 / 拒绝闸门，版本快照、回滚、撤销、版本对比。
- 屏幕锁定、只读成员权限校验、审计日志与跨屏越权告警。
- 全局 AI 模型目录：内置生成器 + OpenAI 兼容模型，含连接测试、密钥脱敏与输出归一化。
- 手动拖拽建边、一句话建边（候选确认）、边属性编辑与删除、孤儿边标记。
- 应用内预览（跳转 + 返回栈）与单文件静态导出，离线可点。
- 确定性变更路由与内置生成器维护：显式指令 / 规则命中短路大模型，创作与否定语义升级。
- 版本来源标记：`manual_direct` / `builtin_rule` / `ai_patch`，记录路由层级与成本标记。
