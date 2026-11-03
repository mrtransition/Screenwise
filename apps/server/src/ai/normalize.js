import { makeId, ID_RE } from '../domain/doc.js';
import { PATCH_OPS } from '../domain/patch.js';
import { modelFailed } from '../errors.js';

/**
 * 远端模型输出 → 系统内部节点树 / patch 的归一化层。
 *
 * 内置生成器天然符合内部契约，自定义模型不会。实测最常见的"接上就白屏"原因都出在这里：
 *  1. 用 HTML 字符串代替 JSON；
 *  2. JSON 里把属性直接写在节点上（data-anchor / style:"a:b" / text 不在 props 里）；
 *  3. 输出 {"root": ...} 而不是 {"version":1,"root":...}；
 *  4. 节点没有 id，或者多条 op 复用了同一个 id；
 *  5. children 里混进字符串 / null；
 *  6. 可点击元素没有 data-anchor → 流程层连不出边；
 *  7. 文案塞在 props.children 里，被当成树结构子节点；
 *  8. patch 用了内部不支持的 op 名（setText / modify / insertNode …）。
 *
 * 归一化的原则是"能救则救、救不了就带着可读原因拒绝"，绝不把半残结构写入屏幕。
 */

const TAG_ALIASES = {
  header: 'header',
  footer: 'footer',
  nav: 'nav',
  aside: 'aside',
  main: 'main',
  section: 'section',
  article: 'article',
  figure: 'figure',
  strong: 'strong',
  em: 'em',
  small: 'small',
  img: 'img',
  image: 'img',
  input: 'input',
  textarea: 'textarea',
  select: 'select',
  table: 'table',
  tr: 'tr',
  td: 'td',
  th: 'th',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  a: 'a',
  label: 'label',
  form: 'form',
  p: 'p',
  span: 'span',
  div: 'div',
  button: 'button',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
};

const CLICKABLE_TAGS = new Set(['button', 'a']);
const CLICKABLE_TYPES = /button|btn|link|action|cta/i;
const STRUCT_KEYS = new Set(['id', 'type', 'tag', 'props', 'children', 'style', 'attrs', 'text', 'name']);

const had = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 把 "display:flex;margin-top:8px" 之类的字符串 style 解析成对象 */
export function parseStyleString(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key || !val) continue;
    if (key.startsWith('--')) {
      out[key] = val;
      continue;
    }
    // background-color → backgroundColor
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    // 纯数字也保留字符串（"0 auto" 这类复合值不能丢单位）
    out[camel] = val;
  }
  return out;
}

/** 把 {"data-anchor":"x"} 这类扁平属性收敛到 props.attrs / props.style / props.text */
function normalizeProps(raw, extra) {
  const props = { style: {}, attrs: {} };

  const collectStyle = (v) => {
    if (!v) return;
    if (typeof v === 'string') Object.assign(props.style, parseStyleString(v));
    else if (typeof v === 'object' && !Array.isArray(v)) Object.assign(props.style, v);
  };

  if (raw && typeof raw === 'object') {
    if (had(raw, 'style')) collectStyle(raw.style);
    if (had(raw, 'attrs') && raw.attrs && typeof raw.attrs === 'object') Object.assign(props.attrs, raw.attrs);
    if (had(raw, 'text') && raw.text != null && raw.text !== '') props.text = String(raw.text);
    else if (had(raw, 'content') && typeof raw.content === 'string' && raw.content) props.text = raw.content;

    // HTML 属性形态：data-* / aria-* / 扁平 class、href、src、placeholder、value …
    for (const [k, v] of Object.entries(raw)) {
      if (STRUCT_KEYS.has(k)) continue;
      if (k === 'content' || v === undefined) continue;
      if (/^(data-|aria-)/.test(k)) props.attrs[k] = v;
      else if (k === 'className') props.attrs.class = v;
      else if (k === 'class' || k === 'href' || k === 'src' || k === 'alt' || k === 'placeholder' || k === 'value' || k === 'type' || k === 'role' || k === 'title') {
        props.attrs[k] = v;
      } else if (typeof v === 'string' || typeof v === 'number') {
        // 未知扁平字段仍然保留，避免丢信息（例如 name / key）
        props.attrs[k] = v;
      }
    }
  }

  if (extra?.props && typeof extra.props === 'object') {
    const p = extra.props;
    if (p.style) collectStyle(p.style);
    if (p.attrs && typeof p.attrs === 'object') Object.assign(props.attrs, p.attrs);
    if (had(p, 'text') && p.text != null && p.text !== '') props.text = String(p.text);
  }

  // 有些模型把文案放在 props.children（字符串）
  if (props.text == null && extra?.props && typeof extra.props.children === 'string' && extra.props.children.trim()) {
    props.text = extra.props.children;
  }
  return props;
}

