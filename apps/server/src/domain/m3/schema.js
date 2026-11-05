/**
 * M3 schema 校验（M0 spike）
 *
 * 设计原则：
 *  - 校验函数只返回问题列表，不抛异常；需要失败即停时用 assert*。
 *  - 每条问题都带 `path`，便于 API 返回 422 SCHEMA_INVALID 时定位。
 *  - ScreenDoc 是严格契约：不允许持久化 `action/actions/frame.swipe`。
 *  - M3E 原始 Doc 是导入格式：允许 action/swipe，但会做结构校验。
 */

import {
  SCREEN_SCHEMA,
  FLOW_SCHEMA_VERSION,
  KINDS,
  KIND_SET,
  VARIANT_SET,
  COLOR_TOKEN_SET,
  TEXT_TOKEN_SET,
  CARD_IMAGE_POSITION_SET,
  CARD_ALIGN_SET,
  PART_LAYOUT_SET,
  PLACE_SET,
  TRANSITION_SET,
  TARGET_KIND_SET,
  EDGE_STATUS_SET,
  TRIGGER_SET,
  SWIPE_DIR_SET,
  GROUP_AXIS_SET,
  PLATFORM_SET,
  THEME_VALUES,
  DEFAULT_THEME,
  M3_ERR,
} from './constants.js';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => isStr(v) && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';

const issue = (path, code, message) => ({ path, code, message });

export class M3SchemaError extends Error {
  constructor(issues, label = 'M3 schema') {
    const first = issues[0];
    super(`${label}: ${first ? `${first.path} ${first.message}` : 'invalid'}`);
    this.name = 'M3SchemaError';
    this.code = M3_ERR.SCHEMA_INVALID;
    this.issues = issues;
  }
}

/** 与 m3e-canvas `normalizeTheme` 对齐：缺失/非法字段回退默认值 */
export function normalizeTheme(theme) {
  if (!isObj(theme)) return { ...DEFAULT_THEME };
  const pick = (key, allowed) => (allowed.includes(theme[key]) ? theme[key] : DEFAULT_THEME[key]);
  return {
    dark: isBool(theme.dark) ? theme.dark : DEFAULT_THEME.dark,
    bothModes: isBool(theme.bothModes) ? theme.bothModes : DEFAULT_THEME.bothModes,
    contrast: pick('contrast', THEME_VALUES.contrast),
    shape: pick('shape', THEME_VALUES.shape),
    font: pick('font', THEME_VALUES.font),
    emphasized: isBool(theme.emphasized) ? theme.emphasized : DEFAULT_THEME.emphasized,
    motion: pick('motion', THEME_VALUES.motion),
  };
}

export function validateTheme(theme, path = 'theme') {
  const out = [];
  if (!isObj(theme)) return [issue(path, 'TYPE', '必须是对象')];
  if (!isBool(theme.dark)) out.push(issue(`${path}.dark`, 'TYPE', '必须是布尔值'));
  if (!isBool(theme.bothModes)) out.push(issue(`${path}.bothModes`, 'TYPE', '必须是布尔值'));
  for (const key of ['contrast', 'shape', 'font', 'motion']) {
    if (!THEME_VALUES[key].includes(theme[key])) {
      out.push(issue(`${path}.${key}`, 'ENUM', `必须是 ${THEME_VALUES[key].join(' / ')} 之一`));
    }
  }
  if (!isBool(theme.emphasized)) out.push(issue(`${path}.emphasized`, 'TYPE', '必须是布尔值'));
  return out;
}

function validateTabs(tabs, path) {
  const out = [];
  if (!Array.isArray(tabs)) return [issue(path, 'TYPE', '必须是数组')];
  tabs.forEach((tab, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(tab)) return out.push(issue(p, 'TYPE', '必须是对象'));
    if (!isStr(tab.label)) out.push(issue(`${p}.label`, 'TYPE', '必须是字符串'));
    if (tab.icon !== undefined && tab.icon !== null && !isStr(tab.icon)) {
      out.push(issue(`${p}.icon`, 'TYPE', '必须是字符串或 null'));
    }
    if (tab.src !== undefined && !isStr(tab.src)) out.push(issue(`${p}.src`, 'TYPE', '必须是字符串'));
  });
  return out;
}

