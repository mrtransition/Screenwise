/**
 * 旧 `node-tree` 兼容层（FR-M3-008 / FR-RENDER-004/005 / AC-316 / AC-601）
 *
 * 旧文档 `{version, root}` 不重写、不静默覆盖：存储里保留原样，只把屏幕标记为
 * `format:"node-tree"`，由独立只读渲染器呈现。需要进入 M3 时必须显式转换
 * （API-019），转换结果带损失报告，且只有用户确认后才保存。
 */

import { SCREEN_SCHEMA, PHONE } from './m3/constants.js';
import { KIND_SPEC } from './m3/registry.js';
import { M3SchemaError, assertScreenDoc, validateScreenDoc } from './m3/schema.js';

export function isLegacyNodeTree(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.format === 'node-tree') return true;
  if (doc.format === 'm3') return false;
  return !!doc.root && typeof doc.root === 'object';
}

export function isM3ScreenDoc(doc) {
  return !!doc && doc.format === 'm3' && doc.schema === SCREEN_SCHEMA;
}

/** 归一化旧文档：只接受 `{version, root}` 或包了一层的对象 */
export function normalizeLegacyDoc(input) {
  if (!input || typeof input !== 'object') return null;
  if (isM3ScreenDoc(input)) return null;
  if (input.root && typeof input.root === 'object') {
    return { version: Number(input.version) || 1, root: input.root };
  }
  if (input.doc && typeof input.doc === 'object') return normalizeLegacyDoc(input.doc);
  return null;
}

