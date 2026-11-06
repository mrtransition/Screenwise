import { randomUUID, createHash } from 'node:crypto';
import { EDIT_SCOPES, DEFAULT_NODE } from './constants.js';
import { badRequest, notFound, conflict, locked, forbiddenTarget, invalidOutput, unprocessable, noPermission, migrationUnsupported, schemaInvalid } from './errors.js';
import { emptyDoc, validateDoc, fingerprint, walk, findNode, collectAnchors, textOf } from './domain/doc.js';
import { applyPatch, validatePatch } from './domain/patch.js';
import { buildGenerationContext, assertContextIsolation } from './ai/context.js';
import { routeIntent, routeLog } from './ai/router.js';
import * as providerMod from './ai/provider.js';
import { normalizeProjectDesign, normalizeTheme, validateProjectDesign, validateScreenDoc, M3SchemaError } from './domain/m3/schema.js';
import { deriveDesignTokens, assembleProjectDoc } from './domain/m3/convert.js';
import { tidyDoc } from './domain/m3/tidy.js';
import { estimateAnchors, anchorOf, parseAnchor } from '../../web/src/screen-render.js';
import { isLegacyNodeTree, convertLegacyToM3, validateLegacyDoc } from './domain/legacy.js';
import {
  normalizeImport,
  persistImportedProject,
  importIntoProject,
  exportProjectAsM3e,
  exportBackup,
  validateProject,
  detectImportKind,
} from './project/io.js';
import { buildProjectPrompt, applyPromptEdit, buildAgentGuide, buildReadme, PROMPT_LANGS, redactSecrets } from './prompt/build.js';
import { createZip } from './export/zip.js';

/** 内置生成器固定 id（与 ai/models.js 保持一致），用于标识"本次未调用大模型" */
const BUILTIN_MODEL_ID = 'mdl_local';

const now = () => new Date().toISOString();
const rid = (p) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/**
 * 业务服务。所有写操作都接收 actor，用于审计（FR-AUDIT-001）。
 * 权限断言集中在这里，路由层不做业务判断。
 */
export class Service {
  constructor(repo, opts = {}) {
    this.repo = repo;
    /** 全局 AI 模型目录；测试注入 service 时可省略 */
    this.models = opts.models || null;
    /** 测试可注入的模型层，用于模拟越权输出 / 非法输出 / 超时 */
    // 注意：必须包一层（不能直接引用 generateFull），否则运行时替换 provider 不会生效
    this.ai = opts.ai || {
      generateFull: (args) => providerMod.generateFull(args),
      generatePatch: (args) => providerMod.generatePatch(args),
    };
  }

  // ---------------- project ----------------

  async createProject({ name, device, design_tokens, design, actor = 'local-user' }) {
    if (!name || !String(name).trim()) throw badRequest('项目名称必填');
    const project_id = rid('prj');
    const legacyTokens = deepMerge(defaultTokens(), design_tokens || {});
    const designInput = design && typeof design === 'object' ? design : designFromLegacyTokens(legacyTokens, name);
    const normalized = normalizeProjectDesign(designInput);
    const designIssues = validateProjectDesign(normalized);
    if (designIssues.length) throw badRequest(`design 非法：${designIssues[0].path} ${designIssues[0].message}`);
    const project = {
      project_id,
      name: String(name).trim(),
      schema_version: 2,
      device: device || { width: DEFAULT_NODE.width, height: DEFAULT_NODE.height },
      design: normalized,
      design_tokens: deepMerge(deriveDesignTokens(normalized), legacyTokens),
      role: 'owner',
      members: [{ user: actor, role: 'owner' }],
      screen_titles: [],
      created_at: now(),
      updated_at: now(),
    };
    await this.repo.createProject(project);
    await this.repo.appendDesignRevision(project_id, {
      revision: 1,
      created_at: now(),
      actor,
      change_summary: '创建项目，写入默认 ProjectDesign',
      design: normalized,
      design_tokens: project.design_tokens,
    });
    await this.audit(project_id, { actor, action: 'project.create', object_id: project_id, result: 'ok' });
    return project;
  }

  async listProjects() {
    return this.repo.listProjects();
  }

  async getProject(pid) {
    const p = await this.repo.getProject(pid);
    if (!p) throw notFound(`项目不存在: ${pid}`);
    return p;
  }

  // ---------------- AI models ----------------

  async listModels() {
    if (!this.models) return { schema_version: 1, models: [], active_model_id: null };
    return this.models.list();
  }

  async createModel(body = {}) {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    return this.models.create(body);
  }

  async updateModel(modelId, body = {}) {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    return this.models.update(modelId, body);
  }

  async deleteModel(modelId) {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    return this.models.remove(modelId);
  }

  async activateModel(modelId) {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    return this.models.activate(modelId);
  }

  /** 连接测试：地址 / 密钥 / 模型名任何一个不对都在这里暴露，而不是等到生成时才 502 */
  async testModel(modelId) {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    const model = await this.models.get(modelId);
    if (!model) throw notFound(`模型不存在: ${modelId}`);
    try {
      const res = await providerMod.testConnection(model);
      return { model_id: modelId, ...res };
    } catch (err) {
      // 测试失败是"预期结果"而不是服务异常：返回结构化结果，前端直接展示原因
      return {
        model_id: modelId,
        ok: false,
        code: err.code || 'MODEL_FAILED',
        message: err.message,
        detail: err.detail || null,
      };
    }
  }

  /** 健康检查 / 顶栏展示：当前生效的模型摘要（不含密钥） */
  async aiInfo() {
    const active = await this.resolveModel();
    const info = providerMod.describeProvider(active || undefined);
    const generator = this.models ? await this.models.generatorConfig() : null;
    return { ...info, route_enabled: !!generator?.router_enabled && generator?.scope !== 'off' };
  }

  /**
   * 内置生成器维护配置（GET /api/generator）。
   * 只返回可维护项与只读结构信息，不含密钥、不含任何项目正文。
   */
  async getGeneratorConfig() {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    const cfg = await this.models.generatorConfig();
    return {
      ...cfg,
      // 作用说明放在服务端，前端不必硬编码文案
      scope_hint: {
        global: '规则与显式结构化指令都会短路到内置生成器，其余请求走大模型',
        explicit_only: '只处理携带 node_id / anchor 的结构化指令，自然语言请求走大模型',
        off: '关闭内置生成器，确定性请求也走大模型（AC-211）',
      },
      rule_labels: RULE_LABELS,
    };
  }

  /** 维护内置生成器（PATCH /api/generator）：名称 / 启用范围 / 规则 / 路由开关 */
  async updateGeneratorConfig(body = {}, { actor = 'local-user' } = {}) {
    if (!this.models) throw badRequest('当前服务未启用模型目录');
    if (!actor) throw badRequest('缺少操作者');
    const input = {
      name: body.name,
      scope: body.scope,
      rules: body.rules,
      router_enabled: body.router_enabled ?? body.router,
      actor,
    };
    if (input.router_enabled !== undefined && typeof input.router_enabled !== 'boolean') {
      throw badRequest('router_enabled 必须是布尔值');
    }
    const next = await this.models.updateGenerator(input);
    return { ...(await this.getGeneratorConfig()), model: { model_id: next.model_id, name: next.name } };
  }

  /** 路由决策日志（FR-ROUTE-007）：按屏查询最近 100 条，已脱敏 */
  async listRouteLogs(pid, sid) {
    const h = await this.getHistory(pid);
    return h.jobs
      .filter((j) => j.target_screen_id === sid && j.route_decision)
      .slice(-100)
      .reverse()
      .map((j) => ({
        job_id: j.job_id,
        at: j.created_at,
        status: j.status,
        model_requested: j.model_requested || j.model?.model_id || null,
        model_effective: j.model_effective || null,
        ...j.route_decision,
      }));
  }

  async resolveModel() {
    if (!this.models) return null;
    return this.models.getActive();
  }

  /** 兼容投影（FR-THEME-007）：旧调用方写 design_tokens，内部折算到 ProjectDesign */
  async updateDesignTokens(pid, tokens, who = '') {
    if (!tokens || typeof tokens !== 'object') throw badRequest('design_tokens 必填');
    await this.assertWriter(pid, who);
    const next = await this.repo.updateProject(pid, (proj) => {
      const design = normalizeProjectDesign(proj.design || {});
      const merged = deepMerge(proj.design_tokens || {}, tokens);
      if (tokens.colors?.primary) {
        design.paletteKey = 'custom';
        design.customPalette = {
          ...(design.customPalette || {}),
          label: design.customPalette?.label || '自定义',
          primary: tokens.colors.primary,
        };
      }
      return { ...proj, design, design_tokens: merged };
    });
    await this.recordDesignRevision(pid, who, '旧接口 /tokens 更新（兼容投影）', next);
    await this.audit(pid, { actor: who, action: 'design_tokens.update', object_id: pid, result: 'ok' });
    return next;
  }

  async getDesign(pid) {
    const project = await this.getProject(pid);
    return {
      design: project.design,
      design_tokens: project.design_tokens,
      revisions: (await this.repo.listDesignRevisions(pid)).revisions.slice(-20).reverse(),
    };
  }

  /** 主题/设计规范的权威写入口（API-016）：只记项目修订，不递增屏幕版本 */
  async updateDesign(pid, body = {}, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    const patch = body.design && typeof body.design === 'object' ? body.design : body;
    const next = await this.repo.updateProject(pid, (proj) => {
      const design = normalizeProjectDesign(deepMerge(proj.design || {}, patch));
      const issues = validateProjectDesign(design);
      if (issues.length) throw badRequest(`design 非法：${issues[0].path} ${issues[0].message}`, { code: 'THEME_INVALID', issues });
      return { ...proj, design, design_tokens: { ...(proj.design_tokens || {}), ...deriveDesignTokens(design) } };
    });
    await this.recordDesignRevision(pid, actor, body.change_summary || '更新项目设计规范', next);
    await this.audit(pid, { actor, action: 'design.update', object_id: pid, result: 'ok' });
    return { design: next.design, design_tokens: next.design_tokens };
  }

  async recordDesignRevision(pid, actor, summary, project) {
    const revs = await this.repo.listDesignRevisions(pid);
    return this.repo.appendDesignRevision(pid, {
      revision: (revs.revisions.at(-1)?.revision ?? 0) + 1,
      created_at: now(),
      actor,
      change_summary: summary,
      design: project.design,
      design_tokens: project.design_tokens,
    });
  }

  // ---------------- screens ----------------

  /**
   * 新建屏幕（FR-PROJ-003）。
   *
   * 合并版里「空屏基线」是 M3 ScreenDoc：新建屏默认就是可编辑的 M3 屏，
   * 否则用户新建后只能停在「旧屏只读、需先转换」，M3 设计能力形同不可用。
   * `format:'node-tree'` 仅供导入旧数据时显式指定。
   */
  async createScreen(pid, { title, remark = '', x, y, after_screen_id = null, format = 'm3', baseline = true, actor = 'local-user' }) {
    const project = await this.assertWriter(pid, actor);
    if (!title || !String(title).trim()) throw badRequest('屏幕名称必填');
    if (!['node-tree', 'm3'].includes(format)) throw badRequest('format 只能是 node-tree / m3', { code: 'SCHEMA_VERSION_UNSUPPORTED' });
    const screens = await this.repo.listScreens(pid);
    const screen_id = rid('scr');
    const pos = pickPosition(screens, x, y);
    const meta = {
      screen_id,
      project_id: pid,
      title: String(title).trim(),
      remark,
      order: `${String(screens.length + 1).padStart(4, '0')}`,
      status: 'draft', // draft | generating | pending | applied | locked
      locked: false,
      current_version: 0,
      versions: [],
      pending: null,
      derived_from: after_screen_id,
      format,
      x: pos.x,
      y: pos.y,
      width: project.device.width,
      height: project.device.height,
      created_at: now(),
      updated_at: now(),
    };
    await this.repo.createScreen(pid, meta);
    // 空屏也建立 v1 快照：保证任何屏幕随时有可回滚基线（C-008 的下界）
    // 复制屏幕时由调用方直接写入「复制自 X」作为 v1，不额外制造空屏版本（AC-309）
    if (baseline) {
      const baseDoc = format === 'm3'
        ? emptyM3ScreenDoc(screen_id, String(title).trim(), project.device.width, project.device.height)
        : { version: 1, root: emptyDoc().root };
      await this.repo.commitVersion(pid, screen_id, baseDoc, {
        kind: 'import',
        label: '空屏基线',
        who: actor,
        theme_snapshot: project.design?.theme,
      });
    }
    const created = await this.repo.getScreen(pid, screen_id);
    await this.syncTitles(pid);
    await this.audit(pid, { actor, action: 'screen.create', object_id: screen_id, result: 'ok' });
    return created;
  }