/** 未知 tag 一律降级成 div，渲染器只认白名单 */
function normalizeTag(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return 'div';
  if (TAG_ALIASES[t]) return TAG_ALIASES[t];
  // "Button" / "<div>" / "div " 等写法
  const cleaned = t.replace(/[<>/\s]/g, '');
  if (TAG_ALIASES[cleaned]) return TAG_ALIASES[cleaned];
  return 'div';
}

/** 是否是"看起来可以点"的节点（用于补齐热区） */
function looksClickable(node) {
  const tag = node.tag;
  const attrs = node.props?.attrs || {};
  if (attrs['data-anchor']) return true;
  if (CLICKABLE_TAGS.has(tag)) return true;
  if (attrs.role === 'button' || attrs.role === 'link') return true;
  if (CLICKABLE_TYPES.test(String(tag))) return true;
  const text = node.props?.text || '';
  const style = node.props?.style || {};
  const bg = String(style.background || style.backgroundColor || '');
  // 带背景色的小圆角块通常是按钮
  if (/^#|rgb|hsl|var\(/.test(bg) && style.borderRadius != null) return true;
  if (/^(登录|注册|提交|确定|确认|保存|下一步|继续|返回|获取验证码|去|查看|编辑|删除|新增|下载)$/.test(String(text).trim())) return true;
  return false;
}

export function slugAnchor(text, fallback) {
  const base = String(text || '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  const ascii = /[a-zA-Z0-9]/.test(base) ? base : '';
  return ascii || fallback;
}

/**
 * 一次整屏归一化：返回 { doc, warnings }
 * - 修 id、修 props、修 children、补 version/root
 * - 给可点击元素补 data-anchor（唯一）
 */
export function ensureDocFromRemote(input, { screenIdHint, ensureAnchors = true } = {}) {
  const warnings = [];
  let raw = input;

  // 模型有时返回 {"doc":{"root":...}} 或 {"screen":{...}} 或 {"result":{...}}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.root && typeof raw.root === 'object') {
      /* 已经是 doc */
    } else if (raw.doc && raw.doc.root) raw = raw.doc;
    else if (raw.screen && raw.screen.root) raw = raw.screen;
    else if (raw.result && raw.result.root) raw = raw.result;
    else if (raw.rootNode && typeof raw.rootNode === 'object') raw = { ...raw, root: raw.rootNode };
  }

  if (raw && typeof raw === 'object' && Array.isArray(raw)) {
    throw modelFailed('模型返回的是数组，缺少根节点', {
      hint: '整屏生成必须返回单根节点树 {"version":1,"root":{...}}',
    });
  }

  if (!raw || typeof raw !== 'object' || !raw.root || typeof raw.root !== 'object') {
    const keys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 8).join(', ') : typeof raw;
    throw modelFailed(`模型返回的节点树缺少 root（收到：${keys}）`, {
      hint: '确认模型按 {"version":1,"root":{...}} 结构返回；可点「AI 模型 → 测试连接」看原始回复',
    });
  }

  const usedIds = new Set();
  const usedAnchors = new Set();
  const counters = { anchor: 0 };

  const build = (src, depth, isRoot) => {
    if (src == null) return null;
    // children 里混进字符串：当成文本节点
    if (typeof src === 'string') {
      if (!src.trim()) return null;
      warnings.push('children 中出现纯字符串，已转为文本节点');
      return { id: freshId('txt', usedIds), type: 'text', tag: 'span', props: { style: {}, attrs: {}, text: src }, children: [] };
    }
    if (typeof src !== 'object' || Array.isArray(src)) return null;
    if (depth > 40) return null;

    const id = typeof src.id === 'string' && ID_RE.test(src.id) && !usedIds.has(src.id) ? src.id : freshId(isRoot ? 'root' : String(src.type || src.tag || 'n'), usedIds);
    if (typeof src.id === 'string' && src.id !== id) warnings.push(`节点 id 重复或非法，已重命名：${src.id} → ${id}`);
    usedIds.add(id);

    const tag = normalizeTag(src.tag || src.type);
    const props = normalizeProps(src, { props: src.props });
    const node = {
      id,
      type: String(src.type || (isRoot ? 'frame' : 'component')),
      tag,
      props,
      children: [],
    };

    const kids = Array.isArray(src.children) ? src.children : [];
    for (const kid of kids) {
      const child = build(kid, depth + 1, false);
      if (child) node.children.push(child);
    }

    // 可点击元素没有热区 → 补一个稳定、可读的 anchor（否则流程层连不出边）
    if (ensureAnchors && !props.attrs['data-anchor'] && looksClickable(node)) {
      let a = slugAnchor(props.text, `el${++counters.anchor}`);
      let uniq = a;
      let i = 2;
      while (usedAnchors.has(uniq)) uniq = `${a}_${i++}`;
      usedAnchors.add(uniq);
      props.attrs['data-anchor'] = uniq;
    } else if (props.attrs['data-anchor']) {
      let a = String(props.attrs['data-anchor']).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || `el${++counters.anchor}`;
      let uniq = a;
      let i = 2;
      while (usedAnchors.has(uniq)) uniq = `${a}_${i++}`;
      usedAnchors.add(uniq);
      props.attrs['data-anchor'] = uniq;
    }
    return node;
  };

  const root = build(raw.root, 0, true);
  // 兜底：个别模型会把 root 包一层（{root:{root:...}} / {root:{children:[...]}} 但没有 tag）
  if (root && !root.tag) root.tag = 'section';
  if (!raw.root.id) {
    // 根节点 id 必须是字符串（validateDoc 要求），build 已补
  }

  const doc = { version: Number(raw.version) || 1, root };
  if (screenIdHint && typeof root.id === 'string') {
    // 根节点 id 不强绑 screen_id，但记录一下便于排查
    doc.screen_id = screenIdHint;
  }
  return doc;
}

