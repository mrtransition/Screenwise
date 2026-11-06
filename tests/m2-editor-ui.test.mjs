import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveShortcut,
  shortcutConflict,
  UndoHistory,
  resolveDrag,
  applyDrag,
  dragOrigin,
  flattenLayers,
  updateLayer,
  moveLayer,
  searchPalette,
  groupPalette,
  GRID,
  HISTORY_LIMIT,
} from '../apps/web/src/editor-state.js';
import { KIND_SPECS } from '../apps/server/src/domain/m3/registry.js';
import { emptyScreenDoc } from '../apps/server/src/domain/m3/convert.js';

/**
 * M2 编辑器交互逻辑（AC-306 / AC-307 / AC-321 / AC-322）。
 * 这里是纯逻辑层，宿主画布与未来的编辑器岛共用同一份实现。
 */

const doc = () => {
  const d = emptyScreenDoc({ screenId: 'scr_e', title: '编辑器', width: 412, height: 892 });
  d.groups = [
    { id: 'g_a', x: 16, y: 16, axis: 'y', name: '顶栏组', items: [{ id: 'i_a', kind: 'topAppBar', label: '首页', variant: 'filled' }] },
    { id: 'g_b', x: 16, y: 200, axis: 'y', name: '列表组', items: [
      { id: 'i_b1', kind: 'card', label: '卡片一', variant: 'filled' },
      { id: 'i_b2', kind: 'card', label: '卡片二', variant: 'filled' },
    ] },
    { id: 'g_f', x: 0, y: 0, axis: 'free', name: '自由层', items: [{ id: 'i_f', kind: 'fab', variant: 'filled', pos: { x: 340, y: 800 } }] },
  ];
  return d;
};

/* ------------------------------------------------------------------ */
/* AC-307：快捷键                                                       */
/* ------------------------------------------------------------------ */

test('AC-307：V/H 切换工具，空格平移，P 预览，T 排版', () => {
  assert.deepEqual(resolveShortcut({ key: 'v' }), { action: 'tool', tool: 'select' });
  assert.deepEqual(resolveShortcut({ key: 'H' }), { action: 'tool', tool: 'pan' });
  assert.deepEqual(resolveShortcut({ key: ' ' }), { action: 'pan', active: true });
  assert.deepEqual(resolveShortcut({ key: 'p' }), { action: 'preview' });
  assert.deepEqual(resolveShortcut({ key: 't' }), { action: 'tidy' });
  assert.deepEqual(resolveShortcut({ key: 'Delete' }), { action: 'delete' });
});

test('AC-307：方向键微调，Shift 加大步长', () => {
  assert.deepEqual(resolveShortcut({ key: 'ArrowLeft' }), { action: 'nudge', dx: -1, dy: 0, big: false });
  assert.deepEqual(resolveShortcut({ key: 'ArrowDown', shiftKey: true }), { action: 'nudge', dx: 0, dy: 1, big: true });
  assert.deepEqual(resolveShortcut({ key: 'ArrowUp' }), { action: 'nudge', dx: 0, dy: -1, big: false });
});

test('AC-307：输入框内不劫持任何快捷键', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(resolveShortcut({ key: 'Delete', target: { tagName } }), null, `${tagName} 内不劫持 Delete`);
    assert.equal(resolveShortcut({ key: 'ArrowLeft', target: { tagName } }), null, `${tagName} 内不劫持方向键`);
    assert.equal(resolveShortcut({ key: 'p', target: { tagName } }), null, `${tagName} 内不劫持 P`);
  }
  assert.equal(resolveShortcut({ key: ' ' , target: { isContentEditable: true } }), null, 'contenteditable 内不劫持空格');
});

test('AC-307：非编辑器会话（只读/预览）不响应单键快捷键', () => {
  assert.equal(resolveShortcut({ key: 'Delete' }, { editing: false }), null);
  assert.equal(resolveShortcut({ key: 'p' }, { editing: false }), null);
});

test('AC-307：Ctrl 组合键优先，撤销/重做/保存/分组齐全', () => {
  assert.deepEqual(resolveShortcut({ key: 'z', ctrlKey: true }), { action: 'undo' });
  assert.deepEqual(resolveShortcut({ key: 'z', metaKey: true, shiftKey: true }), { action: 'redo' });
  assert.deepEqual(resolveShortcut({ key: 'y', ctrlKey: true }), { action: 'redo' });
  assert.deepEqual(resolveShortcut({ key: 's', ctrlKey: true }), { action: 'save' });
  assert.deepEqual(resolveShortcut({ key: 'g', ctrlKey: true }), { action: 'group' });
  assert.deepEqual(resolveShortcut({ key: 'G', ctrlKey: true, shiftKey: true }), { action: 'ungroup' });
  assert.deepEqual(resolveShortcut({ key: 'd', ctrlKey: true }), { action: 'duplicate' });
  // Ctrl+V 是粘贴，不是切换选择工具
  assert.deepEqual(resolveShortcut({ key: 'v', ctrlKey: true }), { action: 'paste' });
});

