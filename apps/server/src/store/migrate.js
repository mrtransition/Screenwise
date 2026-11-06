/**
 * 存储 v1 → v2 迁移（SRS §5.6.4 / AC-607/608/609/610）
 *
 * 目标：
 *  - project.json 增加 `schema_version:2` 与 `design`（design_tokens 作为派生投影保留）；
 *  - 屏幕坐标从 meta.json 搬到 canvas.json（DC-018），meta 不再持有坐标；
 *  - flow.json 升级到 v2：`source_hotspot_id` → `source_item_id`、swipe 带 direction、
 *    移除持久化 `orphan`；
 *  - 旧 `{version, root}` 文档标记为 `format:"node-tree"`，内容一字不改（只读兼容）；
 *  - 补齐 design-revisions / ui-state / measurements 文件。
 *
 * 幂等：已迁移项目直接跳过。失败：自动从备份恢复，原数据不变。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJson, writeJsonAtomic } from './fs.js';
import { designFromLegacyProject, normalizeEdges } from '../project/io.js';

const V2 = 2;

export async function planMigration(root) {
  const projectsDir = path.join(root, 'projects');
  const names = await fs.readdir(projectsDir).catch(() => []);
  const projects = [];
  for (const pid of names) {
    const dir = path.join(projectsDir, pid);
    const project = await readJson(path.join(dir, 'project.json'));
    if (!project) continue;
    const actions = [];
    if (project.schema_version !== V2) actions.push('project: schema_version→2 + design');
    if (!project.design) actions.push('project: 生成 ProjectDesign（design_tokens 投影）');

    const screensDir = path.join(dir, 'screens');
    const sids = await fs.readdir(screensDir).catch(() => []);
    const screens = [];
    const canvas = (await readJson(path.join(dir, 'canvas.json'), null)) || { schema_version: 1, viewport: { x: 80, y: 80, zoom: 1 } };
    const positions = { ...(canvas.screens || {}) };
    let index = 0;
    for (const sid of sids) {
      const meta = await readJson(path.join(screensDir, sid, 'meta.json'));
      if (!meta) continue;
      const current = meta.current_version
        ? await readJson(path.join(screensDir, sid, 'versions', `v${meta.current_version}.json`))
        : null;
      const format = meta.format || (current?.doc?.format === 'm3' ? 'm3' : 'node-tree');
      const needsPosition = !positions[sid] && (Number.isFinite(meta.x) || Number.isFinite(meta.y));
      if (needsPosition) {
        positions[sid] = {
          x: Number.isFinite(meta.x) ? meta.x : 120 + (index % 3) * 472,
          y: Number.isFinite(meta.y) ? meta.y : 120 + Math.floor(index / 3) * 960,
          width: Number.isFinite(meta.width) ? meta.width : project.device?.width,
          height: Number.isFinite(meta.height) ? meta.height : project.device?.height,
        };
      }
      if (!positions[sid]) {
        positions[sid] = { x: 120 + (index % 3) * 472, y: 120 + Math.floor(index / 3) * 960 };
      }
      if (meta.x !== undefined || meta.y !== undefined || meta.width !== undefined || meta.height !== undefined) {
        actions.push(`screen:${sid}: 坐标移入 canvas.json`);
      }
      if (!meta.format) actions.push(`screen:${sid}: format→${format}`);
      if (format === 'node-tree' && !meta.format) actions.push(`screen:${sid}: 标记只读 node-tree`);
      screens.push({ screen_id: sid, format, meta, current });
      index++;
    }

    const flow = (await readJson(path.join(dir, 'flow.json'), null)) || { edges: [] };
    if (flow.schema_version !== V2) actions.push('flow: schema_version→2');
    if ((flow.edges || []).some((e) => e.orphan !== undefined)) actions.push('flow: 移除持久化 orphan');
    if ((flow.edges || []).some((e) => e.source_hotspot_id && !e.source_item_id)) actions.push('flow: source_hotspot_id→source_item_id');
    if ((flow.edges || []).some((e) => e.trigger === 'swipe' && !e.direction)) actions.push('flow: swipe 补 direction');

    const migrated = project.schema_version === V2 && screens.every((s) => s.meta.format) && actions.length === 0;
    projects.push({ pid, project, screens, flow, canvas, positions, actions, migrated });
  }
  return {
    root,
    projects,
    summary: {
      projects: projects.length,
      migrated: projects.filter((p) => p.migrated).length,
      pending: projects.filter((p) => !p.migrated).length,
      screens: projects.reduce((n, p) => n + p.screens.length, 0),
    },
  };
}

/** 迁移前备份整个 data 目录（不含备份自身），返回备份路径 */
export async function backupData(root) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${root}.backup-${ts}`;
  await fs.cp(root, target, { recursive: true, errorOnExist: true, force: false });
  return target;
}

export async function restoreData(root, backupPath) {
  const src = path.resolve(backupPath);
  const st = await fs.stat(src).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`备份目录不存在: ${backupPath}`);
  const safety = `${root}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const existsRoot = await fs.stat(root).catch(() => null);
  if (existsRoot) await fs.rename(root, safety);
  await fs.cp(src, root, { recursive: true });
  return { restored_from: src, previous: existsRoot ? safety : null };
}

