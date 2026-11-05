# 需求规格说明书（SRS）· M3E 原型工作台（合并版）

**项目名称：** M3E 原型工作台（M3E Prototype Studio）
**文档编号：** SRS-M3STUDIO-001
**文档版本：** V4.1（合并版·审计修订）
**文档状态：** **M0 设计基线草案**（目标态；P0 条目是 M1–M4 的实现与验收范围，本版不进行实现验收）
**编制日期：** 2026-11-05
**合并来源：**

- 本仓库 `prd-diy` v1.0.0（SRS-AIPROTO-003 V3.0）
- `https://github.com/lnkiai/m3e-canvas` main 分支（v0.1.0，MIT）

**取代版本：** SRS-AIPROTO-003 V3.0、SRS-M3STUDIO-001 V4.0

> **基线说明（审计修订）：** 本版为 **M0 设计基线**，不直接用于实现验收。P0 条目构成合并 MVP 的实现与验收范围，按 §11 里程碑分阶段验收；P1/P2/保留条目不参与 MVP 验收。本版重点修复了 V4.0 审计报告中的阻断项 B-01～B-08 与高优先级项 H-01～H-10，并补齐 Kind Registry、FlowEdge 手势、自由组坐标、旧格式只读渲染契约、共享渲染契约与追溯矩阵。

---

## 0. 本次修订说明

### 0.1 合并动机

`prd-diy` 解决的是“**逐屏生成 + 隔离治理 + 版本回滚 + 关联预览 + 离线导出**”，强项在服务端规则、AI 编排与可追溯性；`m3e-canvas` 解决的是“**用真实 Material 3 Expressive 部件快速搭屏 + 主题系统 + 交互预览 + 生成 vibe-coding prompt**”，强项在设计表达能力与交付物。

两者合并后形成一条完整链路：

> 想法 → AI 逐屏生成 / 手工搭屏 → 主题统一 → 屏幕关联 → 可点击预览 → 版本治理 → 导出可运行原型 + 可交付给编码 Agent 的 Prompt。

### 0.2 合并原则

| 原则 | 说明 |
| --- | --- |
| 隔离不降级 | 保留 `prd-diy` 的三层隔离：存储隔离、上下文隔离、编辑隔离 |
| 设计可表达 | 采用 M3E 的语义部件模型，不再以“任意 HTML 节点树”作为主设计模型 |
| 单一真源 | 每个屏幕只有一份 `ScreenDoc`；导航关系只有一份 `FlowEdge`；主题只有一份 `ProjectDesign` |
| 双交付物 | 同时交付“可点击原型”和“vibe-coding Prompt”，两者由同一份设计数据生成 |
| 旧数据不丢 | 旧 `node-tree` 文档可读、可转换、可回滚；不静默覆盖 |
| 分阶段落地 | 先做“宿主 + M3 编辑器岛”，验证后再决定是否统一为 React 前端 |
| 许可合规 | 两个项目均为 MIT；保留 M3E 的 `NOTICE` 与 Apache-2.0 归属说明 |

### 0.3 状态与优先级定义

**优先级：** P0 = 合并 MVP 必须；P1 = 首个正式版应具备；P2 = 后续增强；保留 = 本期不做，保留原规划。

**合并动作：**

| 标记 | 含义 |
| --- | --- |
| 复用 | 现有实现或契约可直接沿用 |
| 改造 | 需求语义保留，但数据结构/渲染/接口需要适配 M3 模型 |
| 新增 | 合并后新增的能力 |
| 保留 | 本期不实现，继续作为后续规划 |
| 废弃 | 合并后不再保留的旧实现或契约 |

### 0.4 与旧 SRS 的关系

- `FR-*`、`NFR-*`、`DC-*`、`API-*`、`AC-*` 编号尽量保留，便于追溯。
- 旧编号中与“任意 HTML 节点树”强绑定的条目统一标记为“改造”，需求意图不变，落地方式改为 M3 `ScreenDoc`。
- 新增编号段：
  - `FR-M3-*`：M3 语义部件与屏幕模型
  - `FR-EDIT-*`：M3 画布与编辑器
  - `FR-THEME-*`：主题与设计系统
  - `FR-RENDER-*`：共享渲染契约
  - `FR-PROMPT-*`：Prompt 交付
  - `FR-I18N-*` / `FR-A11Y-*`：国际化与可访问性
  - `AC-3xx` / `AC-4xx` / `AC-5xx` / `AC-6xx`：合并新增验收场景
  - `DC-015` 起、`NFR-021` 起、`API-015` 起：合并新增约束与接口

### 0.5 V4.1 审计修订摘要

| 修订项 | 对应审计编号 | 说明 |
| --- | --- | --- |
| 验收基线澄清 | B-01 | §0 头部、§1.1、§8.0 明确 M0 设计基线；P0 为 M1–M4 验收范围 |
| 追溯矩阵重编 | B-02 | §8.6 仅引用正文实际编号；旧编号统一重映射到 AC-301～315/321/322 |
| 自由组坐标与图层字段 | B-03 | §5.2 增加 `Item.pos`、`Group.pos`、`hidden`、`name`、`locked`；§5.5 增 DC-036～038 |
| FlowEdge 手势与孤儿边 | B-04 | §5.2 增 `direction`；`swipe` 作为 `trigger`；`orphan` 改为动态计算；DC-023 加例外 |
| Kind Registry | B-05 | 新增附录 §12.5；属性白名单统一 |
| 权限模型 | B-06 | §2.1/§2.3 区分本地单机与团队服务器；鉴权门禁 |
| 旧格式只读渲染 | B-07 | 新增 FR-RENDER-004/005；§6.5 增只读渲染器 |
| 共享渲染契约 | B-08 | 新增 FR-RENDER-001～006 |
| 里程碑验收对齐 | H-01/H-02 | §11 按 P0/P1/P2 拆分；P0 范围与 FR 优先级一致 |
| Prompt 摘要归属 | H-03 | §5.2 增 `prompt_digest`；明确记录在屏幕版本 |
| 主题权威入口 | H-04 | API-016 为权威；`/tokens` 为兼容投影 |
| 项目导入入口 | H-05 | 增 `POST /api/projects/import` |
| 导出形态 | H-06 | §6.5 区分目录版与单文件版；体积预算分别定义 |
| 大文件导入 | H-07 | §6.1 增 multipart/文件路径；P0 支持 |
| Candidate 持久化 | H-08 | §5.2 明确 candidate 持久化与清理 |
| ScreenMeta 坐标 | H-09 | §5.2 删除 ScreenMeta 坐标；`canvas.json` 唯一 |
| 开放问题清理 | H-10 | §9.3 移除已决策项 |
| 支持矩阵统一 | M-01 | NFR-007/023/013/024 统一 |
| 旧测试适配 | M-02 | §8.7 增旧测试适配清单 |
| 属性表统一 | M-03 | 附录 §12.5 为唯一来源 |
| HTML 归一化 | M-04 | §7.3 明确规则 |
| 热区身份 | M-05 | FR-FLOW-001 改为 `(item_id, slot)` |
| 权限重复 | M-06 | 项目权限需求合并到 FR-USER-001 |
| UI 状态持久化 | M-07 | §5.1 增 `ui-state.json` |
| 触发语句 | M-08 | FR-GEN-012 修正 |
| §3.14 标题 | M-09 | 拆分为“保留/不做/P1 未实现” |
| Prompt 导航标记 | M-10 | 按 P1/P2 拆分验收 |

---

## 1. 引言

### 1.1 目的

定义合并后产品的功能需求、非功能需求、数据约束、接口契约与验收标准。本文档是**M0 设计基线**；P0 条目构成 M1–M4 的实现与验收范围，按 §11 里程碑分阶段验收。凡与本文档冲突的实现，以本文档为准；凡标注“保留”“规划”“P1/P2”的能力，不得在 MVP 验收中作为缺陷提出。

### 1.2 产品定位

面向产品经理、设计师、前端原型人员与“vibe coding”使用者，提供**同一个工作台内的两种工作方式**：

1. **AI 优先**：按屏幕逐个生成/修改，屏幕之间在生成阶段完全隔离；结果先进入待确认，再落库为版本。
2. **手工优先**：用真实 M3 部件在画布上搭屏，Tidy 自动布局，主题统一，关联成可点击流程。

两种方式共享同一份设计数据、同一套版本与关联层，并同时产出：

- **可点击原型**：离线可运行，按边跳转，支持 M3 转场与交互部件。
- **vibe-coding Prompt**：把设计转成编码 Agent 可直接执行的短 brief，支持多语言与可编辑。

### 1.3 核心业务目标

| 编号 | 业务目标 | 合并后状态 |
| --- | --- | --- |
| BR-001 | 单屏独立生成：一次只写目标屏 | 保留 |
| BR-002 | 编辑隔离：改 A 屏不影响 B 屏的内容、版本与关联 | 保留并适配 M3 |
| BR-003 | 增量修改：修改类任务优先输出局部 patch | 保留并适配 M3 |
| BR-004 | 后置关联：建边不触发任何屏幕重生成 | 保留 |
| BR-005 | 可回滚：版本快照 + 单屏回滚 | 保留 |
| BR-006 | 可预览、可导出：关联后能点着走通并可离线分发 | 保留并升级为 M3 运行时 |
| BR-007 | 人工编辑一等来源：直接编辑与 AI Patch 并列进入版本树 | 保留并扩展到 M3 属性 |
| BR-008 | 成本可感知：确定性变更短路大模型 | 保留 |
| BR-009 | 冲突可治理：人工与 AI 变更冲突时三方合并、用户裁决 | 保留（P2） |
| BR-010 | 设计可表达：用真实 M3 部件搭屏，主题一处修改全局生效 | 新增 |
| BR-011 | Prompt 可交付：设计一键转成编码 Agent 可执行的 brief | 新增 |
| BR-012 | 双交付物一致：原型与 Prompt 来自同一份设计数据 | 新增 |
| BR-013 | 旧资产可延续：旧项目可打开、可转换、可回滚 | 新增 |
| BR-014 | 渲染一致：编辑器、预览、导出使用同一渲染契约 | 新增（V4.1） |

### 1.4 范围

**合并 MVP 范围（P0）：**

- 项目/屏幕/版本/权限/审计的服务端治理；
- M3 语义部件模型与 `ScreenDoc` 存储；
- 单屏 M3 编辑器（部件面板、属性面板、图层、Tidy、主题、撤销/重做、快捷键）；
- 单屏 AI 生成与局部 patch（M3 输出契约、待确认、失败不落库）；
- 关联层（Item 作为热区、FlowEdge 独立存储、孤儿边）；
- 应用内预览与静态导出（M3 渲染、转场、返回栈、离线）；
- Prompt 生成（中/英/日/韩）、复制/下载、单屏 Prompt；
- M3E 项目导入与导出、旧 node-tree 只读兼容与只读渲染；
- 共享渲染契约（编辑器/预览/导出一致性）；
- 现有 97 个测试适配 + 新增合并测试。

**首个正式版范围（P1）：**

- 多选/框选、分组/取消分组、跨屏复制粘贴；
- 空间编辑扩展到图标、变体、尺寸、开关状态；
- 版本来源/成本看板、项目级主题修订；
- 分享链接（只读快照）；
- 四语言 UI、键盘可达性、性能优化；
- 单文件导出（内联模式）；
- Prompt 导航标记。

**后续增强（P2 / 保留）：**

- 三方合并与冲突 UI；
- 实时多人协作、评论、成员管理界面；
- 条件分支、变量系统、弹层页；
- 组件库/组件复用、插件系统；
- 生产级代码生成（React/Vue/Flutter 工程）；
- PDF/图片批量导出、版本自动清理；
- Prompt 导航标记的编辑态维护。

**明确不做：**

- 用合并版直接替代 IDE 或代码编辑器；
- 在浏览器内运行完整的 Android/iOS 模拟器；
- 保证生成代码可直接上架应用商店。

### 1.5 术语

| 术语 | 定义 |
| --- | --- |
| 项目 / Project | 一次原型设计的容器，含主题、屏幕清单、关联、成员与历史 |
| 屏幕 / Screen | 原型中的一张独立页面，唯一 `screen_id`，对应一个 `ScreenDoc` |
| `ScreenDoc` | 单屏设计文档：`{ schema, format, frame, groups, meta }`，是版本快照的最小单元 |
| `ProjectDoc` | 项目聚合文档：由 `ProjectDesign` + 所有 `ScreenDoc` 组装而成，用于 Prompt/导出/M3E 互操作 |
| Frame | 屏幕设备与画布信息：尺寸、背景、备注、滚动长度、内容排布 |
| Group / Run | 部件组：单个部件，或同族部件组成的横向/纵向连接组；自由组可含独立坐标 |
| Item / Part | M3 语义部件，36 种 `kind`，含 label/icon/variant/size/tabs 等属性 |
| 热区 / Hotspot | 可交互的 Item 或 Item 的某个 slot；身份为 `(item_id, slot)` |
| FlowEdge | 屏幕跳转关系，独立文件存储；合并版中导航的唯一真源 |
| `action` | M3E 原有的部件内跳转声明；合并版仅作为导入/导出投影，不进入版本快照 |
| pending | 已生成但未接受的候选结果，不占版本号 |
| 孤儿边 / orphan | 边引用的源屏、目标屏、Item 或 slot 已不存在；**动态计算**，不持久化到 `flow.json` |
| 主题 / Theme | M3 主题：调色板、明暗、对比度、形状、字体、动效、动态取色 |
| 设计 token | 跨屏唯一共享的视觉变量；合并版中由 Theme 派生，兼容旧接口 |
| `change_source` | 版本来源：`manual_direct` / `builtin_rule` / `ai_patch` / `import` |
| 内置生成器 | 确定性、无网络、恒可用的生成路径 |
| 意图路由 | 在大模型调用前判断走显式短路、规则、分类器还是大模型 |
| Prompt | 由设计生成的编码 brief，支持多语言、选项、手工编辑 |
| Tidy | 基于规则的自动布局：吸附、连接组、边距、栏位、圆角统一 |
| `node-tree` | `prd-diy` 旧文档格式：`{ version, root }`，合并版只读兼容并只读渲染 |
| 分享链接 | 把只读设计压缩进 URL fragment 的链接，或服务端 token 链接 |
| 共享渲染契约 | `ScreenDoc + Theme → 渲染树/HTML` 的唯一转换路径，编辑器/预览/导出共用 |

---

## 2. 总体描述

### 2.1 用户角色与权限

| 角色 | 可做 | 不可做 |
| --- | --- | --- |
| owner / editor（默认 `local-user`） | 全部读写、生成、版本、主题、导出 | — |
| readonly | 查看项目、屏幕、版本、预览、导出、Prompt | 任何写操作返回 403 `NO_PERMISSION` |
| visitor（分享链接） | 只读预览、查看 Prompt（如开启） | 任何写操作；不暴露项目内部 ID 与历史 |
| coding agent | 读取导出的 Prompt / `agent.md` / 设计 JSON | 不直接写项目存储；只能通过导入接口或人工粘贴 |

**权限模型与部署形态（审计修订 B-06）：**

- **本地单机模式（默认）：** 未登记成员视为可写，仅限 `localhost` 或受信内网；`x-proto-user` 缺省 `local-user`。
- **团队服务器模式：** 必须启用成员登记或最小鉴权（如反向代理 Basic/OIDC）；未登记成员一律 403。团队模式在 §2.3 标注为“受信网络内测形态”，P1 前必须补齐鉴权。
- 所有写接口统一走 `assertWriter(pid, actor)`，**服务端校验**，前端置灰只是辅助。
- 分享访问使用只读快照或短期 token，不复用编辑会话。
- 当前没有成员管理接口；新增/编辑成员可先直接改 `project.json`，P2 再提供界面。

### 2.2 系统组成

```
浏览器
├─ 工作台外壳（项目、屏幕清单、版本、关联、预览、导出、AI 模型管理）
├─ M3 编辑器岛（React + M3E 组件：画布、部件面板、属性面板、图层、Tidy、主题）
├─ 共享渲染器（ScreenDoc + Theme → 渲染树/HTML；编辑器缩略图、预览、导出共用）
├─ 旧格式只读渲染器（node-tree → 只读 HTML/缩略图）
└─ 分享查看器（只读预览 + Prompt）

服务端（Node ≥ 20，默认零运行时依赖）
├─ REST API（项目/屏幕/版本/流程/AI/导出/审计）
├─ 领域层（ScreenDoc 校验、M3 patch、迁移、Tidy 服务端复核）
├─ AI 编排（上下文闸门、路由、归一化、Provider 适配）
├─ 存储（文件系统 + 原子写 + 同屏串行队列）
└─ 导出器（静态原型目录版/单文件版、Prompt 包、M3E JSON、分享链接）

外部
├─ OpenAI 兼容 / Claude / Gemini / DeepSeek 等模型服务
└─ Google Fonts / Material Symbols（可离线降级）
```

### 2.3 部署形态

| 形态 | 说明 | 权限要求 | 适用 |
| --- | --- | --- | --- |
| 本地单机 | `npm start` 启动 API + 静态资源；数据落 `data/` | 未登记可写（localhost/受信内网） | 个人使用、内网演示 |
| 团队服务器 | 反向代理 + 持久化卷；**必须启用成员登记或最小鉴权** | 未登记 403；P1 前补齐登录/SSO | 小团队（受信网络内测形态） |
| 纯静态分享 | 导出物或分享链接，无后端 | 无写操作 | 评审、客户演示 |
| 纯静态编辑器 | M3E 编辑器可作为独立静态站点运行（无版本/协作） | 无 | 开源社区、GitHub Pages |

### 2.4 关键设计约束

