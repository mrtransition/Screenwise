/**
 * 项目导入/导出（FR-PROJ-006/007、API-017/017b/026、§5.6）
 *
 * 支持的输入：
 *  - M3E `Doc`：`{frames, groups, ...}`
 *  - 单个旧 `node-tree`：`{version, root}`
 *  - 旧项目包：`{project, screens:[{meta, doc?|current?|versions?}], flow?}`
 *  - `.m3studio` 备份（JSON 形态）：`{schema:"m3studio/backup@1", ...}`
 *
 * 支持输出：M3E JSON、完整备份 JSON、静态原型（由 export/static.js 负责）。
 * 所有导入都是「先校验、后写入」：校验失败不产生任何项目/屏幕/边。
 */

import { randomUUID } from 'node:crypto';
import {
  importM3eProject,
  exportM3eProject,
  assembleProjectDoc,
  deriveDesignTokens,
  makeEdgeId,
} from '../domain/m3/convert.js';
import { normalizeProjectDesign, normalizeTheme, validateM3eDoc, M3SchemaError } from '../domain/m3/schema.js';
import { FLOW_SCHEMA_VERSION } from '../domain/m3/constants.js';
import { isLegacyNodeTree, normalizeLegacyDoc } from '../domain/legacy.js';

const now = () => new Date().toISOString();
const rid = (p) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** 识别导入格式；返回 null 表示无法识别（调用方 422 MIGRATION_UNSUPPORTED） */
export function detectImportKind(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.schema === 'm3studio/backup@1') return 'backup';
  if (Array.isArray(payload.frames) && Array.isArray(payload.groups)) return 'm3e';
  if (payload.doc) {
    const inner = payload.doc;
    if (Array.isArray(inner.frames) && Array.isArray(inner.groups)) return 'm3e';
    if (inner.root) return 'legacy';
  }
  if (isLegacyNodeTree(payload)) return 'legacy';
  if (Array.isArray(payload.screens)) return payload.project ? 'legacy-project' : 'legacy-project';
  return null;
}

/** 旧 design_tokens → ProjectDesign（AC-604：颜色不丢，原 tokens 也原样保留） */
export function designFromLegacyProject(project = {}) {
  const tokens = project.design_tokens && typeof project.design_tokens === 'object' ? project.design_tokens : {};
  const colors = tokens.colors && typeof tokens.colors === 'object' ? tokens.colors : {};
  const primary = typeof colors.primary === 'string' ? colors.primary : null;
  const secondary = typeof colors.secondary === 'string' ? colors.secondary : null;
  const tertiary = typeof colors.tertiary === 'string' ? colors.tertiary : null;
  const neutral = typeof colors.neutral === 'string' ? colors.neutral : null;
  const radiusMd = Number(tokens.radius?.md);
  const family = String(tokens.font?.family ?? '');
  const theme = normalizeTheme({
    shape: Number.isFinite(radiusMd) ? (radiusMd >= 24 ? 'full' : radiusMd <= 6 ? 'square' : 'rounded') : 'rounded',
    font: /serif/i.test(family) ? 'robotoSerif' : /flex/i.test(family) ? 'robotoFlex' : /system|segoe|pingfang/i.test(family) ? 'system' : 'roboto',
  });
  const design = normalizeProjectDesign({
    title: project.design?.title ?? project.name ?? '',
    brief: project.design?.brief ?? '',
    platform: project.device?.width >= 1000 ? 'web' : 'android',
    paletteKey: primary ? 'custom' : 'purple',
    customPalette: primary
      ? { label: '旧项目配色', primary, secondary: secondary || primary, tertiary: tertiary || primary, neutral: neutral || primary }
      : null,
    theme,
    promptOptions: [],
  });
  return { design, design_tokens: tokens };
}