  async listScreens(pid) {
    const project = await this.getProject(pid);
    const screens = await this.repo.listScreens(pid);
    // 画布需要渲染每屏内容，因此列表接口返回当前版本的 doc（画布是唯一消费者）
    return Promise.all(
      screens.map(async (s) => {
        const cur = s.current_version ? await this.repo.getCurrentVersion(pid, s.screen_id) : null;
        return screenView(s, cur, project);
      })
    );
  }

  async getScreen(pid, sid) {
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    const project = await this.getProject(pid);
    const cur = await this.repo.getCurrentVersion(pid, sid);
    return screenView(meta, cur, project);
  }

  async patchCanvas(pid, { screen_id, x, y, width, height, actor = 'local-user' }) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, screen_id);
    if (!meta) throw notFound(`屏幕不存在: ${screen_id}`);
    // DC-018：坐标只写 canvas.json，不碰屏幕 meta/版本
    return this.repo.setPosition(pid, screen_id, {
      x: x ?? meta.x ?? 0,
      y: y ?? meta.y ?? 0,
      width: width ?? meta.width,
      height: height ?? meta.height,
    });
  }

  /**
   * 画布状态写入口（PUT /api/projects/:pid/canvas）。
   * 画布只保存视口与屏幕坐标，不产生版本；但仍必须经过写权限校验，
   * 否则只读成员可以绕过所有屏幕接口直接改画布。
   */
  async saveCanvas(pid, body = {}, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    const input = body?.canvas && typeof body.canvas === 'object' ? body.canvas : body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('canvas 必须是对象');
    const viewport = input.viewport;
    if (viewport !== undefined && (typeof viewport !== 'object' || viewport === null || Array.isArray(viewport))) {
      throw badRequest('canvas.viewport 必须是对象');
    }
    const screens = input.screens;
    if (screens !== undefined) {
      if (typeof screens !== 'object' || screens === null || Array.isArray(screens)) throw badRequest('canvas.screens 必须是对象');
      for (const [sid, pos] of Object.entries(screens)) {
        if (!pos || typeof pos !== 'object' || Array.isArray(pos)) throw badRequest(`canvas.screens.${sid} 必须是对象`);
        for (const k of ['x', 'y', 'width', 'height']) {
          if (pos[k] !== undefined && !Number.isFinite(Number(pos[k]))) throw badRequest(`canvas.screens.${sid}.${k} 必须是数字`);
        }
      }
    }
    return this.repo.saveCanvas(pid, input);
  }

  async reorder(pid, ordered_ids, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    if (!Array.isArray(ordered_ids)) throw badRequest('ordered_ids 必须是数组');
    if (!ordered_ids.length) throw badRequest('ordered_ids 不能为空');
    const screens = await this.repo.listScreens(pid);
    const known = new Set(screens.map((s) => s.screen_id));
    const missing = ordered_ids.filter((id) => !known.has(id));
    if (missing.length) throw badRequest(`ordered_ids 包含不属于该项目的屏幕: ${missing.join(', ')}`);
    for (const [i, sid] of ordered_ids.entries()) {
      await this.repo.updateScreenMeta(pid, sid, (m) => ({ ...m, order: String(i + 1).padStart(4, '0') }));
    }
    await this.syncTitles(pid);
    return this.listScreens(pid);
  }

  async renameScreen(pid, sid, { title, remark }, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    if (title !== undefined && !String(title).trim()) throw badRequest('屏幕名称不能为空');
    const meta = await this.repo.updateScreenMeta(pid, sid, (m) => ({
      ...m,
      title: title === undefined ? m.title : String(title).trim(),
      remark: remark ?? m.remark,
    }));
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    await this.syncTitles(pid);
    return meta;
  }

  async setLock(pid, sid, value, { actor = 'local-user', reason = '' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.pending && value) throw conflict('存在待确认的生成结果，请先处理后再锁定');
    const next = await this.repo.updateScreenMeta(pid, sid, (m) => ({
      ...m,
      locked: !!value,
      // 解锁后回到"有内容 applied / 只有空屏基线 draft"，不能一律标成 applied
      status: value ? 'locked' : m.current_version > 1 ? 'applied' : 'draft',
      lock_audit: value
        ? m.lock_audit
        : [...(m.lock_audit || []), { by: actor, at: now(), reason }],
    }));
    await this.audit(pid, { actor, action: value ? 'screen.lock' : 'screen.unlock', object_id: sid, result: 'ok', detail: { reason } });
    return next;
  }

  /** 复制屏幕（FR-CANVAS-003）：新 screen_id，不带版本历史 */
  async duplicateScreen(pid, sid, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    const src = await this.getScreen(pid, sid);
    const created = await this.createScreen(pid, {
      title: `${src.title} 副本`,
      remark: src.remark,
      x: (src.x ?? 0) + (src.width ?? 375) + 40,
      y: src.y ?? 0,
      format: src.format === 'm3' ? 'm3' : 'node-tree',
      baseline: false, // AC-309：不带版本历史，「复制自 X」直接作为 v1
      actor,
    });
    if (src.doc) {
      const cloned = structuredClone(src.doc);
      if (cloned.format === 'm3') {
        reidM3(cloned);
        cloned.frame.id = created.screen_id;
        cloned.frame.name = created.title;
      } else if (cloned.root) reid(cloned.root);
      await this.repo.commitVersion(pid, created.screen_id, cloned, {
        kind: 'copy',
        label: `复制自 ${src.title}`,
        who: actor,
        theme_snapshot: src.theme_snapshot,
      });
    }
    return this.getScreen(pid, created.screen_id);
  }

  /** 删除屏幕（FR-FLOW-006 / AC-006）：有边时必须显式选择处理方式 */
  async deleteScreen(pid, sid, { edge_action = null, actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    const flow = await this.repo.getFlow(pid);
    const related = flow.edges.filter((e) => e.source_screen_id === sid || e.target_screen_id === sid);
    if (related.length && !edge_action) {
      throw conflict(`该屏幕存在 ${related.length} 条关联边，请指定 edge_action`, {
        code: 'EDGES_EXIST',
        related_edges: related.map((e) => ({ edge_id: e.edge_id, source: e.source_screen_id, target: e.target_screen_id })),
        options: ['delete_edges', 'keep_edges_as_orphan', 'cancel'],
      });
    }
    if (edge_action === 'delete_edges') {
      flow.edges = flow.edges.filter((e) => e.source_screen_id !== sid && e.target_screen_id !== sid);
      await this.repo.saveFlow(pid, { ...flow, updated_at: now() });
    } else if (edge_action && edge_action !== 'keep_edges_as_orphan') {
      throw badRequest(`不支持的 edge_action: ${edge_action}`);
    }
    await this.repo.deleteScreen(pid, sid);
    await this.syncTitles(pid);
    await this.audit(pid, { actor, action: 'screen.delete', object_id: sid, result: 'ok', detail: { edge_action, related: related.length } });
    const flowAfter = await this.repo.getFlow(pid);
    return { deleted: sid, orphan_edges: flowAfter.edges.filter((e) => e.source_screen_id === sid || e.target_screen_id === sid).length };
  }

  // ---------------- generation ----------------

  /**
   * 单屏生成。（POST /api/projects/:pid/screens/:sid/generations）
   * 关键点：
   *  - target_screen_id 来自 URL，不是 body —— body 里的 target 会被校验、不一致即 403
   *  - edit_scope 必填（FR-GEN-002）
   *  - 锁定直接 423（FR-VER-005 / AC-003）
   *  - 结果只写 pending，不产生版本（FR-GEN-006）
   */
  async startGeneration(pid, sid, body = {}) {
    const { prompt, edit_scope, selection = null, target_screen_id, mode, actor = 'local-user' } = body;
    const extra = body;
    if (!prompt || !String(prompt).trim()) throw badRequest('prompt 必填');
    if (!edit_scope || !EDIT_SCOPES.includes(edit_scope)) {
      throw badRequest(`edit_scope 必填且只能是 ${EDIT_SCOPES.join(' / ')}`, { code: 'EDIT_SCOPE_REQUIRED' });
    }
    // 区域/组件级修改必须带选区，否则"只改选中区域"无从谈起。
    // 这是请求侧契约问题，应在调用模型前就拒绝，而不是让模型输出被判非法。
    if (edit_scope !== 'screen' && !(selection?.node_ids?.length > 0)) {
      throw badRequest(`edit_scope=${edit_scope} 时必须提供 selection.node_ids`, {
        code: 'SELECTION_REQUIRED',
        hint: '先在屏幕上选中要修改的区块，或改用「整屏」范围',
      });
    }
    // NFR-002：越权目标写入 403（并告警）
    if (target_screen_id && target_screen_id !== sid) {
      await this.alert(pid, { actor, type: 'CROSS_SCREEN_WRITE_ATTEMPT', target: target_screen_id, route_target: sid });
      throw forbiddenTarget(`target_screen_id=${target_screen_id} 与请求路径屏幕 ${sid} 不一致`);
    }

    const project = await this.assertWriter(pid, actor);
    const screen = await this.repo.getScreen(pid, sid);
    if (!screen) throw notFound(`屏幕不存在: ${sid}`);
    if (screen.locked) throw locked('屏幕已锁定，禁止生成与修改', { screen_id: sid });
    if (screen.status === 'generating') throw conflict('该屏幕已有生成任务进行中');

    // 当前选中的模型决定本次生成走 local 还是远端；模型配置只传到 provider，
    // 不进入上下文，也不会写进屏幕内容。
    const activeModel = await this.resolveModel();

    const cur = await this.repo.getCurrentVersion(pid, sid);
    const doc = cur?.doc || { version: 1, root: emptyDoc().root };
    // 以屏幕当前文档为准（旧项目 meta 可能缺 format），整屏输出必须落回同一格式，
    // 否则会出现 meta.format=m3 但版本内容却是 node-tree 的“空白屏”。
    const targetFormat = doc?.format === 'm3' || screen.format === 'm3' ? 'm3' : 'node-tree';

    // 选区必须是当前屏里真实存在的节点，否则"只改选区"会静默退化成什么都没改。
    const normalizedSelection = normalizeSelection(selection);
    if (edit_scope !== 'screen') {
      // M3 屏没有 root，可选区集合必须按 Item 取，否则所有 M3 选区都会被判成不存在
      const known = selectableIdsOf(doc);
      const missing = normalizedSelection.node_ids.filter((id) => !known.has(id));
      if (missing.length) {
        throw badRequest(`selection.node_ids 不存在于当前屏幕: ${missing.join(', ')}`, {
          code: 'SELECTION_NOT_FOUND',
          hint: '重新在画布上选择要修改的区域，或刷新后重试',
        });
      }
      // FR-GEN-005：组件级只允许单节点，多选会退化成"改一个区域"
      if (edit_scope === 'component' && normalizedSelection.node_ids.length !== 1) {
        throw badRequest(`组件级修改只支持单个节点，当前选中 ${normalizedSelection.node_ids.length} 个`, {
          code: 'SELECTION_REQUIRED',
          hint: '在屏幕上只点选一个组件，或把范围切换为「区域」',
        });
      }
    }

    // ★ 上下文只携带本屏
    const ctx = buildGenerationContext({
      project,
      screen,
      currentDoc: doc,
      instruction: prompt,
      editScope: edit_scope,
      selection: normalizedSelection,
      // M3 屏：内置生成器按 Item 视图定位，item_id 与画布回传的 id 完全一致
      itemView: doc.format === 'm3',
      toNodes: docAsNodes,
      // 两种格式统一由 anchorsOfDoc 产出，避免 M3 上下文丢失已有热区
      anchors: anchorsOfDoc(doc),
    });

    // BR-003：修改类任务优先输出 patch。
    // 判据是「屏幕是否已有实质内容」，而不是 scope —— scope=screen 只是允许整屏重写，
    // 不代表每次都要整屏重写。只有空屏或用户显式要求整屏重生成时才走 full。
    // 判据保持原语义：有热区，或节点数 > 6（≈"像一屏了"）。
    // 不能简化成「有节点就算有内容」，否则空屏基线也会被判为已有内容，
    // 整屏生成会被降级成 patch 路径。
    const hasContent = anchorsOfDoc(cur?.doc).length > 0 || nodeCountOf(cur?.doc) > 6;
    const forceFull = mode === 'full' || /整屏|整页|重新生成整|整个页面重做/.test(prompt);

    // FR-ROUTE-001/002/005：大模型调用前先做确定性路由判定。
    // 只有「可唯一确定变更值」的请求才短路到内置生成器，其余一律走原大模型流程。
    // 路由判定必须在 job 落库前完成，决策日志随 job 一起写入（FR-ROUTE-007）。
    const generatorCfg = this.models ? await this.models.generatorConfig() : null;
    const routeDecision = routeIntent({
      prompt,
      body: { ...extra, selection: normalizedSelection },
      editScope: edit_scope,
      generator: generatorCfg,
      hasContent,
      forceFull,
      // 内置生成器可用性只看它自己的配置开关，与"当前选中哪个模型"无关：
      // 选中远端模型时，确定性请求仍应短路到内置生成器（这正是省 token 的意义）。
      isBuiltinActive: !!generatorCfg && generatorCfg.scope !== 'off',
      modelId: activeModel?.model_id || null,
    });
    const deterministic = routeDecision.layer === 'explicit' || routeDecision.layer === 'rule';

    const job_id = rid('job');
    const job = {
      job_id,
      project_id: pid,
      target_screen_id: sid,
      edit_scope,
      prompt,
      selection: normalizedSelection,
      status: 'generating',
      created_at: now(),
      actor,
      model: activeModel
        ? {
            model_id: activeModel.model_id,
            name: activeModel.name,
            provider: activeModel.provider,
            model: activeModel.model,
          }
        : null,
      // 路由元数据：请求的模型与实际生效的模型分开记（FR-ROUTE-007 / FR-SOURCE-005）
      model_requested: activeModel?.model_id || null,
      model_effective: deterministic ? BUILTIN_MODEL_ID : activeModel?.model_id || null,
      route_decision: routeLog(routeDecision),
      // FR-VER-012 / AC-503：版本记录生成时的 Prompt 摘要（哈希），不保存 Prompt 正文副本
      prompt_digest: digestOf(prompt),
      context_audit: ctx.audit,
    };
    await this.repo.appendHistory(pid, 'jobs', job);
    await this.repo.updateScreenMeta(pid, sid, (m) => ({ ...m, status: 'generating' }));

    // 兜底：无论哪条错误路径，都保证 screen 不会卡在 generating
    // （之前 markJob 只在部分分支调用，job 会永久停在 generating，历史看起来像"一直在生成"）
    let settled = false;
    const settle = async (patchObj) => {
      settled = true;
      try {
        await this.markJob(pid, job_id, patchObj);
        await this.repo.updateScreenMeta(pid, sid, (m) => ({ ...m, status: m.locked ? 'locked' : m.current_version ? 'applied' : 'draft' }));
      } catch (e) {
        console.error('[settle]', e);
      }
    };

    let output;
    try {
      if (!hasContent || forceFull) {
        output = await this.ai.generateFull({ ctx, screen, project, model: activeModel });
        output = { ...output, mode: 'full' };
      } else if (deterministic) {
        // ★ 内置生成器短路（FR-ROUTE-001/002）：不调用大模型，直接产出同契约 patch。
        //   provider 为 local 时走结构化入口（可精确定位 node_id / anchor）；
        //   其余情况（例如当前模型不是内置生成器但要求确定性路由）走同一套规则。
        output = await this.ai.generatePatch({
          ctx,
          // 内置生成器按节点视图定位，产出的 ops 再由 applyM3Ops 翻回 Item 字段
          currentDoc: docAsNodes(doc),
          screen,
          editScope: edit_scope,
          selection: normalizedSelection,
          project,
          // 显式结构化目标：节点由请求指定，值由规则给出
          route: { layer: routeDecision.layer, target: routeDecision.target },
          // 目标节点锚定（内置生成器据此精确定位，而不是靠列举屏内文案）
          model: {
            provider: 'local',
            model: 'local-deterministic',
            model_id: BUILTIN_MODEL_ID,
            target: routeDecision.target,
          },
        });
      } else {
        // 兜底：确定性短路未命中，但当前模型本身就是内置生成器（没有真正的大模型可降级）时，
        // 必须如实走"没听懂"语义，而不是绕过路由判定硬套规则生成 patch。
        // 否则会出现「路由日志记 llm / 版本记 ai_patch，实际却由规则产出」的审计失真。
        if (activeModel && activeModel.provider === 'local') {
          await settle({ status: 'no_op', error: `未命中内置生成器规则：${routeDecision.reason}`, code: 'UNPROCESSABLE' });
          throw unprocessable('没有从指令中识别出可执行的修改，屏幕内容未改变', {
            hint: '把改动说得更确定一些，例如「把登录按钮文案改为立即进入」；或切换到可用的 OpenAI 兼容模型处理这类请求',
            reason: routeDecision.reason,
            note: outputNoteForReason(routeDecision.reason),
          });
        }
        output = await this.ai.generatePatch({
          ctx,
          // M3 屏没有 root：生成器按 Item 节点视图定位，产出的 ops 再由 applyDocPatch 翻回 Item 字段
          currentDoc: docAsNodes(doc),
          screen,
          editScope: edit_scope,
          selection: normalizedSelection,
          project,
          model: activeModel,
        });
        // 自定义模型常常"读懂了整屏上下文就吐一份整屏"，这是能力差异而不是越权：
        // 它是本屏的新内容，落库前同样要过白名单校验，用户还要在待确认里预览。
        // 所以这里只在「整屏覆盖会丢掉本屏已有热区」时才拒绝，其余按 full 正常走确认流程。
        const attemptedFull = output?.mode === 'full' && (output.doc || (output.ops && output.ops.length));
        if (attemptedFull && !output.doc) {
          await settle({ status: 'rejected', error: '修改类任务返回了无文档的整屏结果' });
          throw invalidOutput('修改类任务必须返回局部 patch；如需整屏重写请在指令中明确说明', {
            hint: '在指令中写「整屏重新生成」或将 body.mode 设为 full',
          });
        }
        if (attemptedFull) {
          const before = anchorsOfDoc(doc).map((a) => a.hotspot_id);
          const after = new Set(anchorsOfDoc(output.doc).map((a) => a.hotspot_id));
          const lost = before.filter((a) => !after.has(a));
          if (lost.length && before.length) {
            await settle({ status: 'rejected', error: '整屏替换会丢失已有热区', lost });
            throw invalidOutput(`模型返回整屏内容，但会丢失已有热区：${lost.slice(0, 6).join(', ')}`, {
              code: 'INVALID_OUTPUT',
              hint: '流程连线依赖这些热区；请让模型只改局部，或在指令中写「整屏重新生成」确认覆盖',
              lost_anchors: lost,
            });
          }
        }
        if (!output?.doc && !(output?.ops && output.ops.length)) {
          // 没有可执行变更：这是"没听懂"，不是"输出非法"。屏幕保持不变，并给出可操作的提示。
          await settle({ status: 'no_op', error: '未解析出可执行的局部变更' });
          throw unprocessable('没有从指令中识别出可执行的修改，屏幕内容未改变', {
            hint: '把要改的地方说具体些，例如：把「欢迎回来」改成「晚上好」、给登录按钮加粗、删除「忘记密码」，或在指令中写「整屏重新生成」',
            note: output?.note || null,
          });
        }
      }
    } catch (err) {
      // settle() 可能已在上面按语义写过 no_op / rejected，不要用 failed 覆盖它
      if (!settled) {
        const status = err.code === 'UNPROCESSABLE' ? 'no_op' : 'failed';
        await settle({ status, error: err.message, code: err.code || null });
      }
      await this.audit(pid, { actor, action: 'generation.failed', object_id: sid, result: 'failed', detail: { job_id, error: err.message, code: err.code } });
      throw err;
    }

    // AI-007：输出里若夹带其它屏幕写入，直接拒绝 + 告警
    const violations = detectCrossScreenOutput(output, sid);
    if (violations.length) {
      await settle({ status: 'rejected', error: 'cross-screen write', violations });
      await this.alert(pid, { actor, type: 'AI_CROSS_SCREEN_OUTPUT', target: sid, violations });
      throw forbiddenTarget('AI 输出包含非目标屏幕写入，已拒绝落库', { violations });
    }

    // 输出 schema 校验 + 预应用（AE-006/007：非法输出不落库）
    let candidate;
    if (output.mode === 'full') {
      // 关键：整屏输出必须与目标屏格式一致。内置生成器/多数自定义模型仍按 node-tree 契约
      // 返回内容，遇到 M3 屏时在这里显式转换；否则会把 node-tree 写进 m3 屏幕，
      // 画布、预览、导出全部拿不到 groups，表现为“生成成功但页面空白”。
      const fullDoc = coerceFullDoc(output.doc, { targetFormat, screen, project });
      if (targetFormat === 'm3') {
        const issues = validateScreenDoc(fullDoc);
        if (issues.length) {
          await settle({ status: 'rejected', error: `M3 屏幕输出不合法: ${issues.map((i) => i.path).join(', ')}` });
          throw schemaInvalid(`AI 输出 M3 ScreenDoc 不合法（${issues.length} 项）`, { issues });
        }
      } else {
        const errs = validateDoc(fullDoc);
        if (errs.length) {
          await settle({ status: 'rejected', error: errs.join('; ') });
          throw badRequest(`AI 输出文档不合法: ${errs.join('; ')}`, { code: 'INVALID_OUTPUT' });
        }
      }
      candidate = {
        doc: fullDoc,
        applied: [],
        diff: [{ op: 'full-regenerate', node_id: fullDoc.root?.id || fullDoc.frame?.id || sid }],
      };
    } else {
      try {
        candidate = applyDocPatch(doc, output.ops, { screenId: sid });
      } catch (err) {
        await settle({ status: 'rejected', error: err.message, code: err.code });
        if (err.code === 'FORBIDDEN_TARGET') {
          await this.alert(pid, { actor, type: 'PATCH_FORBIDDEN_TARGET', target: sid, detail: err.errors });
          throw forbiddenTarget(err.message, { errors: err.errors });
        }
        throw badRequest(err.message, { code: 'INVALID_OUTPUT', errors: err.errors });
      }
      if (!candidate.applied.length) {
        await settle({ status: 'rejected', error: 'patch 未产生任何变更' });
        throw badRequest('patch 未命中任何节点，未写入屏幕', { code: 'INVALID_OUTPUT', note: output.note });
      }
    }

    const pending = {
      job_id,
      mode: output.mode,
      edit_scope,
      prompt,
      selection: normalizedSelection,
      doc: candidate.doc,
      diff: candidate.diff,
      applied: candidate.applied,
      created_at: now(),
      base_version: screen.current_version,
      // DC-011 / FR-ROUTE-008：内置生成器产出的变更必须可追溯，且成本为 0
      change_source: deterministic ? 'builtin_rule' : 'ai_patch',
      route_layer: routeDecision.layer,
      rule_id: routeDecision.rule_id || null,
      ai_cost: deterministic ? 0 : null,
      change_summary: deterministic ? buildSummary(routeDecision, output) : null,
      prompt_digest: digestOf(prompt),
    };
    await this.markJob(pid, job_id, { status: 'pending_confirm', output_summary: summarize(output, candidate) });
    const nextMeta = await this.repo.updateScreenMeta(pid, sid, (m) => ({ ...m, status: 'pending', pending }));

    return {
      job_id,
      target_screen_id: sid,
      edit_scope,
      status: 'pending_confirm',
      mode: output.mode,
      diff: candidate.diff,
      preview_doc: candidate.doc,
      pending: { base_version: pending.base_version },
      screen_status: nextMeta.status,
      // 前端据此区分"内置生成器处理"与"大模型处理"，不需要再猜
      route: {
        ...routeLog(routeDecision),
        change_source: pending.change_source,
        change_summary: pending.change_summary,
      },
      context_audit: ctx.audit,
    };
  }

  /** 接受 pending：这是唯一会递增版本号的用户路径（FR-GEN-006 / C-008） */
  async applyPending(pid, sid, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，禁止应用 patch');
    const pending = meta.pending;
    if (!pending) throw conflict('没有待确认的生成结果');
    if (pending.base_version !== meta.current_version) {
      throw conflict('屏幕内容已变化（存在更新的版本），请重新生成以避免覆盖', { code: 'STALE_PENDING' });
    }
    // 落库前最后一道防线：pending 必须是合法 ScreenDoc（DC-030），且 frame.id 与路径一致。
    // 这里也覆盖“等待确认期间代码升级/数据被手工改动”的情况。
    if (pending.doc?.format === 'm3') {
      const issues = validateScreenDoc(pending.doc);
      if (issues.length) {
        await this.rejectPending(pid, sid, { actor, reason: 'pending 文档校验失败' });
        throw schemaInvalid(`待确认的 M3 ScreenDoc 已不合法（${issues.length} 项）`, { issues });
      }
      if (pending.doc.frame?.id !== sid) {
        await this.rejectPending(pid, sid, { actor, reason: 'pending frame.id 不匹配' });
        throw schemaInvalid('pending 的 frame.id 与屏幕不一致', {
          issues: [{ path: 'doc.frame.id', code: 'MISMATCH', message: `期望 ${sid}，实际 ${pending.doc.frame?.id}` }],
        });
      }
    }
    const { meta: nextMeta, record } = await this.repo.commitVersion(pid, sid, pending.doc, {
      kind: pending.mode === 'full' ? 'generate' : 'patch',
      label: pending.mode === 'full' ? `单屏生成（${pending.edit_scope}）` : `局部 patch（${pending.edit_scope}）`,
      prompt: pending.prompt,
      job_id: pending.job_id,
      who: actor,
      change_source: pending.change_source || 'ai_patch',
      route_layer: pending.route_layer || 'llm',
      rule_id: pending.rule_id || null,
      ai_cost: pending.ai_cost ?? null,
      change_summary: pending.change_summary || null,
      prompt_digest: pending.prompt_digest || digestOf(pending.prompt || ''),
    });
    await this.repo.updateScreenMeta(pid, sid, (m) => ({
      ...m,
      pending: null,
      status: 'applied',
      // M3 屏落库后确保 meta.format 与内容一致，避免旧项目 meta 缺 format 时预览走错渲染器
      format: pending.doc?.format === 'm3' ? 'm3' : m.format,
    }));
    await this.markJob(pid, pending.job_id, { status: 'applied', applied_version: record.version });
    await this.audit(pid, { actor, action: 'generation.apply', object_id: sid, result: 'ok', detail: { job_id: pending.job_id, version: record.version } });
    return { screen: { ...nextMeta, pending: null }, version: record.version };
  }

  async rejectPending(pid, sid, { actor = 'local-user', reason = '' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (!meta.pending) throw conflict('没有待确认的生成结果');
    const jobId = meta.pending.job_id;
    await this.repo.updateScreenMeta(pid, sid, (m) => ({ ...m, pending: null, status: m.locked ? 'locked' : m.current_version ? 'applied' : 'draft' }));
    await this.markJob(pid, jobId, { status: 'rejected_by_user' });
    await this.audit(pid, { actor, action: 'generation.reject', object_id: sid, result: 'ok', detail: { job_id: jobId, reason } });
    return { rejected: true };
  }

  /**
   * 手动编辑（空间编辑 / 用户直接改节点属性）—— 也走版本，不允许绕过历史。
   * 这是 `manual_direct` 的唯一写入口（DC-010）；锁定与待确认状态在这里统一拦截，
   * 画布的锁定置灰只是辅助（NFR-018）。
   */
  async manualPatch(pid, sid, { ops, edit_scope = 'screen', actor = 'local-user' }) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，禁止内容编辑');
    // 有 pending 时先处理掉：否则人工修改会让 pending 的 base_version 立即过期（STALE_PENDING）
    if (meta.pending) throw conflict('存在待确认的生成结果，请先接受或拒绝', { code: 'PENDING_EXISTS' });
    const cur = await this.repo.getCurrentVersion(pid, sid);
    const errs = validatePatch({ ops }, { screenId: sid });
    if (errs.length) throw invalidOutput(errs.join('; '), { errors: errs });
    let patched;
    try {
      // M3 屏的 Item 改文案：ops 仍是 node_id 形状，只是改到的字段是 label / text / value
      patched = cur.doc?.format === 'm3'
        ? (() => {
            const translated = translateNodeTextOps(cur.doc, ops);
            if (!translated) {
              const err = new Error('M3 屏幕只支持按 item_id 修改文案');
              err.code = 'INVALID_OUTPUT';
              throw err;
            }
            return applyM3Ops(cur.doc, translated);
          })()
        : applyPatch(cur.doc, { ops, target_screen_id: sid }, { screenId: sid });
    } catch (err) {
      throw invalidOutput(err.message, { errors: err.errors || null });
    }
    const doc = patched.doc;
    const { record } = await this.repo.commitVersion(pid, sid, doc, {
      kind: 'manual',
      label: '手动编辑',
      who: actor,
      // DC-010：人工编辑必须可区分，不得伪装成 AI 版本
      change_source: 'manual_direct',
      route_layer: 'manual',
      ai_cost: 0,
      change_summary: summarizeOps(ops, cur.doc, doc),
    });
    await this.audit(pid, { actor, action: 'screen.manual_patch', object_id: sid, result: 'ok', detail: { version: record.version, edit_scope } });
    return { version: record.version, doc };
  }

  // ---------------- editor save / tidy（API-018 / API-024） ----------------

  /**
   * 编辑器保存整屏 ScreenDoc（API-018 / FR-EDIT-019 / DC-032）。
   *
   * 校验顺序与既有写入路径一致：权限 → 锁定 → pending → format → `base_version` → schema。
   * 任何一步失败都不产生版本（失败不落库）。
   */
  async saveScreenDoc(pid, sid, body = {}, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，禁止保存');
    if (meta.pending) throw conflict('存在待确认的生成结果，请先接受或拒绝', { code: 'PENDING_EXISTS' });
    if (meta.format === 'node-tree') {
      throw migrationUnsupported('旧 node-tree 屏幕为只读；请先调用 /convert 转换后再保存');
    }

    const baseVersion = Number(body.base_version);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      throw badRequest('base_version 必填，且必须是非负整数', { code: 'BASE_VERSION_REQUIRED', hint: '请先读取屏幕当前版本再提交 base_version' });
    }
    // DC-032 / AC-319：两个标签页同时保存时，后到者必须被拒绝，不得覆盖
    if (baseVersion !== meta.current_version) {
      throw conflict(`版本已前进（当前 v${meta.current_version}，提交基于 v${baseVersion}）`, {
        code: 'CONFLICT',
        current_version: meta.current_version,
        hint: '请刷新后重试，或另存为副本；本地未保存内容不会丢失',
      });
    }

    const doc = body.doc;
    const issues = validateScreenDoc(doc);
    if (issues.length) {
      throw schemaInvalid(`ScreenDoc 校验失败（${issues.length} 项）`, { issues });
    }
    if (doc.frame?.id !== sid) {
      throw schemaInvalid('doc.frame.id 必须等于路径中的 screen_id', {
        issues: [{ path: 'doc.frame.id', code: 'MISMATCH', message: `期望 ${sid}，实际 ${doc.frame?.id}` }],
      });
    }

    // 整屏替换不得让「仍被 confirmed 边引用」的热区凭空消失（AI-006 的同口径检查）。
    // 未被引用的部件可以正常删除；否则用户永远无法清理占位元素。
    const before = await this.repo.getCurrentVersion(pid, sid);
    const flow = await this.repo.getFlow(pid);
    const referenced = new Set(
      flow.edges
        .filter((e) => (!e.status || e.status === 'confirmed') && e.source_screen_id === sid && e.source_item_id)
        .map((e) => e.source_item_id)
    );
    const lost = lostHotspots(before?.doc, doc).filter((id) => referenced.has(id));
    if (lost.length) {
      throw invalidOutput(`保存会删除 ${lost.length} 个仍被关联引用的热区`, {
        lost_items: lost,
        hint: '请先删除这些热区的关联边，或保留对应 Item',
      });
    }

    const summary = body.summary || summarizeDocChange(before?.doc, doc);
    const { record } = await this.repo.commitVersion(pid, sid, doc, {
      kind: 'manual',
      label: summary,
      who: actor,
      change_source: 'manual_direct',
      route_layer: 'manual',
      ai_cost: 0,
      change_summary: summary,
    });
    await this.audit(pid, {
      actor,
      action: 'screen.save_doc',
      object_id: sid,
      result: 'ok',
      detail: { version: record.version, base_version: baseVersion, edit_scope: body.edit_scope || 'screen' },
    });
    return { version: record.version, change_summary: summary, doc };
  }

  /** Tidy 预览（API-024 / FR-EDIT-009）：只返回结果，不落库、不产生版本 */
  async tidyScreen(pid, sid, body = {}, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    const project = await this.getProject(pid);
    const cur = await this.repo.getCurrentVersion(pid, sid);
    const source = body.doc ?? cur?.doc;
    if (!source) throw badRequest('当前屏幕没有可排版的内容');
    if (source.format !== 'm3') throw migrationUnsupported('旧 node-tree 屏幕不支持 Tidy；请先转换');
    const shape = body.shape || project.design?.theme?.shape || 'rounded';
    const { doc, changes } = tidyDoc(source, { shape });
    const issues = validateScreenDoc(doc);
    return {
      doc,
      changes,
      changed_count: changes.length,
      shape,
      valid: issues.length === 0,
      issues,
      base_version: meta.current_version,
    };
  }

  // ---------------- versions ----------------

  async listVersions(pid, sid) {
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    return { current_version: meta.current_version, versions: await this.repo.listVersions(pid, sid) };
  }

  async getVersion(pid, sid, v) {
    const rec = await this.repo.getVersion(pid, sid, Number(v));
    if (!rec) throw notFound(`版本不存在: ${sid}@v${v}`);
    return rec;
  }

  /** 回滚（FR-VER-003 / AC-005）：只改本屏指针 */
  async rollback(pid, sid, version, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，禁止版本回滚');
    if (meta.pending) throw conflict('存在待确认的生成结果，请先接受或拒绝');
    const v = Number(version);
    const rec = await this.repo.getVersion(pid, sid, v);
    if (!rec) throw notFound(`版本不存在: ${sid}@v${v}`);
    const next = await this.repo.setCurrentVersion(pid, sid, v, actor);
    await this.audit(pid, { actor, action: 'screen.rollback', object_id: sid, result: 'ok', detail: { from: meta.current_version, to: v } });
    return { screen: next, version: v };
  }

  /**
   * 撤销最近一次变更（FR-PATCH-005）：等价于回滚到上一个版本。
   * 只切本屏指针，不删除历史，也不影响其他屏与关联边。
   */
  async undoLast(pid, sid, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，禁止撤销');
    if (meta.pending) throw conflict('存在待确认的生成结果，请先接受或拒绝');
    const target = meta.current_version - 1;
    if (target < 1) throw conflict('没有可撤销的历史版本');
    const rec = await this.repo.getVersion(pid, sid, target);
    if (!rec) throw notFound(`上一个版本不存在: ${sid}@v${target}`);
    const next = await this.repo.setCurrentVersion(pid, sid, target, actor);
    await this.audit(pid, {
      actor,
      action: 'screen.undo',
      object_id: sid,
      result: 'ok',
      detail: { from: meta.current_version, to: target },
    });
    return { screen: next, version: target, undone_from: meta.current_version };
  }

  async diffVersions(pid, sid, a, b) {
    const A = await this.getVersion(pid, sid, a);
    const B = await this.getVersion(pid, sid, b);
    // M3 ScreenDoc 没有 root：按 Item 展平，旧文档仍按节点树展平。
    // 两种格式都返回 `{node_id, tag, text, style, attrs}`，前端版本对比无需分支。
    const flatten = (doc) => {
      const map = new Map();
      if (doc?.format === 'm3') {
        for (const group of doc.groups ?? []) {
          for (const item of group.items ?? []) {
            if (item?.id) map.set(item.id, { ...item, __kind: 'item', __group: group.id });
          }
        }
        return map;
      }
      walk(doc?.root, (n) => map.set(n.id, n));
      return map;
    };
    const ma = flatten(A.doc);
    const mb = flatten(B.doc);
    const added = [];
    const removed = [];
    const changed = [];
    const details = { added: [], removed: [], changed: [] };
    const brief = (n) =>
      n.__kind === 'item'
        ? {
            node_id: n.id,
            tag: n.kind || 'item',
            text: String(m3ItemText(n) || '').slice(0, 120),
            style: n.style || {},
            attrs: n.attrs || {},
          }
        : {
            node_id: n.id,
            tag: n.tag,
            text: String(textOf(n) || '').slice(0, 120),
            style: n.props?.style || {},
            attrs: n.props?.attrs || {},
          };
    const sameNode = (before, n) => {
      if (before.__kind === 'item' || n.__kind === 'item') {
        // 内容/样式/槽位变化都算差异；group 归属变化同样影响布局
        const pick = (x) => {
          const { __group, ...rest } = x;
          return { ...rest, __group };
        };
        return JSON.stringify(pick(before)) === JSON.stringify(pick(n));
      }
      return before.tag === n.tag && JSON.stringify(before.props || {}) === JSON.stringify(n.props || {});
    };
    for (const [id, n] of mb) {
      if (!ma.has(id)) {
        added.push(id);
        details.added.push(brief(n));
      } else {
        const before = ma.get(id);
        if (!sameNode(before, n)) {
          changed.push(id);
          details.changed.push({ node_id: id, tag: brief(n).tag, before: brief(before), after: brief(n) });
        }
      }
    }
    for (const [id, n] of ma) {
      if (!mb.has(id)) {
        removed.push(id);
        details.removed.push(brief(n));
      }
    }
    return { a: Number(a), b: Number(b), added, removed, changed, details };
  }

  // ---------------- flow ----------------

  async getFlow(pid) {
    await this.getProject(pid);
    const flow = await this.repo.getFlow(pid);
    const screens = await this.repo.listScreens(pid);
    const byId = new Map(screens.map((s) => [s.screen_id, s]));
    const anchorCache = new Map();
    const anchorsOf = async (sid) => {
      if (!anchorCache.has(sid)) {
        const cur = await this.repo.getCurrentVersion(pid, sid);
        const doc = cur?.doc;
        const list = !doc
          ? []
          : doc.format === 'm3'
            ? estimateAnchors(doc).map((a) => a.hotspot_id)
            : anchorsOfDoc(doc);
        anchorCache.set(sid, list);
      }
      return anchorCache.get(sid);
    };

    const edges = [];
    for (const e of flow.edges) {
      const srcExists = byId.has(e.source_screen_id);
      const tgtExists = e.target_kind === 'screen' || !e.target_kind ? byId.has(e.target_screen_id) : true;
      const anchors = srcExists ? await anchorsOf(e.source_screen_id) : [];
      const hotspot = e.source_hotspot_id ?? (e.source_item_id ? anchorOf(e.source_item_id, e.source_slot) : null);
      const anchorOk = hotspot ? anchors.includes(hotspot) : true;
      edges.push({
        ...e,
        source_hotspot_id: hotspot,
        status: e.status || 'confirmed',
        // DC-039：孤儿状态只在读取时计算，绝不写回 flow.json
        orphan: {
          source_missing: !srcExists,
          target_missing: !tgtExists,
          hotspot_missing: srcExists && !anchorOk,
          item_missing: srcExists && !anchorOk,
          slot_missing: !!(e.source_slot && !anchorOk),
        },
      });
    }
    return { schema_version: 2, edges };
  }

  /** 建边：绝不触碰 screen 目录（C-004 / DC-004）；M3 用 item_id + slot，旧屏用 data-anchor */
  async createEdge(pid, body, { actor = 'local-user', status = 'confirmed' } = {}) {
    await this.assertWriter(pid, actor);
    const { source_screen_id, target_screen_id, url = null, note = '', direction = null, transition = null } = body || {};
    const trigger = body?.trigger || 'click';
    const sourceHotspot = body?.source_hotspot_id ?? null;
    const parsedAnchor = sourceHotspot ? parseAnchor(sourceHotspot) : { item_id: body?.source_item_id ?? null, slot: body?.source_slot ?? null };
    if (!source_screen_id || !parsedAnchor.item_id) {
      throw badRequest('source_screen_id 与 source_hotspot_id（或 source_item_id）均必填');
    }
    if (!['click', 'auto', 'swipe'].includes(trigger)) throw badRequest(`不支持的 trigger: ${trigger}`);
    if (trigger === 'swipe' && !['left', 'right', 'up', 'down'].includes(direction)) {
      throw badRequest('swipe 边必须提供 direction', { code: 'SWIPE_DIRECTION_REQUIRED' });
    }
    const targetKind = body?.target_kind || (target_screen_id ? 'screen' : url ? 'link' : 'screen');
    assertEdgeTarget({ targetKind, targetScreenId: target_screen_id, url });

    const src = await this.repo.getScreen(pid, source_screen_id);
    const tgt = target_screen_id ? await this.repo.getScreen(pid, target_screen_id) : null;
    if (!src) throw notFound(`源屏幕不存在: ${source_screen_id}`);
    if (target_screen_id && !tgt) throw notFound(`目标屏幕不存在: ${target_screen_id}`);

    const hotspots = await this.hotspotsOf(pid, source_screen_id);
    const hotspotId = anchorOf(parsedAnchor.item_id, parsedAnchor.slot);
    if (!hotspots.includes(hotspotId)) {
      throw badRequest(`热区 ${hotspotId} 不存在于源屏幕（可用：${hotspots.join(', ') || '无'}）`, { code: 'HOTSPOT_NOT_FOUND' });
    }

    const flow = await this.repo.getFlow(pid);
    // 同一热区覆盖式建边：一个热区只应有一条出边（避免预览歧义）
    const dup = flow.edges.find(
      (e) =>
        e.source_screen_id === source_screen_id &&
        (e.source_item_id ?? e.source_hotspot_id) === parsedAnchor.item_id &&
        (e.source_slot ?? null) === (parsedAnchor.slot ?? null) &&
        e.status !== 'deleted'
    );
    if (dup) {
      Object.assign(dup, {
        target_kind: targetKind,
        target_screen_id: target_screen_id ?? null,
        url,
        trigger,
        direction: trigger === 'swipe' ? direction : null,
        transition: transition ?? dup.transition ?? 'none',
        note,
        status,
        updated_at: now(),
      });
      await this.repo.saveFlow(pid, { ...flow, updated_at: now() });
      await this.audit(pid, { actor, action: 'flow.reassign', object_id: dup.edge_id, result: 'ok', detail: { to: target_screen_id } });
      return dup;
    }
    const edge = {
      edge_id: rid('edge'),
      project_id: pid,
      source_screen_id,
      source_item_id: parsedAnchor.item_id,
      source_slot: parsedAnchor.slot ?? null,
      source_hotspot_id: hotspotId,
      target_kind: targetKind,
      target_screen_id: target_screen_id ?? null,
      url,
      trigger,
      direction: trigger === 'swipe' ? direction : null,
      transition: transition ?? 'none',
      animation: transition ?? 'none',
      note,
      status,
      created_at: now(),
      updated_at: now(),
      created_by: actor,
    };
    flow.edges.push(edge);
    await this.repo.saveFlow(pid, { ...flow, updated_at: now() });
    await this.audit(pid, { actor, action: status === 'candidate' ? 'flow.candidate' : 'flow.create', object_id: edge.edge_id, result: 'ok' });
    return edge;
  }

  /** 可用热区 id 列表（建边/校验用，只要字符串） */
  async hotspotsOf(pid, sid) {
    const cur = await this.repo.getCurrentVersion(pid, sid);
    if (!cur?.doc) return [];
    return anchorsOfDoc(cur.doc).map((a) => a.hotspot_id);
  }

  async updateEdge(pid, edgeId, body, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const flow = await this.repo.getFlow(pid);
    const e = flow.edges.find((x) => x.edge_id === edgeId);
    if (!e) throw notFound(`关联边不存在: ${edgeId}`);
    const trigger = body.trigger ?? e.trigger;
    if (trigger && !['click', 'auto', 'swipe'].includes(trigger)) throw badRequest(`不支持的 trigger: ${trigger}`);
    const direction = body.direction ?? e.direction ?? null;
    if (trigger === 'swipe' && !['left', 'right', 'up', 'down'].includes(direction)) {
      throw badRequest('swipe 边必须提供 direction', { code: 'SWIPE_DIRECTION_REQUIRED' });
    }
    const targetKind = body.target_kind ?? e.target_kind ?? 'screen';
    const targetScreenId = body.target_screen_id !== undefined ? body.target_screen_id : e.target_screen_id;
    const url = body.url !== undefined ? body.url : e.url ?? null;
    assertEdgeTarget({ targetKind, targetScreenId, url });
    if (targetKind === 'screen' && targetScreenId) {
      const tgt = await this.repo.getScreen(pid, targetScreenId);
      if (!tgt) throw notFound(`目标屏幕不存在: ${targetScreenId}`);
    }
    Object.assign(e, {
      target_kind: targetKind,
      target_screen_id: targetScreenId,
      url,
      trigger,
      direction: trigger === 'swipe' ? direction : null,
      transition: body.transition ?? body.animation ?? e.transition ?? e.animation ?? 'none',
      animation: body.animation ?? body.transition ?? e.animation ?? e.transition ?? 'none',
      note: body.note ?? e.note,
      status: body.status ?? e.status,
      updated_at: now(),
    });
    await this.repo.saveFlow(pid, { ...flow, updated_at: now() });
    await this.audit(pid, { actor, action: 'flow.update', object_id: edgeId, result: 'ok' });
    return e;
  }

  async deleteEdge(pid, edgeId, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const flow = await this.repo.getFlow(pid);
    const idx = flow.edges.findIndex((x) => x.edge_id === edgeId);
    if (idx < 0) throw notFound(`关联边不存在: ${edgeId}`);
    const [removed] = flow.edges.splice(idx, 1);
    await this.repo.saveFlow(pid, { ...flow, updated_at: now() });
    await this.audit(pid, { actor, action: 'flow.delete', object_id: edgeId, result: 'ok' });
    return removed;
  }

  /**
   * 自然语言建边（FR-FLOW-002 / AI-003）：只产出 candidate，必须用户确认。
   * 用本地解析器，不调用生成模型 —— 但同样遵守：不读写屏幕内容以外的任何东西。
   */
  async proposeEdge(pid, { text }, { actor = 'local-user' } = {}) {
    if (!text || !String(text).trim()) throw badRequest('text 必填');
    const screens = await this.repo.listScreens(pid);
    const parsed = parseEdgeIntent(String(text), screens);
    if (!parsed) throw badRequest('未能从描述中识别出「源屏幕 → 目标屏幕」', { code: 'EDGE_PARSE_FAILED' });
    const srcAnchors = await (async () => {
      const cur = await this.repo.getCurrentVersion(pid, parsed.source_screen_id);
      return cur ? anchorsOfDoc(cur.doc) : [];
    })();
    const hotspot =
      srcAnchors.find((a) => parsed.hotspot_keyword && (a.text.includes(parsed.hotspot_keyword) || a.hotspot_id.includes(parsed.hotspot_keyword))) ||
      srcAnchors.find((a) => /login|submit|open|approve|back/.test(a.hotspot_id)) ||
      srcAnchors[0];
    if (!hotspot) throw badRequest('源屏幕中没有可用的热区，无法建立关联', { code: 'NO_HOTSPOT' });
    const candidate = {
      source_screen_id: parsed.source_screen_id,
      source_hotspot_id: hotspot.hotspot_id,
      target_screen_id: parsed.target_screen_id,
      trigger: 'click',
      animation: 'none',
      note: text,
      status: 'candidate',
      confidence: parsed.confidence,
      rationale: `识别到「${parsed.source_title}」的热区 ${hotspot.hotspot_id}（${hotspot.text}）→「${parsed.target_title}」`,
    };
    return candidate;
  }

  async confirmCandidate(pid, body, { actor } = {}) {
    return this.createEdge(pid, body, { actor, status: 'confirmed' });
  }

  // ---------------- preview / export ----------------

  /** 预览数据：只读拼装，不含后续写权限（FR-RENDER-004：旧屏走只读渲染器） */
  async buildPreview(pid, startScreenId) {
    const project = await this.getProject(pid);
    const screens = await this.repo.listScreens(pid);
    if (!screens.length) throw badRequest('项目下还没有屏幕');
    const start = startScreenId || screens[0].screen_id;
    if (!screens.some((s) => s.screen_id === start)) throw notFound(`起始屏幕不存在: ${start}`);
    const payload = {
      project: {
        project_id: project.project_id,
        name: project.name,
        device: project.device,
        design: project.design,
        design_tokens: project.design_tokens,
      },
      start,
      screens: [],
      edges: [],
      render_contract: 'm3studio/render@1',
    };
    for (const s of screens) {
      const cur = await this.repo.getCurrentVersion(pid, s.screen_id);
      const view = screenView(s, cur, project);
      payload.screens.push({
        screen_id: s.screen_id,
        title: s.title,
        locked: s.locked,
        version: s.current_version,
        format: view.format,
        readonly: view.readonly,
        theme_snapshot: cur?.theme_snapshot || project.design?.theme || null,
        // 版本来源随预览返回，供画布/版本树展示"内置生成器 or 大模型"（FR-SOURCE-001）
        change_source: cur?.change_source || null,
        change_summary: cur?.change_summary || null,
        anchors: view.anchors,
        doc: cur?.doc || null,
      });
    }
    const flow = await this.repo.getFlow(pid);
    // 预览/导出只消费已确认的边：候选边只是 AI 建议，不能变成可点击行为
    payload.edges = flow.edges.filter((e) => !e.status || e.status === 'confirmed').map((e) => ({
      edge_id: e.edge_id,
      source_screen_id: e.source_screen_id,
      source_item_id: e.source_item_id ?? null,
      source_slot: e.source_slot ?? null,
      source_hotspot_id: e.source_item_id ? anchorOf(e.source_item_id, e.source_slot) : e.source_hotspot_id ?? null,
      target_kind: e.target_kind || 'screen',
      target_screen_id: e.target_screen_id,
      url: e.url ?? null,
      trigger: e.trigger || 'click',
      direction: e.direction ?? null,
      transition: e.transition ?? e.animation ?? 'none',
      animation: e.transition ?? e.animation ?? 'none',
      status: e.status || 'confirmed',
    }));
    return payload;
  }

  // ---------------- import / export / migration ----------------

  /** 创建新项目并导入（API-017 / AC-612）：先校验、后写入，失败不落库 */
  async importProject(payload, { name, actor = 'local-user' } = {}) {
    const parsed = normalizeImport(payload, { name, actor });
    const result = await persistImportedProject(this.repo, parsed, { actor });
    await this.audit(result.project_id, {
      actor,
      action: 'project.import',
      object_id: result.project_id,
      result: 'ok',
      detail: { kind: parsed.kind, screens: parsed.screens.length, edges: parsed.edges.length, warnings: parsed.warnings.length },
    });
    return {
      ...result,
      kind: parsed.kind,
      screen_count: parsed.screens.length,
      edge_count: parsed.edges.length,
      screens: parsed.screens.map((s) => ({ screen_id: s.screen_id, title: s.title, format: s.format })),
      loss: parsed.loss,
    };
  }

  /** 导入到现有项目（API-017b / AC-613） */
  async importInto(pid, payload, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const result = await importIntoProject(this.repo, pid, payload, { actor });
    await this.audit(pid, { actor, action: 'project.import_existing', object_id: pid, result: 'ok', detail: result });
    return result;
  }

  /** 导出 M3E（AC-605 / FR-PROJ-007） */
  async exportM3e(pid, opts = {}) {
    return exportProjectAsM3e(this.repo, pid, opts);
  }

  /** 完整备份（JSON），可被 import 还原 */
  async exportBackup(pid) {
    return exportBackup(this.repo, pid);
  }

  /**
   * Prompt 生成（API-020 / FR-PROMPT-001~012）。
   * 只读接口：readonly 成员也可调用；单屏模式不读取其它屏正文。
   */
  async getPrompt(pid, { lang = 'zh', screenId = null } = {}) {
    const project = await this.getProject(pid);
    if (!PROMPT_LANGS.includes(lang)) {
      throw badRequest(`不支持的 Prompt 语言: ${lang}（可选 ${PROMPT_LANGS.join(' / ')}）`);
    }
    const screens = await this.repo.listScreens(pid);
    if (screenId && !screens.some((s) => s.screen_id === screenId)) {
      throw notFound(`屏幕不存在: ${screenId}`);
    }
    const entries = await Promise.all(
      screens.map(async (s) => {
        const cur = await this.repo.getCurrentVersion(pid, s.screen_id);
        return { meta: s, doc: cur?.doc || null };
      })
    );
    const flow = await this.repo.getFlow(pid);
    const auto = buildProjectPrompt({
      project,
      screens: entries,
      edges: flow.edges,
      lang,
      screenId: screenId || null,
    });
    // promptEdit 只作用于全项目 Prompt；单屏 brief 必须按当前屏即时生成（FR-PROMPT-005）
    const prompt = screenId ? auto : applyPromptEdit(auto, project.design?.promptEdit, lang);
    return {
      ...prompt,
      project_id: pid,
      editable: !screenId,
      prompt_edit: project.design?.promptEdit ?? null,
      options: project.design?.promptOptions ?? [],
      source: {
        screens: entries.length,
        edges: flow.edges.filter((e) => !e.status || e.status === 'confirmed').length,
        design_revision_source: 'project.design',
      },
    };
  }

  /**
   * Prompt 包（FR-EXPORT-006）：prompt.md + design.json + agent.md + README.md。
   * 单屏包只包含目标屏正文，避免通过 design.json 泄露其它屏内容。
   */
  async exportPromptPack(pid, { lang = 'zh', screenId = null } = {}) {
    const project = await this.getProject(pid);
    const prompt = await this.getPrompt(pid, { lang, screenId });
    const screens = await this.repo.listScreens(pid);
    const entries = await Promise.all(
      screens.map(async (s) => {
        const cur = await this.repo.getCurrentVersion(pid, s.screen_id);
        return { meta: s, doc: cur?.doc || null };
      })
    );
    const scoped = screenId ? entries.filter((x) => x.meta.screen_id === screenId) : entries;
    const flow = await this.repo.getFlow(pid);
    const edges = screenId ? flow.edges.filter((e) => e.source_screen_id === screenId) : flow.edges;
    const positions = (await this.repo.getCanvas(pid)).screens || {};
    const warnings = [...(prompt.warnings || [])];

    let designDoc;
    try {
      designDoc = assembleProjectDoc({
        design: project.design,
        screens: scoped.filter((x) => x.doc),
        edges,
        positions,
        includeHidden: false,
      });
    } catch (err) {
      // 旧 node-tree 屏无法直接组装成 M3E Doc：仍产出 Prompt 包，但明确降级说明
      warnings.push({
        code: 'DESIGN_DOC_PARTIAL',
        message: `项目含无法组装的旧屏，design.json 为部分文档: ${err.message}`,
      });
      designDoc = {
        schema: 'm3studio/project@1',
        title: project.design?.title || project.name,
        brief: project.design?.brief || '',
        platform: project.design?.platform || 'android',
        paletteKey: project.design?.paletteKey,
        customPalette: project.design?.customPalette,
        dynamicColor: project.design?.dynamicColor,
        theme: project.design?.theme,
        promptOptions: project.design?.promptOptions || [],
        screens: scoped.map((x) => ({ screen_id: x.meta.screen_id, title: x.meta.title, format: x.meta.format, doc: x.doc })),
        edges,
      };
    }

    const agent = buildAgentGuide({ project, lang: prompt.lang });
    const readme = buildReadme({ project, lang: prompt.lang, files: ['prompt.md', 'design.json', 'agent.md', 'README.md'] });
    const files = {
      'prompt.md': prompt.markdown,
      'design.json': redactSecrets(JSON.stringify(designDoc, null, 2)).text,
      'agent.md': agent,
      'README.md': readme,
    };
    return {
      project_name: project.name,
      lang: prompt.lang,
      scope: prompt.scope,
      digest: prompt.digest,
      prompt: prompt.markdown,
      files,
      zip: createZip(files),
      warnings,
    };
  }

  /** 旧 node-tree → M3 预览（API-019 / AC-609）：不提交，返回 doc + 损失报告 */
  async convertScreen(pid, sid, body = {}, actor = 'local-user') {
    const project = await this.getProject(pid);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    const source = body.doc ?? (await this.repo.getCurrentVersion(pid, sid))?.doc;
    if (!source) throw badRequest('当前屏幕没有可转换的内容');
    if (source.format === 'm3') throw migrationUnsupported('当前屏幕已经是 M3 文档，无需转换');
    const result = convertScreenDoc(source, {
      screenId: sid,
      title: meta.title,
      device: { w: project.device.width, h: project.device.height },
    });
    const issues = validateLegacyDoc(source);
    return { ...result, source_issues: issues, screen_id: sid, saved: false };
  }

  async validateProject(pid) {
    await this.assertProjectExists(pid);
    return validateProject(this.repo, pid);
  }

  async assertProjectExists(pid) {
    const project = await this.repo.getProject(pid);
    if (!project) throw notFound(`项目不存在: ${pid}`);
    return project;
  }

  async getUiState(pid) {
    await this.assertProjectExists(pid);
    return this.repo.getUiState(pid);
  }

  async saveUiState(pid, state, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    return this.repo.saveUiState(pid, state);
  }

  async saveMeasurements(pid, sid, body = {}, actor = 'local-user') {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，不能更新测量缓存');
    if (!body.items || typeof body.items !== 'object') throw badRequest('items 必填');
    // DC-033：measurements 只是缓存，不产生版本
    return this.repo.saveMeasurements(pid, sid, body.items, body.measured_at);
  }

  async getRenderContract() {
    return {
      contract: 'm3studio/render@1',
      formats: ['m3', 'node-tree'],
      renderers: { m3: 'shared/m3@1', legacy: 'shared/legacy-readonly@1' },
      theme_source: 'project.design',
      note: '编辑器缩略图、应用内预览、静态导出共用此契约（FR-RENDER-001）',
    };
  }

  // ---------------- helpers ----------------

  /** 写操作统一的人角色校验（FR-PROJ-004 / NFR-009）。返回项目，避免重复读。 */
  async assertWriter(pid, actor) {
    const project = await this.getProject(pid);
    if (actor && !canWrite(project, actor)) {
      throw noPermission('只读成员无权限执行写操作');
    }
    return project;
  }

  async syncTitles(pid) {
    const screens = await this.repo.listScreens(pid);
    await this.repo.updateProject(pid, (p) => ({
      ...p,
      screen_titles: screens.map((s) => ({ screen_id: s.screen_id, title: s.title })),
    }));
  }

  async markJob(pid, jobId, patch) {
    return this.repo.updateJob(pid, jobId, patch);
  }

  async audit(pid, entry) {
    return this.repo.appendHistory(pid, 'audits', { log_id: rid('log'), at: now(), ...entry });
  }

  async alert(pid, entry) {
    return this.repo.appendHistory(pid, 'audits', {
      log_id: rid('log'),
      at: now(),
      level: 'alert',
      action: entry.type,
      object_id: entry.target,
      result: 'blocked',
      detail: entry,
      ...entry,
    });
  }

  async getHistory(pid) {
    const h = await this.repo.getHistory(pid);
    return h;
  }
}