const BLOCK_TAGS = new Set(['div', 'section', 'main', 'article', 'aside', 'form', 'figure', 'nav', 'header', 'footer', 'ul', 'ol', 'li']);
const HEADING = { h1: 30, h2: 24, h3: 20, h4: 18 };
const TEXT_TAGS = new Set(['p', 'span', 'strong', 'em', 'small', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function plainText(node, depth = 0) {
  if (!node || depth > 12) return '';
  const own = typeof node.props?.text === 'string' ? node.props.text : '';
  const kids = Array.isArray(node.children) ? node.children : [];
  return (own + kids.map((c) => plainText(c, depth + 1)).join(' ')).replace(/\s+/g, ' ').trim();
}

function attr(node, name) {
  return node?.props?.attrs?.[name] ?? null;
}

function styleOf(node) {
  return node?.props?.style && typeof node.props.style === 'object' ? node.props.style : {};
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

let seq = 0;
function nextId(prefix, used) {
  let id = `${prefix}_${(seq++).toString(36)}`;
  while (used.has(id)) id = `${prefix}_${(seq++).toString(36)}`;
  used.add(id);
  return id;
}

/** 旧节点 → 一个 M3 Item；无法映射时降级为 text/box 并记录损失 */
function itemOf(node, { used, loss, anchorOfNode }) {
  const tag = String(node?.tag ?? 'div').toLowerCase();
  const label = plainText(node);
  const anchor = anchorOfNode ? anchorOfNode(node) : attr(node, 'data-anchor');
  const id = anchor && /^[a-zA-Z_][\w-]*$/.test(anchor) && !used.has(anchor) ? anchor : nextId('itm', used);
  const item = { id, kind: 'box', label: label.slice(0, 200), variant: 'filled', name: tag };
  const style = styleOf(node);
  const fontSize = num(style.fontSize);
  const radius = num(style.borderRadius);

  if (tag === 'button' || (tag === 'a' && attr(node, 'role') === 'button')) {
    if (label.length > 0) {
      item.kind = 'button';
      item.variant = attr(node, 'role') === 'button' || tag === 'a' ? 'text' : 'filled';
    } else {
      item.kind = 'iconButton';
      item.label = '';
    }
    if (radius !== null) item.corners = { tl: radius, tr: radius, bl: radius, br: radius };
  } else if (HEADING[tag]) {
    item.kind = 'text';
    item.variant = 'text';
    item.size = fontSize ?? HEADING[tag];
    item.bold = true;
  } else if (TEXT_TAGS.has(tag)) {
    item.kind = 'text';
    item.variant = 'text';
    if (fontSize) item.size = fontSize;
    if (String(style.fontWeight ?? '').match(/bold|[6-9]00/)) item.bold = true;
  } else if (tag === 'img') {
    item.kind = 'image';
    item.src = attr(node, 'src') || '';
    item.label = attr(node, 'alt') || '';
  } else if (tag === 'input' || tag === 'select') {
    item.kind = tag === 'select' ? 'select' : 'textField';
    item.label = attr(node, 'placeholder') || attr(node, 'aria-label') || attr(node, 'name') || '';
  } else if (tag === 'ul' || tag === 'ol') {
    item.kind = 'box';
  } else if (tag === 'nav') {
    item.kind = 'bottomNav';
    item.label = label || '导航';
  } else if (tag === 'header') {
    item.kind = 'topAppBar';
    item.label = label.slice(0, 40);
  } else if (tag === 'footer') {
    item.kind = 'bottomNav';
    item.label = label || '底部导航';
  } else if (BLOCK_TAGS.has(tag)) {
    item.kind = 'box';
    item.label = '';
  } else {
    item.kind = 'text';
    item.variant = 'text';
    loss.push({ node_id: node?.id ?? null, tag, reason: `未识别的标签 <${tag}>，降级为 text`, fallback: 'text' });
  }
  if (!KIND_SPEC[item.kind]) {
    loss.push({ node_id: node?.id ?? null, tag, reason: `部件 ${item.kind} 不在 Registry，降级为 box`, fallback: 'box' });
    item.kind = 'box';
  }
  return item;
}

/**
 * 旧 node-tree → M3 ScreenDoc（启发式，供 API-019 预览与 AC-609）
 *
 * 布局策略（确定性，不依赖 DOM）：
 *  - 顶层块按文档顺序纵向排列，间距 12dp，左右留 16dp；
 *  - 子元素沿父块的 x 轴排列；层数 > 2 时继续纵向累加；
 *  - 无法映射的节点降级为 box/text，并写入 `report.loss`。
 * 这不是像素级还原；旧的只读渲染器仍保留原版呈现，转换是显式选择。
 */
export function convertLegacyToM3(input, { screenId, title = '旧屏幕', device = PHONE, now = new Date().toISOString() } = {}) {
  const legacy = normalizeLegacyDoc(input);
  if (!legacy) throw new M3SchemaError([{ path: 'doc', code: 'TYPE', message: '不是旧 node-tree 文档' }], '旧文档');
  if (!screenId) throw new M3SchemaError([{ path: 'screen_id', code: 'REQUIRED', message: '缺少 screen_id' }], '旧文档');

  const used = new Set();
  const loss = [];
  const flat = [];

  const anchorOfNode = (node) => attr(node, 'data-anchor');

  const visit = (node, depth, cursor) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    const children = Array.isArray(node.children) ? node.children : [];
    const tag = String(node.tag ?? 'div').toLowerCase();

    /* li 视为一行，不再生成 box 容器 */
    const isListChild = tag === 'li';
    const ownText = typeof node.props?.text === 'string' ? node.props.text.trim() : '';
    const mapped = itemOf(node, { used, loss, anchorOfNode });

    const hasBlockChildren = children.some((c) => c && (BLOCK_TAGS.has(String(c.tag).toLowerCase()) || TEXT_TAGS.has(String(c.tag).toLowerCase())));
    const keep = depth > 0 && (ownText.length > 0 || isListChild || node.props?.attrs?.['data-anchor'] || !hasBlockChildren);
    if (keep) flat.push({ item: mapped, depth });

    if (children.length) {
      let x = 16;
      for (const child of children) {
        visit(child, depth + 1, { x, y: cursor.y });
        const w = num(styleOf(child).width) ?? KIND_SPEC[itemOfPlaceholder(child)]?.w ?? 260;
        x += Math.min(360, w) + 8;
      }
    }
  };

  const itemOfPlaceholder = (node) => {
    const tag = String(node?.tag ?? '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'image';
    if (HEADING[tag] || TEXT_TAGS.has(tag)) return 'text';
    return 'box';
  };

  visit(legacy.root, 0, { x: 16, y: 16 });

  /* 纵向排布：每项高度取部件默认高度，文本按字号 */
  const items = [];
  let y = 16;
  for (const { item, depth } of flat) {
    const spec = KIND_SPEC[item.kind] ?? KIND_SPEC.box;
    let h = spec.h;
    if (item.kind === 'text') h = Math.round((item.size ?? 16) * 1.35);
    if (item.kind === 'image') h = 160;
    if (item.kind === 'box' && !item.label) h = 8; // 纯布局容器不占位，避免空白过大
    const w = Math.min(device.w - 32, item.kind === 'text' ? Math.max(120, Math.min(320, (item.label?.length ?? 0) * ((item.size ?? 16) * 0.9))) : spec.w);
    items.push({
      ...item,
      pos: { x: 16 + Math.min(depth, 2) * 8, y },
    });
    if (item.kind === 'text') items[items.length - 1].size = item.size ?? 16;
    y += h + 12;
  }

  const groups = items.length
    ? [
        {
          id: 'grp_legacy',
          x: 0,
          y: 0,
          axis: 'free',
          name: '旧文档转换',
          locked: false,
          hidden: false,
          pos: { x: 0, y: 0 },
          items,
        },
      ]
    : [];

  const doc = {
    schema: SCREEN_SCHEMA,
    format: 'm3',
    frame: {
      id: screenId,
      name: title,
      x: 0,
      y: 0,
      w: device.w ?? PHONE.w,
      h: device.h ?? PHONE.h,
    },
    groups,
    meta: {
      source_format: 'node-tree',
      source_version: legacy.version,
      converted_at: now,
      loss_count: loss.length,
    },
  };
  assertScreenDoc(doc, '旧文档转换');

  return {
    doc,
    report: {
      source_format: 'node-tree',
      source_version: legacy.version,
      converted: items.length,
      loss,
      loss_count: loss.length,
      summary: loss.length ? `旧文档转换，损失 ${loss.length} 项` : '旧文档转换完成，无损失',
    },
  };
}

/** 旧文档校验（只做结构安全检查，不改写内容） */
export function validateLegacyDoc(doc) {
  const legacy = normalizeLegacyDoc(doc);
  if (!legacy) return [{ path: 'doc', code: 'TYPE', message: '不是有效的旧 node-tree 文档（缺少 root）' }];
  const issues = [];
  const count = { nodes: 0, scripts: 0, handlers: 0 };
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 50) return;
    count.nodes++;
    const tag = String(n.tag ?? '').toLowerCase();
    if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      count.scripts++;
      issues.push({ path: `root.${n.id ?? '?'}`, code: 'UNSAFE_TAG', message: `只读渲染会剥离 <${tag}>` });
    }
    for (const k of Object.keys(n.props?.attrs ?? {})) {
      if (/^on/i.test(k)) {
        count.handlers++;
        issues.push({ path: `root.${n.id ?? '?'}.${k}`, code: 'UNSAFE_ATTR', message: '只读渲染会剥离事件属性' });
      }
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(legacy.root, 0);
  issues.push({ path: 'doc', code: 'INFO', message: `共 ${count.nodes} 个节点；安全过滤将剥离 ${count.scripts} 个危险标签、${count.handlers} 个事件属性` });
  return issues;
}

export { validateScreenDoc };
