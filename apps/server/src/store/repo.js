import path from 'node:path';
import { promises as fs } from 'node:fs';
import { KeyedQueue, readJson, writeJsonAtomic, exists } from './fs.js';

/**
 * 三层物理隔离的仓储：
 *   data/projects/<pid>/project.json
 *   data/projects/<pid>/screens/<sid>/meta.json
 *   data/projects/<pid>/screens/<sid>/versions/v<n>.json
 *   data/projects/<pid>/flow.json
 *   data/projects/<pid>/canvas.json
 *   data/projects/<pid>/history.json  (GenerationJob + PatchRecord + AuditLog)
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

  flowFile(pid) {
    return path.join(this.projectDir(pid), 'flow.json');
  }

  canvasFile(pid) {
    return path.join(this.projectDir(pid), 'canvas.json');
  }

  historyFile(pid) {
    return path.join(this.projectDir(pid), 'history.json');
  }

  metaFile(pid, sid) {
    return path.join(this.screenDir(pid, sid), 'meta.json');
  }

  versionFile(pid, sid, v) {
    return path.join(this.screenDir(pid, sid), 'versions', `v${v}.json`);
  }

  // ---------- project ----------

  async createProject(project) {
    await fs.mkdir(this.screenDir(project.project_id, '_'), { recursive: true });
    await writeJsonAtomic(path.join(this.projectDir(project.project_id), 'project.json'), project);
    await writeJsonAtomic(this.flowFile(project.project_id), { schema_version: 1, edges: [] });
    await writeJsonAtomic(this.canvasFile(project.project_id), {
      schema_version: 1,
      viewport: { x: 80, y: 80, zoom: 1 },
    });
    await writeJsonAtomic(this.historyFile(project.project_id), {
      schema_version: 1,
      jobs: [],
      patches: [],
      audits: [],
    });
    return project;
  }

  async getProject(pid) {
    return readJson(path.join(this.projectDir(pid), 'project.json'));
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
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async updateProject(pid, mut) {
    return this.queue.run(`project:${pid}`, async () => {
      const p = await this.getProject(pid);
      if (!p) return null;
      const next = mut(structuredClone(p));
      next.updated_at = new Date().toISOString();
      await writeJsonAtomic(path.join(this.projectDir(pid), 'project.json'), next);
      return next;
    });
  }

  // ---------- screens ----------

  async listScreens(pid) {
    const dir = path.join(this.projectDir(pid), 'screens');
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const sid of names) {
      const meta = await readJson(this.metaFile(pid, sid));
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => a.order.localeCompare(b.order));
  }

  async getScreen(pid, sid) {
    return readJson(this.metaFile(pid, sid));
  }

  async createScreen(pid, screen) {
    return this.queue.run(`screen:${lockKey(pid, screen.screen_id)}`, async () => {
      await this.#writeScreenFiles(pid, screen);
      return screen;
    });
  }

  /** 不带锁的裸写入，供已持锁的调用方（如 createScreen）复用，避免自锁 */
  async #writeScreenFiles(pid, screen) {
    await fs.mkdir(path.join(this.screenDir(pid, screen.screen_id), 'versions'), { recursive: true });
    await writeJsonAtomic(this.metaFile(pid, screen.screen_id), screen);
  }

  async getVersion(pid, sid, v) {
    return readJson(this.versionFile(pid, sid, v));
  }

  async getCurrentVersion(pid, sid) {
    const meta = await this.getScreen(pid, sid);
    if (!meta || !meta.current_version) return null;
    return this.getVersion(pid, sid, meta.current_version);
  }

  async listVersions(pid, sid) {
    const meta = await this.getScreen(pid, sid);
    return meta ? meta.versions.slice().reverse() : [];
  }

  /**
   * 提交新版本：写版本文件 → 更新 meta。
   * 只有这一条路径能递增版本号，确保 DC-007 / C-008 不被绕过。
   * writeSrc 是来源标签，例如 {kind:'generate'|'patch'|'rollback'|'manual', prompt, job_id}
   */
  async commitVersion(pid, sid, doc, source) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      const meta = await this.getScreen(pid, sid);
      if (!meta) throw new Error(`screen not found: ${sid}`);
      const v = meta.current_version + 1;
      const record = {
        screen_id: sid,
        version_id: `${sid}@v${v}`,
        version: v,
        created_at: new Date().toISOString(),
        source,
        // FR-SOURCE-001 / FR-SOURCE-003 / FR-SOURCE-005：来源与成本随版本一起持久化，
        // 只取白名单字段，避免把 prompt 之外的路由内部结构写进版本文件。
        change_source: source.change_source || (source.kind === 'manual' ? 'manual_direct' : 'ai_patch'),
        change_summary: source.change_summary || null,
        route_layer: source.route_layer || null,
        rule_id: source.rule_id || null,
        ai_cost: source.ai_cost ?? null,
        doc,
      };
      await writeJsonAtomic(this.versionFile(pid, sid, v), record);
      const nextMeta = {
        ...meta,
        current_version: v,
        status: source.kind === 'rollback' ? meta.status : 'applied',
        updated_at: record.created_at,
        versions: [
          ...meta.versions,
          {
            version: v,
            created_at: record.created_at,
            kind: source.kind,
            label: source.label || defaultLabel(source),
            prompt: source.prompt || null,
            change_source: record.change_source,
            change_summary: record.change_summary,
            route_layer: record.route_layer,
            rule_id: record.rule_id,
            ai_cost: record.ai_cost,
          },
        ],
      };
      await writeJsonAtomic(this.metaFile(pid, sid), nextMeta);
      return { meta: nextMeta, record };
    });
  }

  /** 回滚：只切指针，不复制内容、不碰任何其他屏。 */
  async setCurrentVersion(pid, sid, v, who) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      const meta = await this.getScreen(pid, sid);
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
      return nextMeta;
    });
  }

  async updateScreenMeta(pid, sid, mut) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      const meta = await this.getScreen(pid, sid);
      if (!meta) return null;
      const next = mut(structuredClone(meta));
      next.updated_at = new Date().toISOString();
      await writeJsonAtomic(this.metaFile(pid, sid), next);
      return next;
    });
  }

  /** 删除屏幕：只删该屏目录，FlowEdge 由上层先做孤儿提示 */
  async deleteScreen(pid, sid) {
    return this.queue.run(`screen:${lockKey(pid, sid)}`, async () => {
      await fs.rm(this.screenDir(pid, sid), { recursive: true, force: true });
    });
  }

  // ---------- flow ----------

  async getFlow(pid) {
    return (await readJson(this.flowFile(pid), { schema_version: 1, edges: [] })) || { schema_version: 1, edges: [] };
  }

  async saveFlow(pid, flow) {
    return this.queue.run(`flow:${pid}`, async () => {
      await writeJsonAtomic(this.flowFile(pid), flow);
      return flow;
    });
  }

  // ---------- canvas ----------

  async getCanvas(pid) {
    return readJson(this.canvasFile(pid), { schema_version: 1, viewport: { x: 80, y: 80, zoom: 1 } });
  }

  async saveCanvas(pid, canvas) {
    return this.queue.run(`canvas:${pid}`, async () => {
      await writeJsonAtomic(this.canvasFile(pid), canvas);
      return canvas;
    });
  }

  // ---------- history ----------

  async getHistory(pid) {
    return readJson(this.historyFile(pid), { schema_version: 1, jobs: [], patches: [], audits: [] });
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
    const out = { project, screens: [], flow: await this.getFlow(pid), canvas: await this.getCanvas(pid) };
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