| 编号 | 约束 | 落地位置 / 状态 |
| --- | --- | --- |
| C-001 | 屏幕内容与关联边分文件存储 | `screens/` 与 `flow.json`；保留 |
| C-002 | 生成只能写请求路径指定的屏 | `startGeneration` 校验；保留 |
| C-003 | 生成过程不写任何边 | 不触碰 `flow.json`；保留 |
| C-004 | 建边/改边/删边不触发重生成 | `createEdge/updateEdge/deleteEdge`；保留 |
| C-005 | 不同屏幕的生成上下文不共享正文 | `ai/context.js` 唯一入口；改造为 M3 |
| C-006 | 跨屏一致性只通过设计 token / 主题 | `ProjectDesign.theme`；改造 |
| C-007 | 锁定屏幕拒绝一切内容写入 | `locked` 检查最先；保留 |
| C-008 | 每次版本变更都有快照，且不产生半应用状态 | `commitVersion` + 原子写；保留 |
| C-009 | 空间编辑提交必须生成 `manual_direct` 版本 | `manualPatch` + `change_source`；保留 |
| C-010 | 锁定屏幕必须同时拒绝空间编辑与 AI 写入 | 统一 locked 校验；保留 |
| C-011 | 内置生成器仅处理“可唯一确定变更值”的请求 | `ai/router.js`；改造为 M3 op |
| C-012 | 意图路由不得丢弃否定语义或附加条件 | `ai/rules.js`；保留 |
| C-013 | 人工编辑与 AI Patch 冲突时不得自动合并 | P2 |
| C-014 | 三方合并 base 必须为双方共同祖先版本 | P2 |
| C-015 | 路由与合并决策日志须可审计，不含敏感内容 | 路由日志已实现；合并日志 P2 |
| C-016 | 屏幕版本只存单屏 `ScreenDoc`，不存项目聚合 | 新增；保证隔离 |
| C-017 | `FlowEdge` 是导航唯一真源，`ScreenDoc` 不持久化 `action` | 新增；导入时转换、导出时投影 |
| C-018 | 所有设计文档必须带 `schema` 与 `format`，并经过版本化迁移 | 新增 |
| C-019 | 旧 `node-tree` 文档只读兼容，转换必须显式触发并给出损失报告 | 新增 |
| C-020 | 主题只在项目级维护；屏幕只允许 `frame.bg` 局部覆盖 | 新增 |
| C-021 | 单屏 Prompt 生成不得读取其他屏正文 | 新增；全项目 Prompt 除外 |
| C-022 | 分享链接与导出物不得包含 API Key、服务端密钥、本地图片二进制、AI 改写历史 | 新增 |
| C-023 | 编辑器保存必须携带 `base_version`，版本已前进时拒绝覆盖 | 新增；防止并发丢失 |
| C-024 | M3 输出必须通过 schema 校验后才能进入 pending | 新增 |
| C-025 | 同一 Item 的 `id` 在屏内唯一且稳定；patch 只按 id 定位 | 改造 |
| C-026 | 屏幕坐标在 `ScreenDoc` 内为本地坐标；画布坐标只存 `canvas.json` | 新增 |
| C-027 | Prompt/导出必须可重复：同一 `ScreenDoc` + 主题 + 选项 → 同一输出 | 新增 |
| C-028 | UI 四语言 key 必须完全对齐；缺 key 回退英文并记录 | 新增 |
| C-029 | 导出目录名必须清洗，禁止越出 `exports/` | 保留 |
| C-030 | 许可与归属文件必须随分发保留 | 新增 |
| C-031 | 编辑器、预览、导出必须共用 `ScreenDoc + Theme → 渲染树/HTML` 契约 | 新增（V4.1） |
| C-032 | 旧 `node-tree` 必须通过独立的只读渲染器呈现，不得进入 M3 渲染器 | 新增（V4.1） |
| C-033 | 孤儿边为动态计算，不写入 `flow.json`；写边接口只校验创建时存在性 | 新增（V4.1） |
| C-034 | 团队服务器模式必须启用成员登记或最小鉴权 | 新增（V4.1） |

---

## 3. 功能需求

> 表中“合并动作”说明该需求相对两个来源项目的处理方式；“验收标准”是合并后的目标口径。P0 条目构成合并 MVP 的实现与验收范围。

### 3.1 项目与工作区

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-PROJ-001 | 创建项目 | 填写名称、设备预设（手机 412×892 / 桌面 1280×800）、主题与主色 | P0 | 改造 | 返回唯一 `project_id`；写入默认 `ProjectDesign` 与空 `screen_titles`；手机/桌面预设可切换 |
| FR-PROJ-002 | 设计规范 | 项目级维护调色板、明暗、对比度、形状、字体、动效、动态取色 | P0 | 改造 | 保存后写入 `project.design`；后续生成与导出注入；已有屏幕版本不因主题变化而递增 |
| FR-PROJ-003 | 屏幕清单 | 屏幕可创建、重命名、备注、上移/下移排序、删除 | P0 | 复用 | 新建屏幕产生 v1 空屏基线；排序持久化；拒绝不属于本项目的 `screen_id` |
| FR-PROJ-005 | 项目快照 | 提供项目全量快照读取 | P2 | 改造 | `GET /api/projects/:pid/snapshot` 返回项目、屏幕、版本索引与聚合 `ProjectDoc` |
| FR-PROJ-006 | 项目导入 | 导入 M3E JSON、旧 `node-tree` 项目或 `.m3studio.zip`；支持创建新项目或导入到现有项目 | P0 | 新增 | 导入前校验；返回屏幕数、边数、警告与损失报告；失败不写入；新项目导入返回新 `project_id` |
| FR-PROJ-007 | 项目导出 | 导出 M3E JSON、Prompt 包、静态原型（目录版/单文件版）、完整备份 | P0 | 新增 | 导出格式可选；M3E JSON 可被原项目打开；备份可恢复 |
| FR-PROJ-008 | 项目级 Prompt 配置 | 标题、brief、平台（android/web）、Prompt 选项、手工编辑 Prompt | P0 | 新增 | 配置随项目保存；Prompt 生成可重复；重置可恢复自动生成 |
| FR-PROJ-009 | 项目模板 | 空白、手机种子、桌面种子、M3E 示例 | P1 | 新增 | 新项目可选择模板；模板只影响初始内容 |
| FR-PROJ-010 | 项目级修订 | 主题/设计规范变更记录为项目修订，不产生屏幕版本 | P0 | 新增 | `design-revisions.json` 记录 revision、actor、摘要、主题快照 |
| FR-PROJ-011 | 项目删除/归档 | 删除或归档项目 | P2 | 保留 | 删除需二次确认；归档不删除数据 |

### 3.2 M3 语义部件与屏幕模型

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-M3-001 | 语义部件模型 | 采用 M3E 的 36 种 `kind`（见附录 §12.5 Kind Registry） | P0 | 新增 | 每个 Item 含 `id/kind/label/icon/variant`；`kind` 必须在 Registry 内；未知 kind 拒绝 |
| FR-M3-002 | 屏幕 Frame | 每屏一个 Frame：设备尺寸、背景、备注、滚动长度、内容排布 | P0 | 新增 | 手机 412×892、桌面 1280×800；`length > h` 时预览可滚动；`place` 参与 Tidy 与 Prompt |
| FR-M3-003 | Group / Run | 部件以组存储：单件、横向连接组、纵向连接组、自由组 | P0 | 新增 | `axis` 必填；自由组保留 `pos` 且 Item 可有独立 `pos`（见 §5.2）；锁定组不可拖动/删除/Tidy |
| FR-M3-004 | Item 属性 | 支持 label、supporting、icon、icon2、variant、size、size2、tabs、selected、checked、value、note、fill、src 等；属性白名单以附录 §12.5 为唯一来源 | P0 | 新增 | 属性按 kind 校验；未知字段保留但不参与渲染；`note` 进入 Prompt |
| FR-M3-005 | 图标 | 使用 Material Symbols 名称；支持图标搜索与替换 | P0 | 新增 | 图标名可解析；未知图标降级为占位并提示 |
| FR-M3-006 | 图片 | 支持 https URL 与本地选择；分享/导出可裁剪本地二进制 | P1 | 新增 | 本地图片在项目内可用；分享链接与 M3E 导出只保留 https URL |
| FR-M3-007 | Schema 校验 | 所有 `ScreenDoc` 必须通过 `m3studio/screen@1` 校验 | P0 | 新增 | 缺 schema、kind 非法、id 重复、children 混入字符串等被拒绝并给出路径 |
| FR-M3-008 | 旧文档兼容 | 旧 `{version, root}` 文档以 `format:"node-tree"` 只读打开，并可通过旧格式只读渲染器查看/预览/导出 | P0 | 新增 | 旧项目可查看、预览、导出；编辑入口提示“先转换”；只读渲染器不进入 M3 渲染器 |
| FR-M3-009 | 旧文档转换 | 将旧 node-tree 启发式转换为 M3 ScreenDoc，并输出损失报告 | P1 | 新增 | 转换不覆盖原版本；报告列出无法映射的节点；可回滚 |
| FR-M3-010 | 坐标规范 | `ScreenDoc` 内使用屏幕本地坐标；画布位置只存 `canvas.json` | P0 | 新增 | 移动屏幕不改变 `ScreenDoc`；导出/聚合时再加画布偏移；`ScreenMeta` 不含坐标 |
| FR-M3-011 | 部件默认值 | 每种 kind 有默认尺寸、文案、图标、变体与可连接族 | P0 | 新增 | 从面板拖入即可渲染；同族部件可连接；默认值可被主题影响 |
| FR-M3-012 | 文本尺寸测量 | 文本型部件宽度由渲染测量；服务端有确定性估算兜底 | P1 | 新增 | 客户端上报 `measurements.json`；缺失时 Prompt/导出仍可生成，标注估算 |
| FR-M3-013 | 自由组 Item 坐标 | 自由组内 Item 可携带 `pos:{x,y}`；非自由组 Item 坐标由 Group 与顺序推导 | P0 | 新增 | 分组/取消分组/Tidy 后坐标归一规则确定；拖动自由组 Item 持久化到 `Item.pos` |
| FR-M3-014 | 图层字段 | Group/Item 支持 `name`、`hidden`、`locked` | P0 | 新增 | 图层顺序即绘制顺序；`hidden` 默认不导出（需显式选择）；`locked` 不可编辑 |

### 3.3 画布与编辑器

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-EDIT-001 | 无限画布 | 平移、缩放、适应全部、缩放快捷键 | P0 | 改造 | 缩放 10%–400%；滚轮以指针为中心；`0` 适应、`+/-` 缩放 |
| FR-EDIT-002 | 部件面板 | 按分类浏览、搜索、收藏、拖入画布 | P0 | 新增 | 36 种部件可检索；拖入位置按 4dp 网格吸附；收藏持久化到 `ui-state.json` |
| FR-EDIT-003 | 选择 | 单选、Shift 多选、框选、点击空白取消 | P1 | 新增 | 选中态清晰；多选可移动/复制/分组；跨屏选择不混入 |
| FR-EDIT-004 | 拖拽与吸附 | 拖动部件/组；4dp 网格；智能参考线；`Ctrl` 自由移动 | P0 | 新增 | 松手后坐标持久化；吸附不改变尺寸；跨屏拖动需显式确认 |
| FR-EDIT-005 | 尺寸手柄 | 拖动改变宽高；支持预设宽度与高度 | P0 | 新增 | 最小/最大尺寸受 kind 约束；文本型部件宽度可自适应 |
| FR-EDIT-006 | 复制粘贴 | `Ctrl+C/V`、`Ctrl+D`、跨屏粘贴 | P1 | 新增 | 粘贴生成新 id；跨屏粘贴保留相对布局；不覆盖目标屏现有内容 |
| FR-EDIT-007 | 分组 | `Ctrl+G` 分组、`Ctrl+Shift+G` 取消分组 | P1 | 新增 | 自由组保留相对位置（写入 `Item.pos`）；取消分组后仍可单独选中 |
| FR-EDIT-008 | 图层 | 按屏幕列图层；调整顺序、锁定、隐藏、重命名 | P0 | 新增 | 图层顺序即绘制顺序；锁定组/Item 不可编辑；隐藏默认不导出（需显式选择） |
| FR-EDIT-009 | Tidy | 基于规则自动布局：栏位吸附、连接组、16dp 边距、圆角统一 | P0 | 新增 | 只改位置/连接/圆角；不改文案、顺序、尺寸（圆角除外）；可撤销 |
| FR-EDIT-010 | 快捷键 | V/H、空格平移、滚轮、缩放、撤销/重做、复制/粘贴、分组、方向键、Delete、P 预览 | P0 | 新增 | 快捷键不劫持输入框；与浏览器快捷键冲突时有提示 |
| FR-EDIT-011 | 撤销/重做 | 编辑器会话内 `Ctrl+Z` / `Ctrl+Shift+Z` | P0 | 新增 | 撤销栈至少 50 步；保存后清空会话栈；与服务端版本回滚独立 |
| FR-EDIT-012 | 属性面板 | 按 kind 展示可编辑属性：文案、图标、变体、尺寸、选中项、开关、值、备注 | P0 | 新增 | 修改即时预览；失焦/回车提交一次；非法值拒绝并提示 |
| FR-EDIT-013 | 直接改文案 | 双击文本/部件文案就地编辑 | P0 | 改造 | 只对可编辑文本生效；失焦/回车提交一次；Esc 取消；生成 `manual_direct` 版本 |
| FR-EDIT-014 | 直接改属性 | 图标选择器、变体切换、尺寸预设、开关状态 | P1 | 新增 | 只改目标 Item；其他 Item 不变；提交生成 `manual_direct` 版本 |
| FR-EDIT-015 | 屏幕管理 | 新建、复制、重命名、排序、删除屏幕 | P0 | 复用 | 复制生成新 `screen_id` 与新 Item id；不继承版本历史；删除有边屏返回 409 |
| FR-EDIT-016 | 视图持久化 | 画布视口、左右面板宽度、面板标签持久化 | P2 | 新增 | 刷新后恢复；存储于 `ui-state.json`；多设备不强制同步 |
| FR-EDIT-017 | 移动端 | 小屏只读或简化编辑 | P2 | 新增 | 小屏可预览、可查看 Prompt；编辑能力可降级 |
| FR-EDIT-018 | 编辑器桥接 | 编辑器岛与宿主通过 postMessage 通信 | P0 | 新增 | 加载/变更/保存/选中/错误消息有版本号；origin 校验；超时可恢复 |
| FR-EDIT-019 | 保存与冲突 | 保存携带 `base_version`；版本前进时返回 409 | P0 | 新增 | 冲突时不覆盖；提示刷新/另存；本地未保存内容不丢 |
| FR-EDIT-020 | 只读/锁定 | 只读成员、锁定屏、分享访问进入只读模式 | P0 | 改造 | 工具栏禁用；保存接口 403/423；预览与导出仍可用 |

### 3.4 主题与设计系统

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-THEME-001 | 调色板 | 7 套预设调色板 + 自定义种子色 | P0 | 新增 | 切换后所有屏幕即时更新；自定义种子生成完整 M3 角色；保存到 `ProjectDesign` |
| FR-THEME-002 | 明暗与对比度 | 亮色/暗色/双模式；standard/medium/high 对比度 | P0 | 新增 | 双模式时 Prompt 同时描述两套色板；导出可切换 |
| FR-THEME-003 | 形状 | square/rounded/full 三档全局形状 | P0 | 新增 | 影响部件圆角；单件圆角仍可覆盖 |
| FR-THEME-004 | 字体 | Roboto/Roboto Flex/Roboto Serif/system；CJK 自动补充 Noto Sans | P0 | 新增 | 字体加载失败回退系统字体；Prompt 记录字体族 |
| FR-THEME-005 | 动效 | standard/expressive 两档 M3 动效 | P1 | 新增 | 预览与导出使用对应 spring/easing；减少动效设置优先 |
| FR-THEME-006 | 动态取色 | Material You 动态取色开关 | P2 | 新增 | 开启时 Prompt 说明从壁纸取色；预览使用当前主题兜底 |
| FR-THEME-007 | 设计 token 桥接 | `design_tokens` 作为 Theme 的派生投影，兼容旧接口/旧 AI | P0 | 改造 | `PATCH /tokens` **仅作为兼容投影**，内部委托 `PATCH /design` 并记录同一项目修订；旧调用方仍可读 |
| FR-THEME-008 | 主题版本 | 主题变更记录项目修订；版本快照携带 `theme_snapshot` | P0 | 新增 | 旧版本可按当时主题重放；主题变更不递增屏幕版本号 |
| FR-THEME-009 | 屏幕背景覆盖 | 单屏可覆盖 `frame.bg` | P1 | 新增 | 只影响该屏；不改变项目主题；进入 Prompt 与导出 |
| FR-THEME-010 | 主题导入/导出 | 主题可单独导出/导入为 JSON | P2 | 新增 | 导入前校验；不覆盖屏幕内容 |

### 3.5 共享渲染契约（V4.1 新增）

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-RENDER-001 | 唯一渲染入口 | 编辑器缩略图、应用内预览、静态导出必须共用 `ScreenDoc + Theme → 渲染树/HTML` 契约 | P0 | 新增 | 同一 `ScreenDoc` + 同一主题在三处渲染结构一致；视觉回归基线通过 |
| FR-RENDER-002 | 确定性 | 渲染输出不依赖随机 id/时间/环境；同一输入同一输出 | P0 | 新增 | 两次渲染 DOM 结构相同（允许属性顺序差异）；快照对比通过 |
| FR-RENDER-003 | 主题注入 | 渲染器只从 `Theme` 取色/字/形/动效；不得硬编码 | P0 | 新增 | 切换主题后三处同步更新；无硬编码色值 |
| FR-RENDER-004 | 旧格式只读渲染 | `format:"node-tree"` 的 `ScreenDoc` 由独立只读渲染器渲染；不得进入 M3 渲染器 | P0 | 新增 | 旧屏在编辑器缩略图/预览/导出中可查看；M3 渲染器拒绝 node-tree 输入 |
| FR-RENDER-005 | 只读渲染安全 | 旧格式只读渲染器必须转义文本、禁止执行脚本、限制资源加载 | P0 | 新增 | `<script>`/`on*`/`javascript:` 被剥离；本地图片不进入分享/导出 |
| FR-RENDER-006 | 渲染一致性验收 | 定义编辑器/预览/导出的视觉回归基线 | P1 | 新增 | 关键屏三处截图差异 ≤ 阈值；差异需记录原因 |