function validateCorners(corners, path) {
  if (corners === undefined) return [];
  if (!isObj(corners)) return [issue(path, 'TYPE', '必须是对象')];
  return ['tl', 'tr', 'bl', 'br']
    .filter((k) => !isNum(corners[k]))
    .map((k) => issue(`${path}.${k}`, 'TYPE', '必须是有限数字'));
}

/**
 * Item 校验。
 * @param {unknown} item
 * @param {string} path
 * @param {{allowAction?: boolean, allowPos?: boolean}} [opts]
 */
export function validateItem(item, path = 'item', opts = {}) {
  const out = [];
  if (!isObj(item)) return [issue(path, 'TYPE', '必须是对象')];

  if (!isNonEmptyStr(item.id)) out.push(issue(`${path}.id`, 'REQUIRED', '必须是非空字符串'));
  if (!KIND_SET.has(item.kind)) {
    out.push(issue(`${path}.kind`, 'ENUM', `必须是 ${KINDS.length} 种 M3 kind 之一`));
  }
  if (!isStr(item.label)) out.push(issue(`${path}.label`, 'TYPE', '必须是字符串'));
  if (item.icon !== undefined && item.icon !== null && !isStr(item.icon)) {
    out.push(issue(`${path}.icon`, 'TYPE', '必须是字符串或 null'));
  }
  if (item.icon2 !== undefined && item.icon2 !== null && !isStr(item.icon2)) {
    out.push(issue(`${path}.icon2`, 'TYPE', '必须是字符串或 null'));
  }
  if (!VARIANT_SET.has(item.variant)) {
    out.push(issue(`${path}.variant`, 'ENUM', '必须是 filled / tonal / elevated / outlined / text 之一'));
  }

  const optionalStrings = ['supporting', 'note', 'src', 'name'];
  for (const key of optionalStrings) {
    if (item[key] !== undefined && !isStr(item[key])) out.push(issue(`${path}.${key}`, 'TYPE', '必须是字符串'));
  }
  const optionalNumbers = [
    'size',
    'size2',
    'w',
    'radiusTop',
    'radiusBottom',
    'selected',
    'value',
    'count',
    'imageSize',
    'trackThickness',
  ];
  for (const key of optionalNumbers) {
    if (item[key] !== undefined && !isNum(item[key])) out.push(issue(`${path}.${key}`, 'TYPE', '必须是有限数字'));
  }
  if (item.value !== undefined && isNum(item.value) && (item.value < 0 || item.value > 100)) {
    out.push(issue(`${path}.value`, 'RANGE', '必须在 0..100 之间'));
  }

  const optionalBools = [
    'checked',
    'switch',
    'noImage',
    'bold',
    'wavy',
    'contained',
    'railExpanded',
    'railModal',
    'collapseOnScroll',
    'locked',
    'hidden',
  ];
  for (const key of optionalBools) {
    if (item[key] !== undefined && !isBool(item[key])) out.push(issue(`${path}.${key}`, 'TYPE', '必须是布尔值'));
  }

  if (item.fill !== undefined && !COLOR_TOKEN_SET.has(item.fill)) {
    out.push(issue(`${path}.fill`, 'ENUM', '必须是合法 ColorToken'));
  }
  if (item.iconFill !== undefined && item.iconFill !== 'none' && !COLOR_TOKEN_SET.has(item.iconFill)) {
    out.push(issue(`${path}.iconFill`, 'ENUM', '必须是合法 ColorToken 或 "none"'));
  }
  if (item.textColor !== undefined && !TEXT_TOKEN_SET.has(item.textColor)) {
    out.push(issue(`${path}.textColor`, 'ENUM', '必须是合法 TextToken'));
  }
  if (item.imagePos !== undefined && !CARD_IMAGE_POSITION_SET.has(item.imagePos)) {
    out.push(issue(`${path}.imagePos`, 'ENUM', '必须是合法 CardImagePos'));
  }
  for (const key of ['contentAlign', 'textAlign']) {
    if (item[key] !== undefined && !CARD_ALIGN_SET.has(item[key])) {
      out.push(issue(`${path}.${key}`, 'ENUM', '必须是 start / center / end 之一'));
    }
  }
  if (item.layout !== undefined && !PART_LAYOUT_SET.has(item.layout)) {
    out.push(issue(`${path}.layout`, 'ENUM', '必须是合法布局值'));
  }
  if (item.tabs !== undefined) out.push(...validateTabs(item.tabs, `${path}.tabs`));
  if (item.corners !== undefined) out.push(...validateCorners(item.corners, `${path}.corners`));

  /* DC-036：Item.pos 仅自由组允许，且必须是屏幕本地绝对坐标。 */
  if (item.pos !== undefined) {
    if (!opts.allowPos) {
      out.push(issue(`${path}.pos`, 'POS_NOT_ALLOWED', '非自由组 Item 不得携带 pos；坐标由 Group 与顺序推导'));
    } else if (!isObj(item.pos)) {
      out.push(issue(`${path}.pos`, 'TYPE', '必须是 {x:number,y:number}'));
    } else {
      for (const key of ['x', 'y']) {
        if (!isNum(item.pos[key])) out.push(issue(`${path}.pos.${key}`, 'TYPE', '必须是有限数字'));
      }
    }
  }

  /* DC-017：导航只能存在 FlowEdge，ScreenDoc 里不允许 action。 */
  if (!opts.allowAction) {
    if (item.action !== undefined) {
      out.push(issue(`${path}.action`, 'ACTION_NOT_ALLOWED', 'ScreenDoc 不得持久化 action；请改用 FlowEdge'));
    }
    if (item.actions !== undefined) {
      out.push(issue(`${path}.actions`, 'ACTION_NOT_ALLOWED', 'ScreenDoc 不得持久化 actions；请改用 FlowEdge'));
    }
  }

  return out;
}

