import path from 'node:path';
import { promises as fs } from 'node:fs';
import { KeyedQueue, readJson, writeJsonAtomic, exists } from './fs.js';
import { FLOW_SCHEMA_VERSION } from '../domain/m3/constants.js';

/**
 * 三层物理隔离的仓储（v2）：
 *   data/projects/<pid>/project.json            项目 + ProjectDesign + screen_titles
 *   data/projects/<pid>/design-revisions.json   主题/设计规范修订（不产生屏幕版本）
 *   data/projects/<pid>/canvas.json             画布视口 + 屏幕位置（唯一坐标源）
 *   data/projects/<pid>/ui-state.json           编辑器 UI 状态（面板/收藏）
 *   data/projects/<pid>/measurements.json       文本宽度测量缓存（非权威）
 *   data/projects/<pid>/screens/<sid>/meta.json 状态/锁定/版本索引/pending（不含坐标）
 *   data/projects/<pid>/screens/<sid>/versions/v<n>.json
 *   data/projects/<pid>/flow.json               FlowEdge（只存 screen_id + item_id + slot）
 *   data/projects/<pid>/history.json            GenerationJob + PatchRecord + AuditLog
 *
 * 目录边界即权限边界：AI 服务拿到的仓储实例是 screenWriter(pid, sid)，越界即抛错。
 */
export class Repo {
  constructor(root) {
    this.root = root;
    this.queue = new KeyedQueue();
  }

  projectDir(pid) {
    return path.join(this.root, 'projects', pid);
  }

  screenDir(pid, sid) {
    return path.join(this.projectDir(pid), 'screens', sid);
  }

  projectFile(pid) {
    return path.join(this.projectDir(pid), 'project.json');
  }

  flowFile(pid) {
    return path.join(this.projectDir(pid), 'flow.json');
  }

  canvasFile(pid) {
    return path.join(this.projectDir(pid), 'canvas.json');
  }

  historyFile(pid) {
    return path.join(this.projectDir(pid), 'history.json');
  }

  designRevisionsFile(pid) {
    return path.join(this.projectDir(pid), 'design-revisions.json');
  }

  uiStateFile(pid) {
    return path.join(this.projectDir(pid), 'ui-state.json');
  }

  measurementsFile(pid) {
    return path.join(this.projectDir(pid), 'measurements.json');
  }

  metaFile(pid, sid) {
    return path.join(this.screenDir(pid, sid), 'meta.json');
  }

  versionFile(pid, sid, v) {
    return path.join(this.screenDir(pid, sid), 'versions', `v${v}.json`);
  }

  // ---------- project ----------

  async createProject(project) {
    const pid = project.project_id;
    await fs.mkdir(this.screenDir(pid, '_'), { recursive: true });
    await writeJsonAtomic(this.projectFile(pid), withProjectDefaults(project));
    await writeJsonAtomic(this.flowFile(pid), { schema_version: FLOW_SCHEMA_VERSION, edges: [] });
    await writeJsonAtomic(this.canvasFile(pid), {
      schema_version: 2,
      viewport: { x: 80, y: 80, zoom: 1 },
      screens: {},
    });
    await writeJsonAtomic(this.historyFile(pid), {
      schema_version: 2,
      jobs: [],
      patches: [],
      audits: [],
    });
    await writeJsonAtomic(this.designRevisionsFile(pid), { schema_version: 1, revisions: [] });
    await writeJsonAtomic(this.uiStateFile(pid), emptyUiState());
    await writeJsonAtomic(this.measurementsFile(pid), { schema_version: 1, screens: {} });
    return project;
  }

  async getProject(pid) {
    const p = await readJson(this.projectFile(pid));
    return p ? withProjectDefaults(p) : null;
  }