### 3.6 AI 生成与编辑

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-GEN-001 | 单屏生成 | 选中一屏、输入需求、生成 | P0 | 改造 | 目标屏来自 URL；body `target_screen_id` 与路径不一致 → 403 `FORBIDDEN_TARGET`；输出 M3 `ScreenDoc` |
| FR-GEN-002 | 范围声明 | `edit_scope` 必填：`screen` / `region` / `component` | P0 | 改造 | 缺失/非法 → 400 `EDIT_SCOPE_REQUIRED`；选区用 Item/Group id |
| FR-GEN-003 | 上下文隔离 | 只携带本屏 `ScreenDoc`、主题、其他屏标题（≤40 字）、指令 | P0 | 改造 | `context_audit.embedded_screen_ids` 只含目标屏；断言 Prompt 不含其他屏正文与 Item id |
| FR-GEN-004 | 区域级生成 | 选中 Item/Group 后只改该区域 | P0 | 改造 | 选区 id 必须真实存在；否则 400 `SELECTION_NOT_FOUND`；选区外不变 |
| FR-GEN-005 | 组件级修改 | 同 004，粒度到单个 Item | P0 | 改造 | 只改目标 Item 及其允许的子属性；多选为 P1 |
| FR-GEN-006 | 待确认闸门 | 生成结果先进入 pending，接受后才落库 | P0 | 复用 | 接受前 `current_version` 不变；拒绝后屏幕完全不变；pending 含 `base_version` |
| FR-GEN-007 | 失败不落库 | 超时、schema 非法、跨屏输出时失败 | P0 | 复用 | 屏幕内容与版本不变；job 状态为 `failed/rejected/no_op`，不残留 `generating` |
| FR-GEN-008 | 任务记录 | 记录 job_id、目标屏、scope、prompt、selection、状态、模型快照、上下文审计 | P1 | 复用 | 可按屏查询；不含 API Key；记录 `route_layer` 与 `ai_cost` |
| FR-GEN-009 | 模型维护 | 新增/编辑/删除/启停 OpenAI 兼容、Claude、Gemini、DeepSeek 模型 | P0 | 复用 | API Key 只存服务端；接口只回 `has_api_key` 与末四位；留空保留，显式清除才清空 |
| FR-GEN-010 | 模型选择 | 指定当前模型；内置 `mdl_local` 恒存在 | P0 | 复用 | 内置模型不可删除/停用/改 provider（可改名）；失效回退 `mdl_local`；切换只影响后续生成 |
| FR-GEN-011 | 连接测试 | 对模型发一次最小请求 | P1 | 复用 | 返回 `{ ok, latency_ms, message, detail.hint }`；地址/密钥/模型名错误可区分 |
| FR-GEN-012 | 整屏重生成 | 显式触发整屏覆盖 | P0 | 改造 | body `mode:"full"`，或指令命中“整屏 / 整页 / 重新生成整屏 / 整个页面重做”；输出完整 `ScreenDoc` |
| FR-GEN-013 | M3 输出契约 | 模型只输出 `{target_screen_id, mode, doc?|ops?}`；kind/字段/id/坐标受白名单约束 | P0 | 新增 | 非法输出 422 `SCHEMA_INVALID`；缺 root/数组/夹带他屏 → 拒绝；不落库 |
| FR-GEN-014 | 输出归一化 | 兼容代码块 JSON、别名 op、缺 id、属性平铺、HTML 片段、parts 数组 | P0 | 改造 | 能修复的修复并记录；不能修复的拒绝；修复不改变语义；HTML 片段归一化规则见 §7.3 |
| FR-GEN-015 | 生成后 Tidy | 整屏生成默认执行 Tidy（可关） | P1 | 新增 | Tidy 只改布局；生成结果仍可手工调整；Tidy 失败不阻塞落库 |
| FR-GEN-016 | 生成影响预览 | 待确认卡片展示将被新增/修改/删除的 Item/Group | P0 | 改造 | 接受前可查看 diff；接受后按 diff 校验实际变更 |
| FR-GEN-017 | 多屏起草 | 从一句想法起草 3–5 屏 M3 设计 | P2 | 新增 | 输出多屏 `ProjectDoc`；逐屏进入待确认；不自动建边（可生成候选） |
| FR-GEN-018 | AI 辅助备注 | 为屏幕/Item 生成或改写行为备注 | P2 | 新增 | 备注进入 Prompt；可撤销；不改变布局与文案 |
| FR-GEN-019 | 生成取消 | 生成中可取消；超时可重试 | P1 | 新增 | 取消后 job 为 `cancelled`；屏幕不变；可重试同一 prompt |
| FR-GEN-020 | 生成限流 | 同屏同时只允许一个生成任务 | P0 | 复用 | 并发生成返回 409 `CONFLICT`；异屏可并行 |

### 3.7 空间编辑与人工变更

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-SPACE-001 | 文本直接编辑 | 双击文本/部件文案进入编辑态，失焦或回车提交 | P0 | 改造 | 提交生成一条 `manual_direct` 版本；连续输入不逐键落库 |
| FR-SPACE-002 | 图标/简单元素替换 | 点击图标触发选择器，提交后生效 | P1 | 新增 | 只改目标 Item；其他 Item 不变；生成 `manual_direct` 版本 |
| FR-SPACE-003 | 属性直接编辑 | 变体、尺寸、选中项、开关、值、备注可在属性面板直接改 | P1 | 新增 | 按 kind 约束校验；非法值拒绝；一次提交一个版本 |
| FR-SPACE-004 | 布局直接编辑 | 拖拽、缩放、Tidy 后保存 | P0 | 新增 | 只改位置/尺寸/连接；不改变文案与 Item 顺序（除非显式移动） |
| FR-SPACE-005 | 提交粒度 | 以“失焦/显式保存/离开编辑态”为一次提交 | P0 | 复用 | 连续输入只产生一条版本记录 |
| FR-SPACE-006 | 锁定屏拦截 | 锁定屏幕禁用编辑入口，返回与 AI 写入一致的锁定错误 | P0 | 复用 | 锁定屏无法进入编辑态；错误码 `SCREEN_LOCKED` |
| FR-SPACE-007 | 编辑撤销 | 编辑态内撤销与服务端版本回滚独立 | P1 | 改造 | 编辑态撤销不产生版本；版本回滚产生新版本指针 |
| FR-SPACE-008 | 语义摘要 | 每次 `manual_direct` 版本携带可读摘要 | P1 | 复用 | 如“手工修改文案：「提交」→「保存」”；版本树展示摘要 |
| FR-SPACE-009 | pending 冲突 | 存在待确认 AI 结果时，人工编辑默认拒绝 | P0 | 复用 | 409 `PENDING_EXISTS`；P2 改为三方合并/冲突 UI |
| FR-SPACE-010 | 来源标记 | 人工编辑不得伪装为 AI 版本 | P0 | 复用 | `change_source=manual_direct`；版本列表徽标正确 |

### 3.8 版本、来源与冲突

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-VER-001 | 版本快照 | 每次接受产生完整 `ScreenDoc` 快照 | P0 | 改造 | `versions/v<n>.json` 含 doc、来源、主题快照；版本号严格 +1 |
| FR-VER-002 | 版本列表 | 按时间倒序列出版本 | P0 | 复用 | 显示版本号、来源标签、相对时间；标出当前版本 |
| FR-VER-003 | 单屏回滚 | 回滚到指定版本 | P0 | 改造 | 只改本屏指针；其他屏文件 hash 与 mtime 不变；存在 pending 时 409 |
| FR-VER-004 | 版本对比 | 任意两版并排渲染并高亮差异 | P1 | 改造 | 返回 Item/Group 级 `added/removed/changed` 与明细；支持视觉并排 |
| FR-VER-005 | 锁定保护 | 锁定屏拒绝生成、应用、回滚、撤销、编辑 | P0 | 复用 | 423 `SCREEN_LOCKED`；解锁后按内容回到 `draft` 或 `applied` |
| FR-VER-006 | 解锁审计 | 记录解锁人、时间、原因 | P2 | 复用 | 写入 `meta.lock_audit[]` 与 `audits` |
| FR-VER-007 | 来源与成本 | 版本记录 `change_source`、`route_layer`、`rule_id`、`ai_cost`、摘要 | P1 | 复用 | 版本树与详情可区分人工/内置/大模型；`ai_cost=0` 可见 |
| FR-VER-008 | 撤销最近变更 | 回滚到上一版本 | P1 | 复用 | 只切本屏指针；`current_version<=1` 时 409；不删历史 |
| FR-VER-009 | 版本保留策略 | 可配置保留最近 N 个版本/按时间清理 | P2 | 保留 | 清理不删除当前版本；需审计 |
| FR-VER-010 | 三方合并 | 人工编辑与 AI Patch 冲突时以共同祖先为 base 合并 | P2 | 保留 | 冲突 UI；不自动裁决；原子提交 |
| FR-VER-011 | 项目修订查看 | 查看主题/设计规范变更历史 | P2 | 新增 | 可按 revision 预览主题；不影响屏幕版本 |
| FR-VER-012 | Prompt 摘要归属 | 屏幕版本记录生成时的 Prompt 摘要/哈希 | P0 | 新增 | `ScreenVersion.prompt_digest` 字段；可追溯；不存储完整大文本 |

### 3.9 关联与交互

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-FLOW-001 | 热区定义 | 可交互 Item 或其 slot 即为热区；身份为 `(item_id, slot)` | P0 | 改造 | 只有可点击 kind 或显式标记的 Item/slot 可作为边源；`item_id` 屏内唯一；`slot` 缺省为 null |
| FR-FLOW-002 | 拖拽建边 | 关联模式下从 Item/slot 拖到目标屏建边 | P0 | 改造 | 生成 `edge_id`；同一 `(item_id, slot)` 重复建边为覆盖；不写屏幕版本 |
| FR-FLOW-003 | 一句话建边 | 自然语言解析候选边 | P1 | 改造 | 只返回 candidate，不落库；确认后写入；失败 `EDGE_PARSE_FAILED` |
| FR-FLOW-004 | 边属性 | 编辑目标屏/back/link、触发方式、手势方向、转场、备注 | P0 | 改造 | 改边不触碰 `screens/`，不产生版本 |
| FR-FLOW-005 | 删除边 | 删除关联边 | P0 | 复用 | 删除后屏幕内容与版本不变 |
| FR-FLOW-006 | 数据隔离 | `flow.json` 不含 Item 树、文案、HTML、尺寸快照 | P0 | 改造 | 断言不含 `groups` / `items` / `label` 等设计字段 |
| FR-FLOW-007 | 孤儿边 | 源屏、目标屏、Item 或 slot 消失时**动态计算**标记而非持久化 | P0 | 改造 | 读取时计算 `orphan:{source_missing,target_missing,item_missing,slot_missing}`；边变红；`flow.json` 不写入 orphan |
| FR-FLOW-008 | 建边校验 | Item 必须真实存在于源屏；slot 必须存在 | P0 | 改造 | 不存在 → 400 `ITEM_NOT_FOUND` / `SLOT_NOT_FOUND`，列出可用项；创建时校验，读取时动态计算孤儿 |
| FR-FLOW-009 | 删除有边的屏 | 删除前必须显式选择处理方式 | P0 | 复用 | 409 `EDGES_EXIST`，返回 `related_edges` 与选项 |
| FR-FLOW-010 | 动作类型 | 支持 screen / back / link / menu / toggle；swipe 作为 `trigger` | P0 | 新增 | `target_kind` ∈ `screen/back/link/menu/toggle`；swipe 时 `trigger="swipe"` 且 `direction` 必填；link 只允许 http/https；back 走返回栈 |
| FR-FLOW-011 | 多 slot 动作 | 栏类 Item 支持按 slot 建边：`icon`、`icon2`、`tab:N` | P0 | 新增 | 同一 Item 不同 slot 可有不同目标；预览按 slot 命中 |
| FR-FLOW-012 | M3E 导入投影 | 导入 M3E `action/actions/swipe` 转为 FlowEdge | P0 | 新增 | 转换后 `ScreenDoc` 不保留 `action`；边状态默认 confirmed；swipe 转为 `trigger:"swipe"` + `direction` |
| FR-FLOW-013 | 导出投影 | 导出 M3E JSON 时把 FlowEdge 注回 Item `action/actions` | P0 | 新增 | 导出的 JSON 可被 m3e-canvas 打开并按边跳转 |
| FR-FLOW-014 | 条件分支 | 基于变量/表达式的跳转 | P2 | 保留 | 需表达式引擎与运行时改造 |
| FR-FLOW-015 | 自动跳转 | `trigger:"auto"` 的定时/加载跳转 | P2 | 新增 | 预览与导出支持；可关闭 |
| FR-FLOW-016 | Candidate 持久化 | candidate 边持久化在 `flow.json`，带 `status:"candidate"` 与过期时间 | P1 | 新增 | 候选边不参与预览；确认后转 confirmed；过期由后台清理；不触发屏幕版本 |

### 3.10 预览运行时

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-PREVIEW-001 | 启动预览 | 从当前屏或首屏进入 | P0 | 改造 | 按设备尺寸呈现；可“从首页重来”；支持手机/桌面框 |
| FR-PREVIEW-002 | 点击跳转 | 点击热区按边跳转 | P0 | 改造 | 只匹配当前屏已确认边；候选边不参与；按 slot 命中 |
| FR-PREVIEW-003 | 返回 | 返回上一屏 | P0 | 复用 | 返回到栈顶；栈空按钮禁用；back 动作等价 |
| FR-PREVIEW-004 | 未配置提示 | 点击无关联热区 | P1 | 改造 | 提示“热区「x」尚未配置关联”，不乱跳 |
| FR-PREVIEW-005 | 页面适配 | 屏幕内容撑满设备高度，长内容可滚动 | P0 | 改造 | 底部栏贴底；长内容可滚动；按钮不被裁切 |
| FR-PREVIEW-006 | 转场 | slide/slideLeft/slideUp/slideDown/fade/expand/none | P1 | 新增 | 转场与 M3E 一致；可全局关闭；减少动效优先 |
| FR-PREVIEW-007 | 手势 | swipe 左/右/上/下跳转 | P1 | 新增 | 手势与点击边不冲突；方向来自 `FlowEdge.direction`；可在 Prompt 中描述 |
| FR-PREVIEW-008 | 交互部件 | toggle、菜单、标签、底部抽屉、对话框、滑块、开关、复选框、单选框 | P1 | 新增 | 预览内状态可切换；不写回设计；退出预览重置 |
| FR-PREVIEW-009 | 设备与全屏 | 手机/桌面框、缩放适配、全屏 | P1 | 新增 | 全屏时保持比例；可退出 |
| FR-PREVIEW-010 | 分享只读 | 分享链接进入只读预览 | P1 | 新增 | 无编辑入口；不暴露项目内部 ID；Prompt 可选显示 |
| FR-PREVIEW-011 | 预览性能 | 20 屏、1000 Item 流畅切换 | P1 | 新增 | 首屏 <1s；切换 <300ms；无内存泄漏 |
| FR-PREVIEW-012 | 渲染共用 | 预览必须使用 FR-RENDER-001 共享渲染契约 | P0 | 新增 | 与编辑器缩略图、导出视觉一致 |

### 3.11 Prompt 交付

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-PROMPT-001 | 完整 Prompt | 由 `ProjectDoc` 生成结构化编码 brief | P0 | 新增 | 含目标、颜色、主题、布局、行为、风格、通用要求；与 M3E `buildPrompt` 语义一致 |
| FR-PROMPT-002 | 多语言 | 支持中文/英文/日文/韩文 | P0 | 新增 | 输出语言与 UI 语言可独立选择；术语一致 |
| FR-PROMPT-003 | Prompt 选项 | deliverable/tests/darkMode/languages/offline | P1 | 新增 | 选项写入项目；生成时按顺序追加；可随时改 |
| FR-PROMPT-004 | 手工编辑 | 用户可改 Prompt 并保存；可重置为自动生成 | P0 | 新增 | 保存到 `promptEdit`；重置后恢复生成；**版本记录 Prompt 摘要（`prompt_digest`）** |
| FR-PROMPT-005 | 单屏 Prompt | 只导出当前屏的 brief | P1 | 新增 | 不包含其他屏正文；只含标题级导航提示 |
| FR-PROMPT-006 | 复制/下载 | 一键复制、下载 `.md`/`.txt` | P0 | 新增 | 复制成功提示；下载文件名安全 |
| FR-PROMPT-007 | Prompt 导航 | 生成 section/screen 行号标记，点击跳转 | P2 | 新增 | 标记与文本一致；编辑后标记失效并提示 |
| FR-PROMPT-008 | Agent 指南 | 导出 `agent.md` 与设计 JSON，供编码 Agent 直接使用 | P1 | 新增 | 包内含 schema、约束、示例；JSON 可被 M3E 打开 |
| FR-PROMPT-009 | Prompt 与版本 | 版本记录生成时的 Prompt 摘要/哈希 | P0 | 新增 | 由 FR-VER-012 落地；`prompt_digest` 可追溯；不存储完整大文本 |
| FR-PROMPT-010 | Prompt 安全 | 不包含 API Key、服务端路径、其他项目数据 | P0 | 新增 | 安全断言通过；分享链接同样过滤 |
| FR-PROMPT-011 | 平台选择 | android/web 影响 Prompt 与布局建议 | P0 | 新增 | 桌面屏存在时默认 web；可手动切换 |
| FR-PROMPT-012 | Prompt 体量 | 20 屏/1000 Item 的 Prompt 可控 | P1 | 新增 | 默认 ≤60KB；超限提示分屏导出或精简 |