/**
 * Group 校验。
 *
 * @param {{allowAction?: boolean, posMap?: boolean}} [opts]
 *   - `posMap=true` 用于 M3E 原始 Doc：`group.pos` 是 `{itemId:{x,y}}` 映射。
 *   - 默认用于 ScreenDoc：`group.pos` 是 `{x,y}`，Item 在自由组内使用绝对坐标 `Item.pos`。
 */
export function validateGroup(group, path = 'group', opts = {}) {
  const out = [];
  if (!isObj(group)) return [issue(path, 'TYPE', '必须是对象')];
  if (!isNonEmptyStr(group.id)) out.push(issue(`${path}.id`, 'REQUIRED', '必须是非空字符串'));
  if (!isNum(group.x)) out.push(issue(`${path}.x`, 'TYPE', '必须是有限数字'));
  if (!isNum(group.y)) out.push(issue(`${path}.y`, 'TYPE', '必须是有限数字'));
  if (!GROUP_AXIS_SET.has(group.axis)) {
    out.push(issue(`${path}.axis`, 'ENUM', '必须是 x / y / free 之一'));
  }
  for (const key of ['locked', 'free', 'hidden']) {
    if (group[key] !== undefined && !isBool(group[key])) {
      out.push(issue(`${path}.${key}`, 'TYPE', '必须是布尔值'));
    }
  }
  if (group.name !== undefined && !isStr(group.name)) {
    out.push(issue(`${path}.name`, 'TYPE', '必须是字符串'));
  }

  const isFree = group.axis === 'free' || group.free === true;

  if (group.pos !== undefined) {
    if (!isObj(group.pos)) {
      out.push(issue(`${path}.pos`, 'TYPE', '必须是对象'));
    } else if (opts.posMap) {
      for (const [id, p] of Object.entries(group.pos)) {
        if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) {
          out.push(issue(`${path}.pos.${id}`, 'TYPE', '必须是 {x:number,y:number}'));
        }
      }
    } else {
      for (const key of ['x', 'y']) {
        if (!isNum(group.pos[key])) {
          out.push(issue(`${path}.pos.${key}`, 'TYPE', '必须是有限数字'));
        }
      }
    }
  }

  if (!Array.isArray(group.items)) {
    out.push(issue(`${path}.items`, 'TYPE', '必须是数组'));
    return out;
  }
  if (group.items.length === 0) out.push(issue(`${path}.items`, 'EMPTY', '至少包含一个 Item'));
  const seen = new Set();
  group.items.forEach((item, i) => {
    const p = `${path}.items[${i}]`;
    out.push(...validateItem(item, p, { ...opts, allowPos: isFree }));
    if (isObj(item) && isNonEmptyStr(item.id)) {
      if (seen.has(item.id)) out.push(issue(`${p}.id`, 'DUPLICATE', `Item id 在组内重复: ${item.id}`));
      else seen.add(item.id);
    }
  });
  return out;
}