  async listProjects() {
    const dir = path.join(this.root, 'projects');
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const pid of names) {
      const p = await this.getProject(pid);
      if (p) out.push(p);
    }
    return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  async updateProject(pid, mut) {
    return this.queue.run(`project:${pid}`, async () => {
      const p = await this.getProject(pid);
      if (!p) return null;
      const next = mut(structuredClone(p));
      next.updated_at = new Date().toISOString();
      next.schema_version = 2;
      await writeJsonAtomic(this.projectFile(pid), next);
      return next;
    });
  }

  // ---------- design revisions ----------

  async listDesignRevisions(pid) {
    return (await readJson(this.designRevisionsFile(pid), { schema_version: 1, revisions: [] })) || { schema_version: 1, revisions: [] };
  }

  async appendDesignRevision(pid, revision) {
    return this.queue.run(`design:${pid}`, async () => {
      const file = await this.listDesignRevisions(pid);
      file.revisions.push(revision);
      const max = 200;
      if (file.revisions.length > max) file.revisions.splice(0, file.revisions.length - max);
      await writeJsonAtomic(this.designRevisionsFile(pid), file);
      return revision;
    });
  }

  // ---------- ui state / measurements ----------

  async getUiState(pid) {
    return (await readJson(this.uiStateFile(pid), null)) || emptyUiState();
  }

  async saveUiState(pid, state) {
    return this.queue.run(`ui:${pid}`, async () => {
      const next = { ...emptyUiState(), ...(state || {}), updated_at: new Date().toISOString() };
      await writeJsonAtomic(this.uiStateFile(pid), next);
      return next;
    });
  }

  async getMeasurements(pid) {
    return (await readJson(this.measurementsFile(pid), null)) || { schema_version: 1, screens: {} };
  }

  async saveMeasurements(pid, sid, items, measuredAt) {
    return this.queue.run(`measure:${pid}`, async () => {
      const file = await this.getMeasurements(pid);
      file.screens = file.screens || {};
      file.screens[sid] = { screen_id: sid, items: items || {}, measured_at: measuredAt || new Date().toISOString() };
      await writeJsonAtomic(this.measurementsFile(pid), file);
      return file.screens[sid];
    });
  }

  // ---------- screens ----------