### 3.12 导出与分享

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-EXPORT-001 | 静态原型 | 生成可离线运行的可点击原型（目录版/单文件版） | P0 | 改造 | 按边跳转、返回栈、转场、交互部件、主题正确；不依赖后端 |
| FR-EXPORT-002 | 数据可追溯 | 目录版同时输出结构化数据 | P0 | 改造 | `data/screens.json`、`data/flow.json`、`data/project.json`；屏幕与边分离 |
| FR-EXPORT-003 | 目录安全 | 目录名清洗，禁止越出 `exports/` | P0 | 复用 | 非法字符/保留名/路径穿越被清洗或拒绝 |
| FR-EXPORT-004 | 注入防护 | 标题、文本、内联数据不得破坏 HTML/JS | P0 | 改造 | `</script>`、`<`、引号被转义；JSON 内联安全 |
| FR-EXPORT-005 | 布局正确 | 每屏内容撑满设备视口 | P0 | 改造 | 底部栏贴底；长内容滚动；桌面/手机尺寸正确 |
| FR-EXPORT-006 | Prompt 包 | 导出 `prompt.md` + `design.json` + `agent.md` | P0 | 新增 | 可解压即用；JSON 可被 M3E 打开；Prompt 与当前项目一致 |
| FR-EXPORT-007 | 分享链接 | 把只读设计压缩进 URL fragment 或服务端 token | P1 | 新增 | 小项目 `#docz=`；大项目返回 token 链接；不携带密钥 |
| FR-EXPORT-008 | 离线可用 | 导出物断网可打开 | P0 | 改造 | `file://` 或本地静态服务器可用；字体回退；无外部依赖 |
| FR-EXPORT-009 | 导出范围 | 选择全部/单屏/选中屏 | P2 | 新增 | 单屏导出保留入口与返回；边裁剪正确 |
| FR-EXPORT-010 | 图片/PDF | 批量导出屏幕图片或 PDF | P2 | 新增 | 输出分辨率可配置；不影响原型导出 |
| FR-EXPORT-011 | 版本水印 | 导出物可标注版本/时间/来源 | P2 | 新增 | 水印可关闭；不破坏交互 |
| FR-EXPORT-012 | 体积预算 | 目录版与单文件版分别定义体积预算 | P1 | 新增 | **目录版**：20 屏/1000 Item 的 `index.html` ≤300KB，数据文件合计 ≤2MB；**单文件版**：`index.html` ≤2MB（含内联运行时与数据） |
| FR-EXPORT-013 | 导出模式 | 明确目录版（默认）与单文件版（P1） | P0 | 新增 | 目录版数据分离；单文件版内联；两种模式均通过 AC-504/AC-514 对应子项 |
| FR-EXPORT-014 | 旧格式导出 | `format:"node-tree"` 的屏幕通过旧格式只读渲染器导出 | P0 | 新增 | 旧屏可离线查看；不进入 M3 运行时；安全转义 |

### 3.13 协作、权限与审计

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-USER-001 | 角色与权限 | owner/editor/readonly/visitor；区分本地单机与团队服务器 | P0 | 改造 | 本地单机未登记可写；团队服务器未登记 403；所有写接口服务端校验；前端置灰只是辅助 |
| FR-USER-002 | 成员管理 | 邀请、移除、改角色 | P2 | 保留 | 需用户体系；当前可直接改 `project.json` |
| FR-USER-003 | 登录/鉴权 | 登录态、SSO、会话 | P1（团队服务器门禁） | 保留 | 团队服务器模式 P1 前必须提供最小鉴权；本地单机只用 `x-proto-user` 记录 actor |
| FR-USER-004 | 实时协作 | 多人同时编辑、光标、评论 | P2 | 保留 | 需 CRDT/OT 与推送通道 |
| FR-AUDIT-001 | 操作日志 | 记录生成、接受、拒绝、锁定、回滚、复制、删除、建边、改边、删边、主题变更 | P1 | 改造 | 含 `log_id/at/actor/action/object_id/result/detail` |
| FR-AUDIT-002 | 上下文审计 | 每次生成记录目标屏、scope、嵌入屏、标题提示、Prompt 长度 | P1 | 改造 | 可按 `screen_id` 过滤 |
| FR-AUDIT-003 | 异常告警 | 跨屏写入、AI 输出夹带他屏内容时告警 | P1 | 复用 | `level:"alert"`；审计单列展示 |
| FR-AUDIT-004 | 查询接口 | 最近 200 条审计 + 最近 100 个 job | P1 | 复用 | `GET /api/projects/:pid/audit?screen_id=` |
| FR-AUDIT-005 | 项目配置审计 | 主题/设计规范/模型切换记录 | P1 | 新增 | 可追溯谁在何时改了主题或模型 |
| FR-AUDIT-006 | 分享访问统计 | 分享链接访问次数/来源 | P2 | 新增 | 不采集个人敏感信息；可关闭 |

### 3.14 国际化与可访问性

| 编号 | 名称 | 需求 | 优先级 | 合并动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| FR-I18N-001 | UI 多语言 | 中文/英文/日文/韩文 | P1 | 新增 | 所有 UI 字符串有 key；语言切换即时生效 |
| FR-I18N-002 | 内容语言 | 设计与 Prompt 语言可独立选择 | P0 | 新增 | 内容字体按语言补充 Noto Sans；Prompt 语言正确 |
| FR-I18N-003 | RTL | 阿拉伯语等 RTL 布局 | P2 | 新增 | 编辑器 UI 与预览镜像；M3 部件支持 |
| FR-I18N-004 | 语言回退 | 缺 key 回退英文并记录 | P1 | 新增 | 不出现空白或 key 名 |
| FR-A11Y-001 | 键盘可达 | 编辑器主要操作可键盘完成 | P1 | 新增 | Tab 顺序合理；焦点可见；快捷键可查 |
| FR-A11Y-002 | 语义与 ARIA | 按钮/面板/对话框有角色与标签 | P1 | 新增 | 屏幕阅读器可识别主要区域 |
| FR-A11Y-003 | 对比度 | 编辑器 UI 满足 WCAG 2.1 AA | P1 | 新增 | 主题切换后仍满足；画布内容尽力而为 |
| FR-A11Y-004 | 减少动效 | 尊重 `prefers-reduced-motion` | P1 | 新增 | 预览/导出/编辑器动效降级 |

### 3.15 未实现与不做（边界）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 多人实时协作 | 保留 | 单用户，`x-proto-user` 预留 |
| 登录与鉴权（本地单机） | 保留 | 无登录态；分享用只读快照 |
| 登录与鉴权（团队服务器） | P1 未实现 | P1 前必须补齐最小鉴权；当前团队模式为受信网络内测 |
| 成员管理界面/接口 | 保留 | 需改 `project.json` |
| 条件分支/变量 | 保留 | `trigger` 有 click/auto/swipe，无表达式引擎 |
| 弹层页/弹窗预览 | 部分 | M3 `dialog/bottomSheet` 可渲染；独立弹层路由未做 |
| 组件库/组件复用 | 保留 | 只有部件级复用，无用户组件定义 |
| 生产级代码生成 | 保留 | 导出 Prompt/原型，不导出工程代码 |
| 版本自动清理 | 保留 | 版本永久保留，P2 再做保留策略 |
| 多节点框选 | P1 未实现 | MVP 先单选 + 分组；框选随后 |
| 画布节点虚拟化 | P2 未实现 | 1000+ Item 性能优化 |
| 实时协同编辑 | 保留 | 需 CRDT/OT |
| 插件系统 | 保留 | 无插件 API |
| PDF/图片导出 | P2 未实现 | 先做原型与 Prompt |
| 单文件导出 | P1 未实现 | MVP 先做目录版 |
| Prompt 导航标记 | P2 未实现 | P1 仅静态标记 |

---

## 4. 非功能需求

### 4.1 隔离、原子性与安全

| 编号 | 类别 | 需求 | 优先级 | 验收方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| NFR-001 | 隔离 | 改 A 屏后，B 屏目录内所有文件内容 hash 与 mtime 不变 | P0 | AC-001 自动化 | 保留 |
| NFR-002 | 隔离 | 生成无法写入非目标屏 | P0 | 403 + 告警，AC-002/007 | 保留 |
| NFR-003 | 隔离 | 上下文只嵌入目标屏 | P0 | `context_audit` + Prompt 断言 | 改造 |
| NFR-004 | 原子性 | 版本提交失败不产生半应用状态 | P0 | AC-008 故障注入 | 保留 |
| NFR-005 | 安全 | 密钥不回显；导出目录不可越界；HTML/JS 注入被转义 | P0 | 单元/集成断言 | 改造 |
| NFR-006 | 并发 | 同屏写入串行（`KeyedQueue`），异屏并行 | P0 | 并发写同屏版本号不重复 | 保留 |
| NFR-007 | 可移植 | 服务端零运行时依赖，Node ≥22 直接启动 | P1 | 任意 cwd 启动监听端口 | 改造 |
| NFR-008 | 可替换 | 更换模型不改业务代码 | P1 | `provider.js` 适配层 | 保留 |
| NFR-009 | 一致性 | 多屏视觉统一只靠 Theme/设计 token | P1 | 生成与导出注入 | 改造 |
| NFR-010 | 可用性 | 常见自然语言修改能产出 patch | P1 | 回归用例 | 改造 |
| NFR-011 | 错误可操作 | 422 必须带 `detail.hint`；区分“输出非法”与“没听懂” | P1 | 回归用例 | 保留 |
| NFR-012 | 性能 | 单屏生成 P95 ≤30s；画布 500 Item 流畅 | P1 | 压测 | 目标 |
| NFR-013 | 兼容 | Chrome/Edge/Safari/Firefox 最近两个大版本；iOS Safari 16+ | P1 | 兼容性测试 | 目标 |
| NFR-014 | 性能 | 空间编辑提交到版本可见 P95 ≤500ms（本地） | P1 | 性能测试 | 目标 |
| NFR-015 | 性能 | 规则路由决策 P95 ≤50ms | P1 | 压测 | 保留 |
| NFR-016 | 成本 | 确定性文字修改类请求的大模型调用占比 ≤5% | P1 | 路由日志统计 | 目标 |
| NFR-017 | 安全 | 路由日志与版本摘要不得包含 API Key、完整 Prompt 正文 | P0 | 安全评审 | 保留 |
| NFR-018 | 一致性 | 空间编辑与 AI 写入共用锁定/权限判定 | P0 | 越权测试 | 保留 |
| NFR-019 | 可观测 | 每次变更具备追踪 ID，串联路由、版本写入 | P1 | 可定位单次变更全链路 | 改造 |
| NFR-020 | 兼容 | 合并不改变原有 API 的向后兼容语义 | P1 | 回归测试 | 目标 |

### 4.2 合并新增非功能需求

| 编号 | 类别 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- | --- |
| NFR-021 | 性能 | 500 Item/20 屏下，画布平移缩放 ≥55fps；Tidy ≤150ms | P1 | 性能报告达标 |
| NFR-022 | 体积 | 编辑器首屏 JS ≤600KB gzip；按需加载 | P1 | 构建产物分析 |
| NFR-023 | 构建 | Node 22/24；npm 安装可重复；CI 通过 typecheck + test + build | P0 | CI 绿灯 |
| NFR-024 | 浏览器 | 见 NFR-013（统一矩阵） | P1 | 兼容性矩阵 |
| NFR-025 | 迁移 | 旧数据可读；迁移有 dry-run、备份、报告、回滚 | P0 | AC-601～610 |
| NFR-026 | 安全 | AI Key 默认服务端保存；浏览器 BYOK 可选；分享/导出不含密钥 | P0 | 安全评审 + 扫描 |
| NFR-027 | 可维护 | Schema 版本化；迁移脚本可重复；共享类型/契约 | P0 | 代码评审 |
| NFR-028 | 可观测 | 结构化日志、request id、路由日志、审计 | P1 | 日志可检索 |
| NFR-029 | 可访问性 | 编辑器 UI 满足 WCAG 2.1 AA；画布内容尽力而为 | P1 | 审计报告 |
| NFR-030 | 国际化 | 四语言 key 完全对齐；缺 key 回退英文 | P1 | parity 测试 |
| NFR-031 | 离线 | 静态导出与分享查看器断网可用；字体回退 | P0 | AC-504/508 |
| NFR-032 | 许可 | MIT + NOTICE；Apache-2.0 归属保留；无 GPL 依赖 | P0 | 许可扫描 |
| NFR-033 | 测试 | 现有 97 例适配 + 新增 ≥60 例；关键路径覆盖 | P0 | 测试报告 |
| NFR-034 | 并发 | 编辑器保存冲突检测；同屏串行；异屏并行 | P0 | AC-319 |
| NFR-035 | 兼容性 | API v1 保持；废弃字段有过渡期与文档 | P1 | 回归 + 文档 |
| NFR-036 | 可恢复 | 导入/迁移/导出失败可回滚；不破坏原数据 | P0 | 故障注入 |
| NFR-037 | 数据规模 | 单项目 ≤200 屏；单屏 ≤2000 Item；项目 ≤50MB | P1 | 压测 |
| NFR-038 | 启动 | 本地 `npm start` ≤3s 可访问；错误有可操作提示 | P1 | 启动测试 |
| NFR-039 | 渲染一致 | 编辑器/预览/导出共享 FR-RENDER-001 契约；视觉回归通过 | P0 | 视觉回归报告 |
| NFR-040 | 大文件导入 | P0 导入支持 multipart 或服务端文件路径，上限与 NFR-037 一致 | P0 | AC-611 |
| NFR-041 | 权限门禁 | 团队服务器模式未登记 403；P1 前提供最小鉴权 | P0 | 越权测试 |

---

## 5. 数据需求

### 5.1 物理存储

```
data/
├─ ai-models.json                         全局模型目录（跨项目共享，密钥只存服务端）
└─ projects/<pid>/
   ├─ project.json                        项目元数据 + ProjectDesign + members + screen_titles
   ├─ design-revisions.json               主题/设计规范变更历史
   ├─ canvas.json                         画布视口与屏幕位置（唯一坐标源）
   ├─ ui-state.json                       编辑器 UI 状态（面板宽度、标签、收藏）
   ├─ flow.json                           关联边（只存 screen_id + item_id + slot + 目标）
   ├─ measurements.json                   文本宽度测量缓存（非权威，可重建）
   ├─ history.json                        jobs[] / patches[] / audits[]
   └─ screens/<sid>/
      ├─ meta.json                        状态、锁定、当前版本、版本索引、pending
      └─ versions/v<n>.json               每版完整 ScreenDoc 快照
```

**兼容旧数据：** 迁移后仍保留 `project.json` 的旧字段（`design_tokens`、`device`、`screen_titles`），并新增 `schema_version: 2` 与 `design`。旧 `screens/<sid>/versions/v<n>.json` 的 `doc` 若为 `{version, root}`，则标记 `format:"node-tree"`，只读兼容并通过旧格式只读渲染器呈现。

**坐标唯一源：** 屏幕画布位置只存 `canvas.json`；`ScreenMeta` 不含坐标。`ScreenDoc.frame.x/y` 在屏内恒为 0。

### 5.2 核心实体

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| Project | `project_id`、`name`、`schema_version`、`device{width,height}`、`design`、`design_tokens`、`members[]`、`screen_titles[]` | `design` 为权威主题；`design_tokens` 为派生投影 |
| ProjectDesign | `title`、`brief`、`platform`、`paletteKey`、`customPalette`、`dynamicColor`、`theme`、`promptOptions`、`promptEdit` | 项目级设计配置 |
| ProjectRevision | `revision`、`created_at`、`actor`、`change_summary`、`design`、`design_tokens` | 主题/规范变更历史 |
| ScreenMeta | `screen_id`、`project_id`、`title`、`remark`、`order`、`status`、`locked`、`current_version`、`versions[]`、`pending`、`derived_from`、`lock_audit[]`、`format` | **不含 x/y**；`status` ∈ `draft/generating/pending/applied/locked` |
| ScreenDoc | `schema`、`format`、`frame`、`groups[]`、`meta` | 单屏设计文档；版本快照的最小单元 |
| Frame | `id`、`name`、`x`、`y`、`w`、`h`、`bg`、`note`、`length`、`place` | `frame.id = screen_id`；`ScreenDoc` 内 `x=y=0` |
| Group | `id`、`x`、`y`、`axis`、`items[]`、`locked`、`hidden`、`name`、`free`、`pos` | 屏幕本地坐标；`pos` 用于自由组；`hidden` 默认不导出 |
| Item | `id`、`kind`、`label`、`icon`、`variant`、`supporting`、`size`、`size2`、`tabs`、`selected`、`checked`、`value`、`note`、`fill`、`src`、`pos`、`hidden`、`name`、`locked` 等 | 36 种 kind；`id` 屏内唯一；`pos` 仅自由组使用；**不含 `action`** |
| ScreenVersion | `version`、`version_id`、`created_at`、`source{kind,label,prompt,job_id}`、`change_source`、`change_summary`、`route_layer`、`rule_id`、`ai_cost`、`theme_snapshot`、`prompt_digest`、`doc` | 整文件快照，非 diff 链 |
| GenerationJob | `job_id`、`target_screen_id`、`edit_scope`、`prompt`、`selection`、`status`、`model{...}`、`context_audit`、`route_decision`、`created_at`、`actor` | `status` ∈ `generating/pending_confirm/applied/rejected/failed/no_op/cancelled` |
| FlowEdge | `edge_id`、`source_screen_id`、`source_item_id`、`source_slot`、`target_kind`、`target_screen_id`、`url`、`trigger`、`direction`、`transition`、`note`、`status`、`expires_at`、时间戳、`created_by` | `target_kind` ∈ `screen/back/link/menu/toggle`；`trigger` ∈ `click/swipe/auto`；`swipe` 时 `direction` ∈ `left/right/up/down`；`status` ∈ `candidate/confirmed`；**`orphan` 动态计算，不存本表** |
| Measurement | `screen_id`、`items{item_id: width}`、`measured_at` | 文本型部件宽度缓存；Prompt/导出兜底 |
| UiState | `viewport`、`panelWidths`、`activeTab`、`favorites[]` | 编辑器 UI 状态；P2 视图持久化 |
| AiModel | `model_id`、`name`、`provider`、`model`、`base_url`、`api_key`、`timeout_ms`、`enabled`、`builtin`、`source` | `api_key` 永不出现在任何响应中 |