/**
 * Frame 校验。
 * @param {{local?: boolean, allowSwipe?: boolean}} [opts]
 */
export function validateFrame(frame, path = 'frame', opts = {}) {
  const out = [];
  if (!isObj(frame)) return [issue(path, 'TYPE', '必须是对象')];
  if (!isNonEmptyStr(frame.id)) out.push(issue(`${path}.id`, 'REQUIRED', '必须是非空字符串'));
  if (!isStr(frame.name)) out.push(issue(`${path}.name`, 'TYPE', '必须是字符串'));
  if (!isNum(frame.x)) out.push(issue(`${path}.x`, 'TYPE', '必须是有限数字'));
  if (!isNum(frame.y)) out.push(issue(`${path}.y`, 'TYPE', '必须是有限数字'));
  if (opts.local) {
    if (frame.x !== 0) out.push(issue(`${path}.x`, 'LOCAL_COORD', 'ScreenDoc 内 frame.x 必须为 0'));
    if (frame.y !== 0) out.push(issue(`${path}.y`, 'LOCAL_COORD', 'ScreenDoc 内 frame.y 必须为 0'));
  }
  for (const key of ['w', 'h']) {
    if (frame[key] !== undefined && (!isNum(frame[key]) || frame[key] <= 0)) {
      out.push(issue(`${path}.${key}`, 'RANGE', '必须是正数'));
    }
  }
  if (frame.bg !== undefined && !COLOR_TOKEN_SET.has(frame.bg)) {
    out.push(issue(`${path}.bg`, 'ENUM', '必须是合法 ColorToken'));
  }
  if (frame.note !== undefined && !isStr(frame.note)) out.push(issue(`${path}.note`, 'TYPE', '必须是字符串'));
  if (frame.length !== undefined && (!isNum(frame.length) || frame.length <= 0)) {
    out.push(issue(`${path}.length`, 'RANGE', '必须是正数'));
  }
  if (frame.place !== undefined && !PLACE_SET.has(frame.place)) {
    out.push(issue(`${path}.place`, 'ENUM', '必须是 top / center / bottom / spread 之一'));
  }
  if (frame.swipe !== undefined) {
    if (!opts.allowSwipe) {
      out.push(issue(`${path}.swipe`, 'ACTION_NOT_ALLOWED', 'ScreenDoc 不得持久化 frame.swipe；请改用 FlowEdge'));
    } else if (!isObj(frame.swipe)) {
      out.push(issue(`${path}.swipe`, 'TYPE', '必须是对象'));
    } else {
      for (const [dir, target] of Object.entries(frame.swipe)) {
        if (!SWIPE_DIR_SET.has(dir)) out.push(issue(`${path}.swipe.${dir}`, 'ENUM', '非法滑动方向'));
        if (!isNonEmptyStr(target)) out.push(issue(`${path}.swipe.${dir}`, 'TYPE', '目标必须是字符串'));
      }
    }
  }
  return out;
}

