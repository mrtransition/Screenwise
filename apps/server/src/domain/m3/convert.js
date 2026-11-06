/**
 * M3E Doc ↔ ScreenDoc / FlowEdge 转换（M0 spike）
 *
 * 目标不是一次实现完整迁移器，而是把最危险的契约先跑通：
 *  - 一个 M3E `frame` → 一个 `ScreenDoc`，组坐标转为屏幕本地坐标；
 *  - `item.action/actions/frame.swipe` → `FlowEdge`，ScreenDoc 内不再保留；
 *  - 导出时按 `FlowEdge` 注回 action/swipe，且不包含服务端字段；
 *  - 同一输入产生同一输出（确定性），id 冲突可重映射并报告。
 */

import {
  SCREEN_SCHEMA,
  PROJECT_SCHEMA,
  FLOW_SCHEMA_VERSION,
  PHONE,
  SWIPE_TRANSITION,
  SWIPE_DIR_SET,
  TRANSITION_SET,
  SLOT_PATTERN,
} from './constants.js';
import { assertM3eDoc, assertScreenDoc, normalizeProjectDesign, normalizeTheme, validateProjectDesign, M3SchemaError } from './schema.js';
import { KIND_SPEC } from './registry.js';

const GAP = 3;

/** 尺寸来自唯一的 KIND_SPEC（§12.5 Registry），避免 M0 的两份近似表继续漂移 */
const DEFAULT_W = Object.fromEntries(Object.entries(KIND_SPEC).map(([k, s]) => [k, s.w]));
const DEFAULT_H = Object.fromEntries(Object.entries(KIND_SPEC).map(([k, s]) => [k, s.h]));

const ID_RE = /^[a-zA-Z_][\w-]*$/;

