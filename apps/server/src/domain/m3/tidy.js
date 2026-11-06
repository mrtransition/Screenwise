/**
 * Tidy：基于规则的确定性自动布局（FR-EDIT-009 / API-024 / AC-303 / DC-038）
 *
 * 只改「位置 / 连接 / 圆角」，不改文案、顺序与尺寸（圆角除外）：
 *  - 栏位吸附：顶栏贴顶、底栏/导航贴底、水平整宽部件贴左右 16dp；
 *  - 同族连接：相邻同类族（按钮组、卡片列、列表、表单列）间距压到 16dp；
 *  - 边距统一 16dp，组间纵向间距 16dp；
 *  - 圆角统一按项目形状（square / rounded / full）写入 `corners`；
 *  - 自由组与 locked 组不参与（DC-038 / FR-M3-003）。
 *
 * 纯函数：同一输入必然得到同一输出（FR-RENDER-002 的确定性要求），
 * 返回新文档，不修改入参。
 */

import { groupLayout, itemSize } from './convert.js';
import { KIND_SPEC } from './registry.js';

/** 统一边距（SRS §12.5 Tidy 规则：16dp） */
export const TIDY_MARGIN = 16;
/** 组间纵向间距 */
const GROUP_GAP = 16;
/** 栏位吸附判定容差 */
const SNAP_TOLERANCE = 24;

/** 圆角按形状映射（与渲染器 themeVars 的 radius 档位一致；schema 要求 `{tl,tr,bl,br}` 对象） */
function cornersForShape(shape, w, h) {
  const short = Math.min(w ?? 0, h ?? 0);
  const radius = shape === 'square' ? 0 : shape === 'full' ? Math.round(short / 2) : 12;
  return { tl: radius, tr: radius, bl: radius, br: radius };
}
/** 栏类族：整宽、贴栏位（顶栏/底栏/标签栏/工具栏/搜索栏） */
const BAR_FAMILIES = new Set(['appbar', 'nav']);
/** 无圆角语义的 kind，不写 corners */
const NO_RADIUS_KINDS = new Set(['divider', 'linearProgress', 'text']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const same = (a, b) => Math.abs(a - b) < 0.5;

function isTopPlace(place) {
  return place === 'top' || place === 'sticky-top';
}
function isBottomPlace(place) {
  return place === 'bottom' || place === 'sticky-bottom';
}

/**
 * @param {object} doc    ScreenDoc
 * @param {object} opts   { shape?: 'square'|'rounded'|'full' }
 * @returns {{ doc: object, changes: Array<{group_id, item_id?, before, after, reason}> }}
 */
export function tidyDoc(doc, { shape = 'rounded' } = {}) {
  if (!doc || doc.format !== 'm3' || !Array.isArray(doc.groups)) {
    return { doc, changes: [] };
  }
  const frame = doc.frame ?? {};
  const W = Number(frame.w) || 412;
  const H = Number(frame.h) || 892;
  const length = Math.max(Number(frame.length) || H, H);
  const place = frame.place ?? 'top';


  const next = structuredClone(doc);
  const changes = [];
  const push = (group_id, item_id, before, after, reason) => {
    changes.push({ group_id, item_id: item_id ?? null, before, after, reason });
  };

  const usable = next.groups.filter((g) => g.axis !== 'free' && g.free !== true && !g.locked);

  // ---- 1) 组级栏位吸附：顶/底栏先固定，再排中间流 ----
  const flow = [];
  let cursorY = TIDY_MARGIN;
  for (const g of usable) {
    const bounds = groupBoundsOf(g);
    if (isBottomPlace(place) && isFooterBar(g, bounds, H)) {
      const targetX = isBarGroup(g) ? 0 : TIDY_MARGIN;
      if (isBarGroup(g)) writeFullWidth(g, W, changes);
      const after = groupBoundsOf(g);
      const targetY = H - (after.b - after.t);
      if (!same(g.x, targetX) || !same(g.y, targetY)) {
        push(g.id, null, { x: g.x, y: g.y }, { x: targetX, y: targetY }, '底栏贴底');
        g.x = targetX;
        g.y = targetY;
      }
      continue;
    }
    if (isTopPlace(place) && bounds.t <= SNAP_TOLERANCE && isBarGroup(g)) {
      // 顶部栏位：整宽、贴顶（只对栏类族生效，普通内容不会被吸到 0,0）
      const targetX = 0;
      const targetY = 0;
      if (!same(g.x, targetX) || !same(g.y, targetY)) {
        push(g.id, null, { x: g.x, y: g.y }, { x: targetX, y: targetY }, '顶栏贴顶');
        g.x = targetX;
        g.y = targetY;
      }
      if (isBarGroup(g)) writeFullWidth(g, W, changes);
      cursorY = Math.max(cursorY, groupBoundsOf(g).b + GROUP_GAP);
      continue;
    }
    flow.push(g);
  }

  // ---- 2) 中间流：自上而下、16dp 组间距、左对齐 16dp ----
  for (const g of flow) {
    const horizontalFull = isBarGroup(g);
    const targetX = horizontalFull ? 0 : TIDY_MARGIN;
    const dy = cursorY - groupBoundsOf(g).t;
    if (!same(g.x, targetX) || !same(dy, 0)) {
      push(g.id, null, { x: g.x, y: g.y }, { x: targetX, y: g.y + dy }, '栏位吸附 + 16dp 边距');
      g.x = targetX;
      g.y = g.y + dy;
    }
    if (horizontalFull) writeFullWidth(g, W, changes);

    // 同族连接：组内间距沿用共享布局规则；这里保证右边界不越出 16dp 安全区
    clampHangingRight(g, W, changes);
    cursorY = groupBoundsOf(g).b + GROUP_GAP;
  }
  void length;

  // ---- 3) 圆角统一（自由组保留自身样式，不参与） ----
  for (const g of next.groups) {
    if (g.locked || g.axis === 'free' || g.free === true) continue;
    for (const item of g.items ?? []) {
      if (item.locked || NO_RADIUS_KINDS.has(item.kind)) continue;
      const spec = KIND_SPEC[item.kind];
      if (!spec) continue;
      const size = itemSize(item);
      const corners = cornersForShape(shape, item.size ?? size.w, item.size2 ?? size.h);
      if (JSON.stringify(item.corners) !== JSON.stringify(corners)) {
        push(g.id, item.id, item.corners ?? null, corners, '圆角统一');
        item.corners = corners;
      }
    }
  }

  return { doc: next, changes };
}

function groupBoundsOf(g) {
  const rects = groupLayout(g);
  if (!rects.length) return { l: g.x, t: g.y, r: g.x, b: g.y };
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const p of rects) {
    l = Math.min(l, p.x);
    t = Math.min(t, p.y);
    r = Math.max(r, p.x + p.w);
    b = Math.max(b, p.y + p.h);
  }
  return { l, t, r, b };
}