/** 单屏 ScreenDoc 校验（严格契约） */
export function validateScreenDoc(doc, path = 'doc') {
  const out = [];
  if (!isObj(doc)) return [issue(path, 'TYPE', '必须是对象')];
  if (doc.schema !== SCREEN_SCHEMA) {
    out.push(issue(`${path}.schema`, 'SCHEMA', `必须是 ${SCREEN_SCHEMA}`));
  }
  if (doc.format !== 'm3') out.push(issue(`${path}.format`, 'FORMAT', '必须是 "m3"'));

  out.push(...validateFrame(doc.frame, `${path}.frame`, { local: true, allowSwipe: false }));

  if (!Array.isArray(doc.groups)) {
    out.push(issue(`${path}.groups`, 'TYPE', '必须是数组'));
  } else {
    const groupIds = new Set();
    const itemIds = new Set();
    doc.groups.forEach((group, gi) => {
      const gp = `${path}.groups[${gi}]`;
      out.push(...validateGroup(group, gp, { allowAction: false }));
      if (isObj(group) && isNonEmptyStr(group.id)) {
        if (groupIds.has(group.id)) out.push(issue(`${gp}.id`, 'DUPLICATE', `Group id 重复: ${group.id}`));
        else groupIds.add(group.id);
      }
      if (isObj(group) && Array.isArray(group.items)) {
        group.items.forEach((item, ii) => {
          if (isObj(item) && isNonEmptyStr(item.id)) {
            if (itemIds.has(item.id)) {
              out.push(issue(`${gp}.items[${ii}].id`, 'DUPLICATE', `Item id 在屏内重复: ${item.id}`));
            } else itemIds.add(item.id);
          }
        });
      }
    });
  }

  if (doc.meta !== undefined && !isObj(doc.meta)) out.push(issue(`${path}.meta`, 'TYPE', '必须是对象'));
  if (doc.action !== undefined) out.push(issue(`${path}.action`, 'ACTION_NOT_ALLOWED', 'ScreenDoc 不得持久化 action'));
  return out;
}

export function assertScreenDoc(doc, label = 'ScreenDoc') {
  const issues = validateScreenDoc(doc);
  if (issues.length) throw new M3SchemaError(issues, label);
  return doc;
}

/** ProjectDesign 校验 */
export function validateProjectDesign(design, path = 'design') {
  const out = [];
  if (!isObj(design)) return [issue(path, 'TYPE', '必须是对象')];
  for (const key of ['title', 'brief']) {
    if (design[key] !== undefined && !isStr(design[key])) out.push(issue(`${path}.${key}`, 'TYPE', '必须是字符串'));
  }
  if (design.platform !== undefined && !PLATFORM_SET.has(design.platform)) {
    out.push(issue(`${path}.platform`, 'ENUM', '必须是 android 或 web'));
  }
  if (design.paletteKey !== undefined && !isStr(design.paletteKey)) {
    out.push(issue(`${path}.paletteKey`, 'TYPE', '必须是字符串'));
  }
  if (design.customPalette !== undefined && design.customPalette !== null) {
    if (!isObj(design.customPalette)) out.push(issue(`${path}.customPalette`, 'TYPE', '必须是对象'));
    else if (design.customPalette.primary !== undefined && !isStr(design.customPalette.primary)) {
      out.push(issue(`${path}.customPalette.primary`, 'TYPE', '必须是字符串'));
    }
  }
  if (design.dynamicColor !== undefined && !isBool(design.dynamicColor)) {
    out.push(issue(`${path}.dynamicColor`, 'TYPE', '必须是布尔值'));
  }
  if (design.theme !== undefined) out.push(...validateTheme(design.theme, `${path}.theme`));
  if (design.promptOptions !== undefined) {
    if (!Array.isArray(design.promptOptions) || !design.promptOptions.every(isStr)) {
      out.push(issue(`${path}.promptOptions`, 'TYPE', '必须是字符串数组'));
    }
  }
  if (design.promptEdit !== undefined && design.promptEdit !== null && !isStr(design.promptEdit)) {
    out.push(issue(`${path}.promptEdit`, 'TYPE', '必须是字符串或 null'));
  }
  return out;
}

export function normalizeProjectDesign(design = {}) {
  const d = isObj(design) ? design : {};
  return {
    title: isStr(d.title) ? d.title : '',
    brief: isStr(d.brief) ? d.brief : '',
    platform: PLATFORM_SET.has(d.platform) ? d.platform : 'android',
    paletteKey: isStr(d.paletteKey) ? d.paletteKey : 'purple',
    customPalette: isObj(d.customPalette) ? d.customPalette : null,
    dynamicColor: isBool(d.dynamicColor) ? d.dynamicColor : false,
    theme: normalizeTheme(d.theme),
    promptOptions: Array.isArray(d.promptOptions) ? d.promptOptions.filter(isStr) : [],
    promptEdit: isStr(d.promptEdit) ? d.promptEdit : null,
  };
}

