/**
 * 共享渲染契约（FR-RENDER-001～005）
 *
 * 同一份 `ScreenDoc + Theme` 在编辑器缩略图、应用内预览、静态导出中必须产生一致的
 * 结构。服务端（Node）与浏览器共用本模块：它只做纯字符串拼装，不触碰 DOM、时间或
 * 随机数，因此同一输入永远得到同一输出（FR-RENDER-002）。
 *
 * 两种格式：
 *  - `format:"m3"`：M3 语义部件，走 M3 渲染器；
 *  - `format:"node-tree"`：旧 `{version, root}`，走独立只读渲染器，并做安全过滤。
 */

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const UNITLESS = new Set(['fontWeight', 'opacity', 'zIndex', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'strokeDasharray', 'strokeDashoffset']);

export function styleToCss(style = {}) {
  return Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      const value = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v;
      return `${prop}:${value}`;
    })
    .join(';');
}

/** 旧文档是否只读 node-tree（DC-020 / FR-M3-008） */
export function isLegacyDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.format === 'node-tree') return true;
  if (doc.format === 'm3') return false;
  return !!(doc.root && typeof doc.root === 'object');
}

export function docFormat(doc) {
  if (!doc) return null;
  if (doc.format === 'm3' || doc.format === 'node-tree') return doc.format;
  return doc.root ? 'node-tree' : null;
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

/** 与 m3e-canvas 一致的 7 套预设调色板 + 自定义种子色 */
export const PALETTES = Object.freeze({
  purple: { label: '紫罗兰', primary: '#6750A4', secondary: '#625B71', tertiary: '#7D5260', neutral: '#79747E' },
  blue: { label: '湖水蓝', primary: '#00639B', secondary: '#50606E', tertiary: '#5E5C7E', neutral: '#74777F' },
  green: { label: '森林绿', primary: '#3F6B4F', secondary: '#526350', tertiary: '#3C6470', neutral: '#5C5F5C' },
  orange: { label: '暖橙', primary: '#8B5000', secondary: '#725B3E', tertiary: '#5E5D7A', neutral: '#7A7570' },
  red: { label: '珊瑚红', primary: '#9C4146', secondary: '#775651', tertiary: '#705575', neutral: '#7A7574' },
  teal: { label: '薄荷青', primary: '#006A67', secondary: '#4A635F', tertiary: '#456179', neutral: '#74777A' },
  pink: { label: '玫瑰粉', primary: '#8E4585', secondary: '#735A6E', tertiary: '#7E5260', neutral: '#7C7478' },
  custom: { label: '自定义', primary: '#6750A4', secondary: '#625B71', tertiary: '#7D5260', neutral: '#79747E' },
});

const FONT_STACK = {
  roboto: "Roboto, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  robotoFlex: "'Roboto Flex', Roboto, system-ui, -apple-system, 'PingFang SC', sans-serif",
  robotoSerif: "'Roboto Serif', Georgia, 'Songti SC', 'SimSun', serif",
  system: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
};

const SHAPE_RADIUS = { square: 0, rounded: 16, full: 999 };

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return { r: 103, g: 80, b: 164 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function mix(a, b, ratio) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * ratio, g: x.g + (y.g - x.g) * ratio, b: x.b + (y.b - x.b) * ratio });
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function onColor(bg) {
  return luminance(bg) > 0.42 ? '#1D1B20' : '#FFFFFF';
}

/**
 * ProjectDesign → CSS 变量（FR-RENDER-003：渲染器只从主题取色，不硬编码）。
 * 纯函数：同一 design 永远产生同一组变量。
 */
export function themeVars(design = {}) {
  const theme = design.theme ?? {};
  const dark = theme.dark === true;
  const key = typeof design.paletteKey === 'string' && PALETTES[design.paletteKey] ? design.paletteKey : 'purple';
  const base = key === 'custom' && design.customPalette
    ? { ...PALETTES.custom, ...design.customPalette }
    : PALETTES[key];
  const primary = base.primary ?? PALETTES.purple.primary;
  const secondary = base.secondary ?? PALETTES.purple.secondary;
  const tertiary = base.tertiary ?? PALETTES.purple.tertiary;
  const neutral = base.neutral ?? PALETTES.purple.neutral;
  const radius = SHAPE_RADIUS[theme.shape] ?? 16;
  const contrast = theme.contrast === 'high' ? 1 : theme.contrast === 'medium' ? 0.6 : 0.35;

  const surface = dark ? '#141218' : '#FEF7FF';
  const surfaceLow = dark ? mix(surface, primary, 0.06) : mix(surface, primary, 0.03);
  const surfaceContainer = dark ? mix(surface, primary, 0.1) : mix(surface, primary, 0.06);
  const surfaceHigh = dark ? mix(surface, primary, 0.15) : mix(surface, primary, 0.09);
  const surfaceHighest = dark ? mix(surface, primary, 0.2) : mix(surface, primary, 0.12);
  const onSurface = dark ? mix('#E6E0E9', primary, 0.02) : '#1D1B20';
  const onSurfaceVariant = dark ? mix(onSurface, surface, 0.35) : '#49454F';

  const vars = {
    '--md-primary': primary,
    '--md-on-primary': onColor(primary),
    '--md-primary-container': dark ? mix(surface, primary, 0.45) : mix(primary, '#FFFFFF', 0.8),
    '--md-on-primary-container': dark ? mix('#FFFFFF', primary, 0.25) : mix(primary, '#000000', 0.55),
    '--md-secondary': secondary,
    '--md-secondary-container': dark ? mix(surface, secondary, 0.4) : mix(secondary, '#FFFFFF', 0.8),
    '--md-on-secondary-container': dark ? mix('#FFFFFF', secondary, 0.25) : mix(secondary, '#000000', 0.55),
    '--md-tertiary': tertiary,
    '--md-tertiary-container': dark ? mix(surface, tertiary, 0.4) : mix(tertiary, '#FFFFFF', 0.8),
    '--md-on-tertiary-container': dark ? mix('#FFFFFF', tertiary, 0.25) : mix(tertiary, '#000000', 0.55),
    '--md-surface': surface,
    '--md-surface-container-low': surfaceLow,
    '--md-surface-container': surfaceContainer,
    '--md-surface-container-high': surfaceHigh,
    '--md-surface-container-highest': surfaceHighest,
    '--md-on-surface': onSurface,
    '--md-on-surface-variant': onSurfaceVariant,
    '--md-outline': mix(onSurfaceVariant, surface, 0.4),
    '--md-outline-variant': mix(onSurfaceVariant, surface, 0.72),
    '--md-inverse-surface': dark ? mix('#E6E0E9', secondary, 0.06) : mix('#313033', secondary, 0.04),
    '--md-inverse-on-surface': dark ? '#313033' : '#F4EFF4',
    '--md-shadow': 'rgba(0,0,0,.28)',
    '--md-radius': `${radius}px`,
    '--md-radius-sm': `${Math.max(0, radius * 0.5)}px`,
    '--md-radius-lg': `${radius >= 999 ? radius : radius * 1.75}px`,
    '--md-font': FONT_STACK[theme.font] ?? FONT_STACK.roboto,
    '--md-contrast-border': contrast > 0.9 ? `1px solid ${mix(onSurfaceVariant, surface, 0.25)}` : 'none',
    '--md-neutral': neutral,
    '--md-motion': theme.motion === 'expressive' ? 'cubic-bezier(.2,.8,.2,1)' : 'ease',
  };
  return vars;
}

