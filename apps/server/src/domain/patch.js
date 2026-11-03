import { walk, findNode, parentOf, node, makeId, validateDoc } from './doc.js';

/**
 * Patch 应用器 —— 严格、原子、拒绝越界。
 *
 * 支持的 op（SRS FR-PATCH-001）：
 *   replaceNode   { op, target:{node_id} | {selector:{anchor}}, value:{ node } }
 *   updateProps   { op, target, value:{ style?:{}, attrs?:{}, text?:string } }
 *   insertChild   { op, target, value:{ node, index? } }
 *   insertAfter   { op, target, value:{ node } }
 *   removeNode    { op, target }
 *   setStyle      { op, target, value:{ style } }
 *
 * 安全规则（对应 SRS §7 AI-007 / API 错误码）：
 *   1. 任何越界目标（node 不在本屏） → FORBIDDEN_TARGET
 *   2. 目标 id 形式非法（nth-child / 路径 / 索引） → INVALID_OUTPUT
 *   3. patch 中出现非本屏 screen_id → FORBIDDEN_TARGET + 告警
 *   4. 先在克隆上全量应用，全部成功才返回新 doc，否则原 doc 不变（NFR-008）
 */

const FORBIDDEN_SELECTOR = /(nth-child|nth-of-type|:first|:last|\s>\s|\[\s*\d+\s*\]|^div\b.*\s)/i;

/** 允许的 op 白名单：未知 op 在落库前就拒绝，而不是应用一半才发现 */
export const PATCH_OPS = ['replaceNode', 'updateProps', 'insertChild', 'insertAfter', 'removeNode', 'setStyle'];

export function validatePatch(patch, { screenId } = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object') return ['patch 不是对象'];
  if (!Array.isArray(patch.ops)) return ['patch.ops 必须是非空数组'];

  patch.ops.forEach((op, i) => {
    if (!op || typeof op !== 'object') {
      errors.push(`op[${i}] 不是对象`);
      return;
    }
    if (!op.op) errors.push(`op[${i}] 缺少 op 字段`);
    else if (!PATCH_OPS.includes(op.op)) errors.push(`op[${i}] 不支持的 op: ${op.op}`);
    if (!op.target) errors.push(`op[${i}] 缺少 target`);
    const tgt = op.target;
    if (tgt) {
      if (typeof tgt !== 'object' || Array.isArray(tgt)) {
        errors.push(`op[${i}] target 必须是对象`);
      } else {
        if (!tgt.node_id && !tgt.selector) errors.push(`op[${i}] target 必须含 node_id 或 selector`);
        if (tgt.node_id !== undefined && typeof tgt.node_id !== 'string') errors.push(`op[${i}] target.node_id 必须是字符串`);
        if (tgt.selector !== undefined) {
          const sel = tgt.selector;
          if (typeof sel === 'string' && FORBIDDEN_SELECTOR.test(sel)) {
            errors.push(`op[${i}] 选择器不稳定，禁止使用结构化伪选择器: ${sel}`);
          }
          if (sel && typeof sel === 'object' && sel.type && !['node_id', 'anchor', 'block'].includes(sel.type)) {
            errors.push(`op[${i}] 未知 selector.type: ${sel.type}`);
          }
          if (sel && typeof sel === 'object' && sel.type && typeof sel.value !== 'string') {
            errors.push(`op[${i}] selector.value 必须是字符串`);
          }
        }
        if (tgt.screen_id && screenId && tgt.screen_id !== screenId) {
          errors.push(`op[${i}] 跨屏写入被拒绝: target.screen_id=${tgt.screen_id}，本屏=${screenId}`);
        }
      }
    }
    if (op.op === 'updateProps') {
      if (!op.value || typeof op.value !== 'object') errors.push(`op[${i}] updateProps 缺少 value`);
      else if (op.value.style !== undefined && (typeof op.value.style !== 'object' || Array.isArray(op.value.style))) {
        errors.push(`op[${i}] updateProps.value.style 必须是对象`);
      }
    }
    if (op.op === 'setStyle' && (!op.value || typeof op.value.style !== 'object' || Array.isArray(op.value.style))) {
      errors.push(`op[${i}] setStyle 缺少 value.style 对象`);
    }
    if (['replaceNode', 'insertChild', 'insertAfter'].includes(op.op)) {
      if (!op.value || typeof op.value.node !== 'object' || op.value.node === null) {
        errors.push(`op[${i}] ${op.op} 缺少 value.node`);
      }
    }
  });

  if (patch.target_screen_id && screenId && patch.target_screen_id !== screenId) {
    errors.push(`patch.target_screen_id=${patch.target_screen_id} 与请求屏幕 ${screenId} 不一致`);
  }
  return errors;
}

