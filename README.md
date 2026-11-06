# AI 逐屏原型工作流工具 · v1.2.0

> 逐屏独立生成，最后统一关联。核心原则：**存储隔离、上下文隔离、编辑隔离**。

按 `docs/需求规格说明书.md`（SRS-AIPROTO-003）实现的可运行正式版。  
v1.2.0 完成与 `m3e-canvas` 合并的 M1 / M2 / M3：**存储 v2 与迁移**、**编辑器岛与手工搭屏**、**AI 整屏生成与 Prompt 交付**（详见下文的 M1 / M2 / M3 章节）。v1.1.0 是 M0 基线（规格、ADR、数据模型与编辑器岛桥接契约），运行时行为与 v1.0.0 一致；v1.0.0 在 MVP 基线上补齐了**画布内直接编辑文案（空间编辑）**、内置生成器维护与**确定性路由**、**版本来源标记**。

> **M0 合并基线（已完成）：** 与 `m3e-canvas` 的产品级合并以 `docs/需求规格说明书-合并版-M3E.md`（SRS-M3STUDIO-001 V4.1）为准。M0 已完成规格、ADR、数据模型与编辑器岛桥接的契约验证，M1 / M2 / M3 已在 v1.2.0 落地并通过验收。

---

## 快速开始

```bash
npm start              # 启动服务，默认 http://127.0.0.1:8787
PORT=8788 npm start    # 端口被占用时换一个
npm test               # 224 个验收/回归用例（原有 97 + M0 42 + M1 13 + M2 55 + M3/Prompt 17）
npm run spike:m3       # M3E Doc ↔ ScreenDoc / FlowEdge 往返 spike
npm run trace:m0       # 生成 M0 追溯矩阵报告
npm run migrate:v2 -- --dry-run   # 只读扫描待迁移项目（存储 v1 → v2）
```

也可以在任意目录直接运行入口文件，相对路径与绝对路径都行：

```bash
node apps/server/src/index.js
node <仓库路径>/prd-diy/apps/server/src/index.js
```

启动成功后终端会打印三行地址，这时再访问浏览器：

```
[proto] 界面 http://127.0.0.1:8787/
[proto] API  http://127.0.0.1:8787/api/health
[proto] data <仓库路径>\data
```

> 如果终端没有任何输出、命令瞬间就结束，说明启动入口没有执行。
> 当前版本的入口判断已用 `pathToFileURL` 归一化，相对路径也能正确识别，
> 并由 `tests/startup.test.mjs` 守护；若再次出现，运行 `npm test` 会立即暴露。

零依赖、零构建：后端只用 Node 内置模块，前端为原生 ESM，进程启动即可用。
要求 Node ≥ 20（开发验证使用 Node 24）。

数据落在 `data/`，导出物落在 `exports/`，两者都在 `.gitignore` 中。

### v1.0.0 亮点

- **空间编辑**：在画布上双击标题、正文、按钮文案即可就地修改；失焦 / 回车提交一次，Esc 取消，保存为可回滚的 `manual_direct` 版本。
- **确定性路由**：显式结构化指令与高置信度规则命中时短路到内置生成器，不消耗大模型 token；带创作意图或否定语义的请求自动升级到大模型。
- **内置生成器可维护**：名称、启用范围（全局 / 仅显式 / 关闭）、规则开关、路由总开关均可在界面维护，配置只影响之后的生成。
- **版本来源可追溯**：每个版本标记 `manual_direct` / `builtin_rule` / `ai_patch`，并记录路由层级、命中规则与成本标记（内置生成器 `ai_cost=0`）。
- **发布工程**：版本号、README、SRS、CHANGELOG 与 139 个测试用例同步到 v1.0.0。

---

## 5 分钟走通主链路

1. **新建项目** → 填名称（如「报销审批流程」），设备尺寸默认 375×812；可顺手选主色与圆角，作为跨屏共享的设计规范。
2. **新建屏幕** → 依次建「登录页 / 审批列表 / 审批详情 / 提交成功」，只登记名称，不消耗生成。屏幕清单支持上移/下移调整顺序。
3. **逐屏生成**：点某个屏 → 右侧「生成」→ 选范围（整屏/区域/组件）→ 输入需求 → 生成。
   - 选「区域 / 组件」后点「在屏幕上选择」，再点屏幕内任意区块即可限定修改范围；服务端会校验选区节点真实存在。
   - 结果先进入**待确认**状态，右侧展示影响范围（哪些节点被改），不会自动写入。
   - 点「接受并生成新版本」才落库；点「拒绝」则屏幕完全不变。