/** 把任意输入归一为「项目 + 屏幕 + 边」的中间结构（不写盘） */
export function normalizeImport(payload, { name, actor = 'local-user', nowIso = now() } = {}) {
  const kind = detectImportKind(payload);
  if (!kind) {
    throw new M3SchemaError(
      [
        {
          path: 'payload',
          code: 'FORMAT',
          message: '无法识别导入格式：需要 M3E Doc（frames/groups）、旧 node-tree（root）或备份包（schema=m3studio/backup@1）',
        },
      ],
      '导入'
    );
  }

  if (kind === 'm3e') {
    const doc = payload.doc ?? payload;
    const issues = validateM3eDoc(doc);
    if (issues.length) throw new M3SchemaError(issues, 'M3E Doc');
    const parsed = importM3eProject(doc, { now: nowIso, actor });
    const positions = {};
    const origByNew = Object.fromEntries(Object.entries(parsed.id_map.screens).map(([orig, next]) => [next, orig]));
    for (const screen of parsed.screens) {
      const origId = origByNew[screen.screen_id] ?? screen.screen_id;
      const frame = doc.frames?.find((f) => f.id === origId);
      const fallback = gridPosition(parsed.screens.indexOf(screen));
      positions[screen.screen_id] = {
        x: Number.isFinite(frame?.x) ? frame.x : fallback.x,
        y: Number.isFinite(frame?.y) ? frame.y : fallback.y,
        width: Number.isFinite(frame?.w) ? frame.w : screen.doc.frame.w,
        height: Number.isFinite(frame?.h) ? frame.h : screen.doc.frame.h,
      };
    }
    return {
      kind,
      name: String(name || doc.title || '导入的 M3E 项目').trim(),
      design: parsed.design,
      design_tokens: parsed.design_tokens,
      device: {
        width: parsed.screens[0]?.doc?.frame?.w ?? 412,
        height: parsed.screens[0]?.doc?.frame?.h ?? 892,
      },
      screens: parsed.screens.map((s, i) => ({ ...s, order: i, format: 'm3' })),
      edges: parsed.edges,
      positions,
      warnings: parsed.warnings,
      loss: parsed.loss,
      id_map: parsed.id_map,
    };
  }

  if (kind === 'legacy') {
    const legacy = normalizeLegacyDoc(payload.doc ?? payload);
    if (!legacy) throw new M3SchemaError([{ path: 'doc', code: 'TYPE', message: '旧文档缺少 root' }], '旧文档');
    const pidTitle = String(name || payload.title || '旧项目').trim();
    return {
      kind,
      name: pidTitle,
      design: designFromLegacyProject({ name: pidTitle, design_tokens: {} }).design,
      design_tokens: {},
      device: { width: 375, height: 812 },
      screens: [
        {
          screen_id: rid('scr'),
          title: payload.title || '旧屏幕',
          order: 0,
          format: 'node-tree',
          doc: legacy,
          legacy_source: true,
        },
      ],
      edges: [],
      positions: { __single__: gridPosition(0) },
      warnings: [],
      loss: [],
      id_map: { screens: {}, groups: {}, items: {} },
    };
  }

  if (kind === 'backup') {
    const project = payload.project ?? {};
    const design = normalizeProjectDesign(project.design ?? designFromLegacyProject(project).design);
    const screens = (payload.screens ?? []).map((entry, i) => {
      const meta = entry.meta ?? entry;
      const doc = entry.current?.doc ?? entry.doc ?? latestDoc(entry) ?? null;
      return {
        screen_id: meta.screen_id ?? rid('scr'),
        title: meta.title ?? `屏幕 ${i + 1}`,
        order: Number.isFinite(meta.order) ? meta.order : i,
        format: meta.format ?? (doc?.format === 'm3' ? 'm3' : 'node-tree'),
        doc,
        remark: meta.remark ?? '',
        versions: entry.versions ?? null,
      };
    });
    return {
      kind,
      name: String(name || project.name || '导入的备份').trim(),
      design,
      design_tokens: project.design_tokens ?? {},
      device: project.device ?? { width: 412, height: 892 },
      screens,
      edges: normalizeEdges(payload.flow?.edges ?? payload.edges ?? [], nowIso, actor),
      positions: payload.canvas?.screens ?? {},
      warnings: [],
      loss: [],
      id_map: { screens: {}, groups: {}, items: {} },
    };
  }

  /* 旧项目包：project + screens */
  const project = payload.project ?? {};
  const { design, design_tokens } = designFromLegacyProject(project);
  const screens = (payload.screens ?? []).map((entry, i) => {
    const meta = entry.meta ?? entry;
    const doc = entry.current?.doc ?? entry.doc ?? latestDoc(entry) ?? null;
    return {
      screen_id: meta.screen_id ?? rid('scr'),
      title: meta.title ?? `屏幕 ${i + 1}`,
      order: Number.isFinite(meta.order) ? Number(meta.order) : i,
      format: meta.format ?? (doc?.format === 'm3' ? 'm3' : 'node-tree'),
      doc,
      remark: meta.remark ?? '',
      versions: entry.versions ?? null,
    };
  });
  const positions = {};
  screens.forEach((s, i) => {
    positions[s.screen_id] = {
      x: Number.isFinite(metaOf(payload, i)?.x) ? metaOf(payload, i).x : gridPosition(i).x,
      y: Number.isFinite(metaOf(payload, i)?.y) ? metaOf(payload, i).y : gridPosition(i).y,
      width: metaOf(payload, i)?.width,
      height: metaOf(payload, i)?.height,
    };
  });
  return {
    kind: 'legacy-project',
    name: String(name || project.name || '导入的旧项目').trim(),
    design,
    design_tokens,
    device: project.device ?? { width: 375, height: 812 },
    screens,
    edges: normalizeEdges(payload.flow?.edges ?? payload.edges ?? [], nowIso, actor),
    positions,
    warnings: [],
    loss: [],
    id_map: { screens: {}, groups: {}, items: {} },
  };
}