export function themeCss(design = {}) {
  return Object.entries(themeVars(design)).map(([k, v]) => `${k}:${v}`).join(';');
}

/* ------------------------------------------------------------------ */
/* M3 渲染器                                                           */
/* ------------------------------------------------------------------ */

const GAP = 3;

const KIND_SIZE = {
  box: [412, 220], bottomSheet: [412, 320], button: [128, 56], iconButton: [56, 56], fab: [56, 56],
  extendedFab: [128, 56], chip: [128, 32], topAppBar: [412, 88], bottomNav: [412, 104], navRail: [80, 892],
  searchBar: [380, 56], card: [380, 223], listItem: [380, 72], dialog: [312, 220], snackbar: [344, 48],
  textField: [380, 56], select: [380, 56], switch: [160, 48], checkbox: [128, 40], slider: [380, 44],
  text: [120, 40], image: [200, 200], camera: [200, 267], map: [200, 150], divider: [380, 1],
  loadingIndicator: [48, 48], linearProgress: [380, 4], circularProgress: [48, 48], splitButton: [128, 56],
  fabMenu: [128, 56], toolbar: [220, 56], tabs: [380, 48], radio: [128, 40], carousel: [380, 180],
  datePicker: [312, 400], timePicker: [328, 450],
};

function itemSize(item, frameW = 0) {
  if (item.kind === 'text') {
    const fs = Number.isFinite(item.size) ? item.size : 16;
    const est = Math.max(80, Math.round(String(item.label ?? '').length * fs * 0.62));
    return { w: frameW > 0 ? Math.min(est, frameW) : est, h: Math.round(fs * 1.3) };
  }
  const fallback = KIND_SIZE[item.kind] ?? [120, 40];
  // Registry 默认尺寸按 412 手机预设，屏宽更窄时必须夹到屏内，否则会溢出裁切
  const defaultW = frameW > 0 ? Math.min(fallback[0], frameW) : fallback[0];
  // 显式 width 同样要夹取：模型常照抄 380 / 412 预设，否则内容宽于屏幕、右侧被裁
  const w = Number.isFinite(item.size) ? (frameW > 0 ? Math.min(item.size, frameW) : item.size) : defaultW;
  const h = Number.isFinite(item.size2) ? item.size2 : fallback[1];
  return { w, h };
}

/** 与 convert.js `groupLayout` 同构的确定性布局（屏幕本地绝对坐标） */
export function layoutGroup(group, frameW = 0) {
  const out = [];
  const isFree = group.axis === 'free' || group.free === true;
  // 可用宽度要把组的横向偏移扣掉，否则 x>0 的组里夹满屏宽仍会溢出
  const availW = frameW > 0 ? Math.max(40, frameW - Math.max(0, Number(group.x) || 0)) : 0;
  let off = 0;
  for (const item of group.items ?? []) {
    if (isFree) {
      // 自由组的每个部件都有自己的绝对坐标，剩余宽度按自身 x 计算，
      // 否则 x>0 的部件按整屏宽夹取后仍会探出右边界
      const pos = item.pos ?? { x: group.x ?? 0, y: group.y ?? 0 };
      const room = frameW > 0 ? Math.max(40, frameW - Math.max(0, Number(pos.x) || 0)) : 0;
      const size = itemSize(item, room);
      out.push({ item, x: Number(pos.x) || 0, y: Number(pos.y) || 0, ...size });
      continue;
    }
    const size = itemSize(item, availW);
    out.push({
      item,
      x: group.axis === 'x' ? (group.x ?? 0) + off : group.x ?? 0,
      y: group.axis === 'x' ? group.y ?? 0 : (group.y ?? 0) + off,
      ...size,
    });
    off += (group.axis === 'x' ? size.w : size.h) + GAP;
  }
  return out;
}

/** M3 屏幕的估算热区（无 DOM 时的确定性兜底，供画布关联层使用） */
export function estimateAnchors(doc) {
  const out = [];
  if (!doc || doc.format !== 'm3') return out;
  const frameW = doc.frame?.w ?? 0;
  for (const group of doc.groups ?? []) {
    for (const p of layoutGroup(group, frameW)) {
      if (p.item.hidden) continue;
      out.push({ hotspot_id: anchorOf(p.item.id), item_id: p.item.id, slot: null, x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h });
      for (const slot of p.item.slots ?? []) {
        out.push({ hotspot_id: anchorOf(p.item.id, slot), item_id: p.item.id, slot, x: p.x + p.w / 2, y: p.y + p.h / 2, w: 0, h: 0 });
      }
    }
  }
  return out;
}