4. **直接改文案（空间编辑）**：在画布上**双击**标题、说明或按钮文字，就地修改；失焦或回车提交一次，Esc 取消。
   - 保存后生成一条「人工」版本（`manual_direct`），版本摘要形如「手工修改文案：「提交」→「保存」」，可随时回滚。
   - 锁定屏、存在待确认结果、只读成员都会被拒绝；连续输入不会逐键落库。
5. **局部修改**：对同一屏输入「把 welcome 改成 xxx」这类指令，会输出**局部 patch**而不是整屏重写。
   确定性修改会短路到内置生成器（版本标记 `builtin_rule`，0 token）；创作类描述才走大模型。
6. **版本**：版本页可预览任意历史版本；点「与 vN 对比」并排查看两版内容并高亮新增/修改/删除节点；「撤销上一次变更」等价于回退一个版本，不删除历史。
   版本列表用徽标区分人工 / 内置生成器 / 大模型来源。
7. **设计规范**：顶栏「设计规范」可改主色、正文色、底色、圆角、字号与字体族，后续生成自动注入。
8. **锁定**：属性页可锁定。锁定后生成、空间编辑与手动 patch 都会被拒绝（服务端返回 423，不只是按钮置灰）。
9. **切到「关联」**：画布进入只读，屏幕内的热区显示为紫色描边点。从热区**拖到目标屏**即建边。
   也可以用「用一句话建边」，系统只产出候选边，需你确认才保存。
10. **预览**：点「▶ 预览」从当前屏进入，点热区按边跳转，支持返回栈；未配置的热区会提示而不会乱跳。
11. **导出**：生成 `exports/<name>/index.html`，双击即可独立运行（不依赖后端）；导出目录名会在服务端清洗，不能越出 `exports/`。

---

## M0 合并基线：文档与契约

M0 阶段只交付**规格、ADR、数据模型 spike、编辑器岛协议与追溯矩阵**，不改变 v1.0.0 的运行时行为。

| 文档 | 说明 |
|---|---|
| `docs/需求规格说明书-合并版-M3E.md` | 合并版 SRS V4.1（SRS-M3STUDIO-001），M0 设计基线，P0 为 M1–M4 验收范围 |
| `docs/可行性评估-M3E合并.md` | 方案对比、工作量、风险矩阵、Go/No-Go 与 Kill Criteria |
| `docs/M0-验收报告.md` | M0 交付物、验证结果与 10 项复审门禁 |
| `docs/编辑器岛桥接协议.md` | 宿主 ↔ M3 编辑器岛协议 v1（消息、状态机、错误码、安全校验） |
| `docs/adr/` | ADR 0001–0006：宿主+编辑器岛、ScreenDoc、FlowEdge、主题与版本、桥接协议、自由组坐标 |
| `docs/追溯矩阵-M0.md` | `npm run trace:m0` 生成的编号覆盖报告 |

实现与测试：

| 路径 | 说明 |
|---|---|
| `apps/server/src/domain/m3/constants.js` | 36 种 M3 Kind、FlowEdge 枚举、slot/orphan 规则 |
| `apps/server/src/domain/m3/schema.js` | `ScreenDoc` / `ProjectDesign` / `FlowEdge` / 版本快照校验 |
| `apps/server/src/domain/m3/convert.js` | M3E Doc ↔ `ScreenDoc`/`FlowEdge` 导入导出、自由组坐标、动态 orphan |
| `apps/server/src/domain/m3/bridge.js` | 编辑器岛协议 v1 与状态机 |
| `scripts/m3-spike.mjs` | `npm run spike:m3`：导入 → 导出 → 再导入守恒与确定性 |
| `tests/m3-*.test.mjs` | 42 例 M0 契约测试（schema 13 / 导入导出 17 / 桥接 12） |
| `tests/fixtures/m3e-sample.json` | 3 frame + 自由组 + 未放置组 + action/swipe 的往返样例 |

M0 结论：**有条件 Go**。若触发 Kill Criteria，回退到“仅 M3E 导入导出 + 只读预览”，保留 `ScreenDoc` / `FlowEdge` 契约。

---

## M1 数据与存储：已完成

M1 落地了存储 v2、schema/Registry、M3E 导入导出、旧 `node-tree` 只读兼容与只读渲染、迁移器与 50MB 导入通道。验收对照见 `docs/M1-验收报告.md`。