function metaOf(payload, i) {
  return (payload.screens ?? [])[i]?.meta ?? (payload.screens ?? [])[i];
}

function latestDoc(entry) {
  const list = entry.versions ?? [];
  const sorted = list.slice().sort((a, b) => Number(b.version) - Number(a.version));
  return sorted[0]?.doc ?? entry.current?.doc ?? null;
}

function gridPosition(i) {
  return { x: 80 + (i % 3) * 472, y: 80 + Math.floor(i / 3) * 960 };
}

/** 旧 flow 边 → v2 FlowEdge；source_hotspot_id 映射为 source_item_id（AC-603） */
export function normalizeEdges(edges, nowIso = now(), actor = 'local-user') {
  const out = [];
  for (const e of edges ?? []) {
    if (!e || !e.source_screen_id) continue;
    const trigger = ['click', 'swipe', 'auto'].includes(e.trigger) ? e.trigger : e.trigger === 'swipe' ? 'swipe' : 'click';
    const targetKind = ['screen', 'back', 'link', 'menu', 'toggle'].includes(e.target_kind)
      ? e.target_kind
      : e.target_screen_id
        ? 'screen'
        : e.url
          ? 'link'
          : 'screen';
    const sourceItem = e.source_item_id ?? e.source_hotspot_id ?? null;
    const direction = trigger === 'swipe' ? (['left', 'right', 'up', 'down'].includes(e.direction) ? e.direction : 'left') : null;
    out.push({
      edge_id: e.edge_id || makeEdgeId([e.source_screen_id, sourceItem ?? '', e.target_screen_id ?? '', trigger, direction ?? '']),
      source_screen_id: e.source_screen_id,
      source_item_id: sourceItem,
      source_slot: e.source_slot ?? null,
      target_kind: targetKind,
      target_screen_id: e.target_screen_id ?? null,
      url: e.url ?? null,
      trigger,
      direction,
      transition: e.transition ?? e.animation ?? 'none',
      note: e.note ?? '',
      status: e.status === 'candidate' ? 'candidate' : 'confirmed',
      expires_at: e.expires_at ?? null,
      created_at: e.created_at || nowIso,
      created_by: e.created_by || actor,
    });
  }
  return out;
}

/**
 * 写入一个新项目。所有内容已在内存中校验/归一，失败不会留下半截数据：
 * 先建项目目录，再逐屏写入；任一步失败由调用方清理。
 */