function freshId(prefix, used) {
  let id;
  do {
    id = makeId(String(prefix || 'n').replace(/[^\w-]/g, '').slice(0, 12) || 'n');
  } while (used.has(id));
  return id;
}

/* ------------------------------------------------------------------ HTML */

const SELF_CLOSING = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
const CONTAINER_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'main', 'nav', 'aside', 'ul', 'ol', 'li', 'p', 'form', 'figure',
  'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'button', 'a', 'label', 'strong', 'em', 'small', 'table', 'tr', 'td', 'th',
]);

/**
 * 极简 HTML → 节点树。只处理模型常吐的那部分标签与内联样式，
 * 不追求完整规范，目的是"别让整屏变成一段文字"。
 */
export function htmlToTree(html) {
  const src = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/(html|body|head)>/gi, '')
    .replace(/<(html|body)[^>]*>/gi, '');
  let i = 0;

  const makeRoot = () => ({ tag: 'section', attrs: { 'data-block': 'root' }, style: { width: '100%', minHeight: '100%' }, children: [] });
  const root = makeRoot();
  const stack = [root];

  const pushText = (text) => {
    const t = decodeEntities(text).replace(/\s+/g, ' ');
    if (!t.trim()) return;
    const parent = stack[stack.length - 1];
    // 纯文本挂到父节点的 text 上；父节点已有 text 则另起节点，避免丢字
    if (!parent.text) parent.text = t.trim();
    else parent.children.push({ tag: 'span', text: t.trim(), children: [] });
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));

    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const tagText = src.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!tagText || tagText.startsWith('!') || tagText.startsWith('?')) continue;
    if (tagText.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosed = tagText.endsWith('/');
    const body = selfClosed ? tagText.slice(0, -1) : tagText;
    const m = /^([a-zA-Z][\w-]*)([\s\S]*)$/.exec(body);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    if (tag === 'script' || tag === 'style') {
      const end = src.toLowerCase().indexOf(`</${tag}>`, i);
      i = end < 0 ? src.length : end + tag.length + 3;
      continue;
    }

    const attrs = parseAttrs(m[2]);
    const node = { tag: CONTAINER_TAGS.has(tag) ? tag : tag === 'img' ? 'img' : tag === 'input' ? 'input' : 'div', attrs: {}, style: {}, children: [] };
    let styleAttr = '';
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') styleAttr = v;
      else if (k === 'class') node.attrs.class = v;
      else node.attrs[k] = v;
    }
    if (styleAttr) node.style = parseStyleString(styleAttr);

    const parent = stack[stack.length - 1];
    parent.children.push(node);
    if (!selfClosed && !SELF_CLOSING.has(tag)) stack.push(node);
  }

  // 顶层若只剩一个容器，去掉多余包裹
  let top = root;
  if (root.children.length === 1 && !root.text) top = root.children[0];
  top.attrs = { ...(top.attrs || {}) };
  if (!top.attrs['data-block']) top.attrs['data-block'] = 'root';
  return { version: 1, root: top };
}