  /** 裸读 meta（不含 canvas 投影），写路径必须用它，避免把坐标写回 meta（DC-018） */
  async #readMeta(pid, sid) {
    return readJson(this.metaFile(pid, sid));
  }

  async listScreens(pid) {
    const dir = path.join(this.projectDir(pid), 'screens');
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const canvas = await this.getCanvas(pid);
    const out = [];
    for (const sid of names) {
      const meta = await this.#readMeta(pid, sid);
      if (meta) out.push(withPosition(meta, canvas.screens?.[sid]));
    }
    return out.sort((a, b) => String(a.order).localeCompare(String(b.order)));
  }

  async getScreen(pid, sid) {
    const meta = await this.#readMeta(pid, sid);
    if (!meta) return null;
    const canvas = await this.getCanvas(pid);
    return withPosition(meta, canvas.screens?.[sid]);
  }

  async createScreen(pid, screen) {
    return this.queue.run(`screen:${lockKey(pid, screen.screen_id)}`, async () => {
      await fs.mkdir(path.join(this.screenDir(pid, screen.screen_id), 'versions'), { recursive: true });
      // 坐标只写 canvas.json；meta 保留兼容字段但不作为权威
      const { x, y, width, height, ...meta } = screen;
      await writeJsonAtomic(this.metaFile(pid, screen.screen_id), {
        ...meta,
        format: meta.format || 'node-tree',
      });
      if (Number.isFinite(x) || Number.isFinite(y) || Number.isFinite(width) || Number.isFinite(height)) {
        await this.#setPositionLocked(pid, screen.screen_id, {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          width: Number.isFinite(width) ? width : undefined,
          height: Number.isFinite(height) ? height : undefined,
        });
      }
      return withPosition(
        { ...meta, format: meta.format || 'node-tree' },
        { x, y, width, height }
      );
    });
  }

  async getVersion(pid, sid, v) {
    return readJson(this.versionFile(pid, sid, v));
  }

  async getCurrentVersion(pid, sid) {
    const meta = await this.#readMeta(pid, sid);
    if (!meta || !meta.current_version) return null;
    return this.getVersion(pid, sid, meta.current_version);
  }

  async listVersions(pid, sid) {
    const meta = await this.#readMeta(pid, sid);
    return meta ? (meta.versions || []).slice().reverse() : [];
  }

  /**
   * 提交新版本：写版本文件 → 更新 meta。
   * 只有这一条路径能递增版本号，确保 DC-007 / C-008 不被绕过。
   * writeSrc 是来源标签，例如 {kind:'generate'|'patch'|'rollback'|'manual', prompt, job_id}
   */
  async commitVersion(pid, sid, doc, source) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      const meta = await this.#readMeta(pid, sid);
      if (!meta) throw new Error(`screen not found: ${sid}`);
      const v = meta.current_version + 1;
      const project = await this.getProject(pid);
      // FR-VER-012 / NFR-017：版本只保存 Prompt 摘要，不保存完整正文。
      // source 里可能带 prompt（生成入口为了摘要/兼容传入），写盘前统一剥离。
      const { prompt: _prompt, ...sourceMeta } = source && typeof source === 'object' ? source : {};
      const record = {
        screen_id: sid,
        version_id: `${sid}@v${v}`,
        version: v,
        created_at: new Date().toISOString(),
        source: sourceMeta,
        // FR-SOURCE-001 / FR-SOURCE-003 / FR-SOURCE-005：来源与成本随版本一起持久化，
        // 只取白名单字段，避免把 prompt 之外的路由内部结构写进版本文件。
        change_source: source.change_source || (source.kind === 'manual' ? 'manual_direct' : 'ai_patch'),
        change_summary: source.change_summary || null,
        route_layer: source.route_layer || null,
        rule_id: source.rule_id || null,
        ai_cost: source.ai_cost ?? null,
        // DC-031：主题快照随版本保存，旧版本可按当时主题重放
        theme_snapshot: source.theme_snapshot || project?.design?.theme || null,
        prompt_digest: source.prompt_digest ?? null,
        doc,
      };
      await writeJsonAtomic(this.versionFile(pid, sid, v), record);
      const nextMeta = {
        ...meta,
        format: meta.format || (doc?.format === 'm3' ? 'm3' : 'node-tree'),
        current_version: v,
        status: source.kind === 'rollback' ? meta.status : 'applied',
        updated_at: record.created_at,
        versions: [
          ...(meta.versions || []),
          {
            version: v,
            created_at: record.created_at,
            kind: source.kind,
            label: source.label || defaultLabel(source),
            // FR-PROMPT-009 / DC-041：列表只暴露摘要，不暴露正文
            prompt_digest: record.prompt_digest,
            change_source: record.change_source,
            change_summary: record.change_summary,
            route_layer: record.route_layer,
            rule_id: record.rule_id,
            ai_cost: record.ai_cost,
          },
        ],
      };
      await writeJsonAtomic(this.metaFile(pid, sid), nextMeta);
      return { meta: withPosition(nextMeta, await this.#positionOf(pid, sid)), record };
    });
  }

  /** 回滚：只切指针，不复制内容、不碰任何其他屏。 */
  async setCurrentVersion(pid, sid, v, who) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      const meta = await this.#readMeta(pid, sid);
      if (!meta) return null;
      const rec = await this.getVersion(pid, sid, v);
      if (!rec) return null;
      const nextMeta = {
        ...meta,
        current_version: v,
        status: 'applied',
        updated_at: new Date().toISOString(),
        rolled_back_from: meta.current_version,
        rolled_back_by: who,
      };
      await writeJsonAtomic(this.metaFile(pid, sid), nextMeta);
      return withPosition(nextMeta, await this.#positionOf(pid, sid));
    });
  }

  async updateScreenMeta(pid, sid, mut) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      const meta = await this.#readMeta(pid, sid);
      if (!meta) return null;
      const next = mut(structuredClone(meta));
      next.updated_at = new Date().toISOString();
      // 兼容：历史调用可能带回坐标字段，写盘前统一剥离（DC-018）
      delete next.x;
      delete next.y;
      delete next.width;
      delete next.height;
      await writeJsonAtomic(this.metaFile(pid, sid), next);
      return withPosition(next, await this.#positionOf(pid, sid));
    });
  }

  /** 删除屏幕：只删该屏目录，FlowEdge 由上层先做孤儿提示 */
  async deleteScreen(pid, sid) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      await fs.rm(this.screenDir(pid, sid), { recursive: true, force: true });
      await this.#setPositionLocked(pid, sid, null);
    });
  }

  // ---------- flow ----------

  async getFlow(pid) {
    const flow = await readJson(this.flowFile(pid), { schema_version: FLOW_SCHEMA_VERSION, edges: [] });
    return flow
      ? { ...flow, schema_version: FLOW_SCHEMA_VERSION, edges: flow.edges || [] }
      : { schema_version: FLOW_SCHEMA_VERSION, edges: [] };
  }

  async saveFlow(pid, flow) {
    return this.queue.run(`flow:${pid}`, async () => {
      const next = { schema_version: FLOW_SCHEMA_VERSION, ...flow, edges: flow.edges || [] };
      await writeJsonAtomic(this.flowFile(pid), next);
      return next;
    });
  }

  // ---------- canvas ----------

  async getCanvas(pid) {
    const c = await readJson(this.canvasFile(pid), null);
    return {
      schema_version: 2,
      viewport: c?.viewport || { x: 80, y: 80, zoom: 1 },
      screens: c?.screens || {},
    };
  }

  async saveCanvas(pid, canvas) {
    return this.queue.run(`canvas:${pid}`, async () => {
      const current = await this.getCanvas(pid);
      const next = {
        schema_version: 2,
        viewport: canvas?.viewport || current.viewport,
        screens: canvas?.screens || current.screens,
        updated_at: new Date().toISOString(),
      };
      await writeJsonAtomic(this.canvasFile(pid), next);
      return next;
    });
  }

  async #positionOf(pid, sid) {
    const canvas = await this.getCanvas(pid);
    return canvas.screens?.[sid] || null;
  }

  async #setPositionLocked(pid, sid, pos) {
    const canvas = await this.getCanvas(pid);
    canvas.screens = canvas.screens || {};
    if (pos === null) delete canvas.screens[sid];
    else canvas.screens[sid] = { ...(canvas.screens[sid] || {}), ...pos };
    canvas.schema_version = 2;
    await writeJsonAtomic(this.canvasFile(pid), canvas);
  }

  /** 只写坐标（canvas.json 是唯一坐标源），不产生版本、不碰 meta */
  async setPosition(pid, sid, pos) {
    return this.queue.run(`canvas:${pid}`, async () => {
      await this.#setPositionLocked(pid, sid, pos);
      return this.getScreen(pid, sid);
    });
  }

  async setPositions(pid, positions) {
    return this.queue.run(`canvas:${pid}`, async () => {
      const canvas = await this.getCanvas(pid);
      canvas.screens = { ...(canvas.screens || {}), ...(positions || {}) };
      canvas.updated_at = new Date().toISOString();
      await writeJsonAtomic(this.canvasFile(pid), canvas);
      return canvas;
    });
  }

  // ---------- history ----------

  async getHistory(pid) {
    return (await readJson(this.historyFile(pid), { schema_version: 2, jobs: [], patches: [], audits: [] })) || {
      schema_version: 2,
      jobs: [],
      patches: [],
      audits: [],
    };
  }

  appendHistory(pid, section, entry) {
    return this.queue.run(`history:${pid}`, () => this.#appendHistoryLocked(pid, section, entry));
  }

  /** 无锁版本，只允许在已持有 history 锁的临界区内调用（否则死锁） */
  async #appendHistoryLocked(pid, section, entry) {
    const h = await this.getHistory(pid);
    h[section].push(entry);
    const max = 500;
    if (h[section].length > max) h[section].splice(0, h[section].length - max);
    await writeJsonAtomic(this.historyFile(pid), h);
    return entry;
  }

  /** 更新 job 状态 + 写入一条审计，必须一次性落盘 */
  async updateJob(pid, jobId, patch) {
    return this.queue.run(`history:${pid}`, async () => {
      // 注意：这里必须在内存里同时完成"改 job"和"加审计"，然后只写一次盘。
      // 之前先 mutate 再调用 #appendHistoryLocked（内部会重新 readJson）——
      // 重读会拿到磁盘上的旧对象，把刚改的 status 覆盖回去，job 永远停在 generating。
      const h = await this.getHistory(pid);
      const job = h.jobs.find((j) => j.job_id === jobId);
      if (!job) return null;
      Object.assign(job, patch, { updated_at: new Date().toISOString() });
      h.audits.push({
        log_id: `log_${Math.random().toString(36).slice(2, 10)}`,
        actor: 'system',
        action: 'job.update',
        object_id: jobId,
        result: patch.status,
        detail: patch,
        at: new Date().toISOString(),
      });
      if (h.audits.length > 500) h.audits.splice(0, h.audits.length - 500);
      await writeJsonAtomic(this.historyFile(pid), h);
      return job;
    });
  }

  /** 项目级文件快照（导出设计文件用） */
  async snapshot(pid) {
    const project = await this.getProject(pid);
    const screens = await this.listScreens(pid);
    const out = {
      project,
      screens: [],
      flow: await this.getFlow(pid),
      canvas: await this.getCanvas(pid),
      design_revisions: await this.listDesignRevisions(pid),
    };
    for (const s of screens) {
      const cur = await this.getCurrentVersion(pid, s.screen_id);
      out.screens.push({ meta: s, current: cur, versions: await this.listVersions(pid, s.screen_id) });
    }
    return out;
  }

  async ensureScreenExists(pid, sid) {
    return exists(this.metaFile(pid, sid));
  }
}