### 5.3 `ScreenDoc` 示例

```json
{
  "schema": "m3studio/screen@1",
  "format": "m3",
  "frame": {
    "id": "scr_ab12cd34ef56",
    "name": "首页",
    "x": 0,
    "y": 0,
    "w": 412,
    "h": 892,
    "bg": "surface",
    "note": "展示今日推荐与快捷入口。",
    "length": 1200,
    "place": "top"
  },
  "groups": [
    {
      "id": "grp_header",
      "x": 0,
      "y": 0,
      "axis": "x",
      "name": "顶栏",
      "locked": false,
      "hidden": false,
      "items": [
        {
          "id": "itm_appbar",
          "kind": "topAppBar",
          "label": "今日推荐",
          "icon": "menu",
          "icon2": "search",
          "variant": "filled",
          "name": "应用栏",
          "locked": false,
          "hidden": false
        }
      ]
    },
    {
      "id": "grp_list",
      "x": 16,
      "y": 112,
      "axis": "y",
      "name": "推荐列表",
      "locked": false,
      "hidden": false,
      "items": [
        {
          "id": "itm_card_1",
          "kind": "card",
          "label": "番茄汤",
          "supporting": "30 分钟",
          "icon": null,
          "variant": "filled",
          "size": 380,
          "size2": 223,
          "note": "点击进入食谱详情。",
          "name": "食谱卡片",
          "locked": false,
          "hidden": false
        }
      ]
    },
    {
      "id": "grp_free_1",
      "x": 0,
      "y": 400,
      "axis": "free",
      "name": "自由组",
      "locked": false,
      "hidden": false,
      "pos": { "x": 0, "y": 400 },
      "items": [
        {
          "id": "itm_fab",
          "kind": "fab",
          "label": "添加",
          "icon": "add",
          "variant": "primary",
          "name": "浮动按钮",
          "locked": false,
          "hidden": false,
          "pos": { "x": 344, "y": 720 }
        }
      ]
    }
  ],
  "meta": {
    "source_format": "m3e-canvas@0.1",
    "imported_at": "2026-11-05T00:00:00.000Z"
  }
}
```

**注意：** 上例没有 `action`。导航关系存在 `flow.json`：

```json
{
  "schema_version": 2,
  "edges": [
    {
      "edge_id": "edg_001",
      "source_screen_id": "scr_ab12cd34ef56",
      "source_item_id": "itm_card_1",
      "source_slot": null,
      "target_kind": "screen",
      "target_screen_id": "scr_detail",
      "url": null,
      "trigger": "click",
      "direction": null,
      "transition": "slide",
      "note": "",
      "status": "confirmed",
      "expires_at": null,
      "created_at": "2026-11-05T00:00:00.000Z",
      "created_by": "local-user"
    },
    {
      "edge_id": "edg_002",
      "source_screen_id": "scr_ab12cd34ef56",
      "source_item_id": "itm_fab",
      "source_slot": null,
      "target_kind": "screen",
      "target_screen_id": "scr_detail",
      "url": null,
      "trigger": "swipe",
      "direction": "left",
      "transition": "slideLeft",
      "note": "左滑进入详情",
      "status": "confirmed",
      "expires_at": null,
      "created_at": "2026-11-05T00:00:00.000Z",
      "created_by": "local-user"
    }
  ]
}
```

### 5.4 `ProjectDoc` 聚合示例

```json
{
  "schema": "m3studio/project@1",
  "title": "食谱",
  "brief": "保存和搜索食谱。",
  "platform": "android",
  "paletteKey": "custom",
  "customPalette": {
    "label": "品牌绿",
    "primary": "#3f6b4f",
    "secondary": "#526350",
    "tertiary": "#3c6470",
    "neutral": "#5c5f5c"
  },
  "dynamicColor": false,
  "theme": {
    "dark": false,
    "bothModes": true,
    "contrast": "standard",
    "shape": "rounded",
    "font": "roboto",
    "emphasized": false,
    "motion": "expressive"
  },
  "promptOptions": ["deliverable", "tests"],
  "promptEdit": null,
  "design_tokens": {
    "colors": { "primary": "#3f6b4f", "surface": "#fbfdf8" },
    "radius": { "sm": 8, "md": 16, "lg": 28 },
    "font": { "base": 16, "family": "Roboto" }
  }
}
```

`ProjectDoc` 由服务端在 Prompt/导出时组装：`ProjectDesign` + 每屏 `ScreenDoc.frame`（加上 `canvas.json` 的屏幕位置）+ `ScreenDoc.groups`。组装结果必须可重复（NFR/C-027）。

### 5.5 数据约束

| 编号 | 约束 | 状态 |
| --- | --- | --- |
| DC-001 | Screen 与 FlowEdge 必须独立存储，屏幕内容中不得内嵌跳转关系 | 保留 |
| DC-002 | 一次生成只有一个 `target_screen_id`，且与请求路径一致 | 保留 |
| DC-003 | 生成服务的数据权限仅限目标 Screen 及其 Version | 保留 |
| DC-004 | 关联服务不得调用任何 Screen 内容更新接口 | 保留 |
| DC-005 | 锁定 Screen 的版本号不得因任何操作递增 | 保留 |
| DC-006 | 删除 Screen 前必须检查关联边并等待用户选择处理方式 | 保留 |
| DC-007 | 每次版本变更必须产生新快照，版本号严格 +1 | 保留 |
| DC-008 | Item id 在屏内唯一且稳定；patch 只按 id 定位，禁止位置索引 | 改造 |
| DC-009 | 所有文件写入走“先写临时文件再重命名”的原子写 | 保留 |
| DC-010 | 空间编辑提交必须写入 `change_source=manual_direct`，不得伪装为 AI 版本 | 保留 |
| DC-011 | 内置生成器产生的 Patch 必须标记 `change_source=builtin_rule` | 保留 |
| DC-012 | 三方合并的 `merge_base_version` 必填且必须为双方共同祖先 | 保留（P2） |
| DC-013 | 冲突未处理时不得写入正式屏幕版本 | 保留（P2） |
| DC-014 | 锁定 Screen 的版本号不得因空间编辑或内置生成器操作递增 | 保留 |
| DC-015 | 所有 `ScreenDoc` 必须带 `schema` 与 `format`，并经过版本化校验 | 新增 |
| DC-016 | `item.kind` 必须在 36 种白名单内；未知 kind 拒绝 | 新增 |
| DC-017 | `ScreenDoc` 不得持久化 `action`；导航只存 `FlowEdge` | 新增 |
| DC-018 | `ScreenDoc` 使用屏幕本地坐标；画布坐标只存 `canvas.json`；`ScreenMeta` 不含坐标 | 新增（V4.1 修订） |
| DC-019 | 主题只在项目级维护；屏幕只允许 `frame.bg` 覆盖 | 新增 |
| DC-020 | 旧 `node-tree` 文档只读兼容；转换必须显式触发并保留原版本；只读渲染走独立渲染器 | 新增（V4.1 修订） |
| DC-021 | 分享链接与 M3E 导出不得包含 API Key、本地图片二进制、AI 改写历史 | 新增 |
| DC-022 | Prompt/导出不得包含 API Key、服务端路径、其他项目数据 | 新增 |
| DC-023 | 同一屏内 Item id 唯一；FlowEdge 的 `source_item_id` 在创建/确认时必须存在；孤儿边例外（动态计算） | 新增（V4.1 修订） |
| DC-024 | 版本文件写入后不可修改；回滚只新增版本指针/新版本 | 新增 |
| DC-025 | 导入必须先校验后写入；失败不产生部分数据 | 新增 |
| DC-026 | `ProjectDoc` 组装必须确定性：同一输入产生同一输出 | 新增 |
| DC-027 | 单屏生成上下文不得包含其他屏正文 | 保留/改造 |
| DC-028 | UI 四语言 key 必须对齐；缺 key 回退英文 | 新增 |
| DC-029 | 导出目录名必须清洗；路径必须位于 `exports/` 内 | 保留 |
| DC-030 | 任何 AI 输出必须通过 M3 schema 校验才能进入 pending | 新增 |
| DC-031 | `theme_snapshot` 必须随版本保存，保证旧版本可重放 | 新增 |
| DC-032 | 编辑器保存必须携带 `base_version`；版本已前进时拒绝覆盖 | 新增 |
| DC-033 | `measurements.json` 是缓存，不得作为版本/导出的唯一依据 | 新增 |
| DC-034 | 分享链接必须带 `schema` 与 `format`，读取时校验 | 新增 |
| DC-035 | 导入/导出 M3E 时必须做 id 重映射并报告冲突 | 新增 |
| DC-036 | 自由组内 Item 可携带 `Item.pos`；非自由组 Item 坐标由 Group 与顺序推导，禁止写入 `Item.pos` | 新增（V4.1） |
| DC-037 | `Group.hidden`/`Item.hidden` 为 true 时默认不进入导出；需显式选择 | 新增（V4.1） |
| DC-038 | 分组/取消分组/Tidy 后必须按确定性规则归一坐标，不得依赖临时 UI 状态 | 新增（V4.1） |
| DC-039 | 孤儿边动态计算，不写入 `flow.json`；`flow.json` 的 hash 不因孤儿状态变化 | 新增（V4.1） |
| DC-040 | `swipe` 边必须带 `direction`；缺 direction 拒绝 | 新增（V4.1） |
| DC-041 | `prompt_digest` 必须随屏幕版本保存；可为哈希，不要求完整 Prompt | 新增（V4.1） |
| DC-042 | 团队服务器模式下未登记成员不得写；本地单机模式例外 | 新增（V4.1） |

### 5.6 数据迁移

#### 5.6.1 旧 `node-tree` → `ScreenDoc`

| 旧节点 | 新部件 | 说明 |
| --- | --- | --- |
| 根 `section` | `frame` | 尺寸取 `project.device`；背景取根样式 |
| `button` / `a[role=button]` | `button` 或 `iconButton` | 有文字 → button；纯图标 → iconButton；保留 `data-anchor` → Item id |
| `h1/h2/h3` | `text`（bold, size） | 按字号映射 |
| `p/span/div` 文本叶子 | `text` | 保留文本与主要样式 |
| `img` | `image` | `src` 保留 https；本地图片转为项目资源 |
| `input/select` | `textField` / `select` | label 取 placeholder/aria-label |
| `ul/li` | `listItem` 组 | 按 `axis:"y"` 连接 |
| `nav/header/footer` | `bottomNav` / `topAppBar` | 按位置与子项推断 |
| 其他容器 | `box` 或 `text` | 无法映射时降级并写入损失报告 |

- 转换结果必须经过 schema 校验；失败则保留 `format:"node-tree"`，不覆盖原版本。
- 转换生成一条 `manual_direct` 或 `import` 版本，摘要注明“旧文档转换，损失 N 项”。
- 损失报告字段：`{ node_id, tag, reason, fallback }`。

#### 5.6.2 M3E `Doc` → 项目

1. 校验 `isProject`（`groups`/`frames` 数组、字段合法）。
2. 为每个 `frame` 创建屏幕：`screen_id = frame.id`（冲突时重映射），`ScreenDoc.frame` 取该 frame，`x=y=0`，`groups` 取 `frameOfGroup` 属于该 frame 的组，坐标减去 frame.x/y。
3. 未归属任何 frame 的组：创建“未放置”屏幕，避免丢失。
4. `item.action` / `actions` / `frame.swipe` 转为 FlowEdge；`action.to` 为目标 frame id；`back`/`link` 映射 `target_kind`；`swipe` 映射 `trigger:"swipe"` + `direction`。
5. 删除 `ScreenDoc` 中的 `action`；`toggle`、`tabs`、`checked` 等设计态字段保留。
6. 项目级字段（title/brief/platform/paletteKey/customPalette/dynamicColor/theme/promptOptions/promptEdit）写入 `ProjectDesign`。
7. 返回 `{ screens, edges, warnings, loss }`；全部成功后才提交。

#### 5.6.3 项目 → M3E `Doc`

1. 组装 `ProjectDoc`；`frame.x/y` 取 `canvas.json` 的屏幕位置。
2. 按 `FlowEdge` 给 Item 注回 `action`/`actions`；`target_kind=back` → `{to:"back"}`；`link` → `{to:"link",url}`；`trigger:"swipe"` → `frame.swipe` + `direction`。
3. 输出 `Doc` JSON；不包含服务端字段（`project_id`、`version`、`audit`、`pending`、`theme_snapshot`、`prompt_digest`）。
4. 可选生成 `#docz=` 分享链接；超过大小上限时提示改用文件导出。

#### 5.6.4 迁移策略

- `npm run migrate:v2 -- --dry-run`：只读扫描，输出报告。
- `npm run migrate:v2`：先备份 `data/` 到 `data.backup-<timestamp>/`，再原地迁移；失败自动回滚。
- 迁移幂等：已迁移项目跳过；`schema_version` 升级。
- 旧版本保留：`format:"node-tree"` 版本不删除；转换产生新版本。
- 回滚：恢复备份或按项目回滚；提供 `npm run migrate:v2 -- --restore <backup>`。

---

## 6. 接口需求

### 6.1 通用约定