| 能力 | 路径 | 说明 |
|---|---|---|
| 存储 v2 目录 | `apps/server/src/store/repo.js` | `project.design` 权威、`canvas.json` 唯一坐标源、`flow.json` 不含 orphan |
| 迁移器 | `apps/server/src/store/migrate.js` | 备份 → 迁移 → 失败自动恢复；幂等；可 `--restore` |
| 迁移命令 | `scripts/migrate-v2.mjs` | `npm run migrate:v2 [-- --dry-run/--restore <dir>/--root <dir>]` |
| 导入/导出/备份/校验 | `apps/server/src/project/io.js` | M3E Doc、旧项目包、备份包；先校验后写入，失败零残留 |
| 旧文档转换 | `apps/server/src/domain/legacy.js` | node-tree → ScreenDoc，输出 `{node_id, tag, reason, fallback}` 损失报告 |
| 36 Kind Registry | `apps/server/src/domain/m3/registry.js` | 默认尺寸、可热区、slot、尺寸约束、Tidy 族 |
| 共享渲染器 | `apps/web/src/screen-render.js` | M3 与旧格式各走独立渲染器；旧格式剥 `script`/`on*`/`javascript:` |
| 导入通道 | `apps/server/src/app.js` | JSON / multipart / `file_path`，统一 50MB 上限与 413 `IMPORT_TOO_LARGE` |
| M1 测试 | `tests/m3-migration.test.mjs` | 13 例：AC-301/315/316/601/603/604/605/607/608/609/610/611/612/613 |

M1 修复了两个阻断问题：`service.createEdge` 缺少 `parseAnchor` 导入（建边全 500）；`importIntoProject` 缺补偿事务（失败会留半个项目）。

---

## M2 编辑器集成：已完成

M2 把「手工搭屏」做成了可用闭环：侧栏「设计」页签里选部件、调图层、按 Tidy 排版、撤销重做，保存时走 `base_version` 校验。验收对照见 `docs/M2-验收报告.md`。

| 能力 | 路径 | 说明 |
|---|---|---|
| 保存整屏 ScreenDoc | `POST /api/projects/:pid/screens/:sid/doc` | API-018：`base_version` 必填；锁定/pending/只读/冲突逐层拦截 |
| Tidy | `apps/server/src/domain/m3/tidy.js`、`POST .../tidy` | API-024：栏位吸附、16dp 边距、圆角统一；幂等且不落库 |
| 编辑器会话逻辑 | `apps/web/src/editor-state.js` | 快捷键、50 步撤销栈、4dp 吸附、图层操作、部件检索（纯逻辑） |
| 编辑器岛 | `apps/web/src/island.html`、`island.js` | iframe 内只渲染单屏与处理交互，不访问接口、不落库 |
| 岛屿宿主 | `apps/web/src/island-host.js` | origin/source 与信封校验、10s 超时、挂载复用、`echo` 回灌 |
| 设计面板 | `apps/web/src/main.js` | 部件面板、图层锁定/隐藏/重命名、Tidy、保存、冲突处理 |
| 部件目录 | `GET /api/schema/kinds` | API-028：36 种 kind 的面板元数据 |
| M2 测试 | `tests/m2-editor.test.mjs`、`tests/m2-editor-ui.test.mjs`、`tests/m2-island.test.mjs` | 52 例，覆盖 AC-302/303/304/306/307/308/309/318/319/321/322/323 |

保存冲突（AC-319）不会覆盖：服务端返回 409 与当前版本号，「刷新到最新 / 另存为副本」二选一，本地草稿始终保留。

编辑器岛与宿主只做一次 `ready → load` 握手（`docs/编辑器岛桥接协议.md` §3「回环约束」）：宿主不重复下发 `load`，岛对重复 `load` 不回 `ready`，外部回灌走 `load{echo:true}`。

---

## M3 生成与 Prompt 交付：已完成

M3 在 M2 的手工编辑能力上补齐了「AI 生成 → 版本对比 → 交给编码 Agent」的闭环，并修复了新建 M3 屏整屏生成后预览/导出空白的问题。

