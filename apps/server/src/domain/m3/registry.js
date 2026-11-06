/**
 * M3 Kind Registry 的执行期形态（M1）
 *
 * SRS §12.5 定义了 36 种 kind 的属性、尺寸族与可热区规则；`constants.js` 只冻结了
 * kind 白名单。这里把「默认值」落成常量，供建屏、部件面板、导入降级与测试复用。
 *
 * 设计约束：
 *  - 纯数据 + 纯函数，不依赖运行时环境，便于服务端与浏览器共享；
 *  - 默认尺寸与 m3e-canvas `KIND_SPEC` 的近似值一致（convert.js 复用同一份数据）；
 *  - `family` 用于连接组/Tidy 同族吸附，`hotspot` 表示默认可作为 FlowEdge 源；
 *  - 所有默认值可被主题影响（颜色不写死在这里）。
 */

import { PHONE, VARIANT_SET, COLOR_TOKEN_SET } from './constants.js';

/** 每个 kind 的默认尺寸（dp） */
const SIZE = {
  box: [PHONE.w, 220],
  bottomSheet: [PHONE.w, 320],
  button: [128, 56],
  iconButton: [56, 56],
  fab: [56, 56],
  extendedFab: [128, 56],
  chip: [128, 32],
  topAppBar: [PHONE.w, 88],
  bottomNav: [PHONE.w, 104],
  navRail: [80, PHONE.h],
  searchBar: [380, 56],
  card: [380, 223],
  listItem: [380, 72],
  dialog: [312, 220],
  snackbar: [344, 48],
  textField: [380, 56],
  select: [380, 56],
  switch: [160, 48],
  checkbox: [128, 40],
  slider: [380, 44],
  text: [120, 40],
  image: [200, 200],
  camera: [200, 267],
  map: [200, 150],
  divider: [380, 1],
  loadingIndicator: [48, 48],
  linearProgress: [380, 4],
  circularProgress: [48, 48],
  splitButton: [128, 56],
  fabMenu: [128, 56],
  toolbar: [220, 56],
  tabs: [380, 48],
  radio: [128, 40],
  carousel: [380, 180],
  datePicker: [312, 400],
  timePicker: [328, 450],
};

/**
 * Registry 正文。字段：
 *  - label：部件面板展示名
 *  - icon：默认 Material Symbols 名称
 *  - variant：默认变体
 *  - family：连接组/Tidy 的同族键
 *  - hotspot：是否默认可作为 FlowEdge 源（可点击）
 *  - text：是否文本型（宽度可测量/自适应）
 *  - slots：可挂 action 的命名 slot
 */
const SPEC_ROWS = {
  box: ['容器', null, 'filled', 'layout', false, false, []],
  bottomSheet: ['底部面板', null, 'filled', 'surface', false, false, []],
  button: ['按钮', null, 'filled', 'button', true, false, []],
  iconButton: ['图标按钮', 'add', 'filled', 'button', true, false, []],
  fab: ['浮动按钮', 'add', 'filled', 'button', true, false, []],
  extendedFab: ['扩展浮动按钮', 'add', 'filled', 'button', true, false, []],
  chip: ['标签', null, 'tonal', 'chip', true, true, ['trailing']],
  topAppBar: ['应用栏', 'menu', 'filled', 'appbar', false, false, ['menu', 'icon2']],
  bottomNav: ['底部导航', 'home', 'filled', 'nav', true, false, ['tab:0', 'tab:1', 'tab:2', 'tab:3']],
  navRail: ['侧边导航', 'home', 'filled', 'nav', true, false, ['menu', 'tab:0', 'tab:1', 'tab:2']],
  searchBar: ['搜索栏', 'search', 'filled', 'input', true, true, ['trailing']],
  card: ['卡片', null, 'filled', 'card', true, false, ['trailing', 'main']],
  listItem: ['列表项', null, 'filled', 'list', true, true, ['trailing', 'main']],
  dialog: ['对话框', null, 'filled', 'dialog', true, false, ['main', 'trailing']],
  snackbar: ['提示条', null, 'filled', 'surface', true, true, ['main']],
  textField: ['输入框', null, 'outlined', 'input', true, true, ['trailing']],
  select: ['下拉选择', 'arrow_drop_down', 'outlined', 'input', true, true, ['trailing']],
  switch: ['开关', null, 'filled', 'control', true, true, []],
  checkbox: ['复选框', 'check', 'filled', 'control', true, true, []],
  slider: ['滑块', null, 'filled', 'control', true, false, []],
  text: ['文本', null, 'text', 'text', false, true, []],
  image: ['图片', 'image', 'filled', 'media', true, false, []],
  camera: ['相机', 'photo_camera', 'filled', 'media', true, false, ['main']],
  map: ['地图', 'map', 'filled', 'media', true, false, ['main']],
  divider: ['分隔线', null, 'filled', 'layout', false, false, []],
  loadingIndicator: ['加载指示', null, 'filled', 'progress', false, false, []],
  linearProgress: ['线性进度', null, 'filled', 'progress', false, false, []],
  circularProgress: ['环形进度', null, 'filled', 'progress', false, false, []],
  splitButton: ['分体按钮', 'arrow_drop_down', 'filled', 'button', true, false, ['trailing']],
  fabMenu: ['浮动菜单', 'add', 'filled', 'button', true, false, ['main']],
  toolbar: ['工具栏', null, 'filled', 'appbar', true, false, ['menu', 'action:0', 'action:1']],
  tabs: ['标签页', null, 'filled', 'nav', true, false, ['tab:0', 'tab:1', 'tab:2']],
  radio: ['单选框', null, 'filled', 'control', true, true, []],
  carousel: ['轮播', null, 'filled', 'media', true, false, ['item:0', 'item:1', 'item:2']],
  datePicker: ['日期选择', 'calendar_today', 'filled', 'picker', true, false, ['main']],
  timePicker: ['时间选择', 'schedule', 'filled', 'picker', true, false, ['main']],
};