- 前缀 `/api`，返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, detail? } }`。
- 错误 `detail.hint` 在所有 422 上必须给出可照做的下一步。
- 写操作记录 `actor`（来自 `x-proto-user`，缺省 `local-user`）并写审计。
- 所有写接口必须校验：项目存在、屏幕属于项目、成员权限（团队模式）、锁定、pending、`base_version`（适用时）。
- **请求体上限：** 普通 JSON 5MB；**P0 导入支持** multipart/form-data（上限 50MB，与 NFR-037 一致）或服务端文件路径；导出大文件走下载流。
- 所有时间戳为 ISO 8601 UTC；所有 id 为字符串。

### 6.2 接口清单（保留 + 改造）

| 分类 | 方法与路径 | 说明 | 合并动作 |
| --- | --- | --- | --- |
| 健康 | `GET /api/health` | 当前生效模型与存储路径 | 复用 |
| 模型 | `GET/POST /api/models`、`PATCH/DELETE /api/models/:mid` | 增删改查（脱敏） | 复用 |
| 模型 | `POST /api/models/:mid/activate`、`POST /api/models/:mid/test` | 设为当前、连接测试 | 复用 |
| 生成器 | `GET/PATCH /api/generator` | 内置生成器配置 | 复用/改造 |
| 项目 | `GET/POST /api/projects`、`GET /api/projects/:pid` | 列表/创建/详情 | 复用 |
| 项目 | `PATCH /api/projects/:pid/tokens`、`GET /api/projects/:pid/snapshot` | **兼容投影**（内部委托 `/design`）、全量快照 | 改造 |
| 屏幕 | `GET/POST /api/projects/:pid/screens` | 列表（含 doc 与 anchors）、创建 | 改造 |
| 屏幕 | `GET/PATCH .../screens/:sid` | 详情、重命名/改备注 | 改造 |
| 屏幕 | `PATCH .../screens/:sid/canvas`、`DELETE .../screens/:sid` | 画布位置、删除（可带 `edge_action`） | 复用 |
| 屏幕 | `POST .../screens/reorder`、`POST .../screens/:sid/duplicate` | 排序、复制 | 改造 |
| 锁定 | `POST .../screens/:sid/lock`、`POST .../screens/:sid/unlock` | 带 `reason` | 复用 |
| 版本 | `GET .../screens/:sid/versions`、`GET .../versions/:v` | 列表、单版内容 | 改造 |
| 版本 | `GET .../screens/:sid/diff?a=&b=`、`POST .../rollback`、`POST .../undo` | 对比、回滚、撤销 | 改造 |
| 生成 | `POST .../screens/:sid/generations` | body: `prompt`、`edit_scope`、`selection`、`mode` | 改造 |
| 生成 | `POST .../pending/apply`、`POST .../pending/reject` | 接受/拒绝 | 复用 |
| 生成 | `POST .../manual-patch`、`GET .../jobs` | 手动 ops、任务历史 | 改造 |
| 关联 | `GET /api/projects/:pid/flow` | 返回边 + **动态计算** `orphan` 标记 | 改造 |
| 关联 | `POST .../flow/edges`、`POST .../flow/propose`、`POST .../flow/confirm` | 建边、候选、确认 | 改造 |
| 关联 | `PATCH .../flow/edges/:edgeId`、`DELETE .../flow/edges/:edgeId` | 改边、删边 | 改造 |
| 画布 | `GET/PUT /api/projects/:pid/canvas` | 视口与屏幕位置 | 复用 |
| 预览 | `GET /api/projects/:pid/preview?start=` | 只读拼装 | 改造 |
| 导出 | `POST /api/projects/:pid/export` | body: `start`、`name`、`format`（`static-dir`/`static-single`/`prompt`/`m3e`/`bundle`） | 改造 |
| 审计 | `GET /api/projects/:pid/audit?screen_id=` | 审计与任务 | 复用 |

### 6.3 合并新增接口

| 编号 | 方法与路径 | 说明 | 关键约束 |
| --- | --- | --- | --- |
| API-015 | `GET /api/projects/:pid/design` | 读取项目设计（主题、Prompt 配置） | 只读 |
| API-016 | `PATCH /api/projects/:pid/design` | **主题/标题/brief/平台/Prompt 选项的权威写入口** | 写权限；记录项目修订；不递增屏幕版本 |
| API-017 | `POST /api/projects/import` | **创建新项目**并导入 M3E JSON / 旧项目 / 备份 | multipart 或文件路径；校验后写入；返回新 `project_id`、报告、失败不落库 |
| API-017b | `POST /api/projects/:pid/import` | 导入到**现有项目** | 冲突策略：重映射 id；报告；失败不落库 |
| API-018 | `POST /api/projects/:pid/screens/:sid/doc` | 编辑器保存整屏 `ScreenDoc` | `base_version` 必填；锁定/pending/权限校验；生成 `manual_direct` 版本 |
| API-019 | `POST /api/projects/:pid/screens/:sid/convert` | 旧 node-tree → M3 预览 | 不提交；返回 `{doc, report}`；确认后再保存 |
| API-020 | `GET /api/projects/:pid/prompt?lang=&screen_id=` | 生成 Prompt | 只读；单屏不读其他屏正文；可返回 `marks` |
| API-021 | `POST /api/projects/:pid/share` | 生成分享链接/token | 过滤密钥/本地图片/历史；超限返回 413 |
| API-022 | `GET /api/share/:token` | 读取只读分享快照 | 只读；过期/不存在 404 |
| API-023 | `POST .../screens/:sid/measurements` | 更新文本宽度缓存 | 只更新缓存；不产生版本 |
| API-024 | `POST .../screens/:sid/tidy` | 预览 Tidy 结果 | 不提交；返回 `{doc, changes}` |
| API-025 | `POST .../screens/:sid/items/:itemId/notes` | AI 辅助备注 | 只改 note；待确认或直接落库可配置 |
| API-026 | `GET /api/projects/:pid/export/:format` | 下载导出物 | 格式 `static-dir/static-single/prompt/m3e/bundle`；路径安全 |
| API-027 | `POST /api/projects/:pid/validate` | 校验项目/文档 | 返回错误路径与修复建议 |
| API-028 | `GET /api/schema/:name` | 获取 JSON Schema | 版本化；用于客户端校验 |
| API-029 | `GET/PUT /api/projects/:pid/ui-state` | 编辑器 UI 状态 | 仅 UI 状态；不产生版本 |
| API-030 | `GET /api/projects/:pid/render-contract` | 返回共享渲染契约版本与示例 | 只读；用于编辑器岛与导出器校验 |

### 6.4 编辑器桥接协议

编辑器岛（iframe 或独立窗口）与宿主通过 `postMessage` 通信。所有消息带 `protocol: "m3studio/editor@1"`、`request_id`、`screen_id`。

**宿主 → 编辑器：**

| 消息 | 载荷 | 说明 |
| --- | --- | --- |
| `load` | `{ doc, theme, design_tokens, readonly, locked, locale, measurements }` | 加载屏幕；`doc` 为 `ScreenDoc` |
| `theme` | `{ theme, design_tokens }` | 主题热更新 |
| `mode` | `{ readonly, locked }` | 切换只读/锁定 |
| `flush` | `{}` | 请求立即提交未保存变更 |
| `fit` | `{}` | 适应画布 |
| `preview` | `{ startItemId? }` | 请求预览 |

**编辑器 → 宿主：**

| 消息 | 载荷 | 说明 |
| --- | --- | --- |
| `ready` | `{ protocol, version }` | 编辑器就绪 |
| `change` | `{ doc, dirty, summary, base_version }` | 变更（防抖 300ms），宿主不立即落库 |
| `save` | `{ doc, base_version, summary }` | 用户显式保存 |
| `select` | `{ item_ids, group_ids }` | 选区变化，用于宿主侧生成范围 |
| `preview` | `{ start_screen_id, start_item_id? }` | 请求宿主打开预览 |
| `error` | `{ code, message, detail }` | 编辑器内部错误 |
| `dirty` | `{ dirty }` | 离开前提示 |

**约束：**

- 宿主必须校验 `event.origin` 与 `event.source`。
- 编辑器不得直接访问 API 或存储；所有写入经宿主。
- `doc` 大小上限 5MB；超过拒绝并提示。
- 桥接超时 10s；超时后宿主显示重试，不丢失本地草稿（宿主缓存最后一次 `change`）。
- 协议版本不兼容时拒绝加载并提示升级。

### 6.5 导入/导出格式

| 格式 | 扩展名 | 说明 |
| --- | --- | --- |
| 项目备份 | `.m3studio.zip` | `project.json` + `screens/` + `flow.json` + `design-revisions.json` + `manifest.json` |
| M3E 设计 | `.json` | 符合 m3e-canvas `Doc`；可被原项目打开 |
| 旧项目 | 目录/`.json` | `node-tree` 只读；可转换；由旧格式只读渲染器呈现 |
| Prompt 包 | `.zip` | `prompt.md` + `design.json` + `agent.md` + `README.md` |
| 静态原型（目录版） | 目录 | `index.html` + `data/` + 可选 assets；数据分离；默认模式 |
| 静态原型（单文件版） | `.html` | 内联运行时与数据；P1 |
| 分享链接 | URL | `#docz=` 或 `/s/:token` |

### 6.6 错误码

| HTTP | code | 含义 | 屏幕是否变化 |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数不合法 | 否 |
| 400 | `EDIT_SCOPE_REQUIRED` | 缺 `edit_scope` 或取值非法 | 否 |
| 400 | `SELECTION_REQUIRED` | 区域/组件范围未提供选区 | 否 |
| 400 | `SELECTION_NOT_FOUND` | 选区 Item/Group 不在当前屏 | 否 |
| 400 | `ITEM_NOT_FOUND` / `SLOT_NOT_FOUND` | 热区 Item/slot 不存在 | 否 |
| 400 | `EDGE_PARSE_FAILED` / `NO_HOTSPOT` | 一句话建边解析失败 | 否 |
| 400 | `THEME_INVALID` | 主题/调色板非法 | 否 |
| 400 | `SWIPE_DIRECTION_REQUIRED` | swipe 边缺 direction | 否 |
| 403 | `NO_PERMISSION` | 只读成员/未登记成员（团队模式）执行写操作 | 否 |
| 403 | `FORBIDDEN_TARGET` | 跨屏写入，已拦截并告警 | 否 |
| 404 | `NOT_FOUND` | 项目/屏幕/版本/边/模型/分享不存在 | 否 |
| 409 | `CONFLICT` | 存在 pending、已有生成中、无可撤销版本、保存冲突 | 否 |
| 409 | `PENDING_EXISTS` | 存在待确认 AI 版本，拒绝人工编辑 | 否 |
| 409 | `STALE_PENDING` | pending 基于的版本已过期 | 否 |
| 409 | `EDGES_EXIST` | 删除有边的屏幕未指定处理方式 | 否 |
| 413 | `IMPORT_TOO_LARGE` / `SHARE_TOO_LARGE` | 导入/分享超过上限 | 否 |
| 422 | `INVALID_OUTPUT` | 模型输出违反结构契约 | 否 |
| 422 | `UNPROCESSABLE` | 未识别出可执行的修改 | 否 |
| 422 | `SCHEMA_INVALID` | M3 `ScreenDoc`/`ProjectDoc` 校验失败 | 否 |
| 422 | `SCHEMA_VERSION_UNSUPPORTED` | schema 版本不支持 | 否 |
| 422 | `MIGRATION_UNSUPPORTED` | 旧文档无法转换 | 否 |
| 423 | `SCREEN_LOCKED` | 屏幕已锁定 | 否 |
| 502 | `MODEL_FAILED` | 模型调用失败/超时/输出截断 | 否 |
| 504 | `EDITOR_BRIDGE_TIMEOUT` | 编辑器桥接超时 | 否 |

`INVALID_OUTPUT`、`UNPROCESSABLE`、`SCHEMA_INVALID` 都是 422，但语义不同：前端必须区分“模型输出非法”“没听懂”“设计文档非法”。

---

## 7. AI 编排需求

### 7.1 上下文闸门

| 编号 | 需求 | 描述 | 状态 |
| --- | --- | --- | --- |
| AI-001 | 唯一构造入口 | `buildGenerationContext` 只接收单屏 `ScreenDoc`、主题、指令、选区 | 改造 |
| AI-002 | 标题级跨屏提示 | 其他屏只以标题（≤40 字）出现 | 保留 |
| AI-003 | 输出归一化 | 兼容代码块 JSON、别名、缺 id、属性平铺、HTML 片段 | 改造 |
| AI-004 | 热区补齐 | 可点击 Item 缺 id/可点击语义时补齐；但不得伪造 Item | 改造 |
| AI-005 | 越权拦截 | 输出中出现其他 `screen_id` 或跨屏 target 一律拒绝 | 保留 |
| AI-006 | 热区保护 | 整屏替换会丢失已有热区（Item id）时拒绝 | 改造 |
| AI-007 | 参数降级重试 | 网关拒绝 `response_format`/`max_tokens` 时去参重试一次 | 保留 |
| AI-008 | 截断识别 | 输出因长度上限被截断时明确报错并提示调大上限 | 保留 |
| AI-009 | 内置生成器 | 确定性、无网络、恒可用，遵守同一 M3 输出契约 | 改造 |
| AI-010 | 路由前置 | 意图路由在大模型调用前完成，优先短路 | 保留 |
| AI-011 | 否定语义保留 | 不得丢弃“不要改/仅改/除了”等限定语义 | 保留 |
| AI-012 | 人工修改上下文 | AI 请求携带目标屏人工修改的 keep 标记摘要 | P2 |
| AI-013 | 冲突不自动裁决 | AI 不自动决定人工编辑与自身 Patch 的冲突胜负 | P2 |
| AI-014 | 降级可观测 | 每次降级/升级记录原因 | 保留 |
| AI-015 | M3 Schema 约束 | 只允许 Registry 中的 kind；字段白名单；坐标在屏幕范围内 | 新增 |
| AI-016 | 动作剥离 | AI 输出中的 `action`/`actions`/`swipe` 一律剥离，不写导航 | 新增 |
| AI-017 | 主题只读 | AI 不得修改项目主题/调色板；只能使用当前主题 | 新增 |
| AI-018 | 生成后校验 | 输出先 schema 校验，再跨屏校验，再 pending | 新增 |
| AI-019 | 修复重试 | 可修复错误自动修复一次；不可修复拒绝 | 新增 |
| AI-020 | 成本记录 | 记录 token/字符/路由层级/是否调用大模型 | 改造 |

### 7.2 M3 输出契约

**整屏：**

```json
{
  "target_screen_id": "scr_ab12cd34ef56",
  "mode": "full",
  "doc": {
    "schema": "m3studio/screen@1",
    "format": "m3",
    "frame": { "...": "..." },
    "groups": []
  }
}
```

**局部：**

```json
{
  "target_screen_id": "scr_ab12cd34ef56",
  "mode": "patch",
  "ops": [
    { "op": "updateItem", "item_id": "itm_btn", "patch": { "label": "保存" } },
    { "op": "insertItem", "group_id": "grp_actions", "index": 1, "item": { "id": "itm_new", "kind": "button", "label": "取消", "icon": null, "variant": "text" } },
    { "op": "removeItem", "item_id": "itm_old" },
    { "op": "moveItem", "item_id": "itm_card", "to_group_id": "grp_list", "index": 0 },
    { "op": "updateGroup", "group_id": "grp_list", "patch": { "axis": "y" } },
    { "op": "setFrame", "patch": { "place": "center" } }
  ]
}
```

**允许的 op：**

| op | 目标 | 说明 |
| --- | --- | --- |
| `replaceScreen` | 整屏 | 仅 `mode:"full"`；必须通过 schema 与热区保护 |
| `setFrame` | frame | 只允许 `bg/note/length/place/name` |
| `insertGroup` / `updateGroup` / `removeGroup` | group | `updateGroup` 只允许 `x/y/axis/locked/hidden/name/free/pos` |
| `insertItem` / `updateItem` / `removeItem` / `moveItem` | item | `updateItem` 只允许 Registry 属性白名单 |
| `setTheme` | 禁止 | AI 不得改主题 |

**属性白名单：** 以附录 §12.5 Kind Registry 为唯一来源。`id` 只能在 `insertItem` 中给出，且不得与现有 id 冲突。

**拒绝条件：**

- 缺 `target_screen_id` 或与路径不一致；
- `mode:"full"` 缺 `doc`/`frame`/`groups`；
- `kind` 不在 Registry；
- `item.id` 重复或为空；
- 坐标/尺寸超出屏幕范围超过容差（默认 8dp）；
- 输出包含其他 `screen_id`、其他屏 Item id、`action`、`actions`、`swipe`；
- 整屏替换会删除已有热区且未显式允许；
- 输出被截断或不是 JSON。

### 7.3 归一化规则