| 能力 | 路径 | 说明 |
|---|---|---|
| 按目标格式生成 | `apps/server/src/service.js` | 新建 M3 屏整屏生成仍产出 `groups`，不再误写 legacy `node-tree` |
| M3 版本对比 | `GET .../versions/:a/diff/:b` | 按 Item 返回 `added/removed/changed` 与文案/样式/属性明细 |
| 生成上下文 | `apps/server/src/ai/context.js` | M3 热区与单屏隔离统一，不注入其他屏正文 |
| Prompt 生成 | `GET /api/projects/:pid/prompt` | API-020：`lang=zh/en/ja/ko`，`screen_id` 可切单屏隔离 |
| Prompt 编辑与重置 | `apps/server/src/prompt/build.js` | `promptEdit` 优先，清空后恢复自动生成 |
| Prompt 包 | `GET /api/projects/:pid/export/prompt` | ZIP：`prompt.md` / `design.json` / `agent.md` / `README.md` |
| Prompt 导出 API | `POST /api/projects/:pid/export` | `{format:'prompt'}` 返回文件 map、文件名、ZIP base64 与 digest |
| M3/Prompt 测试 | `tests/m3-regression.test.mjs`、`tests/prompt.test.mjs` | 10 例，覆盖格式一致性、版本 diff、热区/边校验、四语言与包导出 |

Prompt 版本快照只保存 `prompt_digest`（`sha256:<hex>`），不重复保存完整正文；单屏 Prompt 只嵌入目标屏内容，其他屏仅保留标题。

---

## 三层隔离如何实现

### 1. 存储隔离

```
data/projects/<pid>/
├─ project.json          schema_version:2 + design（权威主题）+ design_tokens（投影）
├─ design-revisions.json 主题/设计规范变更（只追加，不动屏幕版本号）
├─ canvas.json           画布视口与屏幕位置（唯一坐标源）
├─ ui-state.json         编辑器 UI 状态（面板宽度、标签、收藏）
├─ flow.json             关联边（只存 screen_id + item_id + slot + 目标，不含 orphan）
├─ measurements.json     文本宽度测量缓存（非权威）
├─ history.json          job / patch / audit
└─ screens/<sid>/
   ├─ meta.json          状态、锁定、当前版本号、format、待确认结果（不含坐标）
   └─ versions/v<n>.json 每次变更的完整 ScreenDoc 快照 + theme_snapshot
```

> `data/ai-models.json` 是**全局** AI 模型目录（跨项目共享），不属于任何项目目录；API Key 只保存在服务端文件里，接口只返回是否已配置和末四位。

- `flow.json` 里**没有任何页面内容**：不含节点树、不含 HTML、不含尺寸快照。测试 `DC-001 / FR-FLOW-005` 直接断言这一点。
- 版本用整文件快照而非 diff 链：回滚只是切 `meta.current_version` 指针，不需要反向重放 patch。

### 2. 上下文隔离

`apps/server/src/ai/context.js` 是唯一的上下文构造入口。每次生成只注入：

- 全局设计 token（跨屏唯一共享物，对应 C-006 / AI-005）
- **当前屏**节点树 + 热区列表
- 其他屏的**标题**（仅用于文案风格参考，且截断到 40 字符）
- 用户指令

不注入：其他屏正文、其他屏版本历史、画布坐标、边列表。

每次生成会把 `context_audit.embedded_screen_ids` 写进 job 记录，测试 `NFR-003` 断言该数组只有目标屏。

### 3. 编辑隔离

| 手段 | 位置 |
|---|---|
| AI 写入白名单（除目标屏外任何 `screen_id` 一律拦截） | `service.js` `detectCrossScreenOutput` |
| patch 只按 `node_id` / `data-anchor` / `data-block` 定位，拒绝 `nth-child` 等结构选择器 | `domain/patch.js` `validatePatch` |
| 同屏写入串行、异屏并行 | `store/fs.js` `KeyedQueue` |
| 版本只由 `commitVersion` 递增；AI 走 `applyPending`，人工走 `manualPatch` | `store/repo.js` |
| 空间编辑只提交文字叶子节点，容器节点不注入编辑入口 | `web/render.js` `data-editable` |
| 人工编辑标记 `manual_direct`，不得伪装为 AI 版本 | `service.js` `manualPatch` / `repo.commitVersion` |
| 锁定在服务端校验 | `service.js` `startGeneration` / `manualPatch` / `rollback` |

---

## 关键设计取舍

**为什么 patch 优先于整屏生成**：SRS BR-003 要求「修改类任务优先输出局部 patch」。判据采用**屏幕是否已有内容**，而不是 `edit_scope`——`scope=screen` 只表示允许整屏重写，不代表每次都要重写。若模型对修改类指令仍返回整屏，会被判为违反契约并拒绝落库（`INVALID_OUTPUT`）。

