/**
 * M3 编辑器岛（SRS §2.2 / §6.4 / FR-EDIT-018）
 *
 * 岛的边界（ADR 0001）：
 *  - 只拿 `load` 下发的 ScreenDoc / 主题，负责单屏渲染与交互；
 *  - **不访问任何接口、不落库**，所有写入通过 `save` / `change` 消息回宿主；
 *  - 宿主负责 schema 校验、`base_version` 冲突与版本写入。
 *
 * 消息方向与载荷见 `docs/编辑器岛桥接协议.md`。
 */

import { renderM3Body, themeCss, SCREEN_BASE_CSS } from './screen-render.js';
import { UndoHistory, resolveShortcut, flattenLayers, resolveDrag, applyDrag, dragOrigin } from './editor-state.js';

const PROTOCOL = 'm3studio/editor@1';
const VERSION = 1;

let screenId = null;
let doc = null;
let theme = {};
let readonly = false;
let locked = false;
let history = new UndoHistory();
let selectedId = null;
let lastSent = null;
let baseVersion = 0;
/** 宿主回灌等外部改动也要算“有未保存内容”，不能只依赖撤销栈 */
let externalDirty = false;
/** 当前屏幕在 iframe 内的缩放比：指针位移要除回文档坐标 */
let viewScale = 1;
/** 拖拽会话：pointerdown 记录起点，pointermove 实时更新，pointerup 只入栈一次 */
let drag = null;
/** 拖拽结束后的那次 click 只用于抑制选中，不再重复处理 */
let suppressClick = false;

const els = {
  title: document.getElementById('title'),
  ver: document.getElementById('ver'),
  state: document.getElementById('state'),
  canvas: document.getElementById('canvas'),
  wrapper: document.getElementById('canvasWrap'),
  hint: document.getElementById('hint'),
  undo: document.getElementById('btnUndo'),
  redo: document.getElementById('btnRedo'),
  save: document.getElementById('btnSave'),
};

const post = (type, payload) => {
  if (!screenId) return;
  parent.postMessage(
    { protocol: PROTOCOL, request_id: `${screenId}:${type}:${Date.now()}`, screen_id: screenId, type, payload },
    '*'
  );
};

function setState(s) {
  els.state.textContent = s;
  els.state.className = `chip${s === 'error' || s === 'conflict' ? ' warn' : ''}`;
}

/**
 * 按容器自适应缩放（不裁剪、不重建 DOM）。
 * 只改 transform、不重建 DOM：窗口缩放时只调 fit()，不会反过来再改布局。
 */
function fit() {
  const f = doc?.frame ?? {};
  const W = f.w ?? 412;
  const H = Math.max(f.length || 0, f.h ?? 892);
  const stage = document.getElementById('stage');
  const wrapper = els.wrapper;
  if (!stage || !wrapper) return;
  const availW = Math.max(120, stage.clientWidth - 32);
  const availH = Math.max(120, stage.clientHeight - 32);
  const scale = Math.min(1, availW / W, availH / H);
  viewScale = scale;
  // wrapper 占位 = 缩放后的真实尺寸（transform 不改变布局盒，占位必须自己收回来）
  wrapper.style.width = `${Math.round(W * scale)}px`;
  wrapper.style.height = `${Math.round(H * scale)}px`;
  els.canvas.style.transform = `scale(${scale})`;
  els.canvas.style.transformOrigin = 'top left';
  els.canvas.style.width = `${W}px`;
  els.canvas.style.height = `${H}px`;
}

function render() {
  if (!doc) {
    els.canvas.innerHTML = '<p style="padding:32px;color:#9ca3af">等待宿主下发屏幕…</p>';
    return;
  }
  // 与预览、导出共用同一个渲染函数（FR-RENDER-001）
  els.canvas.innerHTML = `<style>${SCREEN_BASE_CSS}\n.m3-island{${themeCss({ theme })}}</style>${renderM3Body(doc, { theme })}`;
  els.canvas.querySelector('.m3-screen')?.classList.add('m3-island');
  for (const el of els.canvas.querySelectorAll('[data-item-id]')) {
    if (el.dataset.itemId === selectedId) el.classList.add('sel');
  }
  fit();
  els.ver.textContent = `v${baseVersion}${dirty() ? ' · 未保存' : ''}`;
  els.undo.disabled = readonly || locked || !history.canUndo;
  els.redo.disabled = readonly || locked || !history.canRedo;
  els.save.disabled = readonly || locked || !dirty();
  els.hint.textContent = readonly || locked
    ? '只读模式：可查看，不可保存'
    : '拖拽移动部件（Ctrl 自由定位） · 单击选中 · 双击改文案 · Ctrl+Z 撤销 · Ctrl+S 保存';
}

const dirty = () => history.canUndo || externalDirty;