function parseAttrs(str) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ patch */

const OP_ALIASES = {
  settext: 'updateProps',
  text: 'updateProps',
  settextcontent: 'updateProps',
  modify: 'updateProps',
  modifyprops: 'updateProps',
  update: 'updateProps',
  updatecontent: 'updateProps',
  patch: 'updateProps',
  setprop: 'updateProps',
  setattr: 'updateProps',
  setattributes: 'updateProps',
  updatestyle: 'setStyle',
  style: 'setStyle',
  addchild: 'insertChild',
  insert: 'insertChild',
  appendchild: 'insertChild',
  addnode: 'insertChild',
  append: 'insertChild',
  insertafter: 'insertAfter',
  insertbefore: 'insertAfter',
  add: 'insertChild',
  remove: 'removeNode',
  delete: 'removeNode',
  removenode: 'removeNode',
  deletenode: 'removeNode',
  replace: 'replaceNode',
  replacenode: 'replaceNode',
};

function normalizeOpName(name) {
  const n = String(name || '').trim();
  if (PATCH_OPS.includes(n)) return n;
  const lower = n.toLowerCase().replace(/[\s_-]/g, '');
  if (OP_ALIASES[lower]) return OP_ALIASES[lower];
  if (OP_ALIASES[n]) return OP_ALIASES[n];
  return null;
}

/** 目标写法五花八门：node_id / id / targetId / selector 字符串 … */
function normalizeTarget(t, op) {
  let raw = t;
  if (typeof raw === 'string' || typeof raw === 'number') raw = { node_id: String(raw) };
  if (raw && typeof raw === 'object' && raw.nodeId && !raw.node_id) raw = { ...raw, node_id: String(raw.nodeId) };
  if (raw && typeof raw === 'object' && raw.target_id && !raw.node_id) raw = { ...raw, node_id: String(raw.target_id) };
  if (raw && typeof raw === 'object' && raw.selector !== undefined) {
    const sel = raw.selector;
    if (typeof sel === 'object' && sel && !sel.type) {
      // {selector:{anchor:'x'}} → {selector:{type:'anchor',value:'x'}}
      if (sel.anchor != null) raw = { ...raw, selector: { type: 'anchor', value: String(sel.anchor) } };
      else if (sel.block != null) raw = { ...raw, selector: { type: 'block', value: String(sel.block) } };
      else if (sel.id != null || sel.node_id != null) raw = { ...raw, selector: { type: 'node_id', value: String(sel.id ?? sel.node_id) } };
    }
  }
  // 有些模型直接给 {anchor:'x'}
  if (raw && typeof raw === 'object' && !raw.node_id && !raw.selector) {
    if (raw.anchor != null) return { target: { selector: { type: 'anchor', value: String(raw.anchor) } }, node: raw };
    if (raw.nodeId != null) return { target: { node_id: String(raw.nodeId) }, node: raw };
    if (raw.id != null) return { target: { node_id: String(raw.id) }, node: raw };
  }
  return { target: raw, node: null };
}