/** M3E 原始 Doc 校验：允许 action/actions/frame.swipe */
export function validateM3eDoc(doc, path = 'doc') {
  const out = [];
  if (!isObj(doc)) return [issue(path, 'TYPE', '必须是对象')];
  if (!Array.isArray(doc.frames)) out.push(issue(`${path}.frames`, 'TYPE', '必须是数组'));
  if (!Array.isArray(doc.groups)) out.push(issue(`${path}.groups`, 'TYPE', '必须是数组'));

  if (Array.isArray(doc.frames)) {
    const ids = new Set();
    doc.frames.forEach((frame, i) => {
      const p = `${path}.frames[${i}]`;
      out.push(...validateFrame(frame, p, { local: false, allowSwipe: true }));
      if (isObj(frame) && isNonEmptyStr(frame.id)) {
        if (ids.has(frame.id)) out.push(issue(`${p}.id`, 'DUPLICATE', `Frame id 重复: ${frame.id}`));
        else ids.add(frame.id);
      }
    });
  }

  if (Array.isArray(doc.groups)) {
    const ids = new Set();
    doc.groups.forEach((group, i) => {
      const p = `${path}.groups[${i}]`;
      out.push(...validateGroup(group, p, { allowAction: true, posMap: true }));
      if (isObj(group) && isNonEmptyStr(group.id)) {
        if (ids.has(group.id)) out.push(issue(`${p}.id`, 'DUPLICATE', `Group id 重复: ${group.id}`));
        else ids.add(group.id);
      }
    });
  }

  if (doc.platform !== undefined && !PLATFORM_SET.has(doc.platform)) {
    out.push(issue(`${path}.platform`, 'ENUM', '必须是 android 或 web'));
  }
  if (doc.promptOptions !== undefined && (!Array.isArray(doc.promptOptions) || !doc.promptOptions.every(isStr))) {
    out.push(issue(`${path}.promptOptions`, 'TYPE', '必须是字符串数组'));
  }
  if (doc.promptEdit !== undefined && doc.promptEdit !== null && !isStr(doc.promptEdit)) {
    out.push(issue(`${path}.promptEdit`, 'TYPE', '必须是字符串或 null'));
  }
  if (doc.theme !== undefined) out.push(...validateTheme(doc.theme, `${path}.theme`));
  return out;
}

export function assertM3eDoc(doc, label = 'M3E Doc') {
  const issues = validateM3eDoc(doc);
  if (issues.length) throw new M3SchemaError(issues, label);
  return doc;
}

const isIsoTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

/**
 * FlowEdge 校验（供 M1 存储层复用）。
 *
 * V4.1 契约：
 *  - `trigger` 仅 click / swipe / auto；
 *  - `swipe` 必须携带 `direction`（DC-040）；
 *  - `orphan` 动态计算，不得写入 `flow.json`（DC-039）。
 */