test('AC-307：与浏览器冲突的快捷键会给出提示而不是静默吞掉', () => {
  assert.match(shortcutConflict({ key: 's', ctrlKey: true }), /保存/);
  assert.match(shortcutConflict({ key: 'w', ctrlKey: true }), /关闭标签页/);
  assert.equal(shortcutConflict({ key: 'z', ctrlKey: true }), null);
});

/* ------------------------------------------------------------------ */
/* AC-306：撤销 / 重做                                                  */
/* ------------------------------------------------------------------ */

test('AC-306：编辑 3 次后 Ctrl+Z 两次，再保存只落一条版本（状态层面）', () => {
  const base = doc();
  const h = new UndoHistory().reset(base);

  let d = structuredClone(base);
  d.groups[1].x = 32;
  h.push(d, '移动列表');
  d = structuredClone(d);
  d.groups[1].items[0].label = '卡片一（改）';
  h.push(d, '改文案');
  d = structuredClone(d);
  d.groups[1].items.push({ id: 'i_b3', kind: 'card', label: '卡片三', variant: 'filled' });
  h.push(d, '新增卡片');

  assert.equal(h.depth, 3);

  const one = h.undo();
  assert.equal(one.groups[1].items.length, 2, '第一次撤销去掉新增卡片');
  const two = h.undo();
  assert.equal(two.groups[1].items[0].label, '卡片一', '第二次撤销还原文案');
  assert.equal(two.groups[1].x, 32, '移动仍保留（只撤销了两步）');

  // 保存只看当前状态：一条版本
  h.clear(two);
  assert.equal(h.canUndo, false, '保存后清空会话栈');
  assert.equal(h.canRedo, false);
});

test('AC-306：撤销栈上限 50 步，超出后丢弃最老快照且不报错', () => {
  assert.ok(HISTORY_LIMIT >= 50);
  const h = new UndoHistory().reset(doc());
  for (let i = 0; i < 60; i++) {
    const d = doc();
    d.groups[1].x = i;
    h.push(d, `第 ${i} 步`);
  }
  assert.equal(h.depth, HISTORY_LIMIT, '栈深封顶');
  let cur = h.current;
  let n = 0;
  while (h.canUndo) {
    cur = h.undo();
    n++;
  }
  assert.equal(n, HISTORY_LIMIT);
  assert.ok(cur, '撤销到底仍返回文档');
});

test('AC-306：无实际变化不入栈；重定向上会清空重做栈', () => {
  const base = doc();
  const h = new UndoHistory().reset(base);
  assert.equal(h.push(structuredClone(base)), false, '内容相同不产生撤销步');
  const d1 = structuredClone(base);
  d1.groups[1].x = 40;
  h.push(d1);
  h.push(structuredClone(d1).groups ? (() => { const x = structuredClone(d1); x.groups[1].x = 60; return x; })() : d1);
  assert.equal(h.canUndo, true);
  h.undo();
  assert.equal(h.canRedo, true);
  const d2 = structuredClone(current(h));
  d2.groups[1].y = 300;
  h.push(d2);
  assert.equal(h.canRedo, false, '新编辑后不能重做旧分支');
});

function current(h) {
  return h.current;
}

/* ------------------------------------------------------------------ */
/* AC-322：拖拽与吸附                                                   */
/* ------------------------------------------------------------------ */

test('AC-322：拖拽吸附 4dp 网格，Ctrl 时自由移动，尺寸不变', () => {
  const d = doc();
  const group = d.groups[1];
  const snapped = resolveDrag({ group, startX: 16, startY: 200, dx: 5, dy: 7 });
  assert.equal(snapped.scope, 'group');
  assert.equal(snapped.x % GRID, 0);
  assert.equal(snapped.y % GRID, 0);
  assert.equal(snapped.x, 20);
  assert.equal(snapped.y, 208);
  assert.equal(snapped.snapped, true);

  const free = resolveDrag({ group, startX: 16, startY: 200, dx: 5, dy: 7, free: true });
  assert.equal(free.x, 21);
  assert.equal(free.y, 207);
  assert.equal(free.snapped, false);
});

test('AC-322 / DC-036：自由组拖 Item 写 Item.pos；非自由组只动 Group', () => {
  const d = doc();
  const freeGroup = d.groups[2];
  const r = resolveDrag({ group: freeGroup, item: freeGroup.items[0], startX: 340, startY: 800, dx: -10, dy: -20 });
  assert.equal(r.scope, 'item');
  const after = applyDrag(d, r);
  assert.deepEqual(after.groups[2].items[0].pos, { x: 332, y: 780 });
  assert.deepEqual(d.groups[2].items[0].pos, { x: 340, y: 800 }, '原文档不被修改');

  const runGroup = d.groups[1];
  const g = resolveDrag({ group: runGroup, item: runGroup.items[0], startX: 16, startY: 200, dx: 8, dy: 0 });
  assert.equal(g.scope, 'group', '非自由组拖 Item 实际移动整组');
  const moved = applyDrag(d, g);
  assert.equal(moved.groups[1].x, 24);
  assert.equal(moved.groups[1].items[0].pos, undefined, 'DC-036：非自由组不得写 Item.pos');
});