**为什么热区标识写在页面里**：`data-anchor` 由页面自己声明，关联层只引用名字。这样页面重新生成后，只要同名 anchor 保留，连线自动继续有效；anchor 消失时边标记为 `orphan.hotspot_missing` 并在画布上变红，但**不自动删除**——连线是用户资产。

**为什么版本是快照**：单屏最多留 20~50 个版本时，快照换取的是「回滚绝对不影响别人」和「任意版本可独立打开」。diff 链会让回滚变成一串依赖重放，反而破坏隔离。

---

## 代码结构

```
apps/
├─ server/src/
│  ├─ domain/doc.js        节点树：遍历、查找、锚点、指纹、校验
│  ├─ domain/patch.js      patch 校验与应用（原子、拒绝越界）
│  ├─ ai/context.js        ★ 上下文隔离闸门
│  ├─ ai/models.js         全局模型目录（CRUD / 激活 / 密钥脱敏 / 生成器维护）
│  ├─ ai/router.js         确定性路由：显式 / 规则 / 大模型分层决策
│  ├─ ai/rules.js          路由与生成器共用的规则表（含否定/创作意图防护）
│  ├─ ai/provider.js       provider 适配层（local / OpenAI 兼容）
│  ├─ ai/local.js          内置确定性生成器（模板 + 规则 patch）
│  ├─ store/repo.js        文件系统仓储 + 版本提交 + 并发锁
│  ├─ service.js           业务规则（隔离、锁定、孤儿边、审计）
│  ├─ app.js               REST 路由
│  └─ export/static.js     导出可独立运行的静态包
└─ web/src/
   ├─ canvas.js            无限画布、节点、热区拖拽连线
   ├─ render.js            节点树 → HTML（与导出共用契约）
   └─ main.js              三种工作态：画布 / 关联 / 预览
```

---

## AI 模型：维护与选择

顶栏的 `AI: …` 胶囊是模型入口，点击可新增、编辑、删除和切换模型。模型目录是**全局**配置（`data/ai-models.json`），对所有项目生效。

- **内置生成器 `mdl_local`**：确定性、无网络依赖，永远存在，不能删除或停用；任何自定义模型失效时自动回退到它。
- **OpenAI 兼容模型**：填写模型标识与 Base URL，系统请求 `Base URL + /chat/completions`。API Key 可选，适合自建网关；密钥只保存在服务端，列表接口只返回 `has_api_key` 与末四位。
- **切换范围**：当前模型只影响**之后**的生成任务；已生成版本、屏幕内容、历史记录都不会被改写。每个 job 会记录生成时使用的模型快照（不含密钥）。
- **更新密钥**：编辑时留空表示保持原密钥；勾选「清除已保存的密钥」才会清空。
- **测试连接**：模型卡片上的「测试连接」会真正发一次最小请求，直接暴露地址 / 密钥 / 模型名三类问题，不用等到生成时才发现。
- **内置生成器维护**：点击内置模型卡片上的「维护」，可改名称、启用范围（`global` / `explicit_only` / `off`）、逐条规则开关与路由总开关。`off` 等价于关闭确定性路由，确定性请求也会走大模型。
- **路由可观测**：每次生成把 `route_layer` / `rule_id` / `is_deterministic` / `ai_cost` 写入 job；可用 `GET .../route-logs` 按屏查询，日志不含 prompt 正文与密钥。