function resolveTarget(root, target) {
  if (!target) return null;
  if (target.node_id) {
    return findNode(root, target.node_id) ? { id: target.node_id } : null;
  }
  const sel = target.selector;
  if (typeof sel === 'string') {
    // 允许 '#id' 与 '[data-anchor="x"]'
    const hash = /^#(.+)$/.exec(sel);
    if (hash) return findNode(root, hash[1]) ? { id: hash[1] } : null;
    const anchor = /^\[data-anchor=["']?(.+?)["']?\]$/.exec(sel);
    if (anchor) {
      let hit = null;
      walk(root, (n) => {
        if (!hit && n.props?.attrs?.['data-anchor'] === anchor[1]) hit = n;
      });
      return hit ? { id: hit.id } : null;
    }
    return null;
  }
  if (sel?.type === 'node_id') return findNode(root, sel.value) ? { id: sel.value } : null;
  if (sel?.type === 'anchor') {
    let hit = null;
    walk(root, (n) => {
      if (!hit && n.props?.attrs?.['data-anchor'] === sel.value) hit = n;
    });
    return hit ? { id: hit.id } : null;
  }
  if (sel?.type === 'block') {
    let hit = null;
    walk(root, (n) => {
      if (!hit && n.props?.attrs?.['data-block'] === sel.value) hit = n;
    });
    return hit ? { id: hit.id } : null;
  }
  return null;
}

function normalizeNode(raw) {
  // 模型可能省略 id：补一个，保证后续 patch 可定位
  const n = {
    id: raw.id && typeof raw.id === 'string' ? raw.id : makeId('ai'),
    type: raw.type || 'component',
    tag: raw.tag || 'div',
    props: { style: raw.props?.style || {}, attrs: raw.props?.attrs || {}, ...(raw.props?.text != null ? { text: raw.props.text } : {}) },
    children: [],
  };
  if (raw.children) n.children = raw.children.map(normalizeNode);
  return n;
}

/**
 * 应用 patch。返回 { doc, applied, diff } 或抛错，doc 永不部分修改。
 */
export function applyPatch(originalDoc, patch, { screenId } = {}) {
  const errors = validatePatch(patch, { screenId });
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.code = /跨屏|不一致/.test(errors.join(';')) ? 'FORBIDDEN_TARGET' : 'INVALID_OUTPUT';
    err.errors = errors;
    throw err;
  }

  const working = structuredClone(originalDoc);
  const applied = [];
  const diff = [];

  for (const [i, op] of patch.ops.entries()) {
    const target = resolveTarget(working.root, op.target);
    if (!target) {
      const err = new Error(`op[${i}] 目标未命中：${JSON.stringify(op.target)}（屏幕内容未改变）`);
      err.code = 'INVALID_OUTPUT';
      err.errors = [err.message];
      throw err;
    }
    const n = findNode(working.root, target.id);
    if (!n) {
      const err = new Error(`op[${i}] 目标节点消失：${target.id}`);
      err.code = 'INVALID_OUTPUT';
      throw err;
    }
    const before = JSON.stringify({ props: n.props, children: n.children });
    let kind = op.op;

    switch (op.op) {
      case 'replaceNode': {
        const p = parentOf(working.root, target.id);
        if (!p) {
          const err = new Error('不允许替换 root 节点');
          err.code = 'INVALID_OUTPUT';
          throw err;
        }
        const idx = p.children.findIndex((c) => c.id === target.id);
        p.children[idx] = normalizeNode(op.value.node);
        break;
      }
      case 'updateProps': {
        const v = op.value || {};
        n.props = n.props || { style: {}, attrs: {} };
        if (v.style) n.props.style = { ...n.props.style, ...v.style };
        if (v.attrs) n.props.attrs = { ...n.props.attrs, ...v.attrs };
        if (v.text !== undefined) n.props.text = v.text;
        if (v.remove_attrs) for (const k of v.remove_attrs) delete n.props.attrs?.[k];
        break;
      }
      case 'setStyle': {
        n.props.style = { ...(n.props.style || {}), ...(op.value.style || {}) };
        break;
      }
      case 'insertChild': {
        const child = normalizeNode(op.value.node);
        n.children = Array.isArray(n.children) ? n.children : [];
        const idx = op.value.index == null ? n.children.length : Math.max(0, Math.min(op.value.index, n.children.length));
        n.children.splice(idx, 0, child);
        break;
      }
      case 'insertAfter': {
        const p = parentOf(working.root, target.id);
        if (!p) {
          const err = new Error('root 节点后不能插入兄弟节点');
          err.code = 'INVALID_OUTPUT';
          throw err;
        }
        const idx = p.children.findIndex((c) => c.id === target.id);
        p.children.splice(idx + 1, 0, normalizeNode(op.value.node));
        break;
      }
      case 'removeNode': {
        const p = parentOf(working.root, target.id);
        if (!p) {
          const err = new Error('不允许删除 root 节点');
          err.code = 'INVALID_OUTPUT';
          throw err;
        }
        p.children = p.children.filter((c) => c.id !== target.id);
        break;
      }
      default: {
        const err = new Error(`不支持的 op: ${op.op}`);
        err.code = 'INVALID_OUTPUT';
        throw err;
      }
    }

    const after = n.id === target.id && op.op !== 'removeNode' ? findNode(working.root, target.id) : null;
    diff.push({
      op: op.op,
      node_id: target.id,
      before_len: before.length,
      after: after ? JSON.stringify({ props: after.props, children: after.children }).length : 0,
    });
    applied.push({ index: i, op: op.op, node_id: target.id, kind });
  }

  const docErrors = validateDoc(working);
  if (docErrors.length) {
    const err = new Error(`patch 应用后文档非法：${docErrors.join('; ')}`);
    err.code = 'INVALID_OUTPUT';
    throw err;
  }

  return { doc: working, applied, diff };
}

/** 撤销 patch：用应用前版本覆盖（整版本回滚，FR-PATCH-005） */
export function patchTargetAnchors(doc) {
  const out = [];
  walk(doc.root, (n) => {
    if (n.props?.attrs?.['data-anchor']) out.push(n.props.attrs['data-anchor']);
  });
  return out;
}
