import { esc } from './ui.js';
import { docToSrcdoc } from './render.js';

/** 节点标题栏高度；iframe 内容与热区层都从这段高度之下开始 */
const HEADER = 38;

/**
 * 无限画布（FR-CANVAS-001 ~ 006）
 *
 * 设计要点：
 *  - 画布本身是一个 transform 容器，视口状态独立于屏幕内容；
 *  - 每个屏幕节点内嵌 iframe（srcdoc），天然样式隔离；
 *  - 关联模式下节点只读，热区以悬浮点呈现，可拖拽连线；
 *  - 连线坐标实时换算到画布坐标系（受缩放影响只乘一次逆变换）。
 */
export class CanvasView {
  constructor(el, handlers) {
    this.el = el;
    // { onSelect, onMove, onConnect, onEdgeClick, onNodeSelect, onNodeEdit, onNodeFocus, onNodeEditCancel, onCreateScreen, onExitFlow }
    this.h = handlers;
    this.viewport = { x: 80, y: 80, zoom: 1 };
    this.screens = [];
    this.selected = null;
    this.mode = 'edit'; // edit | flow
    this.selectMode = false;
    this.selection = new Map(); // screenId -> nodeId[]
    this.edges = [];
    this.flowSource = null;
    this.drag = null;
    this.nodeEls = new Map();
    this.iframeDocs = new Map();
    /** screenId -> {anchorId: {x,y}}，来自 iframe 内实测 */
    this.anchorPos = new Map();
    this.observeAnchors();
    this.build();
    this.applyViewport();
  }

