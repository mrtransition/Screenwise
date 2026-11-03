/** 全局 UI 工具：toast / 弹层 / 转义 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function toast(msg, kind = '') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, kind === 'err' ? 4200 : 2400);
}

export function loading(on) {
  const bar = document.getElementById('loadingBar');
  if (on) {
    bar.style.width = '60%';
    bar.style.opacity = '1';
  } else {
    bar.style.width = '100%';
    setTimeout(() => {
      bar.style.opacity = '0';
      bar.style.width = '0';
    }, 260);
  }
}

/** 通用弹层：返回一个 close 函数，body 可以是 DOM 或 HTML 字符串 */
export function modal({ title, body, footer, width }) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal';
  if (width) box.style.width = width;
  box.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><div style="margin-left:auto">${'<button class="btn ghost sm" data-close>关闭</button>'}</div></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>`;
  const bodyEl = box.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);
  const footEl = box.querySelector('.modal-foot');
  if (footer) {
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else footEl.appendChild(footer);
  }
  mask.appendChild(box);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  return { close, box, bodyEl, footEl };
}

export function confirmDialog({ title, message, danger = false, okText = '确定' }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p style="margin:0;line-height:1.7">${message}</p>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button>`,
    });
    m.footEl.querySelector('[data-ok]').onclick = () => {
      m.close();
      resolve(true);
    };
    m.box.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => {
      m.close();
      resolve(false);
    }));
  });
}

/** 把接口错误翻译成用户能看懂的提示（SRS §6 错误码区分） */
export function errText(err) {
  const map = {
    SCREEN_LOCKED: '屏幕已锁定，禁止生成与修改。请先解锁。',
    FORBIDDEN_TARGET: '检测到跨屏写入，已拦截并记录审计告警。',
    INVALID_OUTPUT: 'AI 输出不符合结构约束，未写入屏幕。',
    UNPROCESSABLE: '没有识别出可执行的修改，屏幕内容未改变。',
    EDIT_SCOPE_REQUIRED: '请先选择生成范围（整屏 / 区域 / 组件）。',
    SELECTION_REQUIRED: '「区域 / 组件」范围需要先选中一块内容，或改用「整屏」。',
    MODEL_FAILED: '模型调用失败，屏幕内容保持不变。',
    CONFLICT: '状态冲突，请刷新后重试。',
    EDGES_EXIST: '该屏幕存在关联边，需先处理。',
    HOTSPOT_NOT_FOUND: '热区不存在于源屏幕。',
    NO_HOTSPOT: '源屏幕中没有可用热区。',
    EDGE_PARSE_FAILED: '未能识别出跳转关系，请按「在 A 页点 X 跳到 B 页」描述。',
    STALE_PENDING: '屏幕内容已更新，请重新生成。',
  };
  const base = map[err.code] || err.message || '操作失败';
  // 422 是可重试的：把服务端给的具体建议带出来，而不是只丢一句话
  const hint = err.detail?.hint;
  return hint ? `${base}\n${hint}` : base;
}

export function timeAgo(iso) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