test('AC-322：拖到负坐标被夹到 0', () => {
  const d = doc();
  const r = resolveDrag({ group: d.groups[1], startX: 4, startY: 4, dx: -40, dy: -40 });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

/* ------------------------------------------------------------------ */
/* AC-321：图层                                                         */
/* ------------------------------------------------------------------ */

test('AC-321：图层顺序即绘制顺序，含组与子项', () => {
  const layers = flattenLayers(doc());
  assert.deepEqual(layers.filter((l) => l.depth === 0).map((l) => l.id), ['g_a', 'g_b', 'g_f']);
  assert.deepEqual(layers.filter((l) => l.group_id === 'g_b').map((l) => l.id), ['i_b1', 'i_b2']);
  assert.equal(layers.find((l) => l.id === 'g_a').name, '顶栏组');
});

test('AC-321：单部件组在图层里只展示一条，避免同名组 + 项重复', () => {
  const d = doc();
  d.groups.push({
    id: 'g_manual',
    x: 16,
    y: 500,
    axis: 'y',
    name: '按钮',
    items: [{ id: 'i_manual', kind: 'button', name: '按钮', label: '按钮', variant: 'filled' }],
  });
  const rows = flattenLayers(d, { collapseSingle: true });
  const related = rows.filter((l) => l.id === 'g_manual' || l.group_id === 'g_manual');
  assert.equal(related.length, 1, '单部件组只展示 Item 行');
  assert.equal(related[0].id, 'i_manual');
  assert.equal(related[0].depth, 1);
  assert.equal(flattenLayers(d).length, rows.length + 1, '默认返回值仍保留组行，数据结构不变');
});

test('AC-322：拖拽起点按组类型取坐标，非自由组不会被 Item 偏移带跑', () => {
  const d = doc();
  const free = dragOrigin(d.groups[2], d.groups[2].items[0]);
  assert.deepEqual(free, { scope: 'item', x: 340, y: 800 });

  const flow = dragOrigin(d.groups[1], d.groups[1].items[1]);
  assert.deepEqual(flow, { scope: 'group', x: 16, y: 200 });
});

test('AC-321：重命名/隐藏/锁定持久化到文档；锁定后拒绝修改', () => {
  let d = updateLayer(doc(), { group_id: 'g_b' }, { name: '推荐列表', hidden: true });
  assert.equal(d.groups[1].name, '推荐列表');
  assert.equal(d.groups[1].hidden, true);

  d = updateLayer(d, { group_id: 'g_b', item_id: 'i_b1' }, { name: '主卡片' });
  assert.equal(d.groups[1].items[0].name, '主卡片');

  d = updateLayer(d, { group_id: 'g_b', item_id: 'i_b1' }, { locked: true });
  assert.equal(d.groups[1].items[0].locked, true);
  assert.throws(() => updateLayer(d, { group_id: 'g_b', item_id: 'i_b1' }, { name: '改名' }), /锁定/);

  // 组锁定后，子项一律不可编辑
  const lockedGroup = updateLayer(doc(), { group_id: 'g_b' }, { locked: true });
  assert.throws(() => updateLayer(lockedGroup, { group_id: 'g_b', item_id: 'i_b2' }, { hidden: true }), /锁定/);
});

test('AC-321：图层移动（组间/组内），锁定图层不可移动', () => {
  const d = doc();
  const moved = moveLayer(d, { group_id: 'g_f', to_index: 0 });
  assert.deepEqual(moved.groups.map((g) => g.id), ['g_f', 'g_a', 'g_b'], '绘制顺序随之改变');

  const inner = moveLayer(d, { group_id: 'g_b', item_id: 'i_b2', to_index: 0 });
  assert.deepEqual(inner.groups[1].items.map((i) => i.id), ['i_b2', 'i_b1']);

  const locked = updateLayer(d, { group_id: 'g_a' }, { locked: true });
  assert.throws(() => moveLayer(locked, { group_id: 'g_a', to_index: 2 }), /锁定/);
});

/* ------------------------------------------------------------------ */
/* FR-EDIT-002：部件面板                                                 */
/* ------------------------------------------------------------------ */

test('FR-EDIT-002：36 种部件可检索、可按分类浏览', () => {
  assert.equal(KIND_SPECS.length, 36);
  assert.equal(searchPalette(KIND_SPECS, '').length, 36);

  const buttons = searchPalette(KIND_SPECS, 'button');
  assert.ok(buttons.some((k) => k.kind === 'button'));
  assert.ok(buttons.some((k) => k.kind === 'iconButton'), '英文 kind 子串可命中多音驼峰');

  assert.ok(searchPalette(KIND_SPECS, '卡片').some((k) => k.kind === 'card'), '中文名可检索');
  assert.ok(searchPalette(KIND_SPECS, 'navigation').every((k) => /nav|tab/i.test(k.kind)), '分类词命中');

  const groups = groupPalette(KIND_SPECS);
  assert.ok(groups.length > 5);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 36, '分组不丢部件');
  assert.ok(groups.every((g) => typeof g.family === 'string' && g.items.length > 0));
});