  /** iframe 沙箱内无法直接读取 DOM，靠 postMessage 回传热区真实坐标 */
  observeAnchors() {
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'proto:select') {
        const node = this.frameNode(ev) || (d.screen_id ? this.nodeEls.get(d.screen_id) : null);
        if (node?.dataset.sid && d.node_id) this.h.onNodeSelect?.(node.dataset.sid, d.node_id);
        return;
      }
      if (d.type === 'proto:node-focus' || d.type === 'proto:edit' || d.type === 'proto:edit-cancel') {
        // 空间编辑消息只接受编辑态下、来自已知屏幕的 iframe，避免预览/关联态误触发写入
        const node = this.frameNode(ev) || (d.screen_id ? this.nodeEls.get(d.screen_id) : null);
        const sid = node?.dataset.sid;
        if (!sid || this.mode !== 'edit' || this.selectMode) return;
        const screen = this.screens.find((x) => x.screen_id === sid);
        if (!screen || screen.locked) return;
        if (d.type === 'proto:node-focus') {
          this.h.onNodeFocus?.(sid);
        } else if (d.type === 'proto:edit') {
          if (d.node_id && typeof d.text === 'string') this.h.onNodeEdit?.(sid, d.node_id, d.text, d.original);
        } else {
          this.h.onNodeEditCancel?.(d.reason);
        }
        return;
      }
      if (d.type !== 'proto:anchors') return;
      // 沙箱 iframe 发消息时 source 可能为 null，优先用消息里带的 screen_id 反查节点
      const node = this.frameNode(ev) || (d.screen_id ? this.nodeEls.get(d.screen_id) : null);
      const el = node || (() => {
        for (const [sid, n] of this.nodeEls) if (n.querySelector('iframe.node-frame') === ev.source) return n;
        return null;
      })();
      if (!el?.dataset.sid) return;
      const sid = el.dataset.sid;
      // 只接收当前模式下的最新一次测量，避免旧 iframe（已切模式/已重建）回传把坐标带偏
      if (this.mode !== 'flow' || !this.screens.find((x) => x.screen_id === sid)?.doc) return;
      const map = {};
      // 热区坐标是 iframe 内容坐标（布局像素，与画布缩放无关）；anchor 层已经让出 38px 的标题栏，不能再加一次
      for (const a of d.anchors || []) map[a.hotspot_id] = { x: a.x, y: a.y, w: a.w, h: a.h };
      this.anchorPos.set(sid, map);
      const s = this.screens.find((x) => x.screen_id === sid);
      if (!s) return;
      if (!Object.keys(map).length && (s.anchors || []).length && this.lastEmptyWarn !== sid) {
        // 页面重生成后热区全丢：不要沿用旧坐标，提示一轮即可
        this.lastEmptyWarn = sid;
        console.warn('[flow] 屏幕内未测到任何热区', sid);
      }
      let changed = false;
      for (const a of s.anchors || []) {
        const p = map[a.hotspot_id];
        if (!p) continue;
        // 每次测量都把中心点与组件框写回，保证圆点始终贴合组件
        if (a.x !== p.x || a.y !== p.y || a.w !== p.w || a.h !== p.h) {
          a.x = p.x;
          a.y = p.y;
          a.w = p.w;
          a.h = p.h;
          changed = true;
        }
      }
      if (changed) this.renderAnchors(this.nodeEls.get(sid), s);
      this.renderEdges();
    });
  }

  /** 从 message 事件反查宿主节点 */
  frameNode(ev) {
    try {
      return ev.source?.frameElement?.closest('.node') || this.nodeEls.get(ev.data?.screen_id) || null;
    } catch {
      return null;
    }
  }

  build() {
    this.el.innerHTML = `
      <div class="canvas-wrap" id="cwrap">
        <div class="grid-bg"></div>
        <div class="canvas" id="cv">
          <svg class="edges-svg" id="edgesSvg" width="1" height="1"></svg>
          <div id="nodes"></div>
        </div>
        <div class="canvas-hud">
          <button class="btn ghost sm" data-zoom="out">−</button>
          <span class="zoom" id="zoomText">100%</span>
          <button class="btn ghost sm" data-zoom="in">+</button>
          <button class="btn ghost sm" data-zoom="reset">适应</button>
        </div>
        <div id="flowBanner"></div>
      </div>`;
    this.wrap = this.el.querySelector('#cwrap');
    this.cv = this.el.querySelector('#cv');
    this.nodesEl = this.el.querySelector('#nodes');
    this.svg = this.el.querySelector('#edgesSvg');
    this.zoomText = this.el.querySelector('#zoomText');
    this.banner = this.el.querySelector('#flowBanner');
    this.bindViewport();
    this.el.querySelectorAll('[data-zoom]').forEach((b) => {
      b.onclick = () => {
        const z = b.dataset.zoom;
        if (z === 'reset') this.fit();
        else this.zoomBy(z === 'in' ? 1.15 : 1 / 1.15);
      };
    });
  }

  applyViewport() {
    const { x, y, zoom } = this.viewport;
    this.cv.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.zoomText.textContent = `${Math.round(zoom * 100)}%`;
    // 热区坐标来自 iframe 内 getBoundingClientRect（含缩放），缩放变化后必须重新测量，
    // 否则圆点会随缩放累计漂移。用 rAF 合并高频滚轮事件。
    if (this.mode === 'flow') this.scheduleRemeasure();
  }

  scheduleRemeasure() {
    if (this._remeasureRaf) return;
    this._remeasureRaf = requestAnimationFrame(() => {
      this._remeasureRaf = null;
      this.remeasureAnchors();
    });
  }

  /** 通知每个 iframe 重新上报热区坐标 */
  remeasureAnchors() {
    if (this.mode !== 'flow') return;
    this.nodeEls.forEach((el) => {
      const ifr = el.querySelector('iframe.node-frame');
      try {
        ifr?.contentWindow?.postMessage({ type: 'proto:remeasure' }, '*');
      } catch {
        /* 跨源/未加载完成时忽略，下一轮 resize/load 会补测 */
      }
    });
  }

  setViewport(v) {
    this.viewport = { ...this.viewport, ...v };
    this.applyViewport();
    this.renderEdges();
  }

  zoomBy(f, cx, cy) {
    const rect = this.wrap.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const v = this.viewport;
    const zoom = Math.min(4, Math.max(0.1, v.zoom * f)); // FR-CANVAS-001: 10%–400%
    const k = zoom / v.zoom;
    this.setViewport({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
  }

  fit() {
    if (!this.screens.length) {
      this.setViewport({ x: 80, y: 80, zoom: 1 });
      return;
    }
    const rect = this.wrap.getBoundingClientRect();
    const minX = Math.min(...this.screens.map((s) => s.x));
    const minY = Math.min(...this.screens.map((s) => s.y));
    const maxX = Math.max(...this.screens.map((s) => s.x + s.width));
    const maxY = Math.max(...this.screens.map((s) => s.y + s.height));
    const pad = 80;
    // 下限 0.25：再小就完全无法识别内容与热区，宁可出现滚动
    const zoom = Math.max(0.25, Math.min(1, Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY))));
    this.setViewport({
      zoom,
      x: rect.width / 2 - ((minX + maxX) / 2) * zoom,
      y: rect.height / 2 - ((minY + maxY) / 2) * zoom,
    });
  }

  screenToCanvas(clientX, clientY) {
    const rect = this.wrap.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.viewport.x) / this.viewport.zoom,
      y: (clientY - rect.top - this.viewport.y) / this.viewport.zoom,
    };
  }

  bindViewport() {
    // 平移：空白处拖拽 / 空格拖拽 / 中键
    this.wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const onNode = e.target.closest('.node');
      const onAnchor = e.target.closest('.anchor-dot, .anchor-hit');
      if (onNode || onAnchor) return;
      if (e.button === 1 || e.target.closest('.canvas-hud')) return;
      e.preventDefault();
      this.wrap.classList.add('dragging');
      const start = { x: e.clientX, y: e.clientY, vx: this.viewport.x, vy: this.viewport.y };
      const move = (ev) => {
        this.setViewport({ x: start.vx + (ev.clientX - start.x), y: start.vy + (ev.clientY - start.y) });
      };
      const up = () => {
        this.wrap.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // 缩放：滚轮以鼠标为中心
    this.wrap.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          const rect = this.wrap.getBoundingClientRect();
          this.zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08, e.clientX - rect.left, e.clientY - rect.top);
        }
      },
      { passive: false }
    );

    const sel = (e) => {
      if (!e.target.closest('.node') && !e.target.closest('.edges-svg path')) this.h.onSelect?.(null);
    };
    this.wrap.addEventListener('click', sel);
  }

  setMode(mode) {
    if (this.mode !== mode) this.iframeDocs.clear(); // 模式切换需要重建（注入测量脚本/高亮样式）
    this.mode = mode;
    if (mode === 'flow') this.selectMode = false;
    this.wrap.classList.toggle('flow-mode', mode === 'flow');
    this.banner.innerHTML =
      mode === 'flow'
        ? `<span>关联模式：从源屏热区拖到目标屏即可建边</span><button data-exit>退出</button>`
        : '';
    this.banner.style.display = mode === 'flow' ? 'flex' : 'none';
    this.banner.querySelector('[data-exit]')?.addEventListener('click', () => this.h.onExitFlow?.());
    this.renderAll();
  }

  /** 区域选择模式：iframe 允许点击，点中的节点回传给上层 */
  setSelectMode(on) {
    const next = !!on && this.mode === 'edit';
    if (this.selectMode === next) return;
    this.selectMode = next;
    this.wrap.classList.toggle('select-mode', next);
    this.renderAll();
  }

  setSelection(screenId, nodeIds = []) {
    if (!screenId) this.selection.clear();
    else this.selection.set(screenId, nodeIds || []);
    const el = this.nodeEls.get(screenId);
    const s = this.screens.find((x) => x.screen_id === screenId);
    if (el && s) this.updateNode(el, s);
  }

  setData({ screens, edges }) {
    this.screens = screens || [];
    this.edges = edges || [];
    this.renderAll();
    // 关联模式下每次 setData 都补测一次坐标，保证热区落在组件上
    if (this.mode === 'flow') this.scheduleRemeasure();
  }

  setSelected(sid) {
    this.selected = sid;
    this.nodeEls.forEach((el, id) => el.classList.toggle('selected', id === sid));
  }

  renderAll() {
    this.renderNodes();
    this.renderEdges();
  }

  renderNodes() {
    const keep = new Set(this.screens.map((s) => s.screen_id));
    for (const [id, el] of this.nodeEls) {
      if (!keep.has(id)) {
        el.remove();
        this.nodeEls.delete(id);
        this.iframeDocs.delete(id);
      }
    }

    for (const s of this.screens) {
      let el = this.nodeEls.get(s.screen_id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'node';
        el.dataset.sid = s.screen_id;
        el.innerHTML = `
          <div class="node-head">
            <span class="node-idx"></span>
            <span class="node-title"></span>
            <span class="node-badges"></span>
          </div>
          <iframe class="node-frame" scrolling="no" sandbox="allow-same-origin allow-scripts"></iframe>
          <div class="node-anchor-layer"></div>`;
        this.nodesEl.appendChild(el);
        this.nodeEls.set(s.screen_id, el);
        this.bindNode(el, s.screen_id);
      }
      this.updateNode(el, s);
    }
    this.updateNewButton();
    this.renderEdges();
  }

  updateNode(el, s) {
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    el.style.width = `${s.width}px`;
    el.style.height = `${s.height}px`;
    el.classList.toggle('locked', !!s.locked);
    el.classList.toggle('flow-source', this.flowSource?.screen_id === s.screen_id);
    el.classList.toggle('selected', this.selected === s.screen_id);
    el.querySelector('.node-idx').textContent = String(Number(s.order || 0));
    el.querySelector('.node-title').textContent = s.title;
    el.querySelector('.node-title').title = `${s.title}\n${s.screen_id}`;

    const badges = [];
    if (s.locked) badges.push('<span class="badge lock">🔒 锁定</span>');
    if (s.pending) badges.push('<span class="badge pending">待确认</span>');
    if (!s.current_version || s.docIsEmpty) badges.push('<span class="badge empty">空屏</span>');
    else badges.push(`<span class="badge v">v${s.current_version}</span>`);
    el.querySelector('.node-badges').innerHTML = badges.join('');

    // iframe 内容只在版本 / 模式 / 选中态变化时重建，避免打断交互
    const ifr = el.querySelector('.node-frame');
    const selectedIds = this.selection.get(s.screen_id) || [];
    // 编辑态：菜单模式 + 非选择模式 + 未锁定；锁定屏整块禁用入口（FR-SPACE-004）
    const editable = this.mode === 'edit' && !this.selectMode && !s.locked;
    // 缩放比不参与 key：缩放由 message 重新测量处理，重建 iframe 会让热区闪断
    const key = `${s.current_version}|${s.locked}|${this.mode}|${this.selectMode}|${editable}|${selectedIds.join(',')}`;
    if (this.iframeDocs.get(s.screen_id) !== key) {
      ifr.srcdoc = docToSrcdoc(s.doc, {
        interactive: this.mode === 'flow' || this.selectMode,
        hotspots: this.mode === 'flow',
        measure: this.mode === 'flow',
        selectable: this.selectMode,
        editable,
        selectedNodeIds: selectedIds,
        screenId: s.screen_id,
      });
      this.iframeDocs.set(s.screen_id, key);
      if (this.mode === 'flow') {
        // 新模式/新版本：丢掉旧坐标，等新测量结果覆盖
        this.anchorPos.delete(s.screen_id);
        ifr.addEventListener('load', () => this.remeasureFrame(ifr), { once: true });
      }
    }

    this.renderAnchors(el, s);
  }

  /** 通知单个 iframe 重新上报热区坐标 */
  remeasureFrame(ifr) {
    if (this.mode !== 'flow') return;
    try {
      ifr?.contentWindow?.postMessage({ type: 'proto:remeasure' }, '*');
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 热区层渲染。
   *
   * 坐标约定（这是关联模式热区"不落在组件上"的三处坑，必须同时满足）：
   *  1. iframe 内的 rect 已经是 iframe 自身的 CSS 像素，画布 zoom 只作用于外层节点；
   *     所以这里写的是未缩放坐标，由节点的 transform:scale 统一放大 —— 不能再除一次 zoom。
   *  2. 实测坐标是 iframe 内容坐标，anchor 层的 inset 顶部已经让出 38px 标题栏，
   *     所以层内 top 直接用即可，不能减 HEADER；连线起点在外层要加 HEADER（只加一次）。
   *  3. 组件框按"画布实际宽/高 ÷ 设计尺寸"还原，保证宽屏节点下宽度方向也对齐。
   */
  renderAnchors(el, s) {
    const layer = el.querySelector('.node-anchor-layer');
    if (this.mode !== 'flow') {
      layer.innerHTML = '';
      layer.dataset.sig = '';
      return;
    }
    const anchors = s.anchors || [];
    const nodeW = (el.offsetWidth || s.width || 375) - (el.clientLeft || 0) * 2;
    const nodeH = (el.offsetHeight || s.height || 812) - HEADER;
    const designW = s.doc?.device?.width || s.width || 375;
    const designH = s.doc?.device?.height || (s.height || 812) - HEADER;
    const fitX = nodeW / designW;
    const fitY = nodeH / designH;
    // 签名防止重复叠加：坐标 / 尺寸变化才重绘，否则保留现有 DOM（也避免拖拽中途被打断）
    const sig = [
      `${Math.round(nodeW)}x${Math.round(nodeH)}`,
      ...anchors.map((a) => `${a.hotspot_id}:${Math.round(a.x ?? -1)}:${Math.round(a.y ?? -1)}:${Math.round(a.w ?? -1)}:${Math.round(a.h ?? -1)}`),
    ].join('|');
    if (layer.dataset.sig === sig) return;
    layer.dataset.sig = sig;

    layer.innerHTML = anchors
      .map((a, i) => {
        // 只有完全没测到坐标时才用占位位置（正常不会走到）
        const measured = Number.isFinite(a.x) && Number.isFinite(a.y);
        let x = measured ? a.x : nodeW / 2;
        let y = measured ? a.y : 64 + i * 26;
        const w = Number.isFinite(a.w) && a.w > 0 ? Math.max(6, a.w * fitX) : 0;
        const h = Number.isFinite(a.h) && a.h > 0 ? Math.max(6, a.h * fitY) : 0;
        const hw = w ? w / 2 : 0;
        const hh = h ? h / 2 : 0;
        // 兜底夹取：只防止极端数据跑出节点，不影响正常实测坐标
        x = Math.max(hw, Math.min(nodeW - hw, x));
        y = Math.max(hh, Math.min(nodeH - hh, y));
        return `
        ${w ? `<div class="anchor-hit" style="left:${x - hw}px; top:${y - hh}px; width:${w}px; height:${h}px" data-anchor="${esc(a.hotspot_id)}"></div>` : ''}
        <div class="anchor-dot" style="left:${x}px; top:${y}px" data-sid="${esc(s.screen_id)}" data-anchor="${esc(a.hotspot_id)}" title="拖拽到目标屏建边：${esc(a.hotspot_id)}"></div>
        <div class="anchor-label" style="left:${x}px; top:${y}px">${esc(a.hotspot_id)}</div>`;
      })
      .join('');
    // 圆点与组件框都能起线；标签只做展示
    layer.querySelectorAll('.anchor-dot, .anchor-hit').forEach((box) => this.bindAnchor(box, s));
  }

  bindAnchor(dot, s) {
    // 圆点与组件框都能起线，起点统一取组件中心（= 圆点位置）
    const hotspotId = dot.dataset.anchor;
    dot.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!hotspotId) return;
      const cx = parseFloat(dot.style.left) + (dot.classList.contains('anchor-hit') ? dot.offsetWidth / 2 : 0);
      const cy = parseFloat(dot.style.top) + (dot.classList.contains('anchor-hit') ? dot.offsetHeight / 2 : 0);
      const from = { screen_id: s.screen_id, x: s.x + cx, y: s.y + HEADER + cy };
      this.flowSource = { screen_id: s.screen_id, hotspot_id: hotspotId };
      const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      ghost.setAttribute('stroke', '#7c3aed');
      ghost.setAttribute('stroke-width', '2');
      ghost.setAttribute('stroke-dasharray', '6 4');
      ghost.setAttribute('fill', 'none');
      this.svg.appendChild(ghost);

      const move = (ev) => {
        const p = this.screenToCanvas(ev.clientX, ev.clientY);
        ghost.setAttribute('d', curve(from, p));
        const tgt = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
        this.nodeEls.forEach((n) => n.classList.remove('drop-target'));
        if (tgt && tgt.dataset.sid !== s.screen_id) tgt.classList.add('drop-target');
      };
      const up = (ev) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        ghost.remove();
        this.nodeEls.forEach((n) => n.classList.remove('drop-target'));
        const tgt = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
        if (tgt && tgt.dataset.sid !== s.screen_id) {
          this.h.onConnect?.({
            source_screen_id: s.screen_id,
            source_hotspot_id: hotspotId,
            target_screen_id: tgt.dataset.sid,
          });
        }
        this.flowSource = null;
        this.renderNodes();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  bindNode(el, sid) {
    el.querySelector('.node-head').addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.mode === 'flow') return;
      e.preventDefault();
      this.h.onSelect?.(sid);
      const s = this.screens.find((x) => x.screen_id === sid);
      const start = { x: e.clientX, y: e.clientY, ox: s.x, oy: s.y };
      let moved = false;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / this.viewport.zoom;
        const dy = (ev.clientY - start.y) / this.viewport.zoom;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        s.x = Math.round(start.ox + dx);
        s.y = Math.round(start.oy + dy);
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
        this.renderEdges();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (moved) this.h.onMove?.(sid, { x: s.x, y: s.y });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('.anchor-dot, .anchor-hit')) return;
      this.h.onSelect?.(sid);
    });
  }

  updateNewButton() {
    let btn = this.nodesEl.querySelector('.new-btn.node');
    if (!btn) {
      btn = document.createElement('div');
      btn.className = 'node new-btn';
      btn.innerHTML = '<span>＋ 新建屏幕</span>';
      btn.onclick = () => this.h.onCreateScreen?.();
      this.nodesEl.appendChild(btn);
    }
    let x = 120;
    let y = 120;
    if (this.screens.length) {
      const cols = 4;
      if (this.screens.length % cols === 0) {
        x = 120;
        y = Math.max(...this.screens.map((s) => s.y + s.height)) + 100;
      } else {
        const last = this.screens[this.screens.length - 1];
        x = last.x + last.width + 50;
        y = last.y;
      }
    }
    btn.style.left = `${x}px`;
    btn.style.top = `${y}px`;
    btn.style.width = '200px';
    btn.style.height = '120px';
  }

  renderEdges() {
    const byId = new Map(this.screens.map((s) => [s.screen_id, s]));
    const paths = [];
    for (const e of this.edges) {
      const src = byId.get(e.source_screen_id);
      const tgt = byId.get(e.target_screen_id);
      if (!src || !tgt) continue;
      const anchor = (src.anchors || []).find((a) => a.hotspot_id === e.source_hotspot_id);
      const from = {
        x: src.x + (anchor?.x ?? src.width / 2),
        // 热区坐标相对 iframe 内容；节点标题栏高 38px，连线的起点同样要加上
        y: src.y + HEADER + (anchor?.y ?? (src.height - HEADER) / 2),
      };
      // 用屏幕实际相对位置决定从目标左/右侧进入，不能拿 id 字符串比大小
      const goingRight = tgt.x + tgt.width / 2 >= src.x + src.width / 2;
      const to = {
        x: goingRight ? tgt.x : tgt.x + tgt.width,
        y: tgt.y + tgt.height / 2,
      };
      const d = curve(from, to);
      const bad = e.orphan?.hotspot_missing || e.orphan?.target_missing || e.orphan?.source_missing;
      const candidate = e.status === 'candidate';
      paths.push(`
        <path d="${d}" stroke="${bad ? '#dc2626' : candidate ? '#f59e0b' : '#7c3aed'}" stroke-width="2"
          stroke-dasharray="${bad ? '6 5' : candidate ? '8 5' : ''}" fill="none" opacity="${this.mode === 'flow' ? 1 : 0.55}"></path>
        <path class="hit" d="${d}" stroke="transparent" stroke-width="14" fill="none" data-edge="${esc(e.edge_id)}"></path>
        <circle cx="${to.x}" cy="${to.y}" r="4" fill="${bad ? '#dc2626' : '#7c3aed'}"></circle>`);
    }
    this.svg.innerHTML = paths.join('');
    this.svg.querySelectorAll('path.hit').forEach((p) => {
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.mode === 'flow') this.h.onEdgeClick?.(p.dataset.edge);
      });
    });
    let w = 1;
    let h = 1;
    for (const s of this.screens) {
      w = Math.max(w, s.x + s.width + 200);
      h = Math.max(h, s.y + s.height + 200);
    }
    this.svg.setAttribute('width', w);
    this.svg.setAttribute('height', h);
  }

  /** 标记某屏为"生成中"（乐观 UI） */
  markGenerating(sid, on) {
    const el = this.nodeEls.get(sid);
    if (!el) return;
    const badges = el.querySelector('.node-badges');
    if (on) badges.innerHTML = '<span class="badge pending"><span class="spinner"></span> 生成中</span>';
    else this.updateNode(el, this.screens.find((s) => s.screen_id === sid));
  }
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
