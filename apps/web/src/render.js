/**
 * 节点树 → HTML 渲染器（前端版，与 server/export/static.js 保持同一份契约）
 * 用于在画布 iframe / 预览中真实渲染屏幕内容。
 */
const META_TAGS = new Set([
  'div', 'span', 'button', 'section', 'header', 'footer', 'main', 'nav', 'aside', 'ul', 'li', 'p', 'a', 'label',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'figure', 'strong', 'em', 'small', 'article',
]);
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr']);
const UNITLESS = new Set(['fontWeight', 'opacity', 'zIndex', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order']);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function styleToCss(style = {}) {
  return Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${prop}:${typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v}`;
    })
    .join(';');
}

/**
 * 节点 → HTML。
 * editable 只用于画布的空间编辑态：给"纯文本叶子节点"打 data-editable 标记，
 * 容器节点不参与（避免双击容器时误改整块内容）。导出 / 预览永远不传该选项。
 */
export function nodeToHtml(n, { editable = false } = {}) {
  if (!n) return '';
  const tag = META_TAGS.has(n.tag) ? n.tag : 'div';
  const attrs = { ...(n.props?.attrs || {}) };
  for (const [k, v] of Object.entries(attrs)) if (v === '' || v === null || v === undefined) delete attrs[k];
  const style = styleToCss(n.props?.style || {});
  if (style) attrs.style = style;
  attrs['data-node-id'] = n.id;
  const children = Array.isArray(n.children) ? n.children : [];
  if (editable && n.props?.text && children.length === 0) attrs['data-editable'] = '1';
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  if (n.tag === 'img') return `<img${attrStr} alt="">`;
  if (VOID_TAGS.has(tag)) return `<${tag}${attrStr}>`;
  const inner = [n.props?.text ? esc(n.props.text) : '', ...children.map((c) => nodeToHtml(c, { editable }))].join('');
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

const BASE = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827;background:#fff}
[data-anchor]{cursor:pointer;position:relative}
button{font:inherit;background:none;border:0;padding:0}
`;

/**
 * 交互模式：点击热区 → 高亮/派发；
 * 选择模式：点击节点 → 回传 node_id；
 * 空间编辑模式（editable）：双击文字叶子节点就地编辑，失焦 / Enter 提交一次，Esc 放弃。
 */
export function docToSrcdoc(
  doc,
  {
    interactive = false,
    hotspots = false,
    measure = false,
    selectable = false,
    editable = false,
    selectedNodeIds = [],
    highlightMap = {},
    screenId = '',
  } = {}
) {
  const extra = `
${hotspots ? '[data-anchor]{outline:2px dashed rgba(37,99,235,.55);outline-offset:2px;border-radius:6px}' : ''}
${selectable ? '[data-node-id]{cursor:crosshair}[data-node-id]:hover{outline:1px dashed rgba(37,99,235,.45);outline-offset:2px}' : ''}
${editable ? '[data-editable]{cursor:text;border-radius:4px}[data-editable]:hover{outline:1px dashed rgba(37,99,235,.55);outline-offset:2px}[contenteditable="true"]{outline:2px solid #2563eb !important;outline-offset:2px;background:rgba(37,99,235,.06);cursor:text;user-select:text}' : ''}
${highlightCss(selectedNodeIds, highlightMap)}
${interactive || selectable || editable ? '' : 'body{pointer-events:none}'}
${editable ? 'body{user-select:none}' : ''}
`;
  // 热区坐标用"完全不受画布缩放影响"的方式测量：
  // iframe 里的 getBoundingClientRect 会带上父页面 transform:scale 的结果，
  // 若再按 zoom 做除法，浏览器取整/边框/滚动差的零头会被放大成几十上百像素（关联模式热区漂移的根因）。
  // clientLeft/clientTop/clientWidth 是布局像素，一开始就与缩放无关。
  const measureScript = measure
    ? `<script>
(function(){
  function report(){
    var de=document.documentElement, body=document.body;
    var sx=de.clientLeft||0, sy=de.clientTop||0;
    var cx=de.clientLeft+(body?body.clientLeft:0), cy=de.clientTop+(body?body.clientTop:0);
    var out=[];
    document.querySelectorAll('[data-anchor]').forEach(function(el){
      var x=0, y=0, w=0, h=0, n=el;
      while(n && n.nodeType===1){
        x+=n.offsetLeft+n.clientLeft; y+=n.offsetTop+n.clientTop;
        if(n===body||n===de) break;
        n=n.offsetParent;
      }
      w=el.offsetWidth||0; h=el.offsetHeight||0;
      if(!w || !h){ // display:contents 等无盒元素退回 rect，但同样不做缩放补偿
        var r=el.getBoundingClientRect();
        out.push({hotspot_id:el.getAttribute('data-anchor'), x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height, rect:true});
        return;
      }
      // 累加得到的是相对 body 的布局坐标；减去 iframe 文档自身滚动后的可视原点
      out.push({hotspot_id:el.getAttribute('data-anchor'), x:x-cx+w/2, y:y-cy+h/2, w:w, h:h});
    });
    window.parent.postMessage({type:'proto:anchors', screen_id: ${JSON.stringify(String(screenId || ''))}, anchors: out}, '*');
  }
  function remeasure(){ requestAnimationFrame(function(){ requestAnimationFrame(report); }); }
  window.addEventListener('message', function(ev){
    if(ev.data && ev.data.type==='proto:remeasure') remeasure();
  });
  // 等布局与字体就绪再测，避免首帧尺寸为 0
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(report).catch(report); } else { setTimeout(report, 30); }
  window.addEventListener('load', remeasure);
  // 图片 / 异步内容撑开布局后尺寸会变，观察 DOM 尺寸变化再补测
  if(window.ResizeObserver){
    var ro = new ResizeObserver(function(){ remeasure(); });
    ro.observe(document.documentElement);
    if(document.body) ro.observe(document.body);
  }
})();
</script>`
    : '';
  const selectScript = selectable
    ? `<script>
document.addEventListener('click', function(ev){
  var el = ev.target.closest('[data-node-id]');
  if(!el) return;
  ev.preventDefault(); ev.stopPropagation();
  window.parent.postMessage({type:'proto:select', node_id: el.getAttribute('data-node-id'), screen_id: ${JSON.stringify(String(screenId || ''))}}, '*');
}, true);
</script>`
    : '';
  // 空间编辑（FR-SPACE-001/003/005）：一次编辑会话只提交一次，逐键不落库。
  const editScript = editable
    ? `<script>
(function(){
  var SID = ${JSON.stringify(String(screenId || ''))};
  var editing = null;
  var original = '';
  function post(type, extra){
    var msg = { type: type, screen_id: SID };
    for (var k in (extra || {})) msg[k] = extra[k];
    window.parent.postMessage(msg, '*');
  }
  function normalize(text){
    return String(text || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function stopEditing(){
    if (!editing) return null;
    var el = editing;
    editing = null;
    el.removeAttribute('contenteditable');
    el.classList.remove('proto-editing');
    return el;
  }
  function commit(save){
    if (!editing) return;
    var el = editing;
    var text = normalize(el.textContent);
    stopEditing();
    if (!save || text === original) { el.textContent = original; return; }
    if (!text) {
      el.textContent = original;
      post('proto:edit-cancel', { node_id: el.getAttribute('data-node-id'), reason: 'empty' });
      return;
    }
    el.textContent = text;
    // 只有值真正变化才提交；提交按钮 / 失焦 / Enter 共用这一次
    post('proto:edit', { node_id: el.getAttribute('data-node-id'), text: text, original: original });
  }
  document.addEventListener('dblclick', function(ev){
    var el = ev.target.closest ? ev.target.closest('[data-editable]') : null;
    if (!el) return;
    ev.preventDefault(); ev.stopPropagation();
    if (editing === el) return;
    if (editing) commit(true);
    editing = el;
    original = normalize(el.textContent);
    el.setAttribute('contenteditable', 'true');
    el.classList.add('proto-editing');
    el.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* 选择失败不影响编辑 */ }
  }, true);
  document.addEventListener('keydown', function(ev){
    if (!editing) return;
    if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      var el = stopEditing();
      if (el) el.textContent = original;
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault(); ev.stopPropagation();
      commit(true);
    }
  }, true);
  document.addEventListener('blur', function(ev){
    if (editing && ev.target === editing) commit(true);
  }, true);
  document.addEventListener('click', function(ev){
    if (editing) return;
    var el = ev.target.closest ? ev.target.closest('[data-node-id]') : null;
    ev.preventDefault(); ev.stopPropagation();
    if (el) post('proto:node-focus', { node_id: el.getAttribute('data-node-id') });
  }, true);
})();
</script>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE}${extra}</style></head><body>${
    doc?.root ? nodeToHtml(doc.root, { editable }) : '<div style="padding:24px;color:#9ca3af">（空屏）</div>'
  }${measureScript}${selectScript}${editScript}</body></html>`;
}

/** 选中 / 差异高亮的 CSS。id 来自 AI，必须做 CSS 字符串转义，避免破坏样式表。 */
function highlightCss(selectedNodeIds = [], highlightMap = {}) {
  const rules = [];
  for (const id of selectedNodeIds || []) {
    rules.push(`[data-node-id="${cssString(id)}"]{outline:2px solid #2563eb;outline-offset:2px;border-radius:4px}`);
  }
  for (const [id, color] of Object.entries(highlightMap || {})) {
    rules.push(`[data-node-id="${cssString(id)}"]{outline:2px dashed ${color};outline-offset:2px;border-radius:4px}`);
  }
  return rules.join('\n');
}

function cssString(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // 换行/回车会终止 CSS 字符串，必须转成十六进制转义
    .replace(/[\n\r\f]/g, '\\a ');
}