/** FNV-1a 32 位，足够生成稳定短 id / 去重键 */
export function stableHash(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function makeEdgeId(parts) {
  return `edg_${stableHash(Array.isArray(parts) ? parts.join('|') : parts)}`;
}

export function itemSize(item, widths = {}, frameW = 0) {
  if (item.kind === 'text') {
    // 文本型部件的 size 是字号，宽度由内容估算（FR-M3-012 的确定性兜底）
    const fs = Number.isFinite(item.size) ? item.size : 16;
    const est = widths[item.id] ?? Math.max(80, Math.round(String(item.label ?? '').length * fs * 0.62));
    // 长文案估算宽度会超过屏宽，同样夹到可用宽度，避免文本越过右边界被裁
    const w = frameW > 0 ? Math.min(Number(est), frameW) : Number(est);
    return { w, h: Math.round(fs * 1.3) };
  }
  // Registry 默认宽度按 412 预设；屏宽更窄时夹到屏内，避免与前端渲染/导出不一致
  const fallbackW = DEFAULT_W[item.kind] ?? 120;
  const defaultW = frameW > 0 ? Math.min(fallbackW, frameW) : fallbackW;
  const explicit = Number.isFinite(item.size) ? item.size : widths[item.id];
  // 模型经常照抄 412 预设，把宽度显式写成 380 / 412。显式宽度同样要夹到可用宽度，
  // 否则内容宽于屏幕，右侧被裁掉一截（屏宽 375 时卡片直接溢出到 396+）。
  // frameW 在这里是「组可用的剩余宽度」：组的 x 偏移已被扣掉，夹取后不会越过右边界。
  const w = explicit === undefined ? defaultW : frameW > 0 ? Math.min(explicit, frameW) : explicit;
  let h = item.size2 ?? DEFAULT_H[item.kind] ?? 40;
  return { w: Number(w), h: Number(h) };
}

/**
 * 一个组的近似布局（与 m3e-canvas `layoutOf` 同构）。
 *
 * 自由组有两种输入：
 *  - M3E 原始 Doc：`group.free=true` + `group.pos[itemId]` 相对偏移；
 *  - ScreenDoc：`group.axis="free"` + `Item.pos` 屏幕本地绝对坐标。
 * 两者都在这里归一为绝对坐标。
 */
export function groupLayout(group, widths = {}, frameW = 0) {
  const out = [];
  const isFree = group.free === true || group.axis === 'free';
  // 可用宽度扣掉组的横向偏移，保证 x>0 的组也不会越出屏右边界
  const availW = frameW > 0 ? Math.max(40, frameW - Math.max(0, Number(group.x) || 0)) : 0;
  let off = 0;
  for (let index = 0; index < group.items.length; index++) {
    const item = group.items[index];
    if (isFree) {
      // 自由组的 Item 各有自己的绝对坐标，剩余宽度必须按自身 x 算，
      // 否则 x>0 的部件按整屏宽夹取后仍会探出右边界
      const pos = item.pos && Number.isFinite(item.pos.x) && Number.isFinite(item.pos.y)
        ? item.pos
        : { x: group.x + (group.pos?.[item.id]?.x ?? 0), y: group.y + (group.pos?.[item.id]?.y ?? 0) };
      const room = frameW > 0 ? Math.max(40, frameW - Math.max(0, Number(pos.x) || 0)) : 0;
      const size = itemSize(item, widths, room);
      out.push({ item, index, x: pos.x, y: pos.y, ...size });
      continue;
    }
    const size = itemSize(item, widths, availW);
    out.push({
      item,
      index,
      x: group.axis === 'x' ? group.x + off : group.x,
      y: group.axis === 'x' ? group.y : group.y + off,
      ...size,
    });
    off += (group.axis === 'x' ? size.w : size.h) + GAP;
  }
  return out;
}

export function groupBounds(group, widths = {}) {
  let l = group.x;
  let t = group.y;
  let r = group.x;
  let b = group.y;
  for (const p of groupLayout(group, widths)) {
    l = Math.min(l, p.x);
    t = Math.min(t, p.y);
    r = Math.max(r, p.x + p.w);
    b = Math.max(b, p.y + p.h);
  }
  return { l, t, r, b };
}

export function frameRect(frame) {
  const w = frame.w ?? PHONE.w;
  const h = frame.h ?? PHONE.h;
  return { l: frame.x, t: frame.y, r: frame.x + w, b: frame.y + Math.max(frame.length ?? 0, h) };
}

/** 与 m3e-canvas `frameOfGroup` 一致：组的中心落在哪个 frame 内 */
export function frameOfGroup(group, frames, widths = {}) {
  const bb = groupBounds(group, widths);
  const cx = (bb.l + bb.r) / 2;
  const cy = (bb.t + bb.b) / 2;
  return frames.find((f) => {
    const fr = frameRect(f);
    return cx >= fr.l && cx <= fr.r && cy >= fr.t && cy <= fr.b;
  });
}

function uniqueId(prefix, base, used) {
  const seed = base && ID_RE.test(base) ? base : `${prefix}_${stableHash(base ?? prefix)}`;
  if (!used.has(seed)) return seed;
  let next = `${seed}_${stableHash(`${seed}|${used.size}`)}`;
  let n = 2;
  while (used.has(next)) next = `${seed}_${stableHash(`${seed}|${n++}`)}`;
  return next;
}

/** 强制生成新 id（用于保留 id 冲突 / 非法 id） */
function freshId(prefix, base, used) {
  let next = `${prefix}_${stableHash(base ?? prefix)}`;
  let n = 2;
  while (used.has(next)) next = `${prefix}_${stableHash(`${base ?? prefix}|${n++}`)}`;
  return next;
}

function transitionOf(action) {
  return TRANSITION_SET.has(action?.transition) ? action.transition : 'none';
}

function edgeFromAction({
  sourceScreenId,
  sourceItemId,
  sourceSlot,
  action,
  trigger,
  direction,
  now,
  actor,
  targetIdOf,
}) {
  const to = action?.to;
  let targetKind = 'screen';
  let targetScreenId = null;
  let url = null;

  if (to === 'back') {
    targetKind = 'back';
  } else if (to === 'link') {
    targetKind = 'link';
    url = typeof action.url === 'string' ? action.url : null;
  } else {
    targetScreenId = targetIdOf(to) ?? to ?? null;
  }

  const effectiveTrigger = trigger ?? 'click';
  const effectiveDirection = effectiveTrigger === 'swipe' && SWIPE_DIR_SET.has(direction) ? direction : null;

  return {
    edge_id: makeEdgeId([
      sourceScreenId,
      sourceItemId ?? '',
      sourceSlot ?? '',
      targetKind,
      targetScreenId ?? '',
      url ?? '',
      effectiveTrigger,
      effectiveDirection ?? '',
    ]),
    source_screen_id: sourceScreenId,
    source_item_id: sourceItemId ?? null,
    source_slot: sourceSlot ?? null,
    target_kind: targetKind,
    target_screen_id: targetScreenId,
    url,
    trigger: effectiveTrigger,
    direction: effectiveDirection,
    transition: transitionOf(action),
    note: '',
    status: 'confirmed',
    expires_at: null,
    created_at: now,
    created_by: actor,
  };
}

/**
 * 导入 M3E `Doc`。
 *
 * @param {object} doc
 * @param {{now?: string, actor?: string, widths?: Record<string, number>, reservedScreenIds?: string[]}} [opts]
 * @returns {{design: object, design_tokens: object, screens: Array<{screen_id:string,title:string,order:number,doc:object}>, edges: object[], warnings: object[], loss: object[], id_map: object}}
 */
export function importM3eProject(doc, opts = {}) {
  assertM3eDoc(doc);
  const now = opts.now ?? new Date().toISOString();
  const actor = opts.actor ?? 'local-user';
  const widths = opts.widths ?? {};
  const warnings = [];
  const loss = [];
  const idMap = { screens: {}, groups: {}, items: {} };
  const reserved = new Set(opts.reservedScreenIds ?? []);

  const frames = doc.frames;
  const usedScreenIds = new Set();
  const frameScreenId = new Map();

  for (const frame of frames) {
    let sid = frame.id;
    if (reserved.has(sid) || !ID_RE.test(sid)) {
      const next = freshId('scr', sid, usedScreenIds);
      idMap.screens[sid] = next;
      warnings.push({ code: 'SCREEN_ID_REMAPPED', from: sid, to: next, reason: reserved.has(sid) ? 'conflict' : 'invalid' });
      sid = next;
    }
    usedScreenIds.add(sid);
    frameScreenId.set(frame.id, sid);
  }

  const targetIdOf = (frameId) => frameScreenId.get(frameId) ?? null;

  /** 组归属：中心落在 frame 内；否则进入“未放置”屏 */
  const owned = new Map(frames.map((f) => [f.id, []]));
  const unplaced = [];
  for (const group of doc.groups) {
    const owner = frameOfGroup(group, frames, widths);
    if (owner) owned.get(owner.id).push(group);
    else {
      unplaced.push(group);
      warnings.push({ code: 'GROUP_UNPLACED', group_id: group.id, message: '组不属于任何 frame，已放入“未放置”屏' });
    }
  }

  const edges = [];
  const edgeSeen = new Set();
  const pushEdge = (edge) => {
    if (edgeSeen.has(edge.edge_id)) return;
    edgeSeen.add(edge.edge_id);
    edges.push(edge);
  };

  const buildScreen = (frame, groups, screenId, title, order) => {
    const usedGroupIds = new Set();
    const usedItemIds = new Set();
    const builtGroups = [];
    let convertedActions = 0;

    for (const originalGroup of groups) {
      const group = structuredClone(originalGroup);
      const gid = uniqueId('grp', group.id, usedGroupIds);
      if (gid !== group.id) {
        idMap.groups[group.id] = gid;
        warnings.push({ code: 'GROUP_ID_REMAPPED', from: group.id, to: gid });
      }
      usedGroupIds.add(gid);
      group.id = gid;
      group.x = (group.x ?? 0) - (frame?.x ?? 0);
      group.y = (group.y ?? 0) - (frame?.y ?? 0);

      /* 自由组归一：M3E `free + pos[itemId]` → ScreenDoc `axis:"free" + Item.pos` */
      const isFreeGroup = group.free === true || group.axis === 'free';
      const offsets = isFreeGroup && group.pos && typeof group.pos === 'object' ? group.pos : {};
      if (isFreeGroup) {
        group.axis = 'free';
        group.pos = { x: group.x, y: group.y };
      } else {
        group.axis = group.axis === 'y' ? 'y' : 'x';
        delete group.pos;
      }
      delete group.free;

      const items = [];
      for (const originalItem of group.items) {
        const item = structuredClone(originalItem);
        const iid = uniqueId('itm', item.id, usedItemIds);
        if (iid !== item.id) {
          idMap.items[`${screenId}/${item.id}`] = iid;
          warnings.push({ code: 'ITEM_ID_REMAPPED', screen_id: screenId, from: item.id, to: iid });
        }
        usedItemIds.add(iid);
        item.id = iid;

        if (isFreeGroup) {
          const offset = offsets[originalItem.id] ?? { x: 0, y: 0 };
          item.pos = { x: group.x + (offset.x ?? 0), y: group.y + (offset.y ?? 0) };
        } else {
          delete item.pos;
        }

        /* 导航转 FlowEdge，再从 ScreenDoc 剥离 */
        if (item.action) {
          pushEdge(edgeFromAction({ sourceScreenId: screenId, sourceItemId: iid, sourceSlot: null, action: item.action, now, actor, targetIdOf }));
          convertedActions++;
        }
        if (item.actions && typeof item.actions === 'object') {
          for (const [slot, action] of Object.entries(item.actions)) {
            pushEdge(edgeFromAction({ sourceScreenId: screenId, sourceItemId: iid, sourceSlot: slot, action, now, actor, targetIdOf }));
            convertedActions++;
          }
        }
        delete item.action;
        delete item.actions;
        /* AI 改写历史不属于设计文档，也不应进入导出/分享 */
        delete item.noteHistory;
        items.push(item);
      }
      group.items = items;
      builtGroups.push(group);
    }

    /* frame.swipe → FlowEdge；source_slot 为空，方向写入 direction（V4.1） */
    if (frame?.swipe && typeof frame.swipe === 'object') {
      for (const [dir, target] of Object.entries(frame.swipe)) {
        if (!SWIPE_DIR_SET.has(dir)) {
          warnings.push({ code: 'SWIPE_DIR_INVALID', screen_id: screenId, direction: dir });
          continue;
        }
        pushEdge(
          edgeFromAction({
            sourceScreenId: screenId,
            sourceItemId: null,
            sourceSlot: null,
            action: { to: target, transition: SWIPE_TRANSITION[dir] ?? 'slide' },
            trigger: 'swipe',
            direction: dir,
            now,
            actor,
            targetIdOf,
          })
        );
        convertedActions++;
      }
    }

    const screenDoc = {
      schema: SCREEN_SCHEMA,
      format: 'm3',
      frame: {
        id: screenId,
        name: title,
        x: 0,
        y: 0,
        w: frame?.w ?? PHONE.w,
        h: frame?.h ?? PHONE.h,
        ...(frame?.bg !== undefined ? { bg: frame.bg } : {}),
        ...(frame?.note !== undefined ? { note: frame.note } : {}),
        ...(frame?.length !== undefined ? { length: frame.length } : {}),
        ...(frame?.place !== undefined ? { place: frame.place } : {}),
      },
      groups: builtGroups,
      meta: { source_format: 'm3e-canvas@0.1', imported_at: now },
    };
    assertScreenDoc(screenDoc, `导入屏幕 ${screenId}`);

    return {
      screen_id: screenId,
      title,
      order,
      doc: screenDoc,
      converted_actions: convertedActions,
    };
  };

  const screens = frames.map((frame, index) =>
    buildScreen(frame, owned.get(frame.id) ?? [], frameScreenId.get(frame.id), frame.name, index)
  );

  if (unplaced.length) {
    let screenId;
    do {
      screenId = uniqueId('scr', 'scr_unplaced', usedScreenIds);
      usedScreenIds.add(screenId);
    } while (reserved.has(screenId));
    /* 未放置屏也要用本地坐标：以所有未归属组的包围盒为原点，
     * 否则导出后这些组仍落在 frame 外，往返会再生成一个“未放置”屏。 */
    const boxes = unplaced.map((g) => groupBounds(g, widths));
    const minX = Math.min(...boxes.map((b) => b.l));
    const minY = Math.min(...boxes.map((b) => b.t));
    const maxR = Math.max(...boxes.map((b) => b.r));
    const maxB = Math.max(...boxes.map((b) => b.b));
    const synthetic = {
      id: screenId,
      name: '未放置',
      x: minX,
      y: minY,
      w: Math.max(PHONE.w, Math.ceil(maxR - minX)),
      h: Math.max(PHONE.h, Math.ceil(maxB - minY)),
      note: '导入时未归属任何 frame 的组',
    };
    screens.push(buildScreen(synthetic, unplaced, screenId, '未放置', screens.length));
    idMap.screens.scr_unplaced = screenId;
  }

  const design = normalizeProjectDesign({
    title: doc.title,
    brief: doc.brief,
    platform: doc.platform,
    paletteKey: doc.paletteKey,
    customPalette: doc.customPalette,
    dynamicColor: doc.dynamicColor,
    theme: doc.theme,
    promptOptions: doc.promptOptions,
    promptEdit: doc.promptEdit,
  });

  const designIssues = validateProjectDesign(design);
  if (designIssues.length) throw new M3SchemaError(designIssues, 'ProjectDesign');

  return {
    design,
    design_tokens: deriveDesignTokens(design),
    screens,
    edges,
    warnings,
    loss,
    id_map: idMap,
  };
}

/** 主题 → 派生设计 token（非权威，供旧 UI / Prompt 兼容） */
export function deriveDesignTokens(design) {
  const theme = normalizeTheme(design?.theme);
  const palette = design?.customPalette ?? {};
  const radius = theme.shape === 'square' ? 8 : theme.shape === 'full' ? 28 : 16;
  const fontFamily =
    theme.font === 'robotoFlex'
      ? "'Roboto Flex', Roboto, system-ui, sans-serif"
      : theme.font === 'robotoSerif'
        ? "'Roboto Serif', Georgia, serif"
        : theme.font === 'system'
          ? "system-ui, -apple-system, 'Segoe UI', sans-serif"
          : 'Roboto, system-ui, sans-serif';
  return {
    colors: {
      primary: typeof palette.primary === 'string' ? palette.primary : '#6750A4',
      surface: '#FEF7FF',
    },
    radius: { sm: Math.max(4, radius / 2), md: radius, lg: radius * 1.75 },
    font: { base: 16, family: fontFamily },
  };
}

function normalizeItemForExport(item) {
  const next = { ...item };
  delete next.action;
  delete next.actions;
  delete next.noteHistory;
  /* M3E 不认识服务端图层字段；自由组坐标已折算为 group.pos 映射 */
  delete next.name;
  delete next.hidden;
  delete next.locked;
  delete next.pos;
  next.label = typeof next.label === 'string' ? next.label : '';
  next.icon = next.icon === undefined ? null : next.icon;
  next.variant = next.variant ?? 'filled';
  return next;
}

/**
 * 构建孤儿边判定上下文。孤儿状态只在这里计算，绝不写回 `flow.json`（DC-039）。
 * @param {Array<object>} screens `{doc}` 或 ScreenDoc
 */
export function createOrphanContext(screens = []) {
  const screenIds = new Set();
  const itemIdsByScreen = new Map();
  for (const entry of screens) {
    const doc = entry?.doc ?? entry;
    const sid = doc?.frame?.id;
    if (!sid) continue;
    screenIds.add(sid);
    const ids = new Set();
    for (const group of doc.groups ?? []) {
      for (const item of group.items ?? []) {
        if (item && typeof item.id === 'string' && item.id) ids.add(item.id);
      }
    }
    itemIdsByScreen.set(sid, ids);
  }
  return { screenIds, itemIdsByScreen };
}

/**
 * 动态计算一条边的孤儿状态（FR-FLOW-007）。
 * @returns {{source_missing:boolean,target_missing:boolean,item_missing:boolean,slot_missing:boolean,orphan:boolean}}
 */
export function computeEdgeOrphan(edge, context) {
  const reasons = {
    source_missing: false,
    target_missing: false,
    item_missing: false,
    slot_missing: false,
  };
  if (!context.screenIds.has(edge.source_screen_id)) reasons.source_missing = true;
  if (edge.source_item_id) {
    const items = context.itemIdsByScreen.get(edge.source_screen_id);
    if (!items || !items.has(edge.source_item_id)) reasons.item_missing = true;
  }
  if (edge.target_kind === 'screen' && !context.screenIds.has(edge.target_screen_id)) {
    reasons.target_missing = true;
  }
  if (edge.source_slot && !SLOT_PATTERN.test(edge.source_slot)) reasons.slot_missing = true;
  return { ...reasons, orphan: Object.values(reasons).some(Boolean) };
}

function actionForEdge(edge) {
  if (edge.target_kind === 'back') return { to: 'back', transition: edge.transition ?? 'none' };
  if (edge.target_kind === 'link') return { to: 'link', transition: edge.transition ?? 'none', url: edge.url ?? '' };
  if (edge.target_kind === 'screen') return { to: edge.target_screen_id, transition: edge.transition ?? 'none' };
  /* menu / toggle 仍以目标屏表达；无目标时跳过，避免导出不可打开的 action */
  return edge.target_screen_id ? { to: edge.target_screen_id, transition: edge.transition ?? 'none' } : null;
}

/**
 * 导出 M3E `Doc`。
 *
 * @param {{
 *   design: object,
 *   screens: Array<object>,
 *   edges?: object[],
 *   positions?: Record<string,{x:number,y:number}>,
 *   includeHidden?: boolean
 * }} input
 */
export function exportM3eProject(input) {
  const design = normalizeProjectDesign(input.design);
  const designIssues = validateProjectDesign(design);
  if (designIssues.length) throw new M3SchemaError(designIssues, 'ProjectDesign');

  const edges = Array.isArray(input.edges) ? input.edges : [];
  const positions = input.positions ?? {};
  const includeHidden = input.includeHidden === true;
  const orphanContext = createOrphanContext(input.screens ?? []);

  /* 边按稳定顺序处理，保证导出可重复 */
  const orderedEdges = [...edges].sort((a, b) =>
    `${a.source_screen_id}\u0000${a.source_item_id ?? ''}\u0000${a.source_slot ?? ''}\u0000${a.direction ?? ''}\u0000${a.edge_id}`.localeCompare(
      `${b.source_screen_id}\u0000${b.source_item_id ?? ''}\u0000${b.source_slot ?? ''}\u0000${b.direction ?? ''}\u0000${b.edge_id}`
    )
  );

  const edgesBySource = new Map();
  const swipeByScreen = new Map();
  const warnings = [];

  for (const edge of orderedEdges) {
    if (edge.status && edge.status !== 'confirmed') continue;

    const orphan = computeEdgeOrphan(edge, orphanContext);
    if (orphan.orphan) {
      warnings.push({ code: 'EDGE_SKIPPED', edge_id: edge.edge_id, reason: 'orphan', detail: orphan });
      continue;
    }

    if (edge.trigger === 'swipe') {
      const dir = edge.direction;
      if (!SWIPE_DIR_SET.has(dir) || !edge.target_screen_id) {
        warnings.push({
          code: 'SWIPE_DIRECTION_REQUIRED',
          edge_id: edge.edge_id,
          reason: 'swipe 边缺少 direction 或目标屏',
        });
        continue;
      }
      if (!swipeByScreen.has(edge.source_screen_id)) swipeByScreen.set(edge.source_screen_id, {});
      const bucket = swipeByScreen.get(edge.source_screen_id);
      if (bucket[dir] && bucket[dir] !== edge.target_screen_id) {
        warnings.push({
          code: 'EDGE_CONFLICT',
          edge_id: edge.edge_id,
          reason: `同一屏同一方向已有 swipe 边: ${dir}`,
        });
        continue;
      }
      bucket[dir] = edge.target_screen_id;
      continue;
    }

    const action = actionForEdge(edge);
    if (!action) {
      warnings.push({ code: 'EDGE_SKIPPED', edge_id: edge.edge_id, reason: 'menu/toggle 边缺少目标屏' });
      continue;
    }
    if (!edge.source_item_id) {
      warnings.push({ code: 'EDGE_SKIPPED', edge_id: edge.edge_id, reason: '缺少 source_item_id' });
      continue;
    }
    const key = `${edge.source_screen_id}\u0000${edge.source_item_id}`;
    if (!edgesBySource.has(key)) edgesBySource.set(key, []);
    edgesBySource.get(key).push({ slot: edge.source_slot ?? null, action });
  }

  const frames = [];
  const groups = [];

  for (const entry of input.screens ?? []) {
    const doc = entry?.doc ?? entry;
    assertScreenDoc(doc, `导出屏幕 ${doc?.frame?.id ?? '?'}`);
    const sid = doc.frame.id;
    const pos = positions[sid] ?? { x: 0, y: 0 };
    const frame = {
      id: sid,
      name: doc.frame.name,
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      w: doc.frame.w ?? PHONE.w,
      h: doc.frame.h ?? PHONE.h,
      ...(doc.frame.bg !== undefined ? { bg: doc.frame.bg } : {}),
      ...(doc.frame.note !== undefined ? { note: doc.frame.note } : {}),
      ...(doc.frame.length !== undefined ? { length: doc.frame.length } : {}),
      ...(doc.frame.place !== undefined ? { place: doc.frame.place } : {}),
    };
    const swipes = swipeByScreen.get(sid);
    if (swipes && Object.keys(swipes).length) frame.swipe = swipes;
    frames.push(frame);

    for (const originalGroup of doc.groups) {
      if (originalGroup.hidden && !includeHidden) continue;

      const group = structuredClone(originalGroup);
      const isFree = group.axis === 'free' || group.free === true;
      group.x = (group.x ?? 0) + frame.x;
      group.y = (group.y ?? 0) + frame.y;

      if (isFree) {
        /* ScreenDoc 的 Item.pos 是屏幕本地绝对坐标 → M3E group.pos 相对偏移 */
        const offsets = {};
        for (const item of group.items) {
          const p = item.pos ?? { x: group.x, y: group.y };
          offsets[item.id] = { x: p.x - group.x, y: p.y - group.y };
        }
        group.axis = 'x';
        group.free = true;
        group.pos = offsets;
      } else {
        group.axis = group.axis === 'y' ? 'y' : 'x';
        delete group.free;
        delete group.pos;
      }
      delete group.name;
      delete group.hidden;

      group.items = group.items
        .filter((item) => includeHidden || !item.hidden)
        .map((originalItem) => {
          const item = normalizeItemForExport(originalItem);
          const actions = edgesBySource.get(`${sid}\u0000${item.id}`) ?? [];
          for (const { slot, action } of actions) {
            if (!slot) item.action = action;
            else {
              if (!item.actions) item.actions = {};
              item.actions[slot] = action;
            }
          }
          return item;
        });

      if (group.items.length === 0) continue;
      groups.push(group);
    }
  }

  const doc = {
    groups,
    frames,
    paletteKey: design.paletteKey,
    ...(design.customPalette ? { customPalette: design.customPalette } : {}),
    dynamicColor: design.dynamicColor,
    frame: frames.some((f) => (f.w ?? PHONE.w) === PHONE.w && (f.h ?? PHONE.h) === PHONE.h) ? 'phone' : 'blank',
    platform: design.platform,
    title: design.title,
    brief: design.brief,
    ...(design.promptEdit !== null ? { promptEdit: design.promptEdit } : {}),
    ...(design.promptOptions.length ? { promptOptions: design.promptOptions } : {}),
    theme: normalizeTheme(design.theme),
  };

  assertM3eDoc(doc, '导出 M3E Doc');
  return { doc, warnings };
}

/** 项目聚合文档：M3E Doc + schema 标记，供 Prompt/导出复用 */
export function assembleProjectDoc(input) {
  const { doc } = exportM3eProject(input);
  return { schema: PROJECT_SCHEMA, ...doc };
}

/** 空 ScreenDoc 基线（M1 建屏时复用） */
export function emptyScreenDoc({ screenId, title = '未命名屏幕', width = PHONE.w, height = PHONE.h } = {}) {
  return {
    schema: SCREEN_SCHEMA,
    format: 'm3',
    frame: { id: screenId, name: title, x: 0, y: 0, w: width, h: height },
    groups: [],
    meta: {},
  };
}

/** 空 flow 基线 */
export function emptyFlow() {
  return { schema_version: FLOW_SCHEMA_VERSION, edges: [] };
}

export { ID_RE };