相关接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/models` | 模型列表 + `active_model_id`（脱敏） |
| `POST` | `/api/models` | 新增模型 |
| `PATCH` | `/api/models/:mid` | 更新模型（`api_key` 留空保持，`clear_api_key:true` 清除） |
| `DELETE` | `/api/models/:mid` | 删除自定义模型；内置模型拒绝 |
| `POST` | `/api/models/:mid/activate` | 设为当前模型 |
| `POST` | `/api/models/:mid/test` | 连接测试，返回 `{ ok, latency_ms, message, detail.hint }` |
| `GET` | `/api/generator` | 内置生成器配置（范围 / 规则 / 路由开关） |
| `PATCH` | `/api/generator` | 维护内置生成器（名称 / `scope` / `rules` / `router_enabled`） |
| `GET` | `/api/projects/:pid/screens/:sid/route-logs` | 最近 100 条路由决策日志（脱敏） |
| `GET` | `/api/health` | 返回当前生效模型的 `provider` / `model` / `base_url` / `name` / `route_enabled` |

首次启动且没有模型目录时，仍兼容旧的环境变量用法：

```bash
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://your-gateway/v1
AI_API_KEY=***
AI_MODEL=your-model
```

此时会生成一个 `source=env` 的模型并设为当前模型；之后可在界面里继续维护。

### 自定义模型接入的兼容范围

内置生成器的输出天然符合内部契约，自定义模型不会，因此 `apps/server/src/ai/provider.js` + `normalize.js` 承担了"让它能用"的适配：

| 差异点 | 处理方式 |
|---|---|
| Base URL 只写域名 / 写到 `/v1/` / 直接贴 `/chat/completions` | 统一归一，不会出现 `/chat/completions/chat/completions` |
| 网关不支持 `response_format` / `max_tokens` | 识别到该参数被拒时自动去掉并重试一次，`max_tokens` 被点名 `max_completion_tokens` 时换字段重试 |
| 连接失败 / 超时 / 401 / 404 / 429 | 统一 `502 MODEL_FAILED`，带 `detail.hint` 与 `detail.endpoint`，不再冒 500 堆栈 |
| 返回 ```json 代码块、前后夹带说明文字 | 依次尝试直解析 → 代码块提取 → 括号配平截取 |
| `content` 是 parts 数组 / `reasoning_content` / `tool_calls.arguments` | 依次兜底提取 |
| 整屏返回的是 HTML 字符串 | 极简 HTML 解析回节点树，不再压平成一段文字 |
| 属性平铺在节点上（`data-anchor`、`style:"a:b"`、`text` 不在 props） | 归一化到 `props.style` / `props.attrs` / `props.text` |
| `{"root":…}` 少 `version`、节点缺 id、children 混入字符串、id 重复 | 自动补齐 / 重命名 / 转文本节点 |
| 可点击元素没有 `data-anchor` | 按 `button` / `a` / role / 按钮型样式补齐唯一热区，保证流程能连边 |
| patch 用了 `setText` / `modify` / `addChild` 之类的别名 | 映射到 `updateProps` / `insertChild` 等内部 op，无法识别的单条 op 丢弃而不是整批失败 |
| 修改类指令返回了整屏 `doc` | 按整屏待确认接受；**仅当会丢失本屏已有热区**时才拒绝，避免流程断线 |
| 输出被 `max_tokens` 截断 | 明确报"输出被长度限制截断"，提示调大上限 |

默认输出预算为 8192 token（`AI_MAX_TOKENS` 可覆盖）；整屏节点树较大时网关按默认值容易截断，需要时在网关侧或该环境变量调大。

仍然会被拒绝（落库前）：完全缺 `root`、返回数组、夹带其他 `screen_id`、patch 目标不在本屏。这类输出不会产生版本，屏幕内容保持不变。

---

## 测试覆盖

`npm test` → 224 个用例全部通过（含 `tests/remote-model.test.mjs` 自定义模型接入 16 例、`tests/space-edit.test.mjs` 空间编辑 6 例、M0 的 `tests/m3-*.test.mjs` 42 例、M1 的 `tests/m3-migration.test.mjs` 13 例、M2 的 `tests/m2-editor.test.mjs` 33 例、`tests/m2-editor-ui.test.mjs` 21 例与 `tests/m2-island.test.mjs` 6 例、M3 的 `tests/m3-selection.test.mjs` 6 例与 `tests/m3-regression.test.mjs` 5 例、Prompt 的 `tests/prompt.test.mjs` 6 例）。

**空间编辑（space-edit.test.mjs）**
- `AC-201` 直接改文案生成一条 `manual_direct` 版本，摘要包含「旧文案 → 新文案」
- 空间编辑可被版本撤销恢复，且撤销不删除历史版本
- `AC-202` / `DC-014` 锁定屏拒绝空间编辑，版本号不递增
- 存在待确认结果时返回 409 `PENDING_EXISTS`，pending 不被破坏
- `NFR-018` 只读成员的空间编辑被服务端拒绝（403）
- 客户端契约：只有文字叶子节点带 `data-editable`，编辑脚本只在失焦 / 回车提交一次