function lockKey(pid, sid) {
  return `${pid}/${sid}`;
}

function withPosition(meta, pos) {
  const out = { ...meta };
  if (pos) {
    if (Number.isFinite(pos.x)) out.x = pos.x;
    if (Number.isFinite(pos.y)) out.y = pos.y;
    if (Number.isFinite(pos.width)) out.width = pos.width;
    if (Number.isFinite(pos.height)) out.height = pos.height;
  }
  return out;
}

function withProjectDefaults(project) {
  const p = { ...project };
  p.schema_version = 2;
  if (!p.design || typeof p.design !== 'object') {
    p.design = {
      title: p.name || '',
      brief: '',
      platform: 'android',
      paletteKey: 'purple',
      customPalette: null,
      dynamicColor: false,
      theme: {
        dark: false,
        bothModes: false,
        contrast: 'standard',
        shape: 'rounded',
        font: 'roboto',
        emphasized: false,
        motion: 'standard',
      },
      promptOptions: [],
      promptEdit: null,
    };
  }
  if (!p.design_tokens || typeof p.design_tokens !== 'object') p.design_tokens = {};
  if (!Array.isArray(p.members)) p.members = [];
  if (!Array.isArray(p.screen_titles)) p.screen_titles = [];
  return p;
}

function emptyUiState() {
  return {
    schema_version: 1,
    viewport: null,
    panelWidths: {},
    activeTab: null,
    favorites: [],
    updated_at: null,
  };
}

function defaultLabel(source) {
  switch (source.kind) {
    case 'generate':
      return 'AI 单屏生成';
    case 'patch':
      return 'AI 局部 patch';
    case 'manual':
      return '手动编辑';
    case 'import':
      return '导入';
    case 'copy':
      return '复制屏幕';
    default:
      return source.kind;
  }
}

export { withProjectDefaults, withPosition };
