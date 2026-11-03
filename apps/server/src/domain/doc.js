import { randomUUID } from 'node:crypto';
import { EDIT_SCOPES } from '../constants.js';

/**
 * 屏幕内容 = 节点树（节点级 patch 的前提）。
 * doc = { version: 1, root: <Node> }
 * Node = { id, type, tag, props:{style,attrs,text}, children[] }
 *
 * 约束：
 *  - 每个节点 id 在屏内唯一且稳定；patch 只按 id 定位，不按索引。
 *  - 可点击元素必须带 data-anchor 属性（流程层唯一依赖）。
 *  - 顶层区块带 data-block 语义标签，便于按块 patch。
 */
export function makeId(prefix = 'n') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function node(type, tag, props = {}, children = []) {
  return { id: makeId(type), type, tag, props, children };
}

export function emptyDoc() {
  return {
    version: 1,
    root: node('frame', 'section', {
      style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#f7f8fa' },
      attrs: { 'data-block': 'root' },
    }),
  };
}

export function cloneDoc(doc) {
  return structuredClone(doc);
}

export function walk(n, fn, parent = null) {
  if (!n || typeof n !== 'object') return;
  // 允许直接传 doc：容器本身不是节点，不能进入回调（否则会出现 id=undefined 的伪节点）
  if (!Array.isArray(n.children) && n.root && typeof n.root === 'object') {
    walk(n.root, fn, parent);
    return;
  }
  fn(n, parent);
  const kids = n.children;
  if (!Array.isArray(kids)) return;
  for (const c of kids) walk(c, fn, n);
}

export function findNode(root, id) {
  let hit = null;
  walk(root, (n) => {
    if (!hit && n.id === id) hit = n;
  });
  return hit;
}

export function parentOf(root, id) {
  let hit = null;
  walk(root, (n, p) => {
    if (n.id === id) hit = p;
  });
  return hit;
}

export function collectAnchors(root) {
  const out = [];
  walk(root, (n) => {
    const a = n.props?.attrs?.['data-anchor'];
    if (a) out.push({ hotspot_id: a, node_id: n.id, text: textOf(n) });
  });
  return out;
}

export function textOf(n) {
  if (n.props?.text) return String(n.props.text);
  const s = [];
  for (const c of Array.isArray(n.children) ? n.children : []) {
    const t = textOf(c);
    if (t) s.push(t);
  }
  return s.join(' ').trim();
}

export function validateDoc(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['doc 不是对象'];
  if (!doc.root) errs.push('缺少 root');
  const seen = new Set();
  walk(doc.root, (n) => {
    if (!n.id || typeof n.id !== 'string') errs.push(`节点缺少 id: ${n.tag}`);
    else if (seen.has(n.id)) errs.push(`节点 id 重复: ${n.id}`);
    else seen.add(n.id);
    if (!n.tag || typeof n.tag !== 'string') errs.push(`节点 ${n.id} 缺少 tag`);
    if (n.children && !Array.isArray(n.children)) errs.push(`节点 ${n.id} children 不是数组`);
  });
  return errs;
}

/** 结构指纹：用于隔离性验证（改了 A 屏，B 屏指纹必须不变） */
export function fingerprint(doc) {
  const parts = [];
  walk(doc.root, (n) => {
    parts.push(
      `${n.id}|${n.tag}|${JSON.stringify(n.props?.style || {})}|${JSON.stringify(n.props?.attrs || {})}|${
        n.props?.text ?? ''
      }`
    );
  });
  return parts.join('\n');
}

export function countNodes(doc) {
  let c = 0;
  walk(doc.root, () => c++);
  return c;
}

export const ID_RE = /^[a-zA-Z_][\w-]*$/;
export { EDIT_SCOPES };