/** 热区标识：Item 无 slot 时直接用 id，有 slot 时用 `id::slot`（FR-FLOW-001 的投影） */
export function anchorOf(itemId, slot = null) {
  return slot ? `${itemId}::${slot}` : String(itemId ?? '');
}

export function parseAnchor(anchor) {
  const s = String(anchor ?? '');
  const i = s.indexOf('::');
  return i < 0 ? { item_id: s, slot: null } : { item_id: s.slice(0, i), slot: s.slice(i + 2) };
}

const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 21 21',
  add: 'M12 4v16M4 12h16',
  arrow_drop_down: 'M6 9l6 6 6-6',
  arrow_back: 'M20 12H4M10 6l-6 6 6 6',
  check: 'M4 12l5 5L20 6',
  close: 'M5 5l14 14M19 5 5 19',
  home: 'M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-4 3.6-6 8-6s8 2 8 6',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM12 2v3M12 19v3M2 12h3M19 12h3',
  more_vert: 'M12 6.5v.01M12 12v.01M12 17.5v.01',
  favorite: 'M12 21s-8-5.1-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.9-8 11-8 11z',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5L13 16l3-3 4 4M9 9.5v.01',
  photo_camera: 'M4 8h3l2-3h6l2 3h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2v14M9 4v14M15 6v14',
  calendar_today: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  schedule: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
};

function iconSvg(name, size = 20, color = 'currentColor') {
  const path = ICONS[name];
  const inner = path
    ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<circle cx="12" cy="12" r="3" fill="${color}"/>`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${inner}</svg>`;
}

function text(value) {
  return esc(value ?? '');
}

function tabsOf(item) {
  if (Array.isArray(item.tabs) && item.tabs.length) return item.tabs.map((t) => (typeof t === 'string' ? t : t?.label ?? ''));
  const label = String(item.label ?? '');
  return label.includes('|') ? label.split('|').map((s) => s.trim()).filter(Boolean) : [label || '标签一', '标签二'];
}