/**
 * Prompt 摘要（FR-VER-012 / DC-041）：只保存哈希，不保存正文。
 * 固定 `sha256:` 前缀，便于前端/审计识别算法。
 */
function digestOf(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

/**
 * 把整屏生成结果收敛到目标屏格式。
 *
 * 内置生成器与多数兼容模型仍输出旧 `{version, root}`；如果目标屏是 M3，
 * 直接落库会得到「meta.format=m3 但 doc 没有 groups」的空白屏。
 * 这里在 schema 校验前显式转换，并统一 frame.id / 尺寸。
 */
function coerceFullDoc(doc, { targetFormat, screen, project }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw invalidOutput('整屏生成结果缺少文档对象', { code: 'INVALID_OUTPUT' });
  }
  if (targetFormat === 'm3') {
    let source = doc;
    if (source.format === 'm3') return normalizeM3Frame(source, { screen, project });
    if (isLegacyNodeTree(source)) {
      const { doc: converted } = convertLegacyToM3(source, {
        screenId: screen.screen_id,
        title: screen.title,
        device: { w: project.device?.width, h: project.device?.height },
      });
      return normalizeM3Frame(converted, { screen, project });
    }
    // 模型可能省略 format/schema，但已按 M3 的 groups 结构输出
    if (Array.isArray(source.groups)) return normalizeM3Frame(source, { screen, project });
    // 兼容包了一层 {doc:{...}} 的输出
    if (source.doc && typeof source.doc === 'object') {
      return coerceFullDoc(source.doc, { targetFormat, screen, project });
    }
    throw invalidOutput('整屏生成结果既不是 node-tree 也不是 M3 ScreenDoc', {
      code: 'INVALID_OUTPUT',
      hint: '请让模型输出 {version,root} 或 {schema,format:"m3",frame,groups}',
    });
  }
  if (doc.format === 'm3') {
    throw invalidOutput('目标屏幕是 node-tree，不能写入 M3 ScreenDoc', { code: 'INVALID_OUTPUT' });
  }
  if (doc.root && typeof doc.root === 'object') return { version: Number(doc.version) || 1, root: doc.root };
  if (doc.doc && typeof doc.doc === 'object') return coerceFullDoc(doc.doc, { targetFormat, screen, project });
  throw invalidOutput('整屏生成结果缺少 root 节点', { code: 'INVALID_OUTPUT' });
}

