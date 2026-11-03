import { randomUUID } from 'node:crypto';
import { EDIT_SCOPES, DEFAULT_NODE } from './constants.js';
import { badRequest, notFound, conflict, locked, forbiddenTarget, invalidOutput, unprocessable, noPermission } from './errors.js';
import { emptyDoc, validateDoc, fingerprint, walk, collectAnchors, textOf } from './domain/doc.js';
import { applyPatch, validatePatch } from './domain/patch.js';
import { buildGenerationContext, assertContextIsolation } from './ai/context.js';
import { routeIntent, routeLog } from './ai/router.js';
import * as providerMod from './ai/provider.js';

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

  async createProject({ name, device, design_tokens, actor = 'local-user' }) {
    if (!name || !String(name).trim()) throw badRequest('项目名称必填');
    const project_id = rid('prj');
    const project = {
      project_id,
      name: String(name).trim(),
      device: device || { width: DEFAULT_NODE.width, height: DEFAULT_NODE.height },
      design_tokens: deepMerge(defaultTokens(), design_tokens || {}),
      role: 'owner',
      members: [{ user: actor, role: 'owner' }],
      screen_titles: [],
      created_at: now(),
      updated_at: now(),
    };
    await this.repo.createProject(project);
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

  async updateDesignTokens(pid, tokens, who = '') {
    if (!tokens || typeof tokens !== 'object') throw badRequest('design_tokens 必填');

    // FR-PROJ-004：只读成员不可写
    await this.assertWriter(pid, who);

    const next = await this.repo.updateProject(pid, (proj) => ({
      ...proj,
      design_tokens: deepMerge(proj.design_tokens || {}, tokens),
    }));
    await this.audit(pid, { actor: who, action: 'design_tokens.update', object_id: pid, result: 'ok' });
    return next;
  }

  // ---------------- screens ----------------

  async createScreen(pid, { title, remark = '', x, y, after_screen_id = null, actor = 'local-user' }) {
    const project = await this.assertWriter(pid, actor);
    if (!title || !String(title).trim()) throw badRequest('屏幕名称必填');
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
      x: pos.x,
      y: pos.y,
      width: project.device.width,
      height: project.device.height,
      created_at: now(),
      updated_at: now(),
    };
    await this.repo.createScreen(pid, meta);
    // 空屏也建立 v0 快照：保证任何屏幕随时有可回滚基线（C-008 的下界）
    await this.repo.commitVersion(pid, screen_id, { version: 1, root: emptyDoc().root }, { kind: 'import', label: '空屏基线', who: actor });
    const created = await this.repo.getScreen(pid, screen_id);
    await this.syncTitles(pid);
    await this.audit(pid, { actor, action: 'screen.create', object_id: screen_id, result: 'ok' });
    return created;
  }

  async listScreens(pid) {
    await this.getProject(pid);
    const screens = await this.repo.listScreens(pid);
    // 画布需要渲染每屏内容，因此列表接口返回当前版本的 doc（画布是唯一消费者）
    return Promise.all(
      screens.map(async (s) => {
        const cur = s.current_version ? await this.repo.getCurrentVersion(pid, s.screen_id) : null;
        return {
          ...s,
          doc: cur?.doc || null,
          anchors: cur ? collectAnchors(cur.doc) : [],
        };
      })
    );
  }

  async getScreen(pid, sid) {
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    const cur = await this.repo.getCurrentVersion(pid, sid);
    return { ...meta, doc: cur?.doc || null, anchors: cur ? collectAnchors(cur.doc) : [] };
  }

  async patchCanvas(pid, { screen_id, x, y, width, height, actor = 'local-user' }) {
    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, screen_id);
    if (!meta) throw notFound(`屏幕不存在: ${screen_id}`);
    const next = await this.repo.updateScreenMeta(pid, screen_id, (m) => ({
      ...m,
      x: x ?? m.x,
      y: y ?? m.y,
      width: width ?? m.width,
      height: height ?? m.height,
    }));
    return next;
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
      x: src.x + src.width + 40,
      y: src.y,
      actor,
    });
    if (src.doc) {
      const cloned = structuredClone(src.doc);
      reid(cloned.root);
      await this.repo.commitVersion(pid, created.screen_id, cloned, { kind: 'copy', label: `复制自 ${src.title}`, who: actor });
    }
    return this.repo.getScreen(pid, created.screen_id);
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

    // 选区必须是当前屏里真实存在的节点，否则"只改选区"会静默退化成什么都没改。
    const normalizedSelection = normalizeSelection(selection);
    if (edit_scope !== 'screen') {
      const known = new Set();
      walk(doc.root, (n) => known.add(n.id));
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
    });

    // BR-003：修改类任务优先输出 patch。
    // 判据是「屏幕是否已有实质内容」，而不是 scope —— scope=screen 只是允许整屏重写，
    // 不代表每次都要整屏重写。只有空屏或用户显式要求整屏重生成时才走 full。
    const hasContent = (cur?.doc && collectAnchors(cur.doc).length > 0) || (cur?.doc && countAll(cur.doc.root) > 6);
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
          currentDoc: doc,
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
          currentDoc: doc,
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
          const before = collectAnchors(doc).map((a) => a.hotspot_id);
          const after = new Set(collectAnchors(output.doc).map((a) => a.hotspot_id));
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
      const errs = validateDoc(output.doc);
      if (errs.length) {
        await settle({ status: 'rejected', error: errs.join('; ') });
        throw badRequest(`AI 输出文档不合法: ${errs.join('; ')}`, { code: 'INVALID_OUTPUT' });
      }
      candidate = { doc: output.doc, applied: [], diff: [{ op: 'full-regenerate', node_id: output.doc.root.id }] };
    } else {
      try {
        candidate = applyPatch(doc, { ...output, target_screen_id: sid }, { screenId: sid });
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
    });
    await this.repo.updateScreenMeta(pid, sid, (m) => ({ ...m, pending: null, status: 'applied' }));
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

  /** 手动编辑（用户直接改节点属性）—— 也走版本，不允许绕过历史 */
  async manualPatch(pid, sid, { ops, edit_scope = 'screen', actor = 'local-user' }) {    await this.assertWriter(pid, actor);
    const meta = await this.repo.getScreen(pid, sid);
    if (!meta) throw notFound(`屏幕不存在: ${sid}`);
    if (meta.locked) throw locked('屏幕已锁定，禁止内容编辑');
    const cur = await this.repo.getCurrentVersion(pid, sid);
    const errs = validatePatch({ ops }, { screenId: sid });
    if (errs.length) throw invalidOutput(errs.join('; '), { errors: errs });
    let patched;
    try {
      patched = applyPatch(cur.doc, { ops, target_screen_id: sid }, { screenId: sid });
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
      change_summary: summarizeOps(ops),
    });
    await this.audit(pid, { actor, action: 'screen.manual_patch', object_id: sid, result: 'ok', detail: { version: record.version } });
    return { version: record.version, doc };
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
    const flatten = (doc) => {
      const map = new Map();
      walk(doc.root, (n) => map.set(n.id, n));
      return map;
    };
    const ma = flatten(A.doc);
    const mb = flatten(B.doc);
    const added = [];
    const removed = [];
    const changed = [];
    const details = { added: [], removed: [], changed: [] };
    const brief = (n) => ({
      node_id: n.id,
      tag: n.tag,
      text: String(textOf(n) || '').slice(0, 120),
      style: n.props?.style || {},
      attrs: n.props?.attrs || {},
    });
    for (const [id, n] of mb) {
      if (!ma.has(id)) {
        added.push(id);
        details.added.push(brief(n));
      } else {
        const before = ma.get(id);
        const same =
          before.tag === n.tag &&
          JSON.stringify(before.props || {}) === JSON.stringify(n.props || {});
        if (!same) {
          changed.push(id);
          details.changed.push({ node_id: id, tag: n.tag, before: brief(before), after: brief(n) });
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
        anchorCache.set(sid, cur ? collectAnchors(cur.doc).map((a) => a.hotspot_id) : []);
      }
      return anchorCache.get(sid);
    };

    const edges = [];
    for (const e of flow.edges) {
      const srcExists = byId.has(e.source_screen_id);
      const tgtExists = byId.has(e.target_screen_id);
      const anchors = srcExists ? await anchorsOf(e.source_screen_id) : [];
      const anchorOk = anchors.includes(e.source_hotspot_id);
      edges.push({
        ...e,
        status: e.status || 'confirmed',
        orphan: {
          source_missing: !srcExists,
          target_missing: !tgtExists,
          hotspot_missing: srcExists && !anchorOk,
        },
      });
    }
    return { schema_version: 1, edges };
  }

  /** 建边：绝不触碰 screen 目录（C-004 / DC-004） */
  async createEdge(pid, body, { actor = 'local-user', status = 'confirmed' } = {}) {
    await this.assertWriter(pid, actor);
    const { source_screen_id, source_hotspot_id, target_screen_id, trigger = 'click', animation = 'none', note = '' } = body || {};
    if (!source_screen_id || !source_hotspot_id || !target_screen_id) {
      throw badRequest('source_screen_id / source_hotspot_id / target_screen_id 均必填');
    }
    if (!['click', 'auto'].includes(trigger)) throw badRequest(`不支持的 trigger: ${trigger}`);
    const src = await this.repo.getScreen(pid, source_screen_id);
    const tgt = await this.repo.getScreen(pid, target_screen_id);
    if (!src) throw notFound(`源屏幕不存在: ${source_screen_id}`);
    if (!tgt) throw notFound(`目标屏幕不存在: ${target_screen_id}`);
    const cur = await this.repo.getCurrentVersion(pid, source_screen_id);
    const anchors = cur ? collectAnchors(cur.doc).map((a) => a.hotspot_id) : [];
    if (!anchors.includes(source_hotspot_id)) {
      throw badRequest(`热区 ${source_hotspot_id} 不存在于源屏幕（可用：${anchors.join(', ') || '无'}）`, { code: 'HOTSPOT_NOT_FOUND' });
    }
    const flow = await this.repo.getFlow(pid);
    // 同一热区覆盖式建边：一个热区只应有一条出边（避免预览歧义）
    const dup = flow.edges.find(
      (e) => e.source_screen_id === source_screen_id && e.source_hotspot_id === source_hotspot_id && e.status !== 'deleted'
    );
    if (dup) {
      dup.target_screen_id = target_screen_id;
      dup.trigger = trigger;
      dup.animation = animation;
      dup.note = note;
      dup.updated_at = now();
      dup.status = status;
      await this.repo.saveFlow(pid, { ...flow, updated_at: now() });
      await this.audit(pid, { actor, action: 'flow.reassign', object_id: dup.edge_id, result: 'ok', detail: { to: target_screen_id } });
      return dup;
    }
    const edge = {
      edge_id: rid('edge'),
      project_id: pid,
      source_screen_id,
      source_hotspot_id,
      target_screen_id,
      trigger,
      animation,
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

  async updateEdge(pid, edgeId, body, { actor = 'local-user' } = {}) {
    await this.assertWriter(pid, actor);
    const flow = await this.repo.getFlow(pid);
    const e = flow.edges.find((x) => x.edge_id === edgeId);
    if (!e) throw notFound(`关联边不存在: ${edgeId}`);
    if (body.trigger && !['click', 'auto'].includes(body.trigger)) throw badRequest(`不支持的 trigger: ${body.trigger}`);
    if (body.target_screen_id) {
      const tgt = await this.repo.getScreen(pid, body.target_screen_id);
      if (!tgt) throw notFound(`目标屏幕不存在: ${body.target_screen_id}`);
    }
    Object.assign(e, {
      target_screen_id: body.target_screen_id ?? e.target_screen_id,
      trigger: body.trigger ?? e.trigger,
      animation: body.animation ?? e.animation,
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
      return cur ? collectAnchors(cur.doc) : [];
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

  /** 预览数据：只读拼装，不含后续写权限 */
  async buildPreview(pid, startScreenId) {
    const project = await this.getProject(pid);
    const screens = await this.repo.listScreens(pid);
    if (!screens.length) throw badRequest('项目下还没有屏幕');
    const start = startScreenId || screens[0].screen_id;
    if (!screens.some((s) => s.screen_id === start)) throw notFound(`起始屏幕不存在: ${start}`);
    const payload = { project: { project_id: project.project_id, name: project.name, device: project.device }, start, screens: [], edges: [] };
    for (const s of screens) {
      const cur = await this.repo.getCurrentVersion(pid, s.screen_id);
      payload.screens.push({
        screen_id: s.screen_id,
        title: s.title,
        locked: s.locked,
        version: s.current_version,
        // 版本来源随预览返回，供画布/版本树展示"内置生成器 or 大模型"（FR-SOURCE-001）
        change_source: cur?.change_source || null,
        change_summary: cur?.change_summary || null,
        doc: cur?.doc || null,
      });
    }
    const flow = await this.repo.getFlow(pid);
    payload.edges = flow.edges.map((e) => ({
      edge_id: e.edge_id,
      source_screen_id: e.source_screen_id,
      source_hotspot_id: e.source_hotspot_id,
      target_screen_id: e.target_screen_id,
      trigger: e.trigger,
      animation: e.animation,
      status: e.status || 'confirmed',
    }));
    return payload;
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

function canWrite(project, who) {
  const m = (project.members || []).find((x) => x.user === who);
  return !m || m.role !== 'readonly';
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
    node_count: candidate.doc ? countAll(candidate.doc.root) : 0,
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

/** 人工编辑摘要：按 op 类型给出一句话，不展示完整节点树 */
function summarizeOps(ops = []) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return '手工编辑';
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

function countAll(n) {
  let c = 1;
  for (const ch of Array.isArray(n.children) ? n.children : []) c += countAll(ch);
  return c;
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