/** 单个部件的内部结构。所有文案都经过 esc()，所有颜色都来自 CSS 变量。 */
function kindInner(item) {
  const label = text(item.label);
  const supporting = text(item.supporting);
  const icon = item.icon ? iconSvg(item.icon) : '';
  const icon2 = item.icon2 ? iconSvg(item.icon2) : '';
  const checked = item.checked === true || item.switch === true;
  const value = Number.isFinite(item.value) ? Math.max(0, Math.min(100, item.value)) : 40;

  switch (item.kind) {
    case 'box':
      return '';
    case 'bottomSheet':
      return `<div class="m3-sheet"><span class="m3-handle"></span><div class="m3-sheet-title">${label}</div>${supporting ? `<div class="m3-support">${supporting}</div>` : ''}</div>`;
    case 'button':
      return `<span class="m3-btn-inner">${icon}${label ? `<span>${label}</span>` : ''}</span>`;
    case 'iconButton':
      return icon || iconSvg('add');
    case 'fab':
      return icon || iconSvg('add');
    case 'extendedFab':
      return `<span class="m3-btn-inner">${icon || iconSvg('add')}${label ? `<span>${label}</span>` : ''}</span>`;
    case 'chip':
      return `<span class="m3-chip">${icon}<span>${label}</span>${item.slots?.includes('trailing') ? iconSvg('close', 16) : ''}</span>`;
    case 'topAppBar':
      return `<span class="m3-appbar">${iconSvg(item.icon || 'menu')}<span class="m3-appbar-title">${label}</span>${icon2 || iconSvg(item.icon2 || 'more_vert')}</span>`;
    case 'bottomNav':
      return `<span class="m3-nav">${tabsOf(item).slice(0, 4).map((t, i) => `<span class="m3-nav-item${i === (item.selected ?? 0) ? ' on' : ''}">${iconSvg(['home', 'search', 'favorite', 'person'][i % 4])}<span>${text(t)}</span></span>`).join('')}</span>`;
    case 'navRail':
      return `<span class="m3-rail">${iconSvg(item.icon || 'menu')}${[0, 1, 2].map((i) => `<span class="m3-rail-item${i === (item.selected ?? 0) ? ' on' : ''}">${iconSvg(['home', 'search', 'favorite'][i])}</span>`).join('')}</span>`;
    case 'searchBar':
      return `<span class="m3-search">${iconSvg('search')}<span class="m3-search-label">${label || '搜索'}</span></span>`;
    case 'card':
      return `${item.src && /^https?:/i.test(item.src) ? `<div class="m3-card-media"><img src="${esc(item.src)}" alt=""></div>` : ''}<div class="m3-card-body"><div class="m3-card-title">${label}</div>${supporting ? `<div class="m3-support">${supporting}</div>` : ''}</div>`;
    case 'listItem':
      return `<span class="m3-list">${item.src && /^https?:/i.test(item.src) ? `<img class="m3-avatar" src="${esc(item.src)}" alt="">` : `<span class="m3-avatar">${iconSvg(item.icon || 'person')}</span>`}<span class="m3-list-body"><span class="m3-list-title">${label}</span>${supporting ? `<span class="m3-support">${supporting}</span>` : ''}</span>${item.slots?.includes('trailing') ? iconSvg('more_vert') : ''}</span>`;
    case 'dialog':
      return `<span class="m3-dialog"><span class="m3-dialog-title">${label}</span>${supporting ? `<span class="m3-support">${supporting}</span>` : ''}<span class="m3-dialog-actions"><span class="m3-text-btn">取消</span><span class="m3-text-btn">确定</span></span></span>`;
    case 'snackbar':
      return `<span class="m3-snack">${label}</span>`;
    case 'textField':
      return `<span class="m3-field"><span class="m3-field-label">${label || '输入'}</span></span>`;
    case 'select':
      return `<span class="m3-field"><span class="m3-field-value">${label || '请选择'}</span>${iconSvg('arrow_drop_down')}</span>`;
    case 'switch':
      return `<span class="m3-switch${checked ? ' on' : ''}"><span class="m3-switch-thumb"></span></span>${label ? `<span class="m3-switch-label">${label}</span>` : ''}`;
    case 'checkbox':
      return `<span class="m3-check${checked ? ' on' : ''}">${checked ? iconSvg('check', 16) : ''}</span>${label ? `<span class="m3-switch-label">${label}</span>` : ''}`;
    case 'slider':
      return `<span class="m3-slider"><span class="m3-slider-track"><span class="m3-slider-active" style="width:${value}%"></span><span class="m3-slider-thumb" style="left:calc(${value}% - 10px)"></span></span></span>`;
    case 'text':
      return label;
    case 'image':
      return item.src && /^https?:/i.test(item.src)
        ? `<img src="${esc(item.src)}" alt="${esc(item.label)}">`
        : `<span class="m3-media-ph">${iconSvg('image', 32)}${label ? `<span>${label}</span>` : ''}</span>`;
    case 'camera':
      return `<span class="m3-media-ph">${iconSvg('photo_camera', 32)}${label ? `<span>${label}</span>` : ''}</span>`;
    case 'map':
      return `<span class="m3-media-ph">${iconSvg('map', 32)}${label ? `<span>${label}</span>` : ''}</span>`;
    case 'divider':
      return '';
    case 'loadingIndicator':
      return `<span class="m3-spinner"></span>`;
    case 'linearProgress':
      return `<span class="m3-progress"><span style="width:${value}%"></span></span>`;
    case 'circularProgress':
      return `<svg viewBox="0 0 36 36" class="m3-ring"><circle cx="18" cy="18" r="14" fill="none" stroke="var(--md-surface-container-highest)" stroke-width="4"/><circle cx="18" cy="18" r="14" fill="none" stroke="var(--md-primary)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${Math.round(88 * value / 100)} 88" transform="rotate(-90 18 18)"/></svg>`;
    case 'splitButton':
      return `<span class="m3-btn-inner">${label ? `<span>${label}</span>` : ''}</span><span class="m3-split-sep"></span><span class="m3-split-arrow">${iconSvg('arrow_drop_down')}</span>`;
    case 'fabMenu':
      return `<span class="m3-btn-inner">${iconSvg(item.icon || 'add')}</span><span class="m3-fab-menu">${['编辑', '分享', '删除'].map((t) => `<span>${t}</span>`).join('')}</span>`;
    case 'toolbar':
      return `<span class="m3-toolbar">${iconSvg(item.icon || 'menu')}<span class="m3-toolbar-title">${label}</span><span class="m3-toolbar-actions">${iconSvg('search')}${iconSvg('more_vert')}</span></span>`;
    case 'tabs':
      return `<span class="m3-tabs">${tabsOf(item).map((t, i) => `<span class="m3-tab${i === (item.selected ?? 0) ? ' on' : ''}">${text(t)}</span>`).join('')}</span>`;
    case 'radio':
      return `<span class="m3-radio${checked ? ' on' : ''}"></span>${label ? `<span class="m3-switch-label">${label}</span>` : ''}`;
    case 'carousel':
      return `<span class="m3-carousel">${[0, 1, 2].map(() => `<span class="m3-carousel-item"></span>`).join('')}</span>`;
    case 'datePicker':
      return `<span class="m3-picker"><span class="m3-picker-head">${label || '选择日期'}</span><span class="m3-picker-grid">${Array.from({ length: 28 }, (_, i) => `<span>${i + 1}</span>`).join('')}</span></span>`;
    case 'timePicker':
      return `<span class="m3-picker"><span class="m3-picker-head">${label || '选择时间'}</span><span class="m3-picker-time">09 : 41</span></span>`;
    default:
      return label;
  }
}

/** kind → 外层状态 class（变体/填充只影响外观，不改变结构） */
function kindClass(item) {
  const classes = ['m3-item', `m3-k-${item.kind}`];
  if (item.variant) classes.push(`m3-v-${item.variant}`);
  if (item.fill) classes.push(`m3-fill-${item.fill}`);
  if (item.textColor) classes.push(`m3-text-${item.textColor}`);
  if (item.checked) classes.push('is-checked');
  return classes.join(' ');
}

function itemCss(item, p, originX, originY, z) {
  const style = {
    left: `${p.x - originX}px`,
    top: `${p.y - originY}px`,
    width: `${p.w}px`,
    height: `${p.h}px`,
    zIndex: z,
  };
  if (item.fill) style.background = `var(--md-${item.fill.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)})`;
  if (item.textColor) style.color = `var(--md-${item.textColor.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)})`;
  if (item.corners && typeof item.corners === 'object') {
    const { tl, tr, bl, br } = item.corners;
    if ([tl, tr, bl, br].every((v) => Number.isFinite(v))) {
      style.borderRadius = `${tl}px ${tr}px ${br}px ${bl}px`;
    }
  }
  if (Number.isFinite(item.radiusTop) || Number.isFinite(item.radiusBottom)) {
    style.borderRadius = `${item.radiusTop ?? 0}px ${item.radiusTop ?? 0}px ${item.radiusBottom ?? 0}px ${item.radiusBottom ?? 0}px`;
  }
  return styleToCss(style);
}

/**
 * 渲染单屏 body（不含 <html>/<head>）。
 * @param {object} doc ScreenDoc
 * @param {object} design ProjectDesign
 * @param {{includeHidden?:boolean, interactive?:boolean}} [opts]
 */