| 差异 | 处理 |
| --- | --- |
| ```json 代码块、前后说明 | 提取第一个完整 JSON 对象 |
| `doc` 缺 `schema`/`format` | 补齐 `m3studio/screen@1` / `m3` |
| 节点树 `root/children` | 尝试按 §5.6.1 启发式转换；失败则拒绝 |
| `kind` 使用别名（`btn`、`appbar`、`list`） | 映射到 Registry 标准 kind；未知拒绝 |
| `item.id` 缺失 | 生成稳定 id（`itm_<hash>`），记录修复 |
| 属性平铺（`text`、`style`、`data-anchor`） | 归一化到 `label`/`props`/`note` |
| `action`/`actions`/`swipe` | 剥离；记录“导航已忽略” |
| patch 使用 `setText`/`modify`/`addChild` | 映射到 `updateItem`/`insertItem`；无法映射的 op 丢弃并记录 |
| **HTML 片段** | **仅当可解析为单一根元素且能映射到 Registry kind 时归一化；否则 422 `INVALID_OUTPUT`** |
| 返回数组/HTML 字符串 | 按上条处理；解析失败 422 |
| 输出被截断 | 明确报“输出被长度限制截断”，提示调大上限 |

### 7.4 意图路由

| 层 | 处理 | 示例 |
| --- | --- | --- |
| 显式 | 请求已带目标 Item 与目标值 | `{item_id, patch:{label:"保存"}}` |
| 规则 | 固定句式解析 | “把按钮文案改为保存”“图标换成 search”“改成 outlined” |
| 分类器（P2） | 判断确定性替换 vs 需要理解/创作 | “把标题改得更有冲击力” |
| 大模型 | 需要理解/创作/多步修改 | “重新设计这个详情页，突出价格” |

- 含“优化/更有/风格/语气/氛围/重新设计”等创作意图，或“不要/除了/仅改”等否定语义时，不得降级到规则。
- 规则命中但目标不唯一时，升级大模型并记录原因。
- 每次决策记录 `route_layer`、`rule_id`、`is_deterministic`、`ai_cost`、耗时。

### 7.5 Prompt 生成

| 编号 | 需求 | 说明 |
| --- | --- | --- |
| AI-021 | Prompt 输入 | `ProjectDoc` + 语言 + 选项 + 平台；单屏只传该屏 |
| AI-022 | Prompt 结构 | 目标/颜色/主题/布局/行为/风格/通用要求/选项 |
| AI-023 | 确定性 | 同一输入同一输出；不含随机 id/时间 |
| AI-024 | 语言 | 中/英/日/韩；术语表统一 |
| AI-025 | 手工编辑 | `promptEdit` 优先；重置恢复自动生成 |
| AI-026 | 安全 | 不含密钥、路径、其他项目数据 |
| AI-027 | 体量 | 默认 ≤60KB；超限提示分屏或精简 |
| AI-028 | Agent 指南 | 可导出 `agent.md` + JSON；与 m3e-canvas 的 `public/agent.md` 对齐 |
| AI-029 | Prompt 摘要 | 生成时计算 `prompt_digest` 并随屏幕版本保存 | 

### 7.6 模型与密钥

- 默认服务端保存密钥；接口只返回 `has_api_key` 与末四位。
- 浏览器 BYOK 仅作为可选模式：密钥存 `localStorage`，请求直连 Provider；必须提示 CORS/密钥暴露风险。
- 分享/导出/日志/审计不得包含密钥。
- 模型切换只影响后续生成；job 记录模型快照（不含密钥）。
- 内置 `mdl_local` 恒存在；自定义模型失效回退。
- 连接测试返回可操作 `detail.hint`。

### 7.7 失败与重试

| 场景 | 处理 |
| --- | --- |
| 网络失败/超时 | 502 `MODEL_FAILED`；可重试；屏幕不变 |
| 401/403/404/429 | 502 + `detail.hint`（密钥/地址/模型名/限流） |
| 输出截断 | 422/502 + 提示调大 `AI_MAX_TOKENS` |
| schema 非法 | 422 `SCHEMA_INVALID`；可修复则自动修复一次 |
| 跨屏输出 | 403 `FORBIDDEN_TARGET` + 告警；不落库 |
| 丢失热区 | 422 `INVALID_OUTPUT` + `lost_items` |
| 生成中取消 | job `cancelled`；屏幕不变 |
| 同屏并发 | 409 `CONFLICT` |

---

## 8. 验收标准

### 8.0 验收范围与阶段

- **本版（V4.1）为 M0 设计基线，不进行实现验收。**
- **P0 条目**构成 M1–M4 的实现与验收范围，按 §11 里程碑分阶段验收。
- **P1/P2/保留条目**不参与 MVP 验收；P1 纳入 M5 或首个正式版门禁，P2/保留纳入 M6 或后续立项。
- 验收编号只在正文出现；§8.6 追溯矩阵只引用实际编号。

### 8.1 核心隔离场景（保留）

| 编号 | 场景 | 预期结果 | 阶段 |
| --- | --- | --- | --- |
| AC-001 | 修改屏幕 A 后检查 B | B 屏目录所有文件 hash 与 mtime 不变 | M1 |
| AC-002 | body 的 `target_screen_id` 与路径不一致 | 403 `FORBIDDEN_TARGET` + 告警 + 无新版本 | M1 |
| AC-003 | 对锁定屏生成 | 423，版本不变 | M1 |
| AC-004 | 改边目标屏 | 所有屏版本不变、目录零写入 | M4 |
| AC-005 | 回滚 A | 只改 A 的版本指针，B 不变；A 中 Item 消失后相关边读取时标记 orphan，`flow.json` hash 不变 | M1/M4 |
| AC-006 | 删除有边的屏 | 409 `EDGES_EXIST` 并列出边与处理选项 | M4 |
| AC-007 | AI 输出夹带他屏写入 | 403 + 告警 + 不落库 | M3 |
| AC-008 | patch 中途失败 | 版本不递增、内容逐字节相同 | M1 |
| AC-009 | 预览点击热区 | 按已确认边跳转；返回栈正确 | M4 |
| AC-010 | 导出原型 | 离线打开可跳转，数据与边分离存放 | M4 |
| AC-011 | 导出页布局 | 底部操作栏贴底；长内容可滚动 | M4 |
| AC-012 | 关联模式热区定位 | 各档缩放下圆点与部件中心偏差 ≤2px | M4 |

### 8.2 M3 编辑器场景

| 编号 | 场景 | 预期结果 | 阶段 |
| --- | --- | --- | --- |
| AC-301 | 导入含 3 屏、主题、action 的 M3E JSON | 生成 3 屏；主题正确；action 转为 FlowEdge；`ScreenDoc` 无 `action` | M1 |
| AC-302 | 从部件面板拖入按钮并保存 | 新 Item 出现；保存生成一条版本；Prompt 含该按钮 | M2 |
| AC-303 | 点击 Tidy | 栏位吸附、同族连接、16dp 边距；文案/顺序不变；可撤销 | M2 |
| AC-304 | 切换主题为暗色/高对比度 | 所有屏即时更新；不递增屏幕版本；`design-revisions` 新增 | M2 |
| AC-305 | 多选两个按钮并分组/取消分组 | 自由组保留相对位置（`Item.pos`）；取消后可单独选中 | M5（P1） |
| AC-306 | 编辑 3 次后 Ctrl+Z 两次再保存 | 保存的是撤销后的状态；只生成一条版本 | M2 |
| AC-307 | 使用 V/H/空格/方向键/Delete/P | 行为与文档一致；输入框内不劫持 | M2 |
| AC-308 | 只读/锁定屏打开编辑器 | 只读模式；保存 403/423；预览可用 | M2 |
| AC-309 | 复制屏幕 | 新 `screen_id` 与新 Item id；不继承版本历史；v1 摘要“复制自 X” | M2 |
| AC-310 | 删除有边的屏 | 409 `EDGES_EXIST`；选择删边/保留边后正确 | M4 |
| AC-311 | 桌面屏 1280×800 + navRail | 布局正确；rail 折叠/展开可用；Prompt 平台为 web | M5（P1） |
| AC-312 | 屏幕 `length` 1200 > 892 | 预览/导出可滚动；栏位固定；Prompt 描述滚动 | M4 |
| AC-313 | 本地图片 + https 图片 | 项目内可见；分享/导出只保留 https；本地图片有警告 | M5（P1） |
| AC-314 | 修改 Item 文案后查看 FlowEdge | Item id 不变；边仍有效；预览仍跳转 | M4 |
| AC-315 | 导入非法 kind/重复 id | 422 `SCHEMA_INVALID`；不写入；错误路径明确 | M1 |
| AC-316 | 旧 node-tree 屏幕 | 只读可预览；编辑提示转换；转换有损失报告；只读渲染器呈现 | M1 |
| AC-317 | 旧文档转换后保存 | 生成新版本；原版本保留；可回滚 | M5（P1） |
| AC-318 | 编辑器桥接超时/断连 | 宿主提示重试；本地草稿不丢；不产生半版本 | M2 |
| AC-319 | 两个标签页同时保存同一屏 | 后保存者 409；不覆盖；提示刷新/另存 | M2 |
| AC-320 | 分享链接打开 | 只读预览；无编辑入口；无密钥/历史 | M5（P1） |
| AC-321 | 图层锁定/隐藏/重命名 | `locked` 不可编辑；`hidden` 默认不导出；`name` 持久化 | M2 |
| AC-322 | 自由组拖动 Item | `Item.pos` 持久化；取消分组后坐标正确；非自由组禁止 `Item.pos` | M2 |
| AC-323 | 编辑器/预览/导出同一屏 | 三处渲染结构一致；视觉回归通过 | M2/M4 |

### 8.3 AI 生成场景

| 编号 | 场景 | 预期结果 | 阶段 |
| --- | --- | --- | --- |
| AC-401 | 输入“做一个登录页”生成 | 返回 M3 `ScreenDoc` pending；接受后版本 +1 | M3 |
| AC-402 | 拒绝 pending | 屏幕完全不变；无新版本 | M3 |
| AC-403 | AI 输出夹带其他屏 id | 403 `FORBIDDEN_TARGET` + 告警；不落库 | M3 |
| AC-404 | 选中一个卡片后“改这个卡片文案” | 只改该 Item；选区外不变 | M3 |
| AC-405 | “把按钮文案改为保存” | 规则命中 `builtin_rule`；`ai_cost=0`；不调用大模型 | M3 |
| AC-406 | “把标题改得更有冲击力” | 不降级；进入大模型 | M3 |
| AC-407 | “不要改标题，只把副标题改为 X” | 否定语义保留；仅副标题变更 | M3 |
| AC-408 | 模型返回非法 JSON/缺 groups | 422 `SCHEMA_INVALID`；屏幕不变 | M3 |
| AC-409 | 模型输出含 `action` | 剥离 action；FlowEdge 不变；记录警告 | M3 |
| AC-410 | 模型输出缺 Item id | 自动补 id；记录修复；通过校验 | M3 |
| AC-411 | 整屏替换会删除已有热区 | 422 `INVALID_OUTPUT` + `lost_items`；不落库 | M3 |
| AC-412 | pending 基于旧版本接受 | 409 `STALE_PENDING` | M3 |
| AC-413 | 锁定屏生成 | 423 `SCREEN_LOCKED` | M3 |
| AC-414 | 自定义模型失效 | 回退 `mdl_local`；job 记录回退原因 | M3 |
| AC-415 | 查看路由日志 | 含 `route_layer`/`rule_id`/`ai_cost`；无 Prompt 正文/密钥 | M3 |
| AC-416 | 同屏并发生成 | 第二次 409 `CONFLICT`；第一次不受影响 | M3 |
| AC-417 | 生成中取消 | job `cancelled`；屏幕不变；可重试 | M5（P1） |
| AC-418 | 生成后 Tidy 失败 | 生成结果仍可落库；错误可见；不产生半状态 | M5（P1） |
| AC-419 | AI 输出 swipe/action | 剥离；不写 FlowEdge；记录警告 | M3 |
| AC-420 | AI 输出非 Registry kind | 422 `SCHEMA_INVALID`；不落库 | M3 |

### 8.4 Prompt 与导出场景

| 编号 | 场景 | 预期结果 | 阶段 |
| --- | --- | --- | --- |
| AC-501 | 生成中文/英文/日文/韩文 Prompt | 语言正确；术语一致；无其他屏正文（单屏） | M4 |
| AC-502 | 勾选 tests/offline/darkMode | Prompt 追加对应要求；顺序稳定 | M5（P1） |
| AC-503 | 手工改 Prompt 后保存/重置 | 保存生效；重置恢复自动生成；版本记录 `prompt_digest` | M4 |
| AC-504 | 导出静态原型并断网打开 | 可跳转、返回、转场、交互部件；无后端依赖 | M4 |
| AC-505 | 检查导出 `flow.json` | 不含 groups/items/label/HTML/尺寸快照；不含 orphan 持久化字段 | M4 |
| AC-506 | 导出 M3E JSON 并用 m3e-canvas 打开 | 屏幕、部件、主题、跳转可用 | M4 |
| AC-507 | 分享链接 | 只读预览；不含密钥/本地图片/历史；可复制 Prompt（如开启） | M5（P1） |
| AC-508 | 分享链接超过上限 | 413 `SHARE_TOO_LARGE`；提示改用 token/文件导出 | M5（P1） |
| AC-509 | 导出 Prompt 包 | 含 `prompt.md`、`design.json`、`agent.md`；可解压即用 | M4 |
| AC-510 | 导出目录名 `../../evil` | 被清洗或 400；不越出 `exports/` | M4 |
| AC-511 | 标题含 `</script><script>alert(1)</script>` | 导出 HTML 转义；不执行脚本 | M4 |
| AC-512 | Prompt 导航标记 | P1：静态标记与 section/screen 一致；P2：点击跳转、编辑后失效提示 | M5/M6 |
| AC-513 | 断网加载导出物 | 字体回退；布局不崩；交互可用 | M4 |
| AC-514 | 20 屏/1000 Item 导出 | 目录版 `index.html` ≤300KB、数据 ≤2MB；单文件版 `index.html` ≤2MB；打开 ≤3s（中端机） | M4/M5 |
| AC-515 | 单屏 Prompt | 只含当前屏正文；其他屏仅标题 | M5（P1） |
| AC-516 | 旧格式屏幕导出 | 由旧格式只读渲染器呈现；安全转义；不进入 M3 运行时 | M4 |
| AC-517 | swipe 边导出与预览 | `trigger:"swipe"` + `direction` 生效；与点击边不冲突 | M4/M5 |

### 8.5 迁移场景

| 编号 | 场景 | 预期结果 | 阶段 |
| --- | --- | --- | --- |
| AC-601 | 打开旧 `node-tree` 项目 | 可查看/预览/导出（只读渲染器）；编辑提示转换 | M1 |
| AC-602 | 转换简单旧屏 | 生成 M3 `ScreenDoc`；损失报告为空或可解释 | M5（P1） |
| AC-603 | 旧项目有 FlowEdge | 迁移后边保留；`source_hotspot_id` 映射到 Item id | M1 |
| AC-604 | 旧 `design_tokens` | 映射为自定义调色板/主题；颜色不丢 | M1 |
| AC-605 | 导入 M3E action | 转为 FlowEdge；`ScreenDoc` 无 action；swipe 带 direction | M1 |
| AC-606 | 导出回 M3E | action 注回；可被原项目打开 | M4 |
| AC-607 | 重复执行迁移 | 幂等；不重复建屏/建边 | M1 |
| AC-608 | 迁移失败 | 自动恢复备份；原数据不变 | M1 |
| AC-609 | 无法映射的旧节点 | 降级为 box/text；损失报告列出 | M1 |
| AC-610 | 迁移后回滚 | 可恢复到迁移前；版本历史保留 | M1 |
| AC-611 | 导入 50MB 项目 | 通过 multipart 或文件路径成功；超限 413 `IMPORT_TOO_LARGE` | M1 |
| AC-612 | 创建新项目导入 | `POST /api/projects/import` 返回新 `project_id`；屏幕/边正确 | M1 |
| AC-613 | 导入到现有项目 | 冲突 id 重映射；报告列出；失败不落库 | M1 |

### 8.6 需求追溯

> 本矩阵只引用正文实际存在的编号；P1/P2 条目在阶段列标注。

**隔离与治理：**

```
BR-001 → FR-GEN-001/003, NFR-002/003, AC-002/007/403
BR-002 → FR-EDIT-015, FR-VER-003, AC-001/005
BR-003 → FR-GEN-013/014, FR-SPACE-001/005, NFR-004, AC-008
BR-004 → FR-FLOW-002/006, DC-001/004, AC-004
BR-005 → FR-VER-001/002/003/004, DC-007, AC-005
BR-006 → FR-PREVIEW-001/002, FR-EXPORT-001/002, AC-009/010/011
BR-014 → FR-RENDER-001..006, NFR-039, AC-323
```

**M3 设计能力：**

```
BR-010 → FR-M3-001..014, FR-EDIT-002/004/009/012, FR-THEME-001..010, AC-301..315/321/322
BR-011 → FR-PROMPT-001..012, AC-501..515
BR-012 → FR-PROJ-006/007, FR-EXPORT-002/006, DC-026, AC-506/509
BR-013 → FR-M3-008/009, FR-PROJ-006, FR-RENDER-004/005, DC-020/025, AC-601..610/516
```

**人工编辑与路由：**

```
BR-007 → FR-SPACE-001..010, DC-010/014, NFR-018, AC-302/306
BR-008 → FR-GEN-014, NFR-017, AC-405/406/407/415
```

**后续：**

```
BR-009 → FR-VER-010, NFR-019, AC-（P2 另行定义）
```

**P0 域级覆盖索引（具体验收项见 §8.1–8.5；同域 P1/P2 编号的阶段以各需求表为准）：**

```
FR-PROJ-001..003    → AC-301..316/601..613
FR-PROJ-005..011    → AC-301..316/601..613
FR-M3-001..014      → AC-301..323
FR-EDIT-001..020    → AC-302..323
FR-THEME-001..010   → AC-301..323
FR-RENDER-001..006  → AC-323
FR-GEN-001..020     → AC-401..420
FR-SPACE-001..010   → AC-302/306/308/309
FR-VER-001..012     → AC-301..316
FR-FLOW-001..016    → AC-004..012/501..517
FR-PREVIEW-001..012 → AC-009..012/517
FR-PROMPT-001..012  → AC-501..515
FR-EXPORT-001..014  → AC-501..517
FR-USER-001..004    → AC-301..323
FR-AUDIT-001..006   → AC-401..420
FR-I18N-001..004    → AC-323
FR-A11Y-001..004    → AC-323
```

### 8.7 测试基线

**现有（v1.0.0，97 例）适配清单：**

| 文件 | 关注点 | 适配动作 |
| --- | --- | --- |
| `isolation.test.mjs` | AC-001～008、NFR-002/003、DC-001 | 保留；`orphan` 改为动态计算断言 |
| `preview-export.test.mjs` | 预览路由、孤儿边、候选边、导出结构与布局 | 改造：orphan 读取时计算；导出目录版/单文件版拆分 |
| `features.test.mjs` | 区域选区、设计 token、撤销与对比、只读权限、排序、op 白名单、锁定状态恢复、导出目录清洗、热区测量契约 | 改造：`/tokens` 兼容投影；热区身份 `(item_id, slot)` |
| `models.test.mjs` | 模型 CRUD、密钥脱敏、回退、job 模型快照 | 保留 |
| `generator.test.mjs` | 规则路由、生成器维护、路由日志（旧编号用例） | 编号重映射到 AC-405/406/407/415 |
| `scope.test.mjs` | 区域/组件选区、确定性路由与审计 | 保留 |
| `space-edit.test.mjs` | DC-010/014、NFR-018、pending 拦截、客户端可编辑契约（旧编号用例） | 编号重映射到 AC-302/306/308/309 |
| `regression.test.mjs` | 联调期缺陷固化 | 保留；增自由组坐标、hidden 回归 |
| `remote-model.test.mjs` | 自定义模型 16 类兼容性问题 | 保留 |
| `startup.test.mjs` | 启动路径与端口占用提示 | 保留；Node ≥22 |

**合并新增（目标 ≥60 例）：**

| 文件 | 关注点 | 阶段 |
| --- | --- | --- |
| `m3-schema.test.mjs` | ScreenDoc/ProjectDoc 校验、版本、迁移、Registry | M1 |
| `m3-import-export.test.mjs` | M3E 导入/导出、action ↔ FlowEdge、swipe direction、id 重映射 | M1/M4 |
| `m3-editor-bridge.test.mjs` | 桥接协议、超时、保存冲突、只读 | M2 |
| `m3-ai-contract.test.mjs` | M3 输出、归一化、跨屏、热区保护、路由、swipe 剥离 | M3 |
| `m3-prompt.test.mjs` | 四语言、选项、单屏、编辑/重置、体量、prompt_digest | M4 |
| `m3-export.test.mjs` | 静态原型目录版/单文件版、离线、注入、体积 | M4 |
| `m3-migration.test.mjs` | 旧数据迁移、备份、回滚、幂等、大文件导入 | M1 |
| `m3-render.test.mjs` | 共享渲染契约、旧格式只读渲染、视觉回归 | M2/M4 |
| `i18n-a11y.test.mjs` | key parity、键盘、对比度、减少动效 | M5 |
| `perf.test.mjs` | 500 Item/20 屏性能基准 | M5 |

---

## 9. 关键设计取舍与风险

### 9.1 关键取舍

| 主题 | 取舍 | 理由 |
| --- | --- | --- |
| 设计模型 | 采用 M3E `Item/Group/Frame`，不继续以任意 HTML 节点树为主 | 语义化部件才能稳定生成 Prompt、主题和交互；任意 HTML 难以做部件级 patch |
| 屏幕存储 | 一屏一个 `ScreenDoc`，不把整个 M3E `Doc` 存进版本 | 保留存储/上下文/编辑隔离；版本回滚不波及其他屏 |
| 导航真源 | `FlowEdge` 独立存储；`action` 只做导入/导出投影；`orphan` 动态计算 | 满足 DC-001/C-017/DC-039；页面重生成后边仍按 Item id 存活 |
| 手势 | `swipe` 作为 `trigger` + `direction`，不占用 `target_kind` | 与 M3E 导入/导出对齐；目标类型保持简洁 |
| 主题 | 项目级唯一；屏幕只覆盖背景；`/design` 为权威入口 | 跨屏一致性只靠主题；避免每屏主题漂移 |
| 版本 | 整文件快照 + 主题快照 + `prompt_digest` | 回滚是切指针；旧版本可独立重放；Prompt 可追溯 |
| 编辑器集成 | 先“宿主 + 编辑器岛”，后评估统一 React | 降低一次性重写风险；保留现有服务端治理 |
| 旧数据 | 只读兼容 + 独立只读渲染器 + 显式转换 | 不静默丢失；转换可回滚；旧格式不污染 M3 渲染器 |
| 渲染 | 共享 `ScreenDoc + Theme → 渲染树/HTML` 契约 | 避免编辑器/预览/导出漂移 |
| Prompt 与原型 | 同一份数据双输出 | 避免“设计一套、Prompt 一套”漂移 |
| 分享 | 小项目 URL fragment；大项目 token/文件 | 保持纯静态可用，又不被 URL 长度卡死 |

### 9.2 风险

| 风险 | 影响 | 概率 | 应对 |
| --- | --- | --- | --- |
| 数据模型迁移不完整 | 旧项目内容丢失/不可编辑 | 高 | 只读兼容 + 只读渲染器 + 转换报告 + 备份 + 回滚 |
| 编辑器桥接复杂 | 状态不同步、保存冲突 | 高 | 协议版本化 + `base_version` + 超时恢复 + 单一写入路径 |
| 渲染一致性 | 画布/预览/导出三处不一致 | 高 | FR-RENDER-001～006 共享契约 + 视觉回归 |
| AI M3 输出不稳定 | 生成不可用、返工 | 中高 | Registry + schema 校验 + 归一化 + 自动修复一次 + pending |
| Prompt 测量缺失 | 文本宽度/布局偏差 | 中 | 客户端上报 + 服务端估算 + 标注 |
| 构建/依赖升级 | Next/React/TS 版本破坏 | 中 | 锁定版本 + CI + 逐步升级 |
| 分享链接过长 | 分享失败 | 中 | 大小上限 + token/文件回退 |
| 性能 | 多屏/多 Item 卡顿 | 中 | 虚拟化 + 静态缩略图 + 懒加载 |
| 团队服务器鉴权缺失 | 未登记用户可写 | 高 | 本地/团队模式区分 + P1 门禁 + NFR-041 |
| 许可/归属 | 合规风险 | 低 | 保留 MIT/NOTICE/Apache-2.0 归属 |
| 范围蔓延 | 延期 | 高 | 严格 MVP 边界 + 阶段门禁 |

### 9.3 关键开放问题（仅保留真正待决策项）

1. 合并后的主宿主是保留现有零依赖 vanilla 外壳，还是直接统一到 React/Next？（V4.1 已决策：先编辑器岛，M6 再评估）
2. 是否需要多人协作/云端项目？如果需要，CRDT/OT 与用户体系要提前设计。
3. 是否需要把生成的原型直接输出为 React/Vue 工程代码？这会改变产品边界。
4. 团队服务器的最小鉴权选型（反向代理 Basic / OIDC / 自建会话）。
5. 单文件导出的性能上限与降级策略（M5 前确认）。

> 已决策项（不再列为开放问题）：离线单文件导出（P1 单文件版）；旧 node-tree 只读 + 显式转换（P0/P1）；Prompt 语言独立选择（FR-PROMPT-002）；BYOK 可选非主模式（§7.6）。

---

## 10. 状态机附录

**Screen.status：**

```
draft ──生成中──> generating ──成功──> pending ──接受──> applied
  ↑                  │                   │
  │                  └──失败──> draft/applied
  └──────────── 拒绝 ◄──────────────┘