/** @type {Record<string, object>} */
export const KIND_SPEC = Object.freeze(
  Object.fromEntries(
    Object.entries(SPEC_ROWS).map(([kind, [label, icon, variant, family, hotspot, text, slots]]) => [
      kind,
      Object.freeze({
        kind,
        label,
        icon,
        variant,
        family,
        hotspot,
        text,
        slots: Object.freeze(slots),
        w: SIZE[kind][0],
        h: SIZE[kind][1],
      }),
    ])
  )
);

export const KIND_SPECS = Object.freeze(Object.values(KIND_SPEC));

/** 按 kind 取 spec；未知 kind 返回 null（调用方负责按 SCHEMA_INVALID 拒绝或降级为 box） */
export function specOf(kind) {
  return KIND_SPEC[kind] ?? null;
}

/** 默认可热区判定（FR-FLOW-001 / AI-004） */
export function isHotspotKind(kind) {
  return KIND_SPEC[kind]?.hotspot === true;
}

/** 默认尺寸，供布局/导入兜底 */
export function defaultSize(kind) {
  return { w: KIND_SPEC[kind]?.w ?? 120, h: KIND_SPEC[kind]?.h ?? 40 };
}

/**
 * 生成一个部件实例的默认属性（FR-M3-011）。
 * 只填 Registry 内允许的字段，调用方再叠加位置/尺寸覆盖。
 */
export function defaultItem(kind, { id, label, icon, variant } = {}) {
  const spec = KIND_SPEC[kind];
  if (!spec) return null;
  const item = {
    id,
    kind,
    label: label ?? defaultLabelFor(kind),
    variant: VARIANT_SET.has(variant) ? variant : spec.variant,
    name: spec.label,
    locked: false,
    hidden: false,
  };
  const iconName = icon !== undefined ? icon : spec.icon;
  if (iconName) item.icon = iconName;
  if (spec.text) item.size = spec.w;
  return item;
}

function defaultLabelFor(kind) {
  switch (kind) {
    case 'button':
      return '按钮';
    case 'text':
      return '文本';
    case 'topAppBar':
      return '标题';
    case 'card':
      return '卡片标题';
    default:
      return KIND_SPEC[kind]?.label ?? '';
  }
}

/** 校验 kind 是否在 Registry 内；返回问题对象或 null */
export function assertKind(kind, path = 'item.kind') {
  if (KIND_SPEC[kind]) return null;
  return { path, code: 'ENUM', message: '必须是 36 种 M3 kind 之一（见 §12.5 Registry）' };
}

/**
 * 属性白名单：用于「未知字段保留但不参与渲染」的判定（FR-M3-004）。
 * 未列出的字段不会被删除，只在导出/渲染时忽略。
 */
export const ITEM_KNOWN_PROPS = Object.freeze([
  'id', 'kind', 'label', 'supporting', 'icon', 'icon2', 'variant', 'size', 'size2',
  'tabs', 'selected', 'checked', 'value', 'note', 'fill', 'src', 'pos', 'hidden',
  'name', 'locked', 'switch', 'noImage', 'bold', 'wavy', 'contained', 'railExpanded',
  'railModal', 'collapseOnScroll', 'imagePos', 'imageSize', 'contentAlign', 'textAlign',
  'layout', 'corners', 'w', 'radiusTop', 'radiusBottom', 'count', 'trackThickness',
  'iconFill', 'textColor',
]);

/** 只保留渲染允许的 fill / textColor，避免 AI 注入任意 CSS */
export function safeColorToken(value, fallback = null) {
  return COLOR_TOKEN_SET.has(value) ? value : fallback;
}