function normalizeM3Frame(doc, { screen, project }) {
  const out = structuredClone(doc);
  out.schema = out.schema || 'm3studio/screen@1';
  out.format = 'm3';
  out.frame = {
    x: 0,
    y: 0,
    ...(out.frame && typeof out.frame === 'object' ? out.frame : {}),
    // 路径里的屏幕是本屏唯一权威：模型返回的 frame.id 不可信
    id: screen.screen_id,
    name: out.frame?.name || screen.title,
    w: out.frame?.w ?? project.device?.width,
    h: out.frame?.h ?? project.device?.height,
  };
  out.groups = Array.isArray(out.groups) ? out.groups : [];
  out.meta = out.meta && typeof out.meta === 'object' && !Array.isArray(out.meta) ? out.meta : {};
  return out;
}

const TARGET_KINDS = new Set(['screen', 'back', 'link', 'menu', 'toggle']);

/** 关联边目标校验：枚举、screen 目标必填、link 仅允许 http/https */
function assertEdgeTarget({ targetKind, targetScreenId, url }) {
  if (!TARGET_KINDS.has(targetKind)) {
    throw badRequest(`不支持的 target_kind: ${targetKind}（可选 screen / back / link / menu / toggle）`);
  }
  if (targetKind === 'screen' && !targetScreenId) throw badRequest('screen 边必须提供 target_screen_id');
  if (targetKind === 'link') {
    if (!url || !String(url).trim()) throw badRequest('link 边必须提供 url');
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw badRequest('link 边的 url 必须是合法的 http/https 地址');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw badRequest('link 边的 url 只允许 http/https');
    }
  }
}