/**
 * 执行迁移。dryRun 只读扫描；失败自动恢复备份。
 */
export async function runMigration(root, { dryRun = false } = {}) {
  const plan = await planMigration(root);
  if (dryRun) return { dry_run: true, ...plan };
  if (plan.summary.pending === 0) return { dry_run: false, skipped: true, ...plan };

  const backup = await backupData(root);
  const written = [];
  try {
    for (const entry of plan.projects) {
      if (entry.migrated) continue;
      const dir = path.join(root, 'projects', entry.pid);
      const { design, design_tokens } = entry.project.design
        ? { design: entry.project.design, design_tokens: entry.project.design_tokens ?? {} }
        : designFromLegacyProject(entry.project);
      await writeJsonAtomic(path.join(dir, 'project.json'), {
        ...entry.project,
        schema_version: V2,
        design,
        design_tokens,
        updated_at: new Date().toISOString(),
      });
      for (const s of entry.screens) {
        const { x, y, width, height, ...meta } = s.meta;
        await writeJsonAtomic(path.join(dir, 'screens', s.screen_id, 'meta.json'), {
          ...meta,
          format: s.format,
          updated_at: new Date().toISOString(),
        });
      }
      await writeJsonAtomic(path.join(dir, 'canvas.json'), {
        schema_version: 2,
        viewport: entry.canvas.viewport || { x: 80, y: 80, zoom: 1 },
        screens: entry.positions,
        updated_at: new Date().toISOString(),
      });
      await writeJsonAtomic(path.join(dir, 'flow.json'), {
        schema_version: V2,
        edges: normalizeEdges(entry.flow.edges || []),
        updated_at: new Date().toISOString(),
      });
      await ensureProjectFile(path.join(dir, 'design-revisions.json'), {
        schema_version: 1,
        revisions: [
          {
            revision: 1,
            created_at: new Date().toISOString(),
            actor: 'migrate-v2',
            change_summary: '迁移到存储 v2（design_tokens 投影为 ProjectDesign）',
            design,
            design_tokens,
          },
        ],
      });
      await ensureProjectFile(path.join(dir, 'ui-state.json'), {
        schema_version: 1,
        viewport: null,
        panelWidths: {},
        activeTab: null,
        favorites: [],
      });
      await ensureProjectFile(path.join(dir, 'measurements.json'), { schema_version: 1, screens: {} });
      if (entry.flow.schema_version !== V2 || entry.flow.edges !== undefined) await ensureFlowSchemaV2(dir);
      written.push({ pid: entry.pid, actions: entry.actions });
    }
    return { dry_run: false, backup, written, ...(await planMigration(root)) };
  } catch (err) {
    // AC-608：迁移失败自动恢复备份，原数据不变
    await restoreData(root, backup);
    throw new Error(`迁移失败，已从 ${backup} 恢复：${err.message}`);
  }
}

async function ensureProjectFile(file, content) {
  const exists = await readJson(file, null);
  if (exists) return;
  await writeJsonAtomic(file, content);
}

/** 兜底：确认 flow 已是 v2（避免上面写入被后续步骤覆盖） */
async function ensureFlowSchemaV2(dir) {
  const flow = await readJson(path.join(dir, 'flow.json'), null);
  if (flow && flow.schema_version !== V2) {
    await writeJsonAtomic(path.join(dir, 'flow.json'), { ...flow, schema_version: V2 });
  }
}