**隔离性（isolation.test.mjs）**
- `AC-001` 改 A 屏后，B 屏目录内所有文件的 hash 与 mtime 不变
- `AC-002` `target_screen_id` 与路径不一致 → 403 + 审计告警
- `AC-003` 锁定屏生成 → 423，版本不变；解锁记录原因
- `AC-004` 增/改/删边，三块屏幕目录零写入
- `AC-005` 回滚只改本屏指针，其他屏版本与存储不动
- `AC-006` 删除有边的屏 → 409 并列出关联边，需显式选择处理方式
- `AC-007` AI 输出夹带其他 `screen_id` → 403 + 告警 + 不落库
- `AC-008` patch 中途失败 → 版本不递增、内容逐字节相同
- `NFR-003` 生成上下文只嵌入目标屏
- `DC-001` `flow.json` 中不含 `children` / `data-node-id`

**预览与导出（preview-export.test.mjs）**
- 预览按边正确路由、热区缺失的边保留为 orphan
- 自然语言建边只产出候选，不自动落库
- 导出包含全部屏幕与边、不依赖后端、脚本注入被转义

**后续功能（features.test.mjs）**
- 区域 / 组件级生成必须提供真实 `selection.node_ids`，且只改选区内容
- 设计 token 注入生成；局部更新 token 不覆盖其它分组
- 撤销最近变更只切本屏版本指针，并返回节点级 diff 明细
- 只读成员不能写屏幕、生成、版本或设计规范（403 `NO_PERMISSION`）
- 屏幕排序持久化；拒绝不属于本项目的 screen_id
- patch op / selector / value 白名单在落库前生效
- 解锁后状态按是否有内容回到 `draft` / `applied`
- 导出目录名清洗与路径包含校验
- 选区高亮、选择脚本注入与恶意 node id 的 CSS 转义

**AI 模型（models.test.mjs）**
- 默认只有内置生成器，健康检查 / 列表都不泄漏 `api_key`
- 模型新增校验、密钥脱敏（只返回末四位）、留空保留、显式清除
- 激活 / 停用 / 删除当前模型时回退到 `mdl_local`
- 内置模型不可删除、不可停用、provider 不可修改，但名称可改
- 生成任务使用当前选中模型，job 记录模型快照且不含密钥
- 通过本地假网关验证 `/chat/completions` 请求、Bearer 密钥与远端输出落库

**错误语义（regression.test.mjs 的 422 部分）**
- 模糊指令返回 `UNPROCESSABLE`（带可操作建议），不再伪装成"输出非法"
- `region`/`component` 缺少选区在请求侧就被拒（400），不进入模型调用
- 常见自然语言修改（改大、加粗、圆角、新增按钮）都能产出 patch
- 「标题」类指令命中字号最大的节点，而不是文档顺序第一个文本

**启动（startup.test.mjs）**
- 从仓库根目录用相对路径启动，进程必须真正监听端口并响应 `/api/health`
- 在源码目录下用裸文件名启动同样可用
- 端口被占用时给出可操作的提示，而不是抛出未处理的原始错误堆栈

**M0 合并契约（m3-schema / m3-import-export / m3-editor-bridge）**
- `ScreenDoc` 严格禁止持久化 `action` / `actions` / `frame.swipe`，导航只存 `FlowEdge`
- `FlowEdge` 的 `trigger` 仅 `click/swipe/auto`，`swipe` 必须带 `direction`，`orphan` 不得持久化
- 自由组 `axis:"free"` + `Item.pos` 绝对坐标；非自由组出现 `Item.pos` 报 `POS_NOT_ALLOWED`
- `hidden` 组/Item 默认不导出，`includeHidden:true` 才包含
- M3E 导入 → 导出 → 再导入：屏数/边数守恒、自由组偏移守恒、导出确定性
- 孤儿边动态计算（source/target/item/slot missing），不写入 `flow.json`
- 编辑器岛协议：信封校验、状态机、`base_version` 冲突保留草稿、超时重试、origin/source 与 5MB 上限

**M3 生成与 Prompt 交付（m3-regression / prompt）**
- 整屏生成后 `meta.format` 与版本内容一致，M3 屏始终有 `groups`，预览与导出不再空白
- M3 版本对比按 Item 返回 `added/removed/changed` 明细
- 画布 / 测量缓存 / 关联边统一权限校验，非法 `target_kind` 与 `javascript:` 链接被拒绝
- 预览只消费 `confirmed` 边，候选边不会变成可点击行为
- Prompt 支持中 / 英 / 日 / 韩四种语言，结构完整且可重复生成
- `promptEdit` 优先，重置后恢复自动生成；选项顺序稳定，平台与安全过滤生效
- 单屏 Prompt 只嵌入目标屏正文，其它屏仅标题；单屏包的 `design.json` 同样隔离
- Prompt 包包含 `prompt.md` / `design.json` / `agent.md` / `README.md`，可下载 ZIP
- multipart 导入的中文文件名按 UTF-8 解码，不再退化成 latin1 乱码