function canWrite(project, who) {
  const m = (project.members || []).find((x) => x.user === who);
  return !m || m.role !== 'readonly';
}

/** 屏幕视图：doc + 格式 + 只读态 + 热区。坐标由 repo 从 canvas.json 投影而来。 */
function screenView(meta, cur, project) {
  const doc = cur?.doc || null;
  const format = meta.format || (doc?.format === 'm3' ? 'm3' : 'node-tree');
  const anchors = doc
    ? doc.format === 'm3'
      ? estimateAnchors(doc)
      : anchorsOfDoc(doc)
    : [];
  return {
    ...meta,
    format,
    readonly: format === 'node-tree' && !!doc,
    theme_snapshot: cur?.theme_snapshot || project?.design?.theme || null,
    doc,
    anchors,
  };
}

/** 旧 node-tree 转 M3 预览（API-019）：不提交、不覆盖原版本 */
export function convertScreenDoc(doc, opts) {
  return convertLegacyToM3(doc, opts);
}

function emptyM3ScreenDoc(screenId, title, w, h) {
  return {
    schema: 'm3studio/screen@1',
    format: 'm3',
    frame: { id: screenId, name: title, x: 0, y: 0, w, h },
    groups: [],
    meta: {},
  };
}

/** 旧 design_tokens → ProjectDesign（新项目未显式给 design 时使用） */
function designFromLegacyTokens(tokens, name) {
  const primary = tokens?.colors?.primary;
  const radius = Number(tokens?.radius?.md);
  const family = String(tokens?.font?.family ?? '');
  return normalizeProjectDesign({
    title: name,
    paletteKey: primary ? 'custom' : 'purple',
    customPalette: primary ? { label: '项目主色', primary } : null,
    theme: normalizeTheme({
      shape: Number.isFinite(radius) ? (radius >= 24 ? 'full' : radius <= 6 ? 'square' : 'rounded') : 'rounded',
      font: /serif/i.test(family) ? 'robotoSerif' : 'roboto',
    }),
  });
}