export function renderM3Body(doc, design = {}, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  const frame = doc?.frame ?? {};
  const w = frame.w ?? 412;
  const h = frame.h ?? 892;
  const length = Number.isFinite(frame.length) && frame.length > h ? frame.length : h;
  const bg = frame.bg ? `var(--md-${String(frame.bg).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)})` : 'var(--md-surface)';
  const groups = [];
  let gi = 0;
  for (const group of doc?.groups ?? []) {
    if (group.hidden && !includeHidden) continue;
    const placed = layoutGroup(group, w).filter((p) => includeHidden || !p.item.hidden);
    if (!placed.length) continue;
    const originX = Math.min(...placed.map((p) => p.x));
    const originY = Math.min(...placed.map((p) => p.y));
    const right = Math.max(...placed.map((p) => p.x + p.w));
    const bottom = Math.max(...placed.map((p) => p.y + p.h));
    const groupW = Math.max(1, right - originX);
    const groupH = Math.max(1, bottom - originY);
    let ii = 0;
    const items = placed
      .map((p) => {
        const item = p.item;
        const anchor = anchorOf(item.id);
        const slotAnchors = (item.slots ?? [])
          .map((slot) => `<span class="m3-slot" data-slot="${esc(slot)}" data-anchor="${esc(anchorOf(item.id, slot))}"></span>`)
          .join('');
        const tag = item.kind === 'button' || item.kind === 'iconButton' || item.kind === 'fab' || item.kind === 'extendedFab' || item.kind === 'splitButton'
          ? 'button type="button"'
          : 'div';
        const close = tag === 'button type="button"' ? 'button' : 'div';
        return `<${tag} class="${kindClass(item)}" data-anchor="${esc(anchor)}" data-item-id="${esc(item.id)}" data-kind="${esc(item.kind)}" style="${itemCss(item, p, originX, originY, (gi + 1) * 100 + ii++)}">${kindInner(item)}${slotAnchors}</${close}>`;
      })
      .join('');
    groups.push(
      `<div class="m3-group" data-group-id="${esc(group.id)}" style="left:${originX}px;top:${originY}px;width:${groupW}px;height:${groupH}px;z-index:${gi + 1}">${items}</div>`
    );
    gi++;
  }
  return `<div class="m3-screen" data-screen-id="${esc(frame.id ?? '')}" style="width:${w}px;height:${length}px;background:${bg}">${groups.join('')}</div>`;
}