export async function persistImportedProject(repo, parsed, { actor = 'local-user', nowIso = now() } = {}) {
  const project_id = rid('prj');
  const project = {
    project_id,
    name: parsed.name,
    schema_version: 2,
    device: parsed.device,
    design: parsed.design,
    design_tokens: parsed.design_tokens,
    role: 'owner',
    members: [{ user: actor, role: 'owner' }],
    screen_titles: [],
    import_source: parsed.kind,
    created_at: nowIso,
    updated_at: nowIso,
  };
  await repo.createProject(project);
  try {
    const positions = {};
    for (const s of parsed.screens) {
      const screen_id = s.screen_id;
      const doc = s.doc;
      const order = String((s.order ?? 0) + 1).padStart(4, '0');
      await repo.createScreen(project_id, {
        screen_id,
        project_id,
        title: s.title,
        remark: s.remark ?? '',
        order,
        status: 'applied',
        locked: false,
        current_version: 0,
        versions: [],
        pending: null,
        derived_from: null,
        format: s.format,
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (doc) {
        if (Array.isArray(s.versions) && s.versions.length) {
          for (const rec of s.versions.slice().sort((a, b) => a.version - b.version)) {
            await repo.commitVersion(project_id, screen_id, rec.doc, {
              kind: rec.source?.kind || 'import',
              label: rec.source?.label || '导入',
              who: actor,
              change_source: rec.change_source,
              change_summary: rec.change_summary,
              theme_snapshot: rec.theme_snapshot,
            });
          }
        } else {
          await repo.commitVersion(project_id, screen_id, doc, {
            kind: 'import',
            label: parsed.kind === 'm3e' ? '导入 M3E 项目' : '导入旧项目',
            who: actor,
            theme_snapshot: parsed.design?.theme,
          });
        }
      }
      const pos = parsed.positions?.[screen_id] ?? parsed.positions?.__single__ ?? gridPosition(parsed.screens.indexOf(s));
      positions[screen_id] = {
        x: Number.isFinite(pos?.x) ? pos.x : gridPosition(parsed.screens.indexOf(s)).x,
        y: Number.isFinite(pos?.y) ? pos.y : gridPosition(parsed.screens.indexOf(s)).y,
        width: Number.isFinite(pos?.width) ? pos.width : doc?.frame?.w,
        height: Number.isFinite(pos?.height) ? pos.height : doc?.frame?.h,
      };
    }
    await repo.setPositions(project_id, positions);
    const edges = (parsed.edges ?? []).map((e) => ({ ...e, source_screen_id: remapScreen(e.source_screen_id, parsed), target_screen_id: remapScreen(e.target_screen_id, parsed) }));
    await repo.saveFlow(project_id, { schema_version: FLOW_SCHEMA_VERSION, edges, updated_at: nowIso });
    await repo.appendDesignRevision(project_id, {
      revision: 1,
      created_at: nowIso,
      actor,
      change_summary: parsed.kind === 'm3e' ? '导入 M3E 项目（含主题）' : '导入旧项目（design_tokens 投影）',
      design: parsed.design,
      design_tokens: parsed.design_tokens,
    });
    await repo.updateProject(project_id, (p) => ({
      ...p,
      screen_titles: parsed.screens.map((s) => ({ screen_id: s.screen_id, title: s.title })),
    }));
    return { project_id, project: await repo.getProject(project_id), warnings: parsed.warnings, loss: parsed.loss, id_map: parsed.id_map };
  } catch (err) {
    // 校验已在前面完成；这里只处理磁盘错误，尽量不留下半个项目
    const { promises: fs } = await import('node:fs');
    await fs.rm(repo.projectDir(project_id), { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function remapScreen(sid, parsed) {
  if (!sid) return sid;
  return parsed.id_map?.screens?.[sid] ?? sid;
}

/**
 * 导入到现有项目（AC-613）：冲突 id 重映射，边随屏重映射，失败不落库。
 */
export async function importIntoProject(repo, pid, payload, { actor = 'local-user', nowIso = now() } = {}) {
  const existing = await repo.listScreens(pid);
  const reservedScreenIds = existing.map((s) => s.screen_id);
  const kind = detectImportKind(payload);
  if (kind !== 'm3e') {
    throw new M3SchemaError([{ path: 'payload', code: 'FORMAT', message: '导入到现有项目目前只支持 M3E Doc（旧项目请导入为新项目）' }], '导入');
  }
  const doc = payload.doc ?? payload;
  const issues = validateM3eDoc(doc);
  if (issues.length) throw new M3SchemaError(issues, 'M3E Doc');
  const parsed = importM3eProject(doc, { now: nowIso, actor, reservedScreenIds });
  const project = await repo.getProject(pid);
  const maxOrder = existing.reduce((m, s) => Math.max(m, Number(s.order) || 0), 0);
  const created = [];
  const createdIds = [];
  const flowBefore = await repo.getFlow(pid);
  try {
    for (const [i, s] of parsed.screens.entries()) {
      const screen_id = s.screen_id;
      if (reservedScreenIds.includes(screen_id)) {
        parsed.warnings.push({ code: 'SCREEN_ID_STILL_CONFLICT', screen_id });
        continue;
      }
      await repo.createScreen(pid, {
        screen_id,
        project_id: pid,
        title: s.title,
        remark: '',
        order: String(maxOrder + i + 1).padStart(4, '0'),
        status: 'applied',
        locked: false,
        current_version: 0,
        versions: [],
        pending: null,
        derived_from: null,
        format: 'm3',
        created_at: nowIso,
        updated_at: nowIso,
      });
      await repo.commitVersion(pid, screen_id, s.doc, {
        kind: 'import',
        label: '导入到现有项目',
        who: actor,
        theme_snapshot: project?.design?.theme,
      });
      createdIds.push(screen_id);
      created.push(s);
    }
    const flow = await repo.getFlow(pid);
    const known = new Set(flow.edges.map((e) => e.edge_id));
    const addedEdges = [];
    for (const e of parsed.edges) {
      if (!createdIds.includes(e.source_screen_id)) continue;
      const edge = known.has(e.edge_id) ? { ...e, edge_id: makeEdgeId([e.edge_id, createdIds.join('|'), nowIso]) } : e;
      known.add(edge.edge_id);
      addedEdges.push(edge);
    }
    await repo.saveFlow(pid, { schema_version: FLOW_SCHEMA_VERSION, edges: [...flow.edges, ...addedEdges], updated_at: nowIso });
    await repo.updateProject(pid, (p) => ({
      ...p,
      screen_titles: [
        ...(p.screen_titles ?? []),
        ...created.map((s) => ({ screen_id: s.screen_id, title: s.title })),
      ],
    }));
    return {
      project_id: pid,
      imported_screens: created.map((s) => s.screen_id),
      imported_edges: addedEdges.length,
      warnings: parsed.warnings,
      loss: parsed.loss,
      id_map: parsed.id_map,
      screen_count: created.length,
      edge_count: addedEdges.length,
    };
  } catch (err) {
    // DC-025 / AC-613：失败不落库——清掉本次新建的屏，并把 flow 恢复为导入前
    const { promises: fs } = await import('node:fs');
    for (const sid of createdIds) {
      await fs.rm(repo.screenDir(pid, sid), { recursive: true, force: true }).catch(() => {});
    }
    await repo.saveFlow(pid, flowBefore).catch(() => {});
    const titles = new Set(createdIds);
    await repo.updateProject(pid, (p) => ({
      ...p,
      screen_titles: (p.screen_titles ?? []).filter((t) => !titles.has(t.screen_id)),
    })).catch(() => {});
    throw err;
  }
}

/** 导出 M3E Doc（FR-PROJ-007）：旧 node-tree 屏跳过并给出警告，导航由 FlowEdge 注回 */
export async function exportProjectAsM3e(repo, pid, { includeHidden = false } = {}) {
  const project = await repo.getProject(pid);
  const metas = await repo.listScreens(pid);
  const canvas = await repo.getCanvas(pid);
  const flow = await repo.getFlow(pid);
  const screens = [];
  const warnings = [];
  const positions = {};
  for (const meta of metas) {
    const cur = await repo.getCurrentVersion(pid, meta.screen_id);
    if (!cur?.doc) {
      warnings.push({ code: 'EMPTY_SCREEN_SKIPPED', screen_id: meta.screen_id, message: '空屏未导出' });
      continue;
    }
    if (cur.doc.format !== 'm3') {
      warnings.push({
        code: 'LEGACY_SCREEN_SKIPPED',
        screen_id: meta.screen_id,
        message: '旧 node-tree 屏不进入 M3E 导出；请先用 /convert 转换（FR-M3-009）',
      });
      continue;
    }
    screens.push({ doc: cur.doc });
    positions[meta.screen_id] = {
      x: canvas.screens?.[meta.screen_id]?.x ?? 0,
      y: canvas.screens?.[meta.screen_id]?.y ?? 0,
    };
  }
  const out = exportM3eProject({ design: project.design, screens, edges: flow.edges, positions, includeHidden });
  return {
    schema: 'm3studio/project@1',
    doc: out.doc,
    warnings: [...warnings, ...out.warnings],
    screens: screens.length,
    edges: out.doc.groups.reduce((n, g) => n + g.items.filter((i) => i.action || i.actions).length, 0),
    project_doc: assembleProjectDoc({ design: project.design, screens, edges: flow.edges, positions, includeHidden }),
  };
}

/** 完整备份（JSON 形态；可被 import 还原）。包含全部版本，便于二进制级恢复。 */
export async function exportBackup(repo, pid) {
  const project = await repo.getProject(pid);
  const metas = await repo.listScreens(pid);
  const screens = [];
  for (const meta of metas) {
    const versions = [];
    for (const v of meta.versions ?? []) {
      const rec = await repo.getVersion(pid, meta.screen_id, v.version);
      if (rec) versions.push(rec);
    }
    screens.push({
      meta: stripPosition(meta),
      current: await repo.getCurrentVersion(pid, meta.screen_id),
      versions,
    });
  }
  return {
    schema: 'm3studio/backup@1',
    created_at: now(),
    project: stripPosition(project),
    screens,
    flow: await repo.getFlow(pid),
    canvas: await repo.getCanvas(pid),
    design_revisions: await repo.listDesignRevisions(pid),
  };
}

function stripPosition(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { x, y, width, height, ...rest } = obj;
  return rest;
}

/** 项目校验（API-027）：返回错误路径与修复建议，不写盘 */
export async function validateProject(repo, pid) {
  const project = await repo.getProject(pid);
  const metas = await repo.listScreens(pid);
  const flow = await repo.getFlow(pid);
  const canvas = await repo.getCanvas(pid);
  const issues = [];
  if (!project) return { ok: false, issues: [{ path: 'project', code: 'NOT_FOUND', message: '项目不存在' }] };
  if (project.schema_version !== 2) {
    issues.push({ path: 'project.schema_version', code: 'SCHEMA_VERSION', message: '建议运行 npm run migrate:v2 升级到存储 v2' });
  }
  const seen = new Set();
  for (const meta of metas) {
    if (seen.has(meta.screen_id)) issues.push({ path: `screens.${meta.screen_id}`, code: 'DUPLICATE', message: '屏幕 id 重复' });
    seen.add(meta.screen_id);
    if (!meta.format) issues.push({ path: `screens.${meta.screen_id}.format`, code: 'REQUIRED', message: '缺少 format；迁移会补为 node-tree' });
    if (!canvas.screens?.[meta.screen_id]) {
      issues.push({ path: `canvas.screens.${meta.screen_id}`, code: 'MISSING_POSITION', message: '缺少画布坐标，迁移会按网格补齐' });
    }
    const cur = await repo.getCurrentVersion(pid, meta.screen_id);
    if (meta.current_version > 0 && !cur) {
      issues.push({ path: `screens.${meta.screen_id}.versions`, code: 'MISSING_VERSION', message: `当前版本 v${meta.current_version} 文件缺失` });
    }
    if (cur?.doc?.format === 'node-tree') {
      issues.push({ path: `screens.${meta.screen_id}.format`, code: 'LEGACY_READONLY', message: '旧 node-tree 屏幕为只读；如需编辑请先调用 /convert' });
    }
  }
  const screenIds = new Set(metas.map((s) => s.screen_id));
  for (const edge of flow.edges) {
    if (!screenIds.has(edge.source_screen_id)) {
      issues.push({ path: `flow.${edge.edge_id}.source_screen_id`, code: 'ORPHAN', message: '源屏不存在（动态孤儿边，不阻塞）' });
    }
    if (edge.trigger === 'swipe' && !edge.direction) {
      issues.push({ path: `flow.${edge.edge_id}.direction`, code: 'SWIPE_DIRECTION_REQUIRED', message: 'swipe 边缺少 direction' });
    }
  }
  return {
    ok: issues.filter((i) => !['ORPHAN', 'LEGACY_READONLY'].includes(i.code)).length === 0,
    issues,
    counts: { screens: metas.length, edges: flow.edges.length, positions: Object.keys(canvas.screens ?? {}).length },
  };
}