任意状态 ──锁定──> locked ──解锁──> applied（有内容）/ draft（仅空屏基线）
```

**GenerationJob.status：** `generating → pending_confirm → applied | rejected | failed | no_op | cancelled`

**FlowEdge.status：** `candidate → confirmed → 删除`；孤儿边**读取时动态计算**，不改变持久化状态。

**Pending 生命周期：** 生成即创建（带 `base_version`）→ 接受（版本 +1 并清除）| 拒绝（清除）| 版本前进后接受（`STALE_PENDING`，仍可拒绝）。

**编辑器会话：**

```
loading → ready → dirty ⇄ clean → saving → saved
                 │                    │
                 └── conflict ────────┘（409，提示刷新/另存）
```

**导入/迁移：**

```
validating → preview → applying → done
     │           │          │
     └─ invalid  └─ cancel  └─ failed → rollback
```

**项目修订：** `design-revisions.json` 只追加；主题变更不改变屏幕版本号；版本快照带 `theme_snapshot` 与 `prompt_digest`。

---

## 11. 实施里程碑

> 详细工作量、依赖与 Go/No-Go 见《可行性评估-M3E合并.md》。里程碑退出条件只引用本阶段 P0/P1 条目。

| 阶段 | 内容 | 交付物 | 退出条件 |
| --- | --- | --- | --- |
| M0 规格与验证 | 本文档、ADR、数据模型 spike、编辑器岛 spike、Registry、渲染契约 | 决策记录、可运行 demo | 桥接与 ScreenDoc 往返验证通过；Registry 与 §12.5 冻结；追溯矩阵无悬空编号 |
| M1 数据与存储 | ScreenDoc/ProjectDoc、schema、Registry、迁移、API、备份、旧格式只读渲染、大文件导入 | v2 存储与迁移脚本 | 旧项目可读/可只读渲染；M3E 可导入导出；AC-301/315/316/601/603/604/605/607/608/609/610/611/612/613 通过 |
| M2 编辑器集成 | M3 编辑器岛、保存/版本/锁定/只读、图层、自由组坐标、静态缩略图、共享渲染契约 | 可手工搭屏并保存版本 | AC-302/303/304/306/307/308/309/318/319/321/322/323 通过 |
| M3 AI 改造 | M3 上下文、输出契约、归一化、patch、路由、swipe 剥离 | 单屏 AI 生成/patch | AC-401～416/419/420 通过 |
| M4 关联/预览/导出 | FlowEdge 投影、swipe、动态 orphan、预览、静态原型目录版、Prompt、Prompt 包 | 双交付物 | AC-004/005/006/009/010/011/012/310/312/314/501/503/504/505/506/509/510/511/513/514（目录版）/516 通过 |
| M5 主题/i18n/打磨/首个正式版 | 四语言、可访问性、性能、视觉回归、P1 编辑器能力、单文件版、分享链接、Prompt 导航静态标记 | 首个正式版 | P1 验收项与 NFR 达标；AC-305/311/313/317/320/417/418/502/507/508/512（静态）/514（单文件）/515/517 通过 |
| M6 增强 | 三方合并、协作、组件库、代码生成、Prompt 导航点击 | 后续版本 | 另行立项 |

---

## 12. 附录

### 12.1 两项目能力对照

| 能力 | prd-diy | m3e-canvas | 合并后 |
| --- | --- | --- | --- |
| 服务端/项目治理 | 有 | 无 | 保留 prd-diy |
| 版本/回滚/审计 | 有 | 无 | 保留并适配 M3 |
| 单屏 AI 生成 | 有（node-tree） | 有（整项目起草/备注） | 改造为 M3 单屏 |
| 部件化设计 | 无 | 36 种 M3 部件 | 采用 M3E + Registry |
| 主题系统 | 基础 token | 完整 M3 主题 | 采用 M3E；`/design` 权威 |
| 画布编辑 | iframe 节点 | React 画布 | 编辑器岛 |
| 关联层 | 独立 FlowEdge | Item.action | FlowEdge 真源 + 投影 + 动态 orphan |
| 手势 | 无 | swipe | FlowEdge trigger + direction |
| 预览 | 基础跳转 | 转场/手势/交互部件 | 采用 M3E 运行时 |
| 静态原型导出 | 有 | 无 | 保留并升级；目录版/单文件版 |
| Prompt 交付 | 无 | 有（4 语言） | 采用 M3E；`prompt_digest` |
| 分享链接 | 无 | 有（docz） | 采用并加 token 回退 |
| 多语言 UI | 无 | 4 语言 | 采用 M3E |
| 离线 | 导出物 | 静态站点 | 两者都支持 |
| 渲染一致性 | 无 | 无 | 共享契约 + 视觉回归 |
| 旧格式渲染 | 有（旧渲染器） | 无 | 独立只读渲染器 |

### 12.2 许可与归属

- 本项目与 m3e-canvas 均为 MIT。
- 合并后必须保留：
  - `LICENSE`（MIT）；
  - m3e-canvas 的 `NOTICE`；
  - material-components-android / Aler1x / Material Symbols 的 Apache-2.0 归属；
  - 原项目版权声明。
- 不得删除或隐藏第三方归属；分发物（含导出物）应包含 `NOTICE` 或关于页链接。

### 12.3 术语与缩写

| 缩写 | 含义 |
| --- | --- |
| M3 | Material 3 |
| M3E | Material 3 Expressive |
| SRS | 需求规格说明书 |
| ADR | 架构决策记录 |
| BYOK | Bring Your Own Key |
| CRDT | 无冲突复制数据类型 |
| OT | 操作变换 |
| P0/P1/P2 | 优先级 |

### 12.4 文档结论

合并后的产品不是两个工具的简单叠加，而是把“**设计表达**”与“**工程治理**”接成一条链路。技术上可行，但核心难点在数据模型、编辑器集成、渲染一致性与旧格式兼容，不在 AI。本 V4.1 已修复 V4.0 审计的阻断项与高优先级项，可作为 **M0 设计基线**；M1 启动前需冻结 §12.5 Kind Registry 与 §6.4 桥接协议，并通过 §6 复审门禁。

### 12.5 M3 Kind Registry（V4.1 新增）

> 本 Registry 是 `kind` 白名单、属性白名单、默认值、热区性、slot、尺寸约束、Tidy 规则的**唯一来源**。FR-M3-004、AI-015、§7.2 属性白名单、schema 校验均引用本表。完整 36 种 kind 在 M0 冻结前由设计系统负责人补齐字段；本版给出分类与骨架，M0 退出条件为“36 行全部填写且通过评审”。

> **对齐说明（V4.1 冻结）：** 本表 36 行与 `apps/server/src/domain/m3/constants.js` 的 `KINDS`、m3e-canvas `lib/tokens.ts` 的 `KIND_ORDER` 逐项一致。V4.0 草案中的 `segmentedButton`、`headline`、`progress`、`loading`、`menu`、`breadcrumb`、`avatar`、`icon`、`spacer` 不属于 M3E 36 种 kind，已移除；补入 `extendedFab`、`searchBar`、`camera`、`map`、`loadingIndicator`、`linearProgress`、`circularProgress`、`splitButton`、`toolbar`。

| 分类 | kind | 可热区 | 默认 slot | 关键属性 | 尺寸约束 | Tidy 族 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 容器 | box | 是 | null | fill/size/size2 | 40..屏宽 × 24..屏高 | 容器 | 冻结 |
| 容器 | bottomSheet | 是 | `action:N` | fill/size/size2 | 宽 40..屏宽；高 24..屏高 | 浮层 | 冻结 |
| 按钮 | button | 是 | null | label/icon/variant/size | 宽 ≥56；高 40..96 | 按钮组 | 冻结 |
| 按钮 | iconButton | 是 | null | icon/variant/size | 40..96 正方形 | 按钮组 | 冻结 |
| 按钮 | fab | 是 | null | icon/variant/size | 40..96 正方形 | FAB | 冻结 |
| 按钮 | extendedFab | 是 | null | label/icon/variant/size2 | 高 56/80/96；宽自适应 | FAB | 冻结 |
| 按钮 | chip | 是 | null | label/icon/checked/size2 | 高 24..48；宽自适应 | 标签组 | 冻结 |
| 按钮 | splitButton | 是 | `main/menu` | label/icon/variant/size2 | 高 40..96；宽自适应 | 按钮组 | 冻结 |
| 按钮 | fabMenu | 是 | `item:N` | icon/variant/size/tabs | 宽 160..380；高 56 | FAB 菜单 | 冻结 |
| 栏 | topAppBar | 是 | `icon/icon2` | label/icon/icon2/size/size2 | 宽 200..屏宽；高 64/88/120 | 顶栏 | 冻结 |
| 栏 | bottomNav | 是 | `tab:N` | tabs/selected/size | 宽 200..屏宽；高 80/104 | 底栏 | 冻结 |
| 栏 | navRail | 是 | `tab:N` | tabs/selected/size2 | 宽 80；高 200..屏高 | 侧栏 | 冻结 |
| 栏 | toolbar | 是 | `tab:N` | tabs/selected/variant | 高 64；宽自适应 | 工具栏 | 冻结 |
| 栏 | tabs | 是 | `tab:N` | tabs/selected/size | 宽 200..屏宽；高 48 | 标签栏 | 冻结 |
| 栏 | searchBar | 是 | `icon/icon2` | label/icon/icon2/variant/size | 宽 200..屏宽；高 56 | 顶栏 | 冻结 |
| 卡片 | card | 是 | null | label/supporting/icon/variant/size/size2/imagePos/imageSize/contentAlign/textAlign | 宽 160..屏宽；高 96..屏高 | 卡片列 | 冻结 |
| 卡片 | listItem | 是 | `trailing` | label/supporting/icon/icon2/size | 宽 200..屏宽；高 72 | 列表 | 冻结 |
| 表单 | textField | 是 | null | label/supporting/icon/variant/size | 宽 160..屏宽；高 56 | 表单列 | 冻结 |
| 表单 | select | 是 | `tab:N` | label/supporting/icon/variant/size/tabs | 宽 160..屏宽；高 56 | 表单列 | 冻结 |
| 表单 | switch | 是 | null | label/checked/size | 宽 120..屏宽；高 48 | 表单列 | 冻结 |
| 表单 | checkbox | 是 | null | label/checked | 高 40；宽自适应 | 表单列 | 冻结 |
| 表单 | radio | 是 | null | label/checked | 高 40；宽自适应 | 表单列 | 冻结 |
| 表单 | slider | 是 | null | value/size | 宽 120..屏宽；高 44 | 表单列 | 冻结 |
| 选择器 | datePicker | 是 | null | value/size | 宽 280..屏宽；高 484 | 浮层 | 冻结 |
| 选择器 | timePicker | 是 | null | value/size | 宽 280..屏宽；高 420 | 浮层 | 冻结 |
| 文本 | text | 否 | null | label/bold/size | 字号 12..57；宽自适应 | 文本流 | 冻结 |
| 媒体 | image | 是 | null | src/icon/fill/size/size2 | 48..屏宽 × 48..屏高 | 媒体 | 冻结 |
| 媒体 | carousel | 是 | `tab:N` | tabs/count/src/size/size2 | 宽 200..屏宽；高 100..400 | 轮播 | 冻结 |
| 媒体 | camera | 是 | null | src/icon/size/size2 | 96..屏宽 × 96..屏高 | 媒体 | 冻结 |
| 媒体 | map | 是 | null | src/icon/size/size2 | 96..屏宽 × 96..屏高 | 媒体 | 冻结 |
| 反馈 | dialog | 是 | `action:N` | label/supporting/icon | 默认 312×220 | 浮层 | 冻结 |
| 反馈 | snackbar | 是 | `action` | label/supporting | 默认 344×48；宽 ≤ 屏宽-32 | 浮层 | 冻结 |
| 反馈 | loadingIndicator | 否 | null | contained/size | 32..128 正方形 | 进度 | 冻结 |
| 反馈 | linearProgress | 否 | null | value/wavy/size | 宽 120..屏宽；高 24 | 进度 | 冻结 |
| 反馈 | circularProgress | 否 | null | value/wavy/size | 24..120 正方形 | 进度 | 冻结 |
| 布局 | divider | 否 | null | size | 宽 40..屏宽；线高 1 | 分隔 | 冻结 |

**属性白名单（按 kind 校验）：** `label`、`supporting`、`icon`、`icon2`、`variant`、`size`、`size2`、`tabs`、`selected`、`checked`、`value`、`note`、`fill`、`iconFill`、`textColor`、`src`、`bold`、`layout`、`count`、`wavy`、`contained`、`trackThickness`、`noImage`、`imagePos`、`imageSize`、`contentAlign`、`textAlign`、`railExpanded`、`railModal`、`collapseOnScroll`、`corners`、`w`、`name`、`hidden`、`locked`、`pos`（仅自由组）。`kind` 专属字段由 `KIND_SPEC` 决定，未列出的字段在保存时被拒绝或忽略并记录警告。

**尺寸容差：** 坐标/尺寸超出屏幕范围默认容差 8dp；`image`/`carousel` 允许横向溢出裁剪。

**Tidy 规则：** 同族连接、16dp 边距、栏位吸附、圆角统一；自由组不参与 Tidy；`locked` 组不参与 Tidy。

### 12.6 M0 复审门禁（V4.1 新增）

> M0 复核结果见 `docs/M0-验收报告.md`：以下 10 项均已通过，证据包括 `npm test`（139 例）、`npm run spike:m3`、`npm run trace:m0`。

- [x] 追溯矩阵无悬空编号，BR→FR→AC 覆盖 P0 100%；
- [x] §12.5 Registry 36 行全部填写并通过评审；
- [x] FlowEdge 支持 swipe 方向、slot 热区、孤儿边动态计算规则明确；
- [x] 自由组/图层/隐藏/重命名数据字段闭合；
- [x] 旧 node-tree 只读渲染路径明确（FR-RENDER-004/005）；
- [x] 权限模型区分本地单机与团队服务器（§2.1/§2.3/NFR-041）；
- [x] 里程碑验收只引用对应阶段 P0/P1 条目（§11）；
- [x] 开放问题与正文决策无冲突（§9.3）；
- [x] 共享渲染契约（FR-RENDER-001～006）与视觉回归基线定义；
- [x] 大文件导入方案（multipart/文件路径）与 50MB 上限确认。

---

**文档结束**