function apply(newDoc, label) {
  if (readonly || locked) return;
  history.push(newDoc, label);
  doc = newDoc;
  render();
  // change 只是通知宿主刷新缩略图，不落库（协议：宿主不立即写版本）
  post('change', { doc, dirty: true, summary: label || '编辑', base_version: baseVersion });
}

/** 从当前 doc 构造一份新 doc 后交给 apply，避免原地改引用 */
function mutate(fn, label) {
  const next = structuredClone(doc);
  fn(next);
  apply(next, label);
}

function markSelected() {
  for (const el of els.canvas.querySelectorAll('[data-item-id]')) {
    el.classList.toggle('sel', el.dataset.itemId === selectedId);
  }
}

/** 取消进行中的拖拽并恢复开始前的文档 */
function cancelDrag() {
  if (!drag) return;
  doc = drag.baseDoc;
  drag = null;
  render();
}

els.canvas.addEventListener('click', (ev) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const el = ev.target.closest?.('[data-item-id]');
  if (!el) return;
  selectedId = el.dataset.itemId;
  render();
  const group = (doc.groups ?? []).find((g) => (g.items ?? []).some((i) => i.id === selectedId));
  post('select', { item_ids: [selectedId], group_ids: group ? [group.id] : [] });
});

/**
 * 画布内拖拽移动（FR-EDIT-004 / AC-322）：
 *  - 自由组拖 Item 写 Item.pos；非自由组只移动组坐标（DC-036）；
 *  - 默认吸附 4dp，按住 Ctrl 时自由移动；
 *  - 位移按当前 iframe 缩放比换算回文档坐标。
 */
els.canvas.addEventListener('pointerdown', (ev) => {
  if (readonly || locked || !doc || ev.button !== 0) return;
  if (ev.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const itemEl = ev.target.closest?.('[data-item-id]');
  const groupEl = ev.target.closest?.('[data-group-id]');
  if (!itemEl && !groupEl) return;
  let group = null;
  let item = null;
  if (itemEl) {
    group = (doc.groups ?? []).find((g) => (g.items ?? []).some((i) => i.id === itemEl.dataset.itemId)) ?? null;
    item = group?.items?.find((i) => i.id === itemEl.dataset.itemId) ?? null;
  } else {
    group = (doc.groups ?? []).find((g) => g.id === groupEl.dataset.groupId) ?? null;
  }
  if (!group || group.hidden || group.locked) return;
  if (item && (item.hidden || item.locked)) return;

  const origin = dragOrigin(group, item);
  drag = {
    pointerId: ev.pointerId,
    startClientX: ev.clientX,
    startClientY: ev.clientY,
    startX: origin.x,
    startY: origin.y,
    group,
    item,
    baseDoc: doc,
    moved: false,
  };
  suppressClick = false;
  if (item) {
    selectedId = item.id;
    markSelected();
    post('select', { item_ids: [item.id], group_ids: [group.id] });
  }
});

window.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const clientDx = ev.clientX - drag.startClientX;
  const clientDy = ev.clientY - drag.startClientY;
  if (!drag.moved && Math.hypot(clientDx, clientDy) < 3) return;
  drag.moved = true;
  ev.preventDefault();

  const scale = viewScale || 1;
  const result = resolveDrag({
    group: drag.group,
    item: drag.item,
    startX: drag.startX,
    startY: drag.startY,
    dx: clientDx / scale,
    dy: clientDy / scale,
    free: !!(ev.ctrlKey || ev.metaKey),
  });
  doc = applyDrag(drag.baseDoc, result);
  render();
});

window.addEventListener('pointerup', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const session = drag;
  drag = null;
  if (!session.moved) return;
  suppressClick = true;
  const label = session.item
    ? `移动部件：${session.item.name || session.item.label || session.item.kind}`
    : `移动分组：${session.group.name || session.group.id}`;
  const changed = history.push(doc, label);
  render();
  if (changed) post('change', { doc, dirty: true, summary: label, base_version: baseVersion });
});

window.addEventListener('pointercancel', cancelDrag);
window.addEventListener('blur', cancelDrag);

els.canvas.addEventListener('dblclick', (ev) => {
  if (readonly || locked) return;
  const el = ev.target.closest?.('[data-item-id]');
  if (!el) return;
  const itemId = el.dataset.itemId;
  const textEl = el.querySelector('.m3-btn-inner span, .m3-card-title, .m3-appbar-title, .m3-label, span');
  const original = textEl?.textContent ?? '';
  const input = document.createElement('input');
  input.value = original;
  input.style.cssText = 'font:inherit;width:100%;border:1px solid #2563eb;border-radius:6px;padding:2px 4px';
  (textEl ?? el).replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const value = input.value.trim();
    if (!value || value === original) return render();
    // 只改文案走 manual_direct，由宿主决定最终是否落库
    mutate((d) => {
      for (const g of d.groups ?? []) {
        const it = (g.items ?? []).find((i) => i.id === itemId);
        if (it) it.label = value;
      }
    }, `修改文案：「${original}」→「${value}」`);
    post('dirty', { dirty: true });
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      render();
    }
  });
});