/** 整宽部件：栏类（顶栏/底栏/标签栏/搜索栏）或本身接近屏宽 */
function isBarGroup(g) {
  return (g.items ?? []).some((i) => BAR_FAMILIES.has(KIND_SPEC[i.kind]?.family));
}

/**
 * 底栏判定：贴底（容差内）或「栏类族 + 位于下半屏」。
 * 后者覆盖用户从面板拖入底栏后随手放在页面中下部的情况。
 * 判定用语义族而非像素，避免部件宽度被临时修改后误判。
 */
function isFooterBar(g, bounds, H) {
  // 已贴顶的栏不是底栏（顶部应用栏被拖到底部时也不应误判）
  if (bounds.t <= SNAP_TOLERANCE) return false;
  if (bounds.b >= H - SNAP_TOLERANCE) return true;
  return isBarGroup(g) && bounds.t > H / 2;
}

function writeFullWidth(g, W, changes) {
  for (const item of g.items ?? []) {
    const spec = KIND_SPEC[item.kind];
    if (!spec || !BAR_FAMILIES.has(spec.family)) continue;
    if (item.locked) continue;
    if (item.size !== W) {
      changes.push({ group_id: g.id, item_id: item.id, before: item.size ?? null, after: W, reason: '栏位吸附（整宽）' });
      item.size = W;
    }
  }
}

/**
 * 同族连接：组内间距由共享布局规则（`groupLayout`，与编辑器/导出同一份）决定，
 * Tidy 不重写它，而是保证「同族相邻组」之间的组间距恒为 16dp，
 * 并且横排组的右边界不出屏。
 *
 * 说明：直接改 Item 间距会迫使非自由组写 `Item.pos`，违反 DC-036；
 * 因此间距归一落在组坐标上，组内顺序与相对位置保持渲染器推导结果。
 */
function clampHangingRight(g, W, changes) {
  const bounds = groupBoundsOf(g);
  if (bounds.r <= W + 0.5) return;
  const overflow = bounds.r - (W - TIDY_MARGIN);
  const targetX = g.x - overflow;
  if (targetX < 0) return; // 自身比屏宽还宽，交给 schema 容差，不强行压缩
  changes.push({ group_id: g.id, item_id: null, before: { x: g.x }, after: { x: targetX }, reason: '右边界吸附' });
  g.x = targetX;
}