/** 复制 M3 屏幕时重建组/Item id，避免与原屏冲突 */
function reidM3(doc) {
  const gs = new Set();
  const its = new Set();
  const newId = (prefix, used) => {
    let id = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    while (used.has(id)) id = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    used.add(id);
    return id;
  };
  for (const g of doc.groups || []) {
    g.id = newId('grp', gs);
    for (const it of g.items || []) it.id = newId('itm', its);
  }
  doc.frame.id = doc.frame.id;
  return doc;
}

/* ---------------- M3 文档的选区 / patch 桥接 ---------------- */

/** M3 允许外部改写的字段：与渲染器真正读的属性同名，其余字段一律忽略 */
const M3_EDITABLE_FIELDS = new Set([
  'label', 'supporting', 'text', 'value', 'placeholder', 'code',
  'items', 'tabs', 'style', 'attrs',
  'fill', 'textColor', 'icon', 'iconFill', 'image', 'imagePos', 'layout',
  'contentAlign', 'textAlign', 'elevation', 'radiusTop', 'radiusBottom', 'corners',
  'variant', 'selected', 'gap', 'hidden',
]);

/**
 * M3 ScreenDoc 没有 `root`：groups[].items[] 才是可编辑单元。
 * 把每个 Item 映射成一条扁平记录，选区校验 / patch / 改文案都基于 item.id 定位
 * （与画布回传的 data-item-id 完全一致，不再做第二次 id 变换）。
 */