els.undo.addEventListener('click', () => {
  const prev = history.undo();
  if (!prev) return;
  doc = prev;
  render();
  post('change', { doc, dirty: dirty(), summary: '撤销', base_version: baseVersion });
});

els.redo.addEventListener('click', () => {
  const next = history.redo();
  if (!next) return;
  doc = next;
  render();
  post('change', { doc, dirty: dirty(), summary: '重做', base_version: baseVersion });
});

els.save.addEventListener('click', () => {
  if (readonly || locked || !doc) return;
  post('save', { doc, base_version: baseVersion, summary: lastSent?.summary || '编辑器保存' });
  setState('saving');
});

window.addEventListener('keydown', (ev) => {
  const act = resolveShortcut(ev, { editing: true });
  if (!act) return;
  if (act.action === 'undo') {
    ev.preventDefault();
    els.undo.click();
  } else if (act.action === 'redo') {
    ev.preventDefault();
    els.redo.click();
  } else if (act.action === 'save') {
    ev.preventDefault();
    els.save.click();
  } else if (act.action === 'cancel') {
    if (drag) {
      ev.preventDefault();
      cancelDrag();
      return;
    }
    selectedId = null;
    render();
  }
});

/* ------------------------------------------------------------------ */
/* 与宿主的消息                                                        */
/* ------------------------------------------------------------------ */

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.protocol !== PROTOCOL) return;
  if (m.screen_id !== screenId && m.type !== 'load') return;

  switch (m.type) {
    case 'load': {
      const p = m.payload ?? {};
      // echo：宿主侧回灌（Tidy/主题/外部修改），只更新文档，不重建编辑态
      if (p.echo && doc) {
        doc = p.doc ?? doc;
        baseVersion = Number.isInteger(p.base_version) ? p.base_version : baseVersion;
        externalDirty = true;
        render();
        break;
      }
      // 同一屏重复下发 load：保留编辑态与撤销栈，只同步外部来源
      const sameScreen = screenId === m.screen_id && doc !== null;
      screenId = m.screen_id;
      if (sameScreen && JSON.stringify(p.doc) === JSON.stringify(doc)) {
        // 完全相同的重复 load：只同步只读态，不再回 ready（否则与宿主形成回环）
        readonly = !!p.readonly;
        locked = !!p.locked;
        setState(readonly ? 'readonly' : locked ? 'locked' : 'ready');
        return;
      }
      doc = p.doc ?? null;
      theme = p.theme ?? {};
      readonly = !!p.readonly;
      locked = !!p.locked;
      baseVersion = Number.isInteger(p.base_version) ? p.base_version : 0;
      history = new UndoHistory().reset(doc ?? {});
      externalDirty = false;
      selectedId = null;
      els.title.textContent = doc?.frame?.name || '屏幕';
      render();
      setState(readonly ? 'readonly' : locked ? 'locked' : 'ready');
      post('ready', { protocol: PROTOCOL, version: VERSION });
      break;
    }
    case 'theme':
      theme = m.payload?.theme ?? theme;
      render();
      break;
    case 'mode':
      readonly = !!m.payload?.readonly;
      locked = !!m.payload?.locked;
      render();
      setState(readonly ? 'readonly' : locked ? 'locked' : 'ready');
      break;
    case 'flush':
      if (dirty() && doc) post('save', { doc, base_version: baseVersion, summary: '宿主要求提交' });
      break;
    case 'save-result': {
      const r = m.payload ?? {};
      if (r.ok) {
        baseVersion = r.version;
        externalDirty = false;
        history.clear(doc);
        lastSent = null;
        render();
        setState('saved');
      } else if (r.code === 'CONFLICT') {
        setState('conflict');
        // 草稿保留：用户可复制后刷新
      } else {
        setState('error');
      }
      break;
    }
    default:
      break;
  }
});

// 容器尺寸变化（宿主面板拖拽/窗口缩放）后重算缩放
window.addEventListener('resize', fit);

// 岛就绪后主动告知宿主（宿主也会在收到 ready 后开始下发）
if (parent !== window) post('ready', { protocol: PROTOCOL, version: VERSION });
else {
  // 独立打开时给一份示例，便于调试界面本身
  doc = {
    schema: 'm3studio/screen@1',
    format: 'm3',
    frame: { id: 'scr_island', name: '编辑器岛预览', x: 0, y: 0, w: 412, h: 892 },
    groups: [
      { id: 'g1', x: 0, y: 0, axis: 'y', items: [{ id: 'i1', kind: 'topAppBar', label: '编辑器岛', variant: 'filled' }] },
      { id: 'g2', x: 16, y: 104, axis: 'y', items: [{ id: 'i2', kind: 'card', label: '独立打开时的示例', variant: 'filled' }] },
    ],
  };
  screenId = 'scr_island';
  render();
  setState('standalone');
}

void flattenLayers;