/** M3 渲染器必须拒绝 node-tree 输入（FR-RENDER-004） */
export function assertM3Renderable(doc) {
  if (!doc || doc.format !== 'm3' || !Array.isArray(doc.groups) || !doc.frame) {
    throw new Error('M3 渲染器只接受 format:"m3" 的 ScreenDoc');
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* 旧 node-tree 只读渲染器（FR-RENDER-004/005）                         */
/* ------------------------------------------------------------------ */

const META_TAGS = new Set([
  'div', 'span', 'button', 'section', 'header', 'footer', 'main', 'nav', 'aside', 'ul', 'li', 'p', 'a', 'label',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'figure', 'strong', 'em', 'small', 'article', 'img', 'input', 'br', 'hr',
]);

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr']);

const ATTR_OK = /^(aria-[a-z-]+|data-[a-z0-9-]+|role|alt|title|href|src|type|placeholder|name|for|width|height|class|id|value|checked|disabled)$/i;

const CSS_PROP_OK = /^(color|background|background-color|background-image|border|border-radius|border-color|border-width|border-style|padding|padding-(top|right|bottom|left)|margin|margin-(top|right|bottom|left)|font|font-size|font-weight|font-family|font-style|line-height|letter-spacing|text-align|text-decoration|display|flex|flex-direction|flex-wrap|align-items|align-content|align-self|justify-content|gap|row-gap|column-gap|width|height|min-width|max-width|min-height|max-height|position|top|right|bottom|left|z-index|opacity|overflow|overflow-x|overflow-y|box-shadow|object-fit|grid-template-columns|grid-template-rows|grid-column|grid-row|white-space)$/i;

function safeUrl(value, { allowLocal = false } = {}) {
  const v = String(value ?? '').trim();
  if (/^(https?:|mailto:|tel:|#)/i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(v)) return allowLocal ? v : null;
  if (allowLocal && /^[./a-z0-9_-]+\.(png|jpe?g|gif|webp|svg)$/i.test(v)) return v;
  return null;
}

function safeStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const parts = [];
  for (const [k, v] of Object.entries(style)) {
    const raw = String(v ?? '').trim();
    if (!raw) continue;
    if (k.startsWith('--')) continue;
    if (!CSS_PROP_OK.test(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`))) continue;
    if (/url\s*\(|expression\s*\(|javascript:|@import/i.test(raw)) continue;
    parts.push(`${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${raw}`);
  }
  return parts.length ? parts.join(';') : null;
}

/** 旧节点属性清洗：剥离 on* / javascript: / 本地图片（除非显式允许） */
export function safeLegacyAttrs(attrs, { allowLocalImages = false } = {}) {
  const out = [];
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (!ATTR_OK.test(k)) continue;
    if (/^on/i.test(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (k === 'href' || k === 'src') {
      const url = safeUrl(v, { allowLocal: allowLocalImages });
      if (url) out.push(`${k}="${esc(url)}"`);
      continue;
    }
    out.push(`${k}="${esc(v)}"`);
  }
  return out;
}

/**
 * 旧节点 → 安全 HTML。
 * `editable` 只用于画布的空间编辑态；预览/导出永远不传。
 */
export function legacyNodeToHtml(n, { editable = false, allowLocalImages = false } = {}) {
  if (!n) return '';
  const tag = META_TAGS.has(n.tag) ? n.tag : 'div';
  const attrList = safeLegacyAttrs(n.props?.attrs, { allowLocalImages });
  const style = safeStyle(n.props?.style);
  if (style) attrList.push(`style="${esc(style)}"`);
  attrList.push(`data-node-id="${esc(n.id ?? '')}"`);
  const children = Array.isArray(n.children) ? n.children : [];
  if (editable && n.props?.text && children.length === 0) attrList.push('data-editable="1"');
  const attrs = attrList.length ? ` ${attrList.join(' ')}` : '';
  if (tag === 'img') return `<img${attrs} alt="${esc(n.props?.attrs?.alt ?? '')}">`;
  if (tag === 'input') return `<input${attrs}>`;
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  const inner = [n.props?.text ? esc(n.props.text) : '', ...children.map((c) => legacyNodeToHtml(c, { editable, allowLocalImages }))].join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** 旧屏 body：独立于 M3 渲染器，缺失内容给出明确占位 */
export function renderLegacyBody(doc, opts = {}) {
  return doc?.root
    ? legacyNodeToHtml(doc.root, opts)
    : '<div style="padding:24px;color:#9ca3af">（空屏）</div>';
}

/** 统一入口：按 doc.format 分派，调用方不再判断格式 */
export function renderScreenBody(doc, design = {}, opts = {}) {
  const format = docFormat(doc);
  if (format === 'm3') return renderM3Body(doc, design, opts);
  if (format === 'node-tree') return renderLegacyBody(doc, opts);
  return '<div style="padding:24px;color:#9ca3af">（暂无内容）</div>';
}

/* ------------------------------------------------------------------ */
/* 共享基础样式                                                         */
/* ------------------------------------------------------------------ */

export const SCREEN_BASE_CSS = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0}
body{font-family:var(--md-font, system-ui, sans-serif);color:var(--md-on-surface,#111827);background:var(--md-surface,#fff);-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0;padding:0}
[data-anchor]{cursor:pointer}
.m3-screen{position:relative;overflow:hidden}
.m3-group{position:absolute}
.m3-item{position:absolute;display:flex;align-items:center;justify-content:flex-start;overflow:hidden}
.m3-slot{position:absolute;inset:0;pointer-events:auto;background:transparent}
.m3-slot[data-slot="main"]{inset:0}
.m3-slot[data-slot="menu"]{left:0;right:auto;width:56px}
.m3-slot[data-slot="icon2"],.m3-slot[data-slot="trailing"]{left:auto;right:0;width:56px}
.m3-slot[data-slot^="action:"],.m3-slot[data-slot^="tab:"],.m3-slot[data-slot^="item:"]{left:auto;right:0;width:56px}
.m3-support{font-size:13px;line-height:18px;color:var(--md-on-surface-variant);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3-btn-inner{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;height:100%;padding:0 20px;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3-k-button{border-radius:calc(var(--md-radius) * 1.4);background:var(--md-primary);color:var(--md-on-primary)}
.m3-k-button.m3-v-tonal{background:var(--md-secondary-container);color:var(--md-on-secondary-container)}
.m3-k-button.m3-v-elevated{background:var(--md-surface-container-low);color:var(--md-primary);box-shadow:0 1px 3px var(--md-shadow)}
.m3-k-button.m3-v-outlined{background:transparent;color:var(--md-primary);border:1px solid var(--md-outline)}
.m3-k-button.m3-v-text{background:transparent;color:var(--md-primary)}
.m3-k-iconButton,.m3-k-fab,.m3-k-extendedFab{border-radius:999px;background:var(--md-primary-container);color:var(--md-on-primary-container);justify-content:center}
.m3-k-iconButton.m3-v-text,.m3-k-fab.m3-v-text{background:transparent;color:var(--md-on-surface)}
.m3-k-extendedFab .m3-btn-inner{padding:0 16px}
.m3-k-chip{border-radius:999px;background:var(--md-surface-container-high);border:1px solid var(--md-outline-variant)}
.m3-chip{display:inline-flex;align-items:center;gap:6px;height:100%;width:100%;padding:0 12px;font-size:13px;overflow:hidden}
.m3-k-topAppBar,.m3-k-toolbar{background:var(--md-surface-container);border-radius:0}
.m3-appbar,.m3-toolbar{display:flex;align-items:center;gap:12px;width:100%;height:100%;padding:0 16px}
.m3-appbar-title,.m3-toolbar-title{flex:1;font-size:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3-toolbar-actions{display:flex;gap:12px}
.m3-k-bottomNav{background:var(--md-surface-container);border-radius:0}
.m3-nav{display:flex;width:100%;height:100%;align-items:center;justify-content:space-around;padding:8px 0}
.m3-nav-item{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;color:var(--md-on-surface-variant);padding:0 10px}
.m3-nav-item.on{color:var(--md-on-secondary-container);background:var(--md-secondary-container);border-radius:999px;padding:6px 14px}
.m3-k-navRail{background:var(--md-surface-container);border-radius:0}
.m3-rail{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%;height:100%;padding:14px 0}
.m3-rail-item{padding:10px;border-radius:999px;color:var(--md-on-surface-variant)}
.m3-rail-item.on{background:var(--md-secondary-container);color:var(--md-on-secondary-container)}
.m3-k-searchBar{border-radius:999px;background:var(--md-surface-container-high)}
.m3-search{display:flex;align-items:center;gap:10px;width:100%;height:100%;padding:0 16px;color:var(--md-on-surface-variant);font-size:14px}
.m3-k-card{background:var(--md-surface-container-low);border-radius:var(--md-radius);box-shadow:0 1px 2px var(--md-shadow);align-items:stretch;flex-direction:column}
.m3-card-media{height:48%;overflow:hidden}
.m3-card-media img{width:100%;height:100%;object-fit:cover}
.m3-card-body{padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.m3-card-title{font-size:16px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3-k-listItem{padding:0 4px}
.m3-list{display:flex;align-items:center;gap:14px;width:100%;height:100%;padding:0 12px}
.m3-avatar{width:42px;height:42px;border-radius:999px;background:var(--md-secondary-container);color:var(--md-on-secondary-container);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.m3-list-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.m3-list-title{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3-k-dialog{background:var(--md-surface-container-high);border-radius:calc(var(--md-radius) * 1.75);box-shadow:0 8px 24px var(--md-shadow);padding:20px;align-items:stretch;flex-direction:column}
.m3-dialog{display:flex;flex-direction:column;gap:12px;width:100%}
.m3-dialog-title{font-size:20px;font-weight:500}
.m3-dialog-actions{display:flex;justify-content:flex-end;gap:16px;margin-top:auto;padding-top:8px}
.m3-text-btn{color:var(--md-primary);font-size:14px;font-weight:500}
.m3-k-snackbar{background:var(--md-inverse-surface);color:var(--md-inverse-on-surface);border-radius:var(--md-radius-sm);padding:0 16px}
.m3-snack{font-size:14px}
.m3-k-textField,.m3-k-select{border:var(--md-contrast-border);border-radius:var(--md-radius-sm)}
.m3-k-textField{border:1px solid var(--md-outline);border-radius:var(--md-radius-sm)}
.m3-field{display:flex;align-items:center;justify-content:space-between;width:100%;height:100%;padding:0 16px;gap:8px}
.m3-field-label{font-size:15px;color:var(--md-on-surface-variant)}
.m3-field-value{font-size:15px}
.m3-k-switch,.m3-k-checkbox,.m3-k-radio{gap:10px;background:transparent}
.m3-switch{width:52px;height:32px;border-radius:999px;background:var(--md-surface-container-highest);border:1px solid var(--md-outline);position:relative;flex:0 0 auto}
.m3-switch.on{background:var(--md-primary);border-color:var(--md-primary)}
.m3-switch-thumb{position:absolute;top:50%;left:6px;width:20px;height:20px;margin-top:-10px;border-radius:999px;background:var(--md-outline);transition:left .2s var(--md-motion)}
.m3-switch.on .m3-switch-thumb{left:calc(100% - 26px);background:var(--md-on-primary)}
.m3-switch-label{font-size:14px;white-space:nowrap}
.m3-check{width:22px;height:22px;border-radius:4px;border:2px solid var(--md-outline);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--md-on-primary)}
.m3-check.on{background:var(--md-primary);border-color:var(--md-primary)}
.m3-radio{width:22px;height:22px;border-radius:999px;border:2px solid var(--md-outline);flex:0 0 auto}
.m3-radio.on{border-color:var(--md-primary);box-shadow:inset 0 0 0 4px var(--md-surface),inset 0 0 0 12px var(--md-primary)}
.m3-slider{width:100%;padding:0 4px}
.m3-slider-track{display:block;position:relative;height:4px;border-radius:999px;background:var(--md-surface-container-highest)}
.m3-slider-active{display:block;height:4px;border-radius:999px;background:var(--md-primary)}
.m3-slider-thumb{position:absolute;top:-8px;width:20px;height:20px;border-radius:999px;background:var(--md-primary)}
.m3-k-text{font-size:16px;line-height:1.3;white-space:pre-wrap;align-items:flex-start}
.m3-k-text.m3-v-text{font-weight:400}
.m3-k-image img,.m3-k-card img{width:100%;height:100%;object-fit:cover}
.m3-media-ph{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;height:100%;background:var(--md-surface-container-high);color:var(--md-on-surface-variant);font-size:12px}
.m3-k-divider{background:var(--md-outline-variant);height:1px}
.m3-spinner{width:32px;height:32px;border-radius:999px;border:3px solid var(--md-surface-container-highest);border-top-color:var(--md-primary);animation:m3spin 1s linear infinite;margin:auto}
@keyframes m3spin{to{transform:rotate(360deg)}}
.m3-progress{display:block;width:100%;height:100%;background:var(--md-surface-container-highest);border-radius:999px;overflow:hidden}
.m3-progress span{display:block;height:100%;background:var(--md-primary);border-radius:999px}
.m3-ring{width:100%;height:100%}
.m3-k-splitButton{background:var(--md-primary);color:var(--md-on-primary);border-radius:calc(var(--md-radius) * 1.4)}
.m3-split-sep{width:1px;height:55%;background:color-mix(in srgb, var(--md-on-primary) 30%, transparent);flex:0 0 auto}
.m3-split-arrow{display:inline-flex;align-items:center;justify-content:center;width:44px;height:100%;flex:0 0 auto}
.m3-k-fabMenu{overflow:visible;background:transparent;border-radius:999px}
.m3-k-fabMenu .m3-btn-inner{background:var(--md-primary-container);color:var(--md-on-primary-container);border-radius:999px}
.m3-fab-menu{position:absolute;right:0;bottom:64px;display:none;flex-direction:column;gap:6px;background:var(--md-surface-container-high);border-radius:var(--md-radius-sm);padding:6px;font-size:12px;box-shadow:0 4px 12px var(--md-shadow)}
.m3-k-tabs{border-bottom:1px solid var(--md-outline-variant)}
.m3-tabs{display:flex;width:100%;height:100%}
.m3-tab{flex:1;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--md-on-surface-variant);border-bottom:3px solid transparent}
.m3-tab.on{color:var(--md-primary);border-bottom-color:var(--md-primary);font-weight:500}
.m3-k-carousel{overflow:hidden}
.m3-carousel{display:flex;gap:8px;width:100%;height:100%;padding:6px}
.m3-carousel-item{flex:1;background:var(--md-surface-container-high);border-radius:var(--md-radius)}
.m3-k-datePicker,.m3-k-timePicker{background:var(--md-surface-container-high);border-radius:calc(var(--md-radius) * 1.5);padding:14px;align-items:stretch}
.m3-picker{display:flex;flex-direction:column;gap:10px;width:100%}
.m3-picker-head{font-size:16px;font-weight:500;color:var(--md-on-surface-variant)}
.m3-picker-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;font-size:12px;text-align:center;color:var(--md-on-surface)}
.m3-picker-time{font-size:34px;font-weight:600;text-align:center;color:var(--md-primary)}
.m3-k-bottomSheet{background:var(--md-surface-container-low);border-radius:calc(var(--md-radius) * 1.75) calc(var(--md-radius) * 1.75) 0 0;align-items:stretch}
.m3-sheet{display:flex;flex-direction:column;gap:8px;width:100%;padding:10px 20px 20px}
.m3-handle{display:block;width:32px;height:4px;border-radius:999px;background:var(--md-outline-variant);margin:0 auto 8px}
.m3-sheet-title{font-size:20px;font-weight:500}
.m3-k-box{background:transparent}

/* ---- 鼠标交互特效 ----
 * 这套 CSS 同时供设计页（编辑器岛）、预览与静态导出使用，所以只用纯 CSS 状态，
 * 不依赖 JS。未配置 action 的控件也保留悬停反馈，避免原型看起来"死的"。 */
.m3-item{transition:filter .15s ease, box-shadow .15s ease, transform .15s ease, background-color .15s ease, border-color .15s ease}
/* 状态层：默认无，悬停时叠一层 12% 白/黑，按下 20%，再配合阴影与轻微位移，
 * 保证在浅色底和主色底上都能一眼看出来（单纯 brightness(1.08) 几乎不可见）。 */
[data-anchor]{position:relative}
/* 状态层放在内容之下：内部文字/图标统一提升一层，避免被覆盖 */
[data-anchor] > *{position:relative;z-index:1}
[data-anchor]::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .15s ease;z-index:0}
[data-anchor]:hover::before{opacity:1}
[data-anchor]::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;background:rgba(0,0,0,.16);transition:opacity .15s ease;z-index:0}
[data-anchor]:active::after{opacity:1}
.m3-k-button[data-anchor]::before,.m3-k-fab[data-anchor]::before,.m3-k-extendedFab[data-anchor]::before,
.m3-k-splitButton[data-anchor]::before{background:rgba(255,255,255,.18)}
.m3-k-iconButton[data-anchor]::before,.m3-k-chip[data-anchor]::before,.m3-k-fabMenu[data-anchor]::before,
.m3-k-card[data-anchor]::before,.m3-k-listItem[data-anchor]::before,.m3-k-box[data-anchor]::before,
.m3-k-topAppBar[data-anchor]::before,.m3-k-toolbar[data-anchor]::before,
.m3-k-tabs[data-anchor]::before,.m3-k-bottomNav[data-anchor]::before,.m3-k-navRail[data-anchor]::before,
.m3-k-textField[data-anchor]::before,.m3-k-select[data-anchor]::before{background:rgba(0,0,0,.08)}
.m3-k-button[data-anchor]:hover,.m3-k-fab[data-anchor]:hover,.m3-k-extendedFab[data-anchor]:hover,
.m3-k-splitButton[data-anchor]:hover{box-shadow:0 4px 12px var(--md-shadow);transform:translateY(-1px)}
.m3-k-button[data-anchor]:active,.m3-k-fab[data-anchor]:active,.m3-k-extendedFab[data-anchor]:active,
.m3-k-splitButton[data-anchor]:active{box-shadow:0 1px 3px var(--md-shadow);transform:translateY(0) scale(.98)}
.m3-k-iconButton[data-anchor]:hover,.m3-k-chip[data-anchor]:hover,.m3-k-fabMenu[data-anchor]:hover{background:var(--md-surface-container-highest)}
.m3-k-card[data-anchor]:hover,.m3-k-listItem[data-anchor]:hover,.m3-k-box[data-anchor]:hover{box-shadow:0 2px 10px var(--md-shadow);transform:translateY(-1px)}
.m3-k-card[data-anchor]:active,.m3-k-listItem[data-anchor]:active,.m3-k-box[data-anchor]:active{transform:translateY(0) scale(.995)}
.m3-k-tabs[data-anchor]:hover,.m3-k-bottomNav[data-anchor]:hover,.m3-k-navRail[data-anchor]:hover{background:var(--md-surface-container-high)}
.m3-k-tabs[data-anchor]:hover .m3-tab:not(.on),
.m3-k-bottomNav[data-anchor]:hover .m3-nav-item:not(.on),
.m3-k-navRail[data-anchor]:hover .m3-rail-item:not(.on){color:var(--md-on-surface)}
.m3-k-topAppBar[data-anchor]:hover,.m3-k-toolbar[data-anchor]:hover{background:var(--md-surface-container-high)}
.m3-k-text[data-anchor]:hover{color:var(--md-primary);background:color-mix(in srgb, var(--md-primary) 8%, transparent);border-radius:4px}
.m3-k-image[data-anchor]:hover,.m3-k-carousel[data-anchor]:hover{filter:brightness(.92)}
.m3-k-slider[data-anchor]:hover .m3-slider-thumb{transform:scale(1.2);transition:transform .15s ease}
.m3-k-textField[data-anchor]:hover,.m3-k-select[data-anchor]:hover{border-color:var(--md-on-surface)}
.m3-k-switch[data-anchor]:hover,.m3-k-checkbox[data-anchor]:hover,.m3-k-radio[data-anchor]:hover{background:color-mix(in srgb, var(--md-primary) 8%, transparent)}
.m3-item[data-anchor]:focus-visible{outline:2px solid var(--md-primary);outline-offset:2px}
.m3-item[data-anchor]:active{cursor:progress}
@media (prefers-reduced-motion: reduce){
  .m3-item,.m3-switch-thumb,[data-anchor]::before,[data-anchor]::after{transition:none}
  .m3-item[data-anchor]:active{transform:none}
}
`;

export const LEGACY_BASE_CSS = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827;background:#fff}
[data-anchor]{cursor:pointer;position:relative}
button{font:inherit;background:none;border:0;padding:0}
`;

/** 完整只读屏幕文档（供服务端导出/预览与浏览器 iframe 共用） */
export function renderScreenDocument(doc, design = {}, opts = {}) {
  const format = docFormat(doc);
  const css = format === 'm3' ? `${SCREEN_BASE_CSS}\n:root{${themeCss(design)}}` : LEGACY_BASE_CSS;
  const body = renderScreenBody(doc, design, opts);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;
}