/** 把 op 的 value 变成内部结构 */
function normalizeValue(op, opName, raw, original) {
  if (opName === 'updateProps') {
    const out = { ...(raw && typeof raw === 'object' ? raw : {}) };
    // 常见的几种写法：value.text / value.content / value.props.text / value: "新文案"
    if (typeof raw === 'string') return { text: raw };
    if (out.content !== undefined && out.text === undefined) {
      out.text = out.content;
      delete out.content;
    }
    if (out.props && typeof out.props === 'object') {
      if (out.props.text !== undefined && out.text === undefined) out.text = out.props.text;
      if (out.props.style && !out.style) out.style = out.props.style;
      if (out.props.attrs && !out.attrs) out.attrs = out.props.attrs;
      delete out.props;
    }
    if (typeof out.style === 'string') out.style = parseStyleString(out.style);
    // 模型常把 "background:red" 直接写在 value 上
    const leftover = Object.keys(out).filter((k) => !['text', 'style', 'attrs', 'remove_attrs'].includes(k));
    if (leftover.length) {
      const styleKeys = leftover.filter((k) => /^[a-z-]+$/.test(k) || /Color$|Size$|Width$|Height$|Radius$|Align$|Padding$|Margin$/.test(k));
      if (styleKeys.length === leftover.length) {
        out.style = { ...(out.style || {}), ...parseStyleString(leftover.map((k) => `${k}:${out[k]}`).join(';')) };
        for (const k of leftover) delete out[k];
      }
    }
    return out;
  }
  if (opName === 'setStyle') {
    if (typeof raw === 'string') return { style: parseStyleString(raw) };
    if (raw && typeof raw === 'object') {
      if (raw.style) return { style: typeof raw.style === 'string' ? parseStyleString(raw.style) : raw.style };
      // 直接给 {background:'#fff'}
      return { style: raw };
    }
    return { style: {} };
  }
  if (opName === 'replaceNode' || opName === 'insertChild' || opName === 'insertAfter') {
    let node = raw && typeof raw === 'object' ? raw.node ?? raw.newNode ?? raw.element : raw;
    if (!node && original) node = original.node ?? original.newNode ?? original.element;
    // 有些写法把节点平铺在 op 上
    if (!node && original && (original.tag || original.type)) node = original;
    const index = raw && typeof raw === 'object' && raw.index != null ? raw.index : original?.index;
    if (!node || typeof node !== 'object') {
      throw modelFailed(`${opName} 缺少要插入/替换的节点`, {
        hint: '契约要求 value.node 为节点对象',
      });
    }
    const wrapped = ensureDocFromRemote({ version: 1, root: { ...node, id: node.id || undefined } }, { ensureAnchors: true });
    return index != null ? { node: wrapped.root, index } : { node: wrapped.root };
  }
  return raw;
}

/**
 * patch 归一化：修 op 名、修 target 写法、修 value 结构、丢弃无法识别的 op。
 * 返回的 ops 一定满足内部契约，剩下的交给 applyPatch 做严格校验。
 */
export function ensurePatchFromRemote(ops) {
  const out = [];
  const list = Array.isArray(ops) ? ops : [];
  for (const op of list) {
    if (!op || typeof op !== 'object') continue;
    const opName = normalizeOpName(op.op || op.type || op.action || op.operation);
    if (!opName) continue;

    const { target, node: inlineTarget } = normalizeTarget(op.target ?? op.node_id ?? op.id ?? op.selector ?? inlineTargetOf(op), opName);
    let tgt = target;
    if (!tgt || typeof tgt !== 'object' || (!tgt.node_id && !tgt.selector)) continue;

    const rawValue = op.value !== undefined ? op.value : op.props !== undefined ? op.props : op;
    let value;
    try {
      value = normalizeValue(opName, opName, rawValue, op);
    } catch {
      // 单条 op 结构不对时跳过，不要整批失败
      continue;
    }
    if (opName === 'updateProps') {
      if (!value || (!value.style && !value.attrs && value.text === undefined && !value.remove_attrs)) continue;
    }
    if (opName === 'setStyle' && (!value?.style || !Object.keys(value.style).length)) continue;

    const next = { op: opName, target: tgt, value };
    if (op.note) next.note = op.note;
    out.push(next);
  }
  return out;
}

function inlineTargetOf(op) {
  if (op.nodeId != null) return op.nodeId;
  if (op.node_id != null) return op.node_id;
  if (op.target_id != null) return op.target_id;
  if (op.anchor != null) return { selector: { type: 'anchor', value: String(op.anchor) } };
  return null;
}

/**
 * 归一化后的整屏完整性检查：给 service 用来"输出非法不落库"。
 */
export function docQualityWarnings(doc) {
  const warnings = [];
  let count = 0;
  let anchors = 0;
  const visit = (n) => {
    if (!n) return;
    count++;
    if (n.props?.attrs?.['data-anchor']) anchors++;
    for (const c of n.children || []) visit(c);
  };
  visit(doc.root);
  if (count <= 1) warnings.push('模型只返回了根节点，屏幕内容为空');
  if (!anchors) warnings.push('没有识别到任何可点击热区，流程连线将无法建立');
  return warnings;
}