function flattenM3Items(doc) {
  const out = [];
  for (const group of doc?.groups ?? []) {
    if (!Array.isArray(group.items)) continue;
    for (const item of group.items) {
      if (!item || typeof item !== 'object' || !item.id) continue;
      out.push({ group, item, nodeId: item.id });
    }
  }
  return out;
}

/** 可选区集合：旧文档取节点树 id，M3 取 Item id + slot 锚点（`id::slot`） */
function selectableIdsOf(doc) {
  if (!doc) return new Set();
  if (doc.format === 'm3') {
    const set = new Set();
    for (const g of doc.groups ?? []) for (const it of g.items ?? []) if (it?.id) set.add(it.id);
    for (const a of estimateAnchors(doc)) set.add(a.hotspot_id);
    return set;
  }
  const known = new Set();
  walk(doc.root, (n) => known.add(n.id));
  return known;
}

/** 该 Item 是否落在选区内（点中槽位的热区 `id::slot` 也算选中它） */
function m3InSelection(itemId, nodeIds) {
  if (!itemId) return false;
  return nodeIds.some((id) => id === itemId || (typeof id === 'string' && id.startsWith(`${itemId}::`)));
}

/** Item 的主要文案：改文案时用作原文比对 */
function m3ItemText(item) {
  for (const k of ['label', 'text', 'value', 'placeholder']) {
    if (typeof item?.[k] === 'string' && item[k]) return item[k];
  }
  if (Array.isArray(item?.items)) {
    return item.items.map((x) => (typeof x === 'string' ? x : x?.text ?? x?.label ?? '')).filter(Boolean).join(' ');
  }
  if (Array.isArray(item?.tabs)) {
    return item.tabs.map((x) => (typeof x === 'string' ? x : x?.text ?? x?.label ?? '')).filter(Boolean).join(' ');
  }
  return '';
}