**回归（regression.test.mjs）**
覆盖联调中真实出现过的缺陷：遍历只跑到根节点、`props.children` 被误认为树结构、列表接口缺 doc、模板识别被 prompt 元信息干扰、派生 id 误判跨屏、修改类指令误走整屏重写、并发写同屏版本号错乱等。

---

## MVP 边界（未实现）

| 项 | 状态 | 说明 |
|---|---|---|
| 多人实时协作 | 未做 | 单用户，`x-proto-user` 头预留 |
| 项目成员/只读角色 | 完成 | 所有写接口统一 `assertWriter`，只读成员返回 403 `NO_PERMISSION` |
| 条件分支跳转 | 未做 | `trigger` 已有 `click`/`auto`，无表达式引擎 |
| 弹层预览 | 未做 | 只做整屏跳转 + 返回栈 |
| 版本对比可视化 | 完成 | 并排渲染两版内容，节点级新增/删除/修改高亮，可点清单定位 |
| 区域/组件级选择 | 完成（单节点） | 画布内点击选区并回传 `node_id`；多节点框选尚未做 |
| 空间编辑 | 完成（文本） | 双击文字节点直接改文案并落库；富文本、样式面板与拖拽改布局未做 |
| 设计系统 / 组件库 | 部分 | 设计 token 可视化配置完成；组件级复用与组件库未做 |
| 节点虚拟化 | 未做 | 百级节点 DOM 直出，未做 200+ 性能优化 |
| 权限鉴权 | 未做 | 无登录态，仅按 header 记录 actor；角色校验在服务端完成 |

---

## 已知限制

1. **画布内 iframe 的锚点坐标依赖 postMessage 回传**，首帧会先用占位坐标，测量完成后自动校正。极端情况下（字体延迟加载）可能有短暂跳动。
2. **导出物是单文件内联**，屏幕数量大时 `index.html` 会偏大（4 屏约 16KB）。后续可改为按屏拆分为多文件 + 导航页。
3. **内置生成器是模板化的**，视觉丰富度有限；它的价值在于让隔离机制、版本、关联、导出这些真正的核心逻辑可被真实验证。
4. **空间编辑只覆盖纯文本叶子节点**：容器、图片、图标等节点暂不支持双击编辑；编辑写入走同一条 `manual-patch` 人工写入口，存在待确认 AI 版本时会被 409 拦截，避免 pending 立即过期。


---

## 错误码约定

| HTTP | code | 含义 | 屏幕是否变化 |
|---|---|---|---|
| 400 | `BAD_REQUEST` | 请求参数不合法（缺 prompt、缺 scope、缺选区） | 否 |
| 403 | `NO_PERMISSION` | 只读成员执行写操作 | 否 |
| 403 | `FORBIDDEN_TARGET` | 跨屏写入，已拦截并告警 | 否 |
| 409 | `CONFLICT` / `EDGES_EXIST` / `STALE_PENDING` | 状态冲突 | 否 |
| 409 | `PENDING_EXISTS` | 存在待确认 AI 版本，先确认或丢弃再做人工编辑 | 否 |
| 422 | `INVALID_OUTPUT` | 模型输出不符合结构契约（真的违规） | 否 |
| 422 | `UNPROCESSABLE` | 没识别出可执行的修改（"没听懂"） | 否 |
| 423 | `SCREEN_LOCKED` | 屏幕已锁定（含空间编辑） | 否 |
| 502 | `MODEL_FAILED` | 模型调用失败 / 超时 / 输出被截断 / 结构缺 root（详见 `detail.hint`） | 否 |

`INVALID_OUTPUT` 与 `UNPROCESSABLE` 都返回 422，但语义完全不同，前端要区分展示。
`detail.hint` 字段在所有 422 上都会给出可直接照做的下一步。

## License

本项目基于 [MIT License](LICENSE) 发布。

可以自由使用、修改、分发和商用，包括闭源二次开发；保留版权声明与许可证原文即可。

Copyright (c) 2026 mrtransition
