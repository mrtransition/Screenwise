/**
 * M3 编辑器的会话状态：快捷键、撤销栈、拖拽吸附、图层操作、部件面板检索。
 *
 * 这里是**纯逻辑**（不碰 DOM、不碰网络），因此宿主画布、未来的编辑器岛 iframe
 * 与单元测试可以用完全相同的实现。DOM 侧只负责把事件翻译成这里的方法调用。
 *
 * 对应需求：FR-EDIT-001/002/004/008/010/011、AC-306/307/321/322
 */

/** 4dp 网格（FR-EDIT-002 / FR-EDIT-004） */
export const GRID = 4;
/** 撤销栈上限：至少 50 步（FR-EDIT-011） */
export const HISTORY_LIMIT = 50;

const round = (v) => Math.round(v / GRID) * GRID;

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把键盘事件翻译成编辑器动作。
 *
 * 关键约束（AC-307 / FR-EDIT-010）：
 *  - 输入框、文本域、contenteditable 内一律不劫持；
 *  - 单键快捷键（V/H/空格/P/Delete/方向键）要求当前处于编辑器会话；
 *  - 带修饰键的组合优先判定，避免 Ctrl+Z 落到字母 Z 的处理。
 *
 * @param {object} ev  { key, code, ctrlKey, metaKey, shiftKey, altKey, target }
 * @param {object} opts { editing?: boolean }
 * @returns {{action: string, [k: string]: any} | null}
 */
export function resolveShortcut(ev = {}, { editing = true } = {}) {
  if (!editing) return null;
  const t = ev.target ?? {};
  const tag = String(t.tagName ?? '').toUpperCase();
  if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return null;

  const mod = !!(ev.ctrlKey || ev.metaKey);
  const key = String(ev.key ?? '');

  if (mod && !ev.altKey) {
    switch (key.toLowerCase()) {
      case 'z':
        return ev.shiftKey ? { action: 'redo' } : { action: 'undo' };
      case 'y':
        return { action: 'redo' };
      case 's':
        return { action: 'save' };
      case 'a':
        return { action: 'selectAll' };
      case 'd':
        return { action: 'duplicate' };
      case 'c':
        return { action: 'copy' };
      case 'v':
        return { action: 'paste' };
      case 'g':
        return ev.shiftKey ? { action: 'ungroup' } : { action: 'group' };
      default:
        return null;
    }
  }
  if (mod || ev.altKey) return null;

  switch (key) {
    case 'v':
    case 'V':
      return { action: 'tool', tool: 'select' };
    case 'h':
    case 'H':
      return { action: 'tool', tool: 'pan' };
    case ' ':
    case 'Spacebar':
      return { action: 'pan', active: true };
    case 'p':
    case 'P':
      return { action: 'preview' };
    case 't':
    case 'T':
      return { action: 'tidy' };
    case 'Delete':
    case 'Backspace':
      return { action: 'delete' };
    case 'Escape':
      return { action: 'cancel' };
    case 'Enter':
      return { action: 'commit' };
    case 'ArrowLeft':
      return { action: 'nudge', dx: -1, dy: 0, big: !!ev.shiftKey };
    case 'ArrowRight':
      return { action: 'nudge', dx: 1, dy: 0, big: !!ev.shiftKey };
    case 'ArrowUp':
      return { action: 'nudge', dx: 0, dy: -1, big: !!ev.shiftKey };
    case 'ArrowDown':
      return { action: 'nudge', dx: 0, dy: 1, big: !!ev.shiftKey };
    case '0':
      return { action: 'zoom', mode: 'fit' };
    case '+':
    case '=':
      return { action: 'zoom', mode: 'in' };
    case '-':
      return { action: 'zoom', mode: 'out' };
    default:
      return null;
  }
}

/** 与浏览器默认快捷键冲突的组合（需要提示，而不是静默吞掉） */
export function shortcutConflict(ev = {}) {
  const mod = !!(ev.ctrlKey || ev.metaKey);
  const key = String(ev.key ?? '').toLowerCase();
  if (mod && key === 's') return 'Ctrl+S 已被本应用用于“保存版本”';
  if (mod && key === 'w') return 'Ctrl+W 会关闭标签页，编辑器不拦截';
  return null;
}

/* ------------------------------------------------------------------ */
/* 撤销 / 重做                                                          */
/* ------------------------------------------------------------------ */