/** 把 node_id 形状的 patch 翻成 layer/item 定位的 M3 op，翻译不了的直接返回 null */
function translateM3Ops(doc, ops) {
  const nodes = flattenM3Items(doc);
  const byId = new Map();
  for (const n of nodes) byId.set(n.item.id, n);
  // anchor 也指向组件：`item_id` 或 `item_id::slot` 都解析到同一个 Item
  const byAnchor = (a) => {
    const raw = String(a ?? '');
    const base = raw.includes('::') ? raw.slice(0, raw.indexOf('::')) : raw;
    return byId.get(base) ?? null;
  };
  const out = [];
  for (const op of ops ?? []) {
    const t = op?.target ?? {};
    const sel = t.selector;
    const nid = typeof t.node_id === 'string' ? t.node_id : sel?.type === 'node_id' ? sel.value : null;
    let hit = nid ? byId.get(nid) : null;
    if (!hit && sel?.type === 'anchor') hit = byAnchor(sel.value);
    if (!hit && typeof sel === 'string') hit = byAnchor(sel.replace(/^\[data-anchor=["']?|["']?\]$/g, ''));
    if (!hit) return null;
    const at = { layer: 'item', group_id: hit.group.id, item_id: hit.item.id };
    if (op.op === 'updateProps' || op.op === 'setStyle') {
      const v = { ...(op.value ?? {}) };
      const patch = {};
      for (const [k, val] of Object.entries(v)) if (k !== 'remove_attrs') patch[k] = val;
      out.push({ op: 'updateItem', target: at, value: patch });
    } else if (op.op === 'removeNode') {
      out.push({ op: 'removeItem', target: at, value: {} });
    } else {
      return null; // replaceNode / insert* 需要节点树，M3 屏不支持
    }
  }
  return out;
}
/** 在 M3 文档上应用 op：先在克隆上全量应用，任一失败则原 doc 不变 */
function applyM3Ops(doc, ops) {
  if (!ops?.length) {
    const err = new Error('patch 未产生任何变更');
    err.code = 'INVALID_OUTPUT';
    throw err;
  }
  const working = structuredClone(doc);
  const applied = [];
  const diff = [];
  for (const [i, op] of ops.entries()) {
    const t = op?.target ?? {};
    const group = (working.groups ?? []).find((g) => g.id === t.group_id);
    const item = group?.items?.find((it) => it.id === t.item_id);
    if (!group || !item) {
      const err = new Error(`op[${i}] 目标未命中：${JSON.stringify(op.target)}（屏幕内容未改变）`);
      err.code = 'INVALID_OUTPUT';
      throw err;
    }
    if (op.op === 'updateItem') {
      for (const [k, val] of Object.entries(op.value ?? {})) {
        if (!M3_EDITABLE_FIELDS.has(k)) continue;
        if (val && typeof val === 'object' && !Array.isArray(val) && (k === 'style' || k === 'attrs' || k === 'corners')) {
          item[k] = { ...(item[k] || {}), ...val };
        } else if (val === null || val === undefined) {
          delete item[k];
        } else {
          item[k] = val;
        }
      }
      // M3 渲染器的可见文案统一读 label（text 类也一样）：只写 text/value 会"改了但看不见"
      if (typeof (op.value ?? {}).text === 'string' && !('label' in (op.value ?? {}))) {
        item.label = op.value.text;
      }
    } else if (op.op === 'removeItem') {
      group.items = group.items.filter((x) => x.id !== item.id);
      if (!group.items.length) working.groups = working.groups.filter((g) => g.id !== group.id);
    } else {
      const err = new Error(`op[${i}] M3 屏不支持 ${op.op}`);
      err.code = 'INVALID_OUTPUT';
      throw err;
    }
    applied.push({ index: i, op: op.op, node_id: item.id, kind: op.op });
    diff.push({ op: op.op, node_id: item.id, group_id: group.id });
  }
  return { doc: working, applied, diff };
}

/**
 * 统一入口：按文档格式选路。
 * 旧 node-tree 走既有 applyPatch；M3 走 op 翻译 + applyM3Ops。两边返回同一契约 `{doc, applied, diff}`。
 */
export function applyDocPatch(doc, ops, { screenId } = {}) {
  if (doc?.format !== 'm3') return applyPatch(doc, { ops, target_screen_id: screenId }, { screenId });
  const translated = translateM3Ops(doc, ops);
  if (!translated) {
    const err = new Error('M3 屏幕目前只支持按 node_id / item_id 定位的文案与样式变更，本次 patch 无法落位');
    err.code = 'INVALID_OUTPUT';
    err.errors = [err.message];
    throw err;
  }
  return applyM3Ops(doc, translated);
}

/**
 * 生成用的同形节点视图：M3 Item → 伪 node-tree 节点。
 * 内置生成器与上下文都按 node-tree 写，转换放在边界上，两边都不需要各写一套 M3 逻辑。
 */
function docAsNodes(doc) {
  if (!doc) return { version: 1, root: null };
  if (doc.format !== 'm3') return doc;
  const root = { id: '__screen__', tag: 'section', props: { attrs: { 'data-screen': doc.frame?.id ?? '' } }, children: [] };
  // 整屏范围时返回根；区域/组件范围由 local.buildPatch 以 Item 自身为作用域根

  for (const group of doc.groups ?? []) {
    const container = {
      id: group.id,
      tag: 'div',
      props: { attrs: { 'data-group': group.id, ...(group.hidden ? { 'data-hidden': '1' } : {}) } },
      children: [],
    };
    for (const item of group.items ?? []) {
      if (!item?.id) continue;
      container.children.push({
        id: item.id,
        tag: item.kind === 'button' ? 'button' : 'div',
        props: { attrs: { 'data-item-id': item.id, 'data-kind': item.kind }, text: m3ItemText(item), style: {} },
        children: [],
      });
    }
    if (container.children.length) root.children.push(container);
  }
  return { version: 1, root };
}

/**
 * 节点视图上的文案 → 原始 Item 的字段。
 * M3 里可见文案几乎都在 label（text 类也读 label），text 字段只在个别部件上生效，
 * 所以这里优先写 label，不能因为 Item 上恰好有 text 字段就写进一个渲染器不读的位置。
 */
function m3TextFieldOf(item) {
  if (!item) return 'label';
  if (typeof item.label === 'string') return 'label';
  if (Array.isArray(item.items)) return 'items';
  if (Array.isArray(item.tabs)) return 'tabs';
  if (typeof item.text === 'string') return 'text';
  if (typeof item.value === 'string') return 'value';
  return 'label';
}

/** 把节点视图上的 updateProps({text}) 翻回 M3 op（直接改文案走这里） */
function translateNodeTextOps(doc, ops) {
  const nodes = flattenM3Items(doc);
  const out = [];
  for (const op of ops ?? []) {
    const hit = nodes.find((n) => n.item.id === op?.target?.node_id);
    if (!hit) return null;
    const value = op.value ?? {};
    const next = {};
    if (value.text !== undefined) {
      const field = m3TextFieldOf(hit.item);
      if (field === 'items' || field === 'tabs') {
        const list = (hit.item[field] ?? []).map((x) => ({ ...(typeof x === 'string' ? { text: x } : x) }));
        let at = Number.isInteger(value.index) ? value.index : list.findIndex((x) => x.text === m3ItemText(hit.item));
        if (at < 0) at = 0;
        if (list[at]) list[at] = { ...list[at], text: value.text };
        else list.push({ text: value.text });
        next[field] = list;
      } else {
        next[field] = value.text;
        // M3 渲染器只读 label：落到别的字段等于改了但看不见，必须同时写 label
        if (field !== 'label') next.label = value.text;
      }
    }
    if (value.style) next.style = value.style;
    if (value.attrs) next.attrs = value.attrs;
    if (!Object.keys(next).length) return null;
    out.push({ op: 'updateItem', target: { layer: 'item', group_id: hit.group.id, item_id: hit.item.id }, value: next });
  }
  return out;
}

/** 选区归一化：去重、只保留字符串 id，避免把前端对象原样写进 job 审计 */
function normalizeSelection(selection) {
  if (!selection || !Array.isArray(selection.node_ids)) return null;
  const node_ids = [...new Set(selection.node_ids.filter((x) => typeof x === 'string' && x))];
  if (!node_ids.length) return null;
  return { ...selection, node_ids };
}

/** 浅层深合并：设计 token 支持只提交要改的分组，不覆盖未提交的其它分组 */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function pickPosition(screens, x, y) {
  if (x != null && y != null) return { x, y };
  if (!screens.length) return { x: 120, y: 120 };
  const last = screens[screens.length - 1];
  const cols = 5;
  if (screens.length % cols === 0) {
    return { x: 120, y: Math.max(...screens.map((s) => s.y + s.height)) + 120 };
  }
  return { x: last.x + last.width + 90, y: last.y };
}

function defaultTokens() {
  return {
    colors: { primary: '#2563eb', text: '#111827', sub: '#6b7280', bg: '#f7f8fa', card: '#ffffff', border: '#e5e7eb' },
    radius: { sm: 6, md: 10, lg: 14 },
    spacing: { xs: 4, sm: 8, md: 16, lg: 24 },
    font: { family: 'system-ui, -apple-system, "PingFang SC", sans-serif', base: 14 },
  };
}

/**
 * 扫描 AI 输出里是否出现非目标屏幕的写入指令（AI-007 / NFR-002）
 * 白名单语义：除 target 之外，任何形似 screen_id 的值都视为越权，不依赖"项目里已存在哪些屏"。
 */
const SID_RE = /^(scr|screen)[_-][\w-]{4,}$/i;
/** 派生 id（如 <screenId>_root、<screenId>_v2）属于本屏，不算跨屏 */
const isDerivedOf = (id, target) => id.startsWith(`${target}_`) || id.startsWith(`${target}-`);

export function detectCrossScreenOutput(output, targetSid) {
  const v = [];
  const check = (val, where) => {
    if (typeof val !== 'string' || !val || val === targetSid) return;
    if (SID_RE.test(val) && !isDerivedOf(val, targetSid)) v.push({ where, screen_id: val });
  };
  // 1) 明确出现在 screen_id 字段里的值
  const scan = (obj, base, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    for (const [k, val] of Object.entries(obj)) {
      const where = base ? `${base}.${k}` : k;
      if (k === 'screen_id' || k === 'target_screen_id' || k === 'source_screen_id' || k === 'screenId') check(val, where);
      else scan(val, where, depth + 1);
    }
  };
  scan(output, '', 0);

  // 2) 兜底：输出中任何位置出现形似 screen_id 的字符串，但不是本屏
  const raw = JSON.stringify(output);
  const hits = new Set(raw.match(/["']?(?:scr|screen)[_-][\w-]{4,}["']?/gi) || []);
  for (const h of hits) {
    const id = h.replace(/["']/g, '');
    if (id !== targetSid && !isDerivedOf(id, targetSid)) v.push({ where: 'anywhere', screen_id: id });
  }
  // 去重
  const seen = new Set();
  return v.filter((x) => {
    const key = `${x.where}|${x.screen_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(output, candidate) {
  return {
    mode: output.mode,
    op_count: output.ops?.length ?? null,
    node_count: nodeCountOf(candidate.doc),
    changed: candidate.diff?.length ?? 0,
  };
}

/** 路由未命中原因 → 可读说明（出现在 422 detail.note，便于用户对照调整说法） */
const ROUTE_REASON_NOTE = {
  detect_creative_intent: '检测到创作 / 语义类意图（优化、更有、风格等），需大模型处理',
  negation_in_value: '新值里带有否定语义，无法唯一确定，需大模型处理',
  no_rule_matched: '没有可唯一确定变更值的规则匹配',
  rule_matched_without_value: '命中了规则但取不到明确的新值',
  not_explicit: '缺少可唯一确定的变更值',
  no_selection: '区域 / 组件范围未选择任何区块',
  target_outside_selection: '指定节点不在当前选区内',
  empty_screen_needs_full: '空屏需要整屏生成',
  explicit_full: '请求包含整屏重生成指令',
  generator_disabled: '内置生成器已关闭',
  router_disabled: '确定性路由已关闭',
  scope_explicit_only: '当前为「仅显式」模式，需要带 node_id / anchor',
  no_rule_enabled: '没有启用任何规则',
  generator_unavailable: '内置生成器不可用',
  model_not_builtin: '当前模型不是内置生成器',
};

function outputNoteForReason(reason) {
  return ROUTE_REASON_NOTE[reason] || null;
}

/** 内置生成器版本的可读摘要（FR-SOURCE-003）：版本树不展示裸哈希，用户一眼看懂改了什么 */
function buildSummary(routeDecision, output) {
  if (!routeDecision) return null;
  const prefix = routeDecision.layer === 'explicit' ? '结构化指令' : '本地规则';
  const ruleName = RULE_LABELS[routeDecision.rule_id] || routeDecision.rule_id || '';
  const detail = routeDecision.summary ? `：${routeDecision.summary}` : '';
  const ops = Array.isArray(output?.ops) ? output.ops : [];
  return `${prefix}·${ruleName}${detail}${ops.length > 1 ? `（共 ${ops.length} 处）` : ''}`;
}

/**
 * 人工编辑摘要（FR-SPACE-007）：文本变更给出「旧文案 → 新文案」，其余按 op 归类。
 * 不展示完整节点树，也不写入 prompt 正文以外的敏感内容。
 */
function summarizeOps(ops = [], beforeDoc = null, afterDoc = null) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return '手工编辑';

  const clip = (s) => {
    const text = String(s ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  };
  if (beforeDoc?.root && afterDoc?.root) {
    const changes = [];
    for (const op of list) {
      if (op.op !== 'updateProps' || op.value?.text === undefined || !op.target?.node_id) continue;
      const before = findNode(beforeDoc.root, op.target.node_id);
      const after = findNode(afterDoc.root, op.target.node_id);
      if (!before || !after) continue;
      const from = String(before.props?.text ?? '');
      const to = String(after.props?.text ?? '');
      if (from !== to) changes.push({ from, to });
    }
    if (changes.length === 1) return `手工修改文案：「${clip(changes[0].from)}」→「${clip(changes[0].to)}」`;
    if (changes.length > 1) return `手工修改 ${changes.length} 处文案`;
  }

  const names = { updateProps: '修改属性', setStyle: '修改样式', insertChild: '新增节点', insertAfter: '新增节点', removeNode: '删除节点', replaceNode: '替换节点' };
  const counts = new Map();
  for (const op of list) counts.set(op.op, (counts.get(op.op) || 0) + 1);
  const parts = [...counts.entries()].map(([op, n]) => `${names[op] || op}${n > 1 ? `×${n}` : ''}`);
  return `手工修改：${parts.join('、')}`;
}

const RULE_LABELS = {
  text_replace: '文案替换',
  button_label: '按钮文案',
  tone_adjust: '措辞微调',
  font_scale: '字号调整',
  align_center: '居中',
  radius: '圆角',
  color: '颜色',
  bold: '加粗',
  add_element: '新增元素',
  remove_element: '删除元素',
};

/**
 * 热区集合：兼容 M3 ScreenDoc 与旧 node-tree。
 * M3 屏没有 `root`，直接走旧函数会抛错（新建屏默认 M3 后这条路径就暴露了）。
 */
function anchorsOfDoc(doc) {
  if (!doc) return [];
  // M3 走 estimateAnchors（带 slot/坐标）；旧文档的 data-anchor 也补成同一结构，
  // 上游按 `{hotspot_id, item_id, slot, text}` 消费，两种格式必须同形。
  if (doc.format === 'm3') {
    // M3 的 estimateAnchors 只给几何信息；补 text，保证调用方（建边按文案匹配）两种格式同形
    const labels = new Map();
    for (const g of doc.groups ?? []) {
      for (const i of g.items ?? []) labels.set(i.id, [i.label, i.supporting].filter(Boolean).join(' '));
    }
    return estimateAnchors(doc).map((a) => ({ ...a, text: labels.get(a.item_id) ?? '' }));
  }
  return collectAnchors(doc).map((a) => ({
    hotspot_id: a.hotspot_id,
    item_id: a.hotspot_id,
    slot: null,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    node_id: a.node_id,
    text: a.text ?? '',
  }));
}

/** 节点数：M3 屏按 Item 计，旧文档按节点树计 */
function nodeCountOf(doc) {
  if (!doc) return 0;
  if (doc.format === 'm3') return (doc.groups ?? []).reduce((n, g) => n + (g.items ?? []).length, 0);
  return doc.root ? countAll(doc.root) : 0;
}

function countAll(n) {
  let c = 1;
  for (const ch of Array.isArray(n.children) ? n.children : []) c += countAll(ch);
  return c;
}

/**
 * 整屏保存时被删除、但仍被 confirmed 边引用的热区（AI-006 同口径）。
 * 返回 `item_id` 列表；空数组表示没有热区丢失。
 */
function lostHotspots(beforeDoc, afterDoc) {
  if (!beforeDoc || beforeDoc.format !== 'm3' || !Array.isArray(beforeDoc.groups)) return [];
  if (!afterDoc || !Array.isArray(afterDoc.groups)) return [];
  const kept = new Set();
  for (const g of afterDoc.groups ?? []) for (const i of g.items ?? []) kept.add(i.id);
  const lost = [];
  for (const g of beforeDoc.groups) {
    for (const i of g.items ?? []) {
      if (!kept.has(i.id) && i.kind && !i.hidden) lost.push(i.id);
    }
  }
  return lost;
}

/** 编辑器保存的语义摘要：新增/删除/修改的 Item 与 Group 计数 */
function summarizeDocChange(beforeDoc, afterDoc) {
  if (!beforeDoc || beforeDoc.format !== 'm3') return `搭建屏幕（${countItems(afterDoc)} 个部件）`;
  const beforeItems = itemMap(beforeDoc);
  const afterItems = itemMap(afterDoc);
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const [id, item] of afterItems) {
    if (!beforeItems.has(id)) added++;
    else if (JSON.stringify(beforeItems.get(id)) !== JSON.stringify(item)) modified++;
  }
  for (const id of beforeItems.keys()) if (!afterItems.has(id)) removed++;
  const parts = [];
  if (added) parts.push(`新增 ${added} 个部件`);
  if (removed) parts.push(`删除 ${removed} 个部件`);
  if (modified) parts.push(`调整 ${modified} 个部件`);
  if (!parts.length) {
    const beforeGroups = JSON.stringify((beforeDoc.groups ?? []).map((g) => [g.id, g.x, g.y, g.axis]));
    const afterGroups = JSON.stringify((afterDoc.groups ?? []).map((g) => [g.id, g.x, g.y, g.axis]));
    parts.push(beforeGroups === afterGroups ? '保存屏幕（无内容变化）' : '调整布局');
  }
  return `编辑屏幕：${parts.join('、')}`;
}

function itemMap(doc) {
  const m = new Map();
  for (const g of doc?.groups ?? []) for (const i of g.items ?? []) m.set(i.id, i);
  return m;
}

function countItems(doc) {
  let n = 0;
  for (const g of doc?.groups ?? []) n += (g.items ?? []).length;
  return n;
}

function reid(root) {
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n.id)) n.id = `${n.id}_${randomUUID().slice(0, 4)}`;
    seen.add(n.id);
    (Array.isArray(n.children) ? n.children : []).forEach(visit);
  };
  visit(root);
}

function parseEdgeIntent(text, screens) {
  const found = [];
  for (const s of screens) {
    const idx = text.indexOf(s.title);
    if (idx >= 0) found.push({ ...s, idx });
    else if (s.remark && text.includes(s.remark)) found.push({ ...s, idx: text.indexOf(s.remark) });
  }
  found.sort((a, b) => a.idx - b.idx);
  if (found.length < 2) return null;
  const [src, tgt] = found;
  const between = text.slice(src.idx + src.title.length, tgt.idx);
  const kw = /点击?\s*[「"']?([^「」"'、，,\s]{1,8})[」"']?/.exec(between);
  return {
    source_screen_id: src.screen_id,
    source_title: src.title,
    target_screen_id: tgt.screen_id,
    target_title: tgt.title,
    hotspot_keyword: kw ? kw[1] : null,
    confidence: 0.86,
  };
}