export function validateFlowEdge(edge, path = 'edge') {
  const out = [];
  if (!isObj(edge)) return [issue(path, 'TYPE', '必须是对象')];
  for (const key of ['edge_id', 'source_screen_id']) {
    if (!isNonEmptyStr(edge[key])) out.push(issue(`${path}.${key}`, 'REQUIRED', '必须是非空字符串'));
  }
  for (const key of ['source_item_id', 'source_slot', 'target_screen_id', 'url']) {
    if (edge[key] !== undefined && edge[key] !== null && !isStr(edge[key])) {
      out.push(issue(`${path}.${key}`, 'TYPE', '必须是字符串或 null'));
    }
  }
  if (!TARGET_KIND_SET.has(edge.target_kind)) {
    out.push(issue(`${path}.target_kind`, 'ENUM', '必须是 screen / back / link / menu / toggle 之一'));
  }
  if (edge.target_kind === 'screen' && !isNonEmptyStr(edge.target_screen_id)) {
    out.push(issue(`${path}.target_screen_id`, 'REQUIRED', 'screen 边必须有目标屏'));
  }
  if (edge.target_kind === 'link' && !isStr(edge.url)) {
    out.push(issue(`${path}.url`, 'REQUIRED', 'link 边必须有 url'));
  }
  if (!TRIGGER_SET.has(edge.trigger)) {
    out.push(issue(`${path}.trigger`, 'ENUM', '必须是 click / swipe / auto 之一'));
  }
  if (edge.direction !== undefined && edge.direction !== null && !SWIPE_DIR_SET.has(edge.direction)) {
    out.push(issue(`${path}.direction`, 'ENUM', '必须是 left / right / up / down 之一'));
  }
  if (edge.trigger === 'swipe' && !SWIPE_DIR_SET.has(edge.direction)) {
    out.push(issue(`${path}.direction`, 'REQUIRED', 'swipe 边必须携带 direction（DC-040）'));
  }
  if (edge.transition !== undefined && !TRANSITION_SET.has(edge.transition)) {
    out.push(issue(`${path}.transition`, 'ENUM', '必须是合法 Transition'));
  }
  if (edge.status !== undefined && !EDGE_STATUS_SET.has(edge.status)) {
    out.push(issue(`${path}.status`, 'ENUM', '必须是 candidate 或 confirmed'));
  }
  if (edge.expires_at !== undefined && edge.expires_at !== null && !isIsoTime(edge.expires_at)) {
    out.push(issue(`${path}.expires_at`, 'TYPE', '必须是 ISO 时间字符串或 null'));
  }
  if (edge.created_at !== undefined && !isIsoTime(edge.created_at)) {
    out.push(issue(`${path}.created_at`, 'TYPE', '必须是 ISO 时间字符串'));
  }
  if (edge.created_by !== undefined && !isStr(edge.created_by)) {
    out.push(issue(`${path}.created_by`, 'TYPE', '必须是字符串'));
  }
  if (edge.note !== undefined && !isStr(edge.note)) {
    out.push(issue(`${path}.note`, 'TYPE', '必须是字符串'));
  }
  if (edge.orphan !== undefined) {
    out.push(issue(`${path}.orphan`, 'ORPHAN_NOT_ALLOWED', 'orphan 必须动态计算，不得持久化（DC-039）'));
  }
  return out;
}

export function validateFlow(flow, path = 'flow') {
  const out = [];
  if (!isObj(flow)) return [issue(path, 'TYPE', '必须是对象')];
  if (flow.schema_version !== FLOW_SCHEMA_VERSION) {
    out.push(issue(`${path}.schema_version`, 'SCHEMA', `必须是 ${FLOW_SCHEMA_VERSION}`));
  }
  if (!Array.isArray(flow.edges)) {
    out.push(issue(`${path}.edges`, 'TYPE', '必须是数组'));
  } else {
    const ids = new Set();
    flow.edges.forEach((edge, i) => {
      const p = `${path}.edges[${i}]`;
      out.push(...validateFlowEdge(edge, p));
      if (isObj(edge) && isNonEmptyStr(edge.edge_id)) {
        if (ids.has(edge.edge_id)) out.push(issue(`${p}.edge_id`, 'DUPLICATE', `Edge id 重复: ${edge.edge_id}`));
        else ids.add(edge.edge_id);
      }
    });
  }
  return out;
}

/** 版本快照：doc + theme_snapshot（DC-031） */
export function validateVersionSnapshot(snapshot, path = 'version') {
  const out = [];
  if (!isObj(snapshot)) return [issue(path, 'TYPE', '必须是对象')];
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    out.push(issue(`${path}.version`, 'RANGE', '必须是 >=1 的整数'));
  }
  out.push(...validateScreenDoc(snapshot.doc, `${path}.doc`));
  out.push(...validateTheme(snapshot.theme_snapshot, `${path}.theme_snapshot`));
  if (snapshot.prompt_digest !== undefined && snapshot.prompt_digest !== null && !isStr(snapshot.prompt_digest)) {
    out.push(issue(`${path}.prompt_digest`, 'TYPE', '必须是字符串或 null（DC-041）'));
  }
  return out;
}

export { isObj, isStr, isNonEmptyStr, isNum, isBool };