/**
 * 会话内撤销栈（FR-EDIT-011 / AC-306）。
 *
 * - 与服务端版本回滚完全独立：这里只处理「本次打开后还没保存」的编辑；
 * - 保存后清空，避免撤销到已落库的状态造成语义混乱；
 * - 栈深超过 `HISTORY_LIMIT` 时丢弃最老的快照。
 */
export class UndoHistory {
  constructor(limit = HISTORY_LIMIT) {
    this.limit = Math.max(1, limit);
    this.past = [];
    this.future = [];
    this.current = null;
  }

  /** 初始化基线快照（打开屏幕时调用），不进入撤销栈 */
  reset(doc) {
    this.past = [];
    this.future = [];
    this.current = structuredClone(doc);
    return this;
  }

  /** 记录一次编辑；返回是否入栈（内容未变化时不入栈） */
  push(doc, label = '') {
    const snapshot = structuredClone(doc);
    if (this.current && JSON.stringify(this.current) === JSON.stringify(snapshot)) return false;
    if (this.current) {
      this.past.push({ doc: this.current, label });
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = snapshot;
    this.future = [];
    return true;
  }

  undo() {
    if (!this.past.length) return null;
    this.future.push(this.current);
    this.current = this.past.pop().doc;
    return structuredClone(this.current);
  }

  redo() {
    if (!this.future.length) return null;
    const next = this.future.pop();
    this.past.push({ doc: this.current, label: '' });
    this.current = structuredClone(next);
    return structuredClone(this.current);
  }

  /** 保存后清空会话栈（FR-EDIT-011） */
  clear(doc = this.current) {
    this.past = [];
    this.future = [];
    if (doc !== undefined) this.current = structuredClone(doc);
    return this;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  get depth() {
    return this.past.length;
  }
}

/* ------------------------------------------------------------------ */
/* 拖拽与吸附                                                          */
/* ------------------------------------------------------------------ */

/**
 * 拖拽结果归一（FR-EDIT-004 / AC-322）。
 *
 * - 默认吸附 4dp；按住 Ctrl 时自由移动；
 * - 尺寸不因吸附改变；
 * - 自由组 Item 写 `Item.pos`；非自由组禁止写 `Item.pos`（DC-036），
 *   只把位移应用到 Group 坐标上。
 *
 * @returns {{scope:'item'|'group', group_id:string, item_id?:string, x:number, y:number, snapped:boolean}}
 */
export function resolveDrag({ group, item = null, startX, startY, dx, dy, free = false, frame = {} }) {
  const snap = (v) => (free ? Math.round(v) : round(v));
  const isFree = group?.axis === 'free' || group?.free === true;
  const rawX = startX + dx;
  const rawY = startY + dy;
  // 组件左上角允许贴边，但坐标不得为负（AC-322 的「取消分组后坐标正确」）
  const x = Math.max(0, snap(rawX));
  const y = Math.max(0, snap(rawY));
  const snapped = x !== rawX || y !== rawY;
  if (isFree && item) {
    return { scope: 'item', group_id: group.id, item_id: item.id, x, y, snapped };
  }
  return { scope: 'group', group_id: group?.id ?? null, x, y, snapped };
}

/** 把拖拽结果写回文档（纯函数，返回新文档；撤销栈直接吃这个结果） */
/**
 * 拖拽起点：自由组取 Item.pos，非自由组取 Group 坐标。
 * 非自由组的 Item 没有 pos，若误用布局偏移会把整组瞬移。
 */
export function dragOrigin(group, item = null) {
  const isFree = group?.axis === 'free' || group?.free === true;
  if (isFree && item) {
    const pos = item.pos ?? { x: group.x ?? 0, y: group.y ?? 0 };
    return { scope: 'item', x: Number(pos.x) || 0, y: Number(pos.y) || 0 };
  }
  return { scope: 'group', x: Number(group?.x) || 0, y: Number(group?.y) || 0 };
}

export function applyDrag(doc, result) {
  const next = structuredClone(doc);
  const group = (next.groups ?? []).find((g) => g.id === result.group_id);
  if (!group) return next;
  if (result.scope === 'item') {
    const item = (group.items ?? []).find((i) => i.id === result.item_id);
    if (item) item.pos = { x: result.x, y: result.y };
    return next;
  }
  group.x = result.x;
  group.y = result.y;
  return next;
}

/* ------------------------------------------------------------------ */
/* 图层                                                                */
/* ------------------------------------------------------------------ */

/** 图层顺序即绘制顺序（FR-EDIT-008 / AC-321）：返回扁平化图层列表 */
export function flattenLayers(doc, { collapseSingle = false } = {}) {
  const out = [];
  for (const g of doc?.groups ?? []) {
    const items = (g.items ?? []).map((i) => ({
      type: 'item',
      id: i.id,
      kind: i.kind,
      name: i.name || i.label || i.kind,
      group_id: g.id,
      hidden: !!i.hidden,
      locked: !!i.locked || !!g.locked,
      depth: 1,
    }));
    // 图层是「控件」清单：只有一个 Item 的组不单独占一行，否则同一个控件会显示成
    // 「组 + 控件」两条。组名不同（AI 生成、手动重命名）同样折叠——组只是布局容器，
    // 不是可单独选中的控件。组上的锁定/隐藏语义落到该控件上（locked 已合并，
    // hidden 见下），保证折叠后信息不丢。
    const redundantGroup = collapseSingle && items.length === 1;
    if (!redundantGroup) {
      out.push({ type: 'group', id: g.id, name: g.name || g.id, hidden: !!g.hidden, locked: !!g.locked, depth: 0 });
    } else if (g.hidden) {
      items[0].hidden = true;
    }
    out.push(...items);
  }
  return out;
}

/** 更新图层字段（name/hidden/locked）；锁定对象拒绝修改（AC-321） */
export function updateLayer(doc, { group_id, item_id = null }, patch = {}) {
  const next = structuredClone(doc);
  const group = (next.groups ?? []).find((g) => g.id === group_id);
  if (!group) throw new Error(`组不存在: ${group_id}`);
  const target = item_id ? (group.items ?? []).find((i) => i.id === item_id) : group;
  if (!target) throw new Error(`部件不存在: ${item_id}`);
  const lockedByParent = item_id ? !!group.locked : false;
  // 解锁是撤销保护本身，必须放行：否则锁定后在界面上再也点不开（折叠后的单部件组
  // 只剩这一行，用户没有别的入口）。父组锁定的继承锁仍由父组决定，不能由子项绕过。
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const unlockOnly = keys.length === 1 && keys[0] === 'locked' && patch.locked === false;
  if (lockedByParent) throw new Error('父组已锁定，请先解锁组');
  if (!unlockOnly && target.locked) throw new Error('已锁定的图层不可编辑');
  for (const key of ['name', 'hidden', 'locked']) {
    if (patch[key] === undefined) continue;
    if (key === 'name') target.name = String(patch.name ?? '').slice(0, 80);
    else target[key] = !!patch[key];
  }
  return next;
}

/** 调整图层顺序：把 group 移到目标组之前/之后，或把 item 在组内上下移动 */
export function moveLayer(doc, { group_id, item_id = null, to_index }) {
  const next = structuredClone(doc);
  const groups = next.groups ?? [];
  if (item_id) {
    const group = groups.find((g) => g.id === group_id);
    if (!group) throw new Error(`组不存在: ${group_id}`);
    const items = group.items ?? [];
    const from = items.findIndex((i) => i.id === item_id);
    if (from < 0) throw new Error(`部件不存在: ${item_id}`);
    if (items[from].locked || group.locked) throw new Error('已锁定的图层不可移动');
    const [moved] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, to_index)), 0, moved);
    return next;
  }
  const from = groups.findIndex((g) => g.id === group_id);
  if (from < 0) throw new Error(`组不存在: ${group_id}`);
  if (groups[from].locked) throw new Error('已锁定的图层不可移动');
  const [moved] = groups.splice(from, 1);
  groups.splice(Math.max(0, Math.min(groups.length, to_index)), 0, moved);
  return next;
}

/* ------------------------------------------------------------------ */
/* 部件面板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 部件面板检索（FR-EDIT-002）：按分类浏览 + 关键词搜索。
 * 命中规则：kind、中文名、英文分类都参与；空关键词返回全部分类。
 */
export function searchPalette(kinds, query = '') {
  const q = String(query).trim().toLowerCase();
  const all = kinds.map((k) => ({ kind: k.kind, label: k.label, family: k.family, hotspot: k.hotspot }));
  if (!q) return all;
  return all.filter((k) => `${k.kind} ${k.label} ${k.family}`.toLowerCase().includes(q));
}

/** 按 family 分组，供面板分栏展示（顺序稳定，便于快照测试） */
export function groupPalette(kinds) {
  const map = new Map();
  for (const k of kinds) {
    if (!map.has(k.family)) map.set(k.family, []);
    map.get(k.family).push({ kind: k.kind, label: k.label });
  }
  return [...map.entries()].map(([family, items]) => ({ family, items }));
}